/**
 * Web mode: local HTTP server exposing the agent session to a browser UI.
 *
 * Serves a static HTML/JS/CSS single page (src/modes/web/ui) plus a JSON API:
 * - Chat/session: GET /api/state, GET /api/events (SSE), POST /api/prompt, POST /api/abort,
 *   POST /api/model, POST /api/thinking, POST /api/session/new, GET /api/models
 * - Model configuration: GET/PUT/DELETE /api/config/providers[/:id], backed by models.json
 *
 * The server binds to 127.0.0.1 only: the agent can execute local commands, so this
 * must not be exposed to the network without authentication.
 */

import { existsSync, readFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { getWebUiAssetsDir } from "../../config.ts";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { ModelConfig, saveModelsConfig } from "../../core/model-config.ts";
import { toJsonEvent } from "../json-event.ts";

export interface RunWebModeOptions {
	/** HTTP port to listen on (127.0.0.1 only). Pass 0 for an ephemeral port (tests). */
	port: number;
}

interface SSEClient {
	write(data: string): void;
	close(): void;
}

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
	"/": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
	"/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
};

/** Strip credential-bearing fields before model/session data crosses the HTTP boundary. */
function toSafeModel(model: unknown): Record<string, unknown> {
	const { headers: _headers, ...rest } = model as Record<string, unknown>;
	return rest;
}

function buildStatePayload(session: AgentSessionRuntime["session"]): Record<string, unknown> {
	return {
		model: session.model ? toSafeModel(session.model) : null,
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
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

/**
 * Run the web mode. Resolves once the server is listening; the listening server handle
 * keeps the process alive. Returns the server so embedders/tests can close it.
 */
export async function runWebMode(runtime: AgentSessionRuntime, options: RunWebModeOptions): Promise<http.Server> {
	const modelsPath = join(runtime.services.agentDir, "models.json");
	const clients = new Set<SSEClient>();
	let session = runtime.session;
	let unsubscribe: (() => void) | undefined;

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

	const handleApi = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
		const path = url.pathname;
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

		if (method === "GET" && path === "/api/models") {
			const modelRuntime = session.modelRuntime;
			const available = new Set(modelRuntime.getAvailableSnapshot().map((m) => `${m.provider}/${m.id}`));
			const providers: Record<string, { auth: unknown }> = {};
			const models = modelRuntime.getModels().map((model) => {
				if (!providers[model.provider]) {
					providers[model.provider] = { auth: modelRuntime.getProviderAuthStatus(model.provider) };
				}
				return toSafeModel(model);
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
			const providers = current.providers;
			if (method === "PUT") {
				const body = await readJsonBody(req, res);
				if (body === undefined) return;
				const providerConfig = body.config ?? body;
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
			const updated = await loadModelsConfigOrThrow();
			sendJson(res, 200, { providers: updated.providers });
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
				default: {
					sendError(res, 404, `Unknown endpoint: ${path}`);
					return;
				}
			}
		}

		if (method === "GET") {
			const staticFile = STATIC_FILES[path];
			if (staticFile) {
				const assetPath = join(getWebUiAssetsDir(), staticFile.file);
				if (!existsSync(assetPath)) {
					res.writeHead(500, { "Content-Type": "text/plain" });
					res.end(`Web UI asset missing: ${assetPath}`);
					return;
				}
				res.writeHead(200, { "Content-Type": staticFile.contentType, "Cache-Control": "no-store" });
				res.end(readFileSync(assetPath, "utf-8"));
				return;
			}
		}

		sendError(res, 404, `Not found: ${method} ${path}`);
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		handleApi(req, res, url).catch((error: unknown) => {
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

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : options.port;
	console.log(`Web UI available at http://127.0.0.1:${port}`);
	return server;
}
