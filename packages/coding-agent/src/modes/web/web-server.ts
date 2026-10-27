/**
 * Web mode: local HTTP server exposing the agent session to a browser UI.
 *
 * Every route lives under WEB_BASE_PATH ("/fly_pi"), so the UI can sit behind a
 * path-prefixing reverse proxy without knowing its own prefix: the page and its
 * assets are relative URLs, and the API paths are relative to the page.
 *
 * Serves a static HTML/JS/CSS single page (src/modes/web/ui) plus a JSON API:
 * - Chat/session: GET /api/state, GET /api/events (SSE), POST /api/prompt, POST /api/abort,
 *   POST /api/model, POST /api/thinking, POST /api/session/new, POST /api/session/resume
 *   (by session id), GET /api/sessions, GET /api/models
 * - Model configuration: GET/PUT/DELETE /api/config/providers[/:id], backed by models.json;
 *   POST /api/probe tests a provider's reachability and lists its models before saving
 * - Scheduled tasks: GET/POST /api/tasks, PUT/DELETE /api/tasks/:id, POST /api/tasks/:id/run,
 *   POST /api/tasks/:id/abort, DELETE /api/tasks/:id/runs/:runId, backed by scheduled-tasks.json.
 *   Runs execute in their own session on the server clock (page closed is fine) and their
 *   transcripts are ordinary sessions the chat view opens with /api/session/resume.
 * - Appearance: GET /api/ui-settings, PUT/DELETE /api/ui-settings/icon, GET /icon, backed by
 *   web-ui.json. The icon is stored on the server so every browser hitting this instance gets
 *   the same tab icon; the page theme stays client-side (localStorage).
 *
 * The server binds to 127.0.0.1 only: the agent can execute local commands, so this
 * must not be exposed to the network without authentication.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import { isValidThinkingLevel, WEB_BASE_PATH } from "../../cli/args.ts";
import { getWebUiAssetsDir } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { createAgentSessionFromServices } from "../../core/agent-session-services.ts";
import { ModelConfig, saveModelsConfig } from "../../core/model-config.ts";
import { resolveConfigValueUncached } from "../../core/resolve-config-value.ts";
import { type SessionInfo, SessionManager } from "../../core/session-manager.ts";
import { toJsonEvent } from "../json-event.ts";
import {
	formatLocalTime,
	type ScheduledTask,
	TASK_TICK_INTERVAL_MS,
	TaskScheduler,
	type TaskSessionFactory,
} from "./scheduled-task-scheduler.ts";

export interface RunWebModeOptions {
	/** HTTP port to listen on (127.0.0.1 only). Pass 0 for an ephemeral port (tests). */
	port: number;
	/**
	 * Test/embedder seam: how a scheduled task run obtains its session. Defaults to creating a
	 * fresh persisted session from this runtime's services.
	 */
	createTaskSession?: TaskSessionFactory;
	/** Test seam: clock used when deciding which tasks are due. */
	taskNow?: () => number;
	/** Test seam: how often the scheduler checks for due tasks. */
	taskTickIntervalMs?: number;
}

interface SSEClient {
	write(data: string): void;
	close(): void;
}

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Sidebar size: session files are read from disk, so cap the list for the browser. */
const MAX_SESSION_LIST_SIZE = 50;

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
	"/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
	"/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
};

/** Bundled tab icon, served at /icon until the user uploads a custom one. */
const DEFAULT_ICON_FILE = "favicon.svg";
/** Only the PNG the browser renders: anything else is rejected before it reaches disk. */
const ICON_CONTENT_TYPE = "image/png";
/** 256 KB of PNG is far above any 128x128 icon; it bounds what a request can write to disk. */
const MAX_ICON_BYTES = 256 * 1024;

interface WebUiIcon {
	type: string;
	/** base64 of the icon bytes, so the setting stays a single JSON file. */
	data: string;
	updatedAt: string;
}

interface WebUiSettings {
	icon?: WebUiIcon;
}

/**
 * Parse the `data:image/png;base64,...` the browser sends after rasterizing the picked file.
 * Returns the icon, or an error message for the 400 response.
 */
function parseIconDataUrl(value: unknown): { icon?: WebUiIcon; error?: string } {
	if (typeof value !== "string") return { error: "缺少必填字段: dataUrl" };
	const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/i.exec(value.trim());
	if (!match) return { error: "图标格式无效：需要 data:image/...;base64, 形式的 data URL" };
	if (match[1].toLowerCase() !== ICON_CONTENT_TYPE) {
		return { error: `图标格式不支持：仅接受 ${ICON_CONTENT_TYPE}` };
	}
	const bytes = Buffer.byteLength(match[2], "base64");
	if (bytes === 0) return { error: "图标内容为空" };
	if (bytes > MAX_ICON_BYTES) {
		return { error: `图标过大：${bytes} 字节，上限 ${MAX_ICON_BYTES} 字节` };
	}
	return { icon: { type: ICON_CONTENT_TYPE, data: match[2], updatedAt: new Date().toISOString() } };
}

/**
 * Strip the base path from a request path. Returns the path to route, or undefined
 * when the request is outside the base (the caller answers 404, or redirects the bare
 * base so `http://host:port/` still lands on the UI).
 */
function stripBasePath(pathname: string): string | undefined {
	if (!pathname.startsWith(`${WEB_BASE_PATH}/`)) return undefined;
	return pathname.slice(WEB_BASE_PATH.length);
}

/** Session handle plus the metadata the sidebar needs; the transcript stays on the server. */
function toSessionSummary(info: SessionInfo): Record<string, unknown> {
	return {
		id: info.id,
		name: info.name,
		cwd: info.cwd,
		created: info.created.toISOString(),
		modified: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage.slice(0, 120),
	};
}

/** Strip credential-bearing fields before model/session data crosses the HTTP boundary. */
function toSafeModel(model: unknown): Record<string, unknown> {
	const { headers: _headers, ...rest } = model as Record<string, unknown>;
	return rest;
}

/** Model fields the browser needs to pick and display a model; drops cost/compat/sampling noise. */
function toPickerModel(model: Record<string, unknown>): Record<string, unknown> {
	return {
		id: model.id,
		provider: model.provider,
		name: model.name,
		api: model.api,
		reasoning: model.reasoning,
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/**
 * models.json can pass its JSON-schema check and still be unusable: provider-composer throws for a
 * custom model with no `api` (and no built-in provider to inherit one from) or no `baseUrl`, and one
 * bad provider empties the *whole* available-model list, which leaves the session on the placeholder
 * model and makes every prompt fail with "No API key found for the selected model". Reject it here
 * with an actionable message instead of persisting a config that breaks chat.
 */
function validateProviderComposition(
	providerId: string,
	provider: Record<string, unknown>,
	hasBuiltInProvider: boolean,
): string | undefined {
	const models = Array.isArray(provider.models) ? (provider.models as Record<string, unknown>[]) : [];
	for (const model of models) {
		const modelId = typeof model.id === "string" ? model.id : "(missing id)";
		const api = model.api ?? provider.api;
		if (!api && !hasBuiltInProvider) {
			return (
				`Provider "${providerId}", model "${modelId}": 必须选择 API 类型（例如 openai-completions）。` +
				"未设置会导致所有模型都无法使用。"
			);
		}
		const baseUrl = model.baseUrl ?? provider.baseUrl;
		if (!baseUrl && !hasBuiltInProvider) {
			return `Provider "${providerId}", model "${modelId}": 必须填写 Base URL。`;
		}
	}
	return undefined;
}

const PROBE_TIMEOUT_MS = 15_000;

/** Auth headers matching provider-composer conventions for a probe request. */
function probeAuthHeaders(
	api: string | undefined,
	key: string | undefined,
	authHeader: boolean,
): Record<string, string> {
	if (!key) return {};
	if (api === "anthropic-messages") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
	if (api === "google-generative-ai") return { "x-goog-api-key": key };
	if (authHeader || !api || api.startsWith("openai") || api === "openai-completions" || api === "openai-responses") {
		return { Authorization: `Bearer ${key}` };
	}
	return {};
}

/** Parse common model-list response shapes (OpenAI-style arrays under data/models, or a bare array). */
function parseProbeModels(payload: unknown): { id: string; name?: string }[] {
	let entries: unknown[] = [];
	if (Array.isArray(payload)) entries = payload;
	else if (payload && typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		for (const field of ["data", "models", "models_list"]) {
			if (Array.isArray(obj[field])) {
				entries = obj[field] as unknown[];
				break;
			}
		}
	}
	const models: { id: string; name?: string }[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const id =
			typeof entry === "string"
				? entry
				: typeof (entry as Record<string, unknown>)?.id === "string"
					? ((entry as Record<string, unknown>).id as string)
					: undefined;
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const name = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).name : undefined;
		models.push({ id, name: typeof name === "string" ? name : undefined });
	}
	return models;
}

/**
 * Probe a provider endpoint without persisting anything: GET <baseUrl>/models with the
 * candidate credentials. Non-2xx responses still prove the server answered (reachable).
 */
async function probeProvider(input: {
	baseUrl: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}): Promise<{
	reachable: boolean;
	status: number;
	listSupported: boolean;
	models: { id: string; name?: string }[];
	message?: string;
}> {
	const key = input.apiKey !== undefined ? resolveConfigValueUncached(input.apiKey) : undefined;
	if (input.apiKey !== undefined && key === undefined) {
		throw Object.assign(new Error(`Failed to resolve API key: ${input.apiKey}`), { statusCode: 400 });
	}
	let url: string;
	try {
		url = new URL("models", `${input.baseUrl.replace(/\/+$/, "")}/`).toString();
	} catch {
		throw Object.assign(new Error(`Invalid Base URL: ${input.baseUrl}`), { statusCode: 400 });
	}
	const headers: Record<string, string> = {
		Accept: "application/json",
		...input.headers,
		...probeAuthHeaders(input.api, key, input.authHeader === true),
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, { method: "GET", headers, signal: controller.signal });
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "AbortError"
				? `请求超时（${PROBE_TIMEOUT_MS / 1000}s）`
				: error instanceof Error
					? error.message
					: String(error);
		return { reachable: false, status: 0, listSupported: false, models: [], message: `服务器不可达: ${reason}` };
	} finally {
		clearTimeout(timeout);
	}
	if (!response.ok) {
		const body = (await response.text()).slice(0, 300);
		return {
			reachable: true,
			status: response.status,
			listSupported: false,
			models: [],
			message: `服务器已响应 (HTTP ${response.status})${body ? `: ${body}` : ""}`,
		};
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		return {
			reachable: true,
			status: response.status,
			listSupported: false,
			models: [],
			message: `服务器已响应 (HTTP ${response.status})，但模型列表不是有效 JSON`,
		};
	}
	return { reachable: true, status: response.status, listSupported: true, models: parseProbeModels(payload) };
}

function buildStatePayload(session: AgentSessionRuntime["session"]): Record<string, unknown> {
	return {
		model: session.model ? toSafeModel(session.model) : null,
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		sessionId: session.sessionManager.getSessionId(),
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		tools: session.getActiveToolNames(),
		messages: session.messages,
	};
}

async function readBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/** Serve a file from the bundled UI asset directory. */
function sendAsset(res: http.ServerResponse, file: string, contentType: string): void {
	const assetPath = join(getWebUiAssetsDir(), file);
	if (!existsSync(assetPath)) {
		res.writeHead(500, { "Content-Type": "text/plain" });
		res.end(`Web UI asset missing: ${assetPath}`);
		return;
	}
	res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
	res.end(readFileSync(assetPath, "utf-8"));
}

/** Session title for one run, so the transcript reads as a task record in the chat sidebar. */
function taskRunSessionName(task: ScheduledTask, startedAt: string): string {
	const firedAt = Date.parse(startedAt);
	return `[定时任务] ${task.name} · ${formatLocalTime(Number.isFinite(firedAt) ? firedAt : Date.now())}`;
}

/**
 * The default run factory: a brand-new persisted session in this instance's session directory,
 * named after the task, so a finished run is an ordinary chat the sidebar and
 * `/api/session/resume` already handle. cwd-bound services (model registry, settings, loaded
 * resources) are shared with the runtime; the session is not, which is what keeps a background
 * run out of the conversation on screen and lets it be aborted on its own.
 */
function createRuntimeTaskSession(runtime: AgentSessionRuntime): TaskSessionFactory {
	return async ({ task, run, sessionDir, model: modelRef, thinkingLevel }) => {
		const sessionManager = SessionManager.create(runtime.session.sessionManager.getCwd(), sessionDir);
		sessionManager.appendSessionInfo(taskRunSessionName(task, run.startedAt));
		if (!modelRef) {
			throw new Error(
				"当前没有可用模型，定时任务无法执行。请在「模型设置」中配置 Provider 并保存，或在顶部选择一个模型。",
			);
		}
		const model = runtime.session.modelRuntime.getModel(modelRef.provider, modelRef.id);
		if (!model) {
			throw new Error(
				`模型不可用：${modelRef.provider}/${modelRef.id}。请在「模型设置」中确认它已配置且可认证，或将任务改为跟随界面模型。`,
			);
		}
		const { session } = await createAgentSessionFromServices({
			services: runtime.services,
			sessionManager,
			model,
			thinkingLevel,
		});
		return session;
	};
}

/**
 * Run the web mode. Resolves once the server is listening; the listening server handle
 * keeps the process alive. Returns the server so embedders/tests can close it.
 */
export async function runWebMode(runtime: AgentSessionRuntime, options: RunWebModeOptions): Promise<http.Server> {
	const modelsPath = join(runtime.services.agentDir, "models.json");
	const webSettingsPath = join(runtime.services.agentDir, "web-ui.json");
	const clients = new Set<SSEClient>();
	let session = runtime.session;
	let unsubscribe: (() => void) | undefined;

	/** Missing or unreadable web-ui.json is not worth failing the page over: use the defaults. */
	const loadWebUiSettings = (): WebUiSettings => {
		try {
			const parsed = JSON.parse(readFileSync(webSettingsPath, "utf-8")) as unknown;
			return parsed && typeof parsed === "object" ? (parsed as WebUiSettings) : {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				console.warn(`Ignoring unreadable ${webSettingsPath}: ${(error as Error).message}`);
			}
			return {};
		}
	};

	const saveWebUiSettings = (settings: WebUiSettings): void => {
		mkdirSync(dirname(webSettingsPath), { recursive: true });
		writeFileSync(webSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
	};

	/** Icon metadata only: the bytes are served at /icon, never through the JSON API. */
	const describeIcon = (icon: WebUiIcon | undefined) =>
		icon
			? {
					set: true,
					type: icon.type,
					updatedAt: icon.updatedAt,
					bytes: Buffer.byteLength(icon.data, "base64"),
				}
			: { set: false };

	const broadcast = (obj: unknown) => {
		const data = `data: ${JSON.stringify(obj)}\n\n`;
		for (const client of clients) {
			client.write(data);
		}
	};

	const rebindSession = async (): Promise<void> => {
		session = runtime.session;
		await session.bindExtensions({
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtime.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtime.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtime.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				broadcast({
					type: "extension_error",
					extensionPath: err.extensionPath,
					event: err.event,
					error: err.error,
				});
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			broadcast(toJsonEvent(event));
		});
	};

	runtime.setRebindSession(async () => {
		await rebindSession();
		broadcast({ type: "session_replaced", state: buildStatePayload(session) });
	});

	await rebindSession();

	// Scheduled tasks live in the server process, not in the page: a browser `setInterval` stops
	// when the tab closes, and these schedules have to keep firing. Every change is broadcast so
	// an open page updates without polling; a closed page misses nothing.
	const scheduler = new TaskScheduler({
		storePath: join(runtime.services.agentDir, "scheduled-tasks.json"),
		// Read per run: /new and /resume can move the chat session to another directory.
		getSessionDir: () => runtime.session.sessionManager.getSessionDir(),
		createSession: options.createTaskSession ?? createRuntimeTaskSession(runtime),
		// A task without a pinned model follows the UI's selection, but only if that selection is
		// actually usable: after a config error the session can still be sitting on the "unknown"
		// placeholder, and a timer must then run a real model instead of failing every fire.
		getDefaultModel: () => {
			const current = runtime.session.model;
			const available = runtime.session.modelRuntime.getAvailableSnapshot();
			const usable = available.find(
				(model) => current && model.provider === current.provider && model.id === current.id,
			);
			const picked = usable ?? available[0];
			return picked ? { provider: picked.provider, id: picked.id } : undefined;
		},
		onChanged: () => broadcast({ type: "tasks_changed", ...scheduler.describe() }),
		now: options.taskNow,
	});

	/**
	 * Task list plus whether runs can be persisted here. An in-memory instance (`--no-session`)
	 * has no session directory, so a run could not leave a transcript: the UI says so up front
	 * instead of letting a task silently produce nothing. The snapshot revision travels with it so
	 * the page can ignore a response that is older than the event it already applied.
	 */
	const taskListPayload = (): Record<string, unknown> => {
		return { ...scheduler.describe(), sessionDir: runtime.session.sessionManager.getSessionDir() };
	};

	const loadModelsConfigOrThrow = async (): Promise<{ providers: Record<string, unknown> }> => {
		const config = await ModelConfig.load(modelsPath);
		const error = config.getError();
		if (error) {
			throw Object.assign(new Error(error), { statusCode: 409 });
		}
		const providers: Record<string, unknown> = {};
		for (const id of config.getProviderIds()) {
			providers[id] = structuredClone(config.getProvider(id));
		}
		return { providers };
	};

	const writeModelsConfig = async (providers: Record<string, unknown>): Promise<void> => {
		await saveModelsConfig(modelsPath, { providers });
		await runtime.session.modelRuntime.refresh({ allowNetwork: false });
	};

	/**
	 * A saved config can leave the session on the placeholder model (no available models, or the
	 * restored model disappeared). Pick the first available model so the next prompt can run;
	 * a model the session is already using is never touched.
	 */
	const ensureUsableModel = async (): Promise<{ id: string; provider: string } | undefined> => {
		const session = runtime.session;
		const available = session.modelRuntime.getAvailableSnapshot();
		if (available.length === 0) return undefined;
		const current = session.model;
		if (current && available.some((m) => m.provider === current.provider && m.id === current.id)) {
			return undefined;
		}
		const picked = available[0];
		try {
			await session.setModel(picked, { persist: true });
		} catch {
			return undefined;
		}
		return { id: picked.id, provider: picked.provider };
	};

	const sendJson = (res: http.ServerResponse, status: number, payload: unknown) => {
		const body = JSON.stringify(payload);
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(body);
	};

	const sendError = (res: http.ServerResponse, status: number, message: string) => {
		sendJson(res, status, { error: message });
	};

	const readJsonBody = async (
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<Record<string, unknown> | undefined> => {
		const contentType = req.headers["content-type"] ?? "";
		if (!contentType.includes("application/json")) {
			sendError(res, 415, "Content-Type must be application/json");
			return undefined;
		}
		try {
			const parsed = JSON.parse(await readBody(req));
			if (parsed === null || typeof parsed !== "object") {
				sendError(res, 400, "Request body must be a JSON object");
				return undefined;
			}
			return parsed as Record<string, unknown>;
		} catch (error) {
			sendError(res, 400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};

	const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> => {
		const method = req.method ?? "GET";

		if (method === "GET" && path === "/api/state") {
			sendJson(res, 200, buildStatePayload(session));
			return;
		}

		if (method === "GET" && path === "/api/events") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				Connection: "keep-alive",
			});
			const client: SSEClient = {
				write: (data) => res.write(data),
				close: () => res.end(),
			};
			clients.add(client);
			client.write(`data: ${JSON.stringify({ type: "hello", state: buildStatePayload(session) })}\n\n`);
			res.on("close", () => clients.delete(client));
			return;
		}

		if (method === "GET" && path === "/api/sessions") {
			const dir = session.sessionManager.getSessionDir();
			// An in-memory session has no session directory (and nothing to resume).
			const sessions = dir ? await SessionManager.list(session.sessionManager.getCwd(), dir) : [];
			sendJson(res, 200, {
				sessions: sessions.slice(0, MAX_SESSION_LIST_SIZE).map(toSessionSummary),
				sessionDir: dir,
				currentSessionId: session.sessionManager.getSessionId(),
			});
			return;
		}

		if (method === "GET" && path === "/api/models") {
			const modelRuntime = session.modelRuntime;
			const available = new Set(modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
			const providers: Record<string, { auth: unknown }> = {};
			const models = modelRuntime.getModels().map((model) => {
				if (!providers[model.provider]) {
					providers[model.provider] = { auth: modelRuntime.getProviderAuthStatus(model.provider) };
				}
				return toPickerModel(toSafeModel(model));
			});
			sendJson(res, 200, {
				models,
				available: [...available],
				providers,
				error: modelRuntime.getError(),
			});
			return;
		}

		if (method === "GET" && path === "/api/config") {
			try {
				const config = await loadModelsConfigOrThrow();
				sendJson(res, 200, { ...config, runtimeError: session.modelRuntime.getError() });
			} catch (error) {
				const err = error as Error & { statusCode?: number };
				sendError(res, err.statusCode ?? 500, err.message);
			}
			return;
		}

		if (method === "POST" && path === "/api/probe") {
			const body = await readJsonBody(req, res);
			if (body === undefined) return;
			const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
			if (!baseUrl) {
				sendError(res, 400, "Missing required field: baseUrl");
				return;
			}
			const rawHeaders =
				body.headers && typeof body.headers === "object" ? (body.headers as Record<string, unknown>) : {};
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(rawHeaders)) {
				if (typeof v === "string") headers[k] = v;
			}
			try {
				const result = await probeProvider({
					baseUrl,
					apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined,
					api: typeof body.api === "string" && body.api ? body.api : undefined,
					headers: Object.keys(headers).length > 0 ? headers : undefined,
					authHeader: body.authHeader === true,
				});
				sendJson(res, 200, result);
			} catch (error) {
				const err = error as Error & { statusCode?: number };
				sendError(res, err.statusCode ?? 500, err.message);
			}
			return;
		}

		const providerMatch = path.match(/^\/api\/config\/providers\/([^/]+)$/);
		if (providerMatch && (method === "PUT" || method === "DELETE")) {
			const providerId = decodeURIComponent(providerMatch[1]);
			let current: { providers: Record<string, unknown> };
			try {
				current = await loadModelsConfigOrThrow();
			} catch (error) {
				const err = error as Error & { statusCode?: number };
				sendError(res, err.statusCode ?? 500, err.message);
				return;
			}
			const providers = structuredClone(current.providers);
			let compositionError: string | undefined;
			if (method === "PUT") {
				const body = await readJsonBody(req, res);
				if (body === undefined) return;
				const providerConfig = (body.config ?? body) as Record<string, unknown>;
				// Captured before writing: after the write the provider exists in the registry.
				compositionError = validateProviderComposition(
					providerId,
					providerConfig,
					session.modelRuntime.getProvider(providerId) !== undefined,
				);
				providers[providerId] = providerConfig;
			} else {
				if (providers[providerId] === undefined) {
					sendError(res, 404, `Provider not found in models.json: ${providerId}`);
					return;
				}
				delete providers[providerId];
			}
			try {
				await writeModelsConfig(providers);
			} catch (error) {
				sendError(res, 400, error instanceof Error ? error.message : String(error));
				return;
			}
			// Schema-valid but uncompusable: roll back so one bad provider cannot take the whole
			// model list (and therefore every chat) down with it.
			if (compositionError) {
				await writeModelsConfig(structuredClone(current.providers)).catch(() => undefined);
				sendError(res, 400, compositionError);
				return;
			}
			const selectedModel = method === "PUT" ? await ensureUsableModel() : undefined;
			const updated = await loadModelsConfigOrThrow();
			sendJson(res, 200, {
				providers: updated.providers,
				runtimeError: session.modelRuntime.getError(),
				selectedModel,
			});
			return;
		}

		if (method === "GET" && path === "/api/ui-settings") {
			sendJson(res, 200, { icon: describeIcon(loadWebUiSettings().icon) });
			return;
		}

		if (path === "/api/ui-settings/icon" && (method === "PUT" || method === "DELETE")) {
			const settings = loadWebUiSettings();
			if (method === "DELETE") {
				delete settings.icon;
			} else {
				const body = await readJsonBody(req, res);
				if (body === undefined) return;
				const parsed = parseIconDataUrl(body.dataUrl);
				if (parsed.error || !parsed.icon) {
					sendError(res, 400, parsed.error ?? "图标无效");
					return;
				}
				settings.icon = parsed.icon;
			}
			try {
				saveWebUiSettings(settings);
			} catch (error) {
				sendError(
					res,
					500,
					`无法写入 ${webSettingsPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			sendJson(res, 200, { icon: describeIcon(settings.icon) });
			return;
		}

		// ---- scheduled tasks -----------------------------------------------------
		// Every response carries the full task list (with run records), so the page can render one
		// request per action instead of re-fetching after the broadcast lands.
		if (path === "/api/tasks" && (method === "GET" || method === "POST")) {
			if (method === "GET") {
				sendJson(res, 200, taskListPayload());
				return;
			}
			const body = await readJsonBody(req, res);
			if (body === undefined) return;
			const created = scheduler.create(body);
			if (created.error || !created.task) {
				sendError(res, 400, created.error ?? "任务创建失败");
				return;
			}
			sendJson(res, 200, { ...taskListPayload(), createdId: created.task.id });
			return;
		}

		const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
		if (taskMatch && (method === "PUT" || method === "DELETE")) {
			const taskId = decodeURIComponent(taskMatch[1]);
			if (method === "DELETE") {
				const removed = scheduler.remove(taskId);
				if (!removed.removed) {
					sendError(res, 404, `未找到定时任务: ${taskId}`);
					return;
				}
				sendJson(res, 200, taskListPayload());
				return;
			}
			const body = await readJsonBody(req, res);
			if (body === undefined) return;
			const updated = scheduler.update(taskId, body);
			if (updated.error) {
				sendError(res, updated.task === undefined ? 404 : 400, updated.error);
				return;
			}
			sendJson(res, 200, taskListPayload());
			return;
		}

		const taskActionMatch = path.match(/^\/api\/tasks\/([^/]+)\/(run|abort)$/);
		if (taskActionMatch && method === "POST") {
			const taskId = decodeURIComponent(taskActionMatch[1]);
			if (taskActionMatch[2] === "abort") {
				const aborted = await scheduler.abort(taskId);
				sendJson(res, 200, { aborted, ...taskListPayload() });
				return;
			}
			// Manual runs bypass the schedule and the enabled flag: the point of the button is to
			// test a task now. 202 because the transcript is not finished when this returns.
			const started = scheduler.runNow(taskId);
			if (!started.started) {
				sendError(res, started.error?.includes("未找到") ? 404 : 409, started.error ?? "任务未能启动");
				return;
			}
			sendJson(res, 202, { started: true, ...taskListPayload() });
			return;
		}

		const taskRunMatch = path.match(/^\/api\/tasks\/([^/]+)\/runs\/([^/]+)$/);
		if (taskRunMatch && method === "DELETE") {
			const removed = scheduler.deleteRun(decodeURIComponent(taskRunMatch[1]), decodeURIComponent(taskRunMatch[2]));
			if (!removed.removed) {
				sendError(res, 404, "未找到该执行记录");
				return;
			}
			sendJson(res, 200, taskListPayload());
			return;
		}

		if (method === "POST" && path.startsWith("/api/")) {
			const body = await readJsonBody(req, res);
			if (body === undefined) return;

			switch (path) {
				case "/api/prompt": {
					const text = typeof body.text === "string" ? body.text.trim() : "";
					if (!text) {
						sendError(res, 400, "Missing required field: text");
						return;
					}
					if (!session.isIdle) {
						const disposition = await session.steer(text, undefined, { source: "rpc" });
						sendJson(res, 200, { disposition });
						return;
					}
					// Fail fast with an actionable hint instead of a 202 whose only feedback is a
					// transient "No API key found for the selected model" error event.
					const model = session.model;
					const usable =
						model !== undefined &&
						session.modelRuntime
							.getAvailableSnapshot()
							.some((available) => available.provider === model.provider && available.id === model.id);
					if (!usable) {
						sendError(res, 409, "当前没有可用模型。请在「模型设置」中配置 Provider 并保存，或在顶部选择模型。");
						return;
					}
					void session.prompt(text, { source: "rpc" }).catch((error: unknown) => {
						broadcast({ type: "web_error", message: error instanceof Error ? error.message : String(error) });
					});
					sendJson(res, 202, { started: true });
					return;
				}
				case "/api/abort": {
					await session.abort();
					sendJson(res, 200, { aborted: true });
					return;
				}
				case "/api/model": {
					const provider = typeof body.provider === "string" ? body.provider : "";
					const modelId = typeof body.modelId === "string" ? body.modelId : "";
					const model = session.modelRuntime.getModel(provider, modelId);
					if (!model) {
						sendError(res, 404, `Model not found: ${provider}/${modelId}`);
						return;
					}
					try {
						await session.setModel(model, { persist: true });
					} catch (error) {
						sendError(res, 400, error instanceof Error ? error.message : String(error));
						return;
					}
					sendJson(res, 200, { model: toSafeModel(model) });
					return;
				}
				case "/api/thinking": {
					const level = typeof body.level === "string" ? body.level : "";
					if (!isValidThinkingLevel(level)) {
						sendError(res, 400, `Invalid thinking level: ${level}`);
						return;
					}
					session.setThinkingLevel(level, { persist: true });
					sendJson(res, 200, { thinkingLevel: session.thinkingLevel });
					return;
				}
				case "/api/session/new": {
					const result = await runtime.newSession();
					sendJson(res, 200, { cancelled: result.cancelled });
					return;
				}
				case "/api/session/resume": {
					const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
					if (!sessionId) {
						sendError(res, 400, "Missing required field: sessionId");
						return;
					}
					if (sessionId === session.sessionManager.getSessionId()) {
						sendJson(res, 200, { cancelled: false, sessionId, sessionFile: session.sessionFile });
						return;
					}
					// The browser addresses sessions by id only: the server resolves the file inside its
					// own session directory, so a request cannot name an arbitrary jsonl path.
					const sessionDir = session.sessionManager.getSessionDir();
					const found = sessionDir
						? SessionManager.findById(session.sessionManager.getCwd(), sessionId, sessionDir)
						: undefined;
					if (!found) {
						sendError(res, 404, `未找到已保存的会话: ${sessionId}`);
						return;
					}
					const result = await runtime.switchSession(found);
					sendJson(res, 200, { cancelled: result.cancelled, sessionId, sessionFile: found });
					return;
				}
				default: {
					sendError(res, 404, `Unknown endpoint: ${path}`);
					return;
				}
			}
		}

		if (method === "GET") {
			// The tab icon: the stored PNG if there is one, otherwise the bundled SVG. no-store
			// because browsers cache favicons hard and the UI would otherwise keep the old icon.
			if (path === "/icon") {
				const icon = loadWebUiSettings().icon;
				if (icon) {
					res.writeHead(200, { "Content-Type": icon.type, "Cache-Control": "no-store" });
					res.end(Buffer.from(icon.data, "base64"));
					return;
				}
				sendAsset(res, DEFAULT_ICON_FILE, "image/svg+xml");
				return;
			}
			const staticFile = STATIC_FILES[path];
			if (staticFile) {
				sendAsset(res, staticFile.file, staticFile.contentType);
				return;
			}
		}

		sendError(res, 404, `Not found: ${method} ${path}`);
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = stripBasePath(url.pathname);
		if (path === undefined) {
			if (url.pathname === "/" || url.pathname === WEB_BASE_PATH) {
				res.writeHead(302, { Location: `${WEB_BASE_PATH}/` });
				res.end();
				return;
			}
			sendError(res, 404, `Not found: ${req.method ?? "GET"} ${url.pathname}`);
			return;
		}
		handleApi(req, res, path).catch((error: unknown) => {
			if (!res.headersSent) {
				sendError(res, 500, error instanceof Error ? error.message : String(error));
			} else {
				res.end();
			}
		});
	});

	const heartbeat = setInterval(() => {
		for (const client of clients) {
			client.write(": ping\n\n");
		}
	}, HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();
	server.on("close", () => clearInterval(heartbeat));

	const taskTick = setInterval(() => scheduler.tick(), options.taskTickIntervalMs ?? TASK_TICK_INTERVAL_MS);
	taskTick.unref();
	server.on("close", () => clearInterval(taskTick));

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	console.log(`Web UI available at http://127.0.0.1:${port}${WEB_BASE_PATH}/`);
	return server;
}
