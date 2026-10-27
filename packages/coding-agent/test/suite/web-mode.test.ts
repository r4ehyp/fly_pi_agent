/**
 * Web mode (pi --mode web) endpoint tests: static UI under the /fly_pi base path, session
 * state, recent-session listing/resume, models.json provider CRUD, scheduled tasks, and the
 * server-side tab icon through the HTTP API.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WEB_BASE_PATH } from "../../src/cli/args.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type {
	ScheduledTask,
	TaskRun,
	TaskSession,
	TaskSessionFactory,
} from "../../src/modes/web/scheduled-task-scheduler.ts";
import { runWebMode } from "../../src/modes/web/web-server.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Smallest valid PNG (1x1 transparent), so /icon gets bytes a browser can actually decode. */
const TINY_PNG_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("web mode", () => {
	let harness: Harness | undefined;
	let closeServer: (() => Promise<void>) | undefined;
	let sessionDir: string | undefined;

	afterEach(async () => {
		if (closeServer) {
			await closeServer();
			closeServer = undefined;
		}
		harness?.cleanup();
		harness = undefined;
		if (sessionDir) {
			rmSync(sessionDir, { recursive: true, force: true });
			sessionDir = undefined;
		}
	});

	/**
	 * Starts the server and returns its UI base (origin + "/fly_pi"), so tests append routes
	 * the way the browser does. Task options are test seams for the scheduler.
	 */
	async function startServer(
		options: {
			persistedSessions?: boolean;
			createTaskSession?: TaskSessionFactory;
			taskNow?: () => number;
			taskTickIntervalMs?: number;
		} = {},
	): Promise<string> {
		let manager: SessionManager | undefined;
		if (options.persistedSessions) {
			sessionDir = mkdtempSync(join(tmpdir(), "pi-web-sessions-"));
			manager = SessionManager.create(process.cwd(), sessionDir);
		}
		harness = await createHarness({ modelsJson: { providers: {} }, sessionManager: manager });
		// The web server only needs the session, the agent dir for models.json, and session
		// replacement hooks; the rest of AgentSessionRuntime is not exercised by these tests.
		const runtimeHost = {
			session: harness.session,
			services: { agentDir: harness.tempDir },
			setRebindSession: () => {},
			newSession: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
		} as unknown as AgentSessionRuntime;
		const server = await runWebMode(runtimeHost, {
			port: 0,
			createTaskSession: options.createTaskSession,
			taskNow: options.taskNow,
			taskTickIntervalMs: options.taskTickIntervalMs ?? 20,
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		closeServer = () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		return `http://127.0.0.1:${address.port}${WEB_BASE_PATH}`;
	}

	/** Writes a persisted session with one exchange into `dir` and returns its file path. */
	function createPersistedSession(dir: string, label: string): string {
		const session = SessionManager.create(process.cwd(), dir);
		session.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `reply to ${label}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const file = session.getSessionFile();
		if (!file) throw new Error("Expected persisted session file");
		return file;
	}

	test("serves the UI page", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("Pi Agent Web UI");
	});

	// Everything is mounted under /fly_pi/ so the UI can share a port with other services.
	test("routes only live under the /fly_pi base path", async () => {
		const origin = (await startServer()).slice(0, -WEB_BASE_PATH.length);
		const redirect = await fetch(`${origin}/`, { redirect: "manual" });
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get("location")).toBe(`${WEB_BASE_PATH}/`);
		const state = await fetch(`${origin}/api/state`);
		expect(state.status).toBe(404);
		const asset = await fetch(`${origin}/app.js`);
		expect(asset.status).toBe(404);
	});

	test("GET /api/state returns session shape", async () => {
		const base = await startServer();
		const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
		expect(state.model).toBeTruthy();
		expect(state.model).not.toHaveProperty("headers");
		expect(Array.isArray(state.messages)).toBe(true);
		expect(state.messages).toEqual([]);
		expect(typeof state.thinkingLevel).toBe("string");
		expect(Array.isArray(state.availableThinkingLevels)).toBe(true);
		// The UI puts this id in the address bar, so it has to be stable and present.
		expect(typeof state.sessionId).toBe("string");
		expect(state.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("provider CRUD persists to models.json and refreshes the model list", async () => {
		const base = await startServer();
		const configRes = await fetch(`${base}/api/config`);
		expect(configRes.status).toBe(200);
		expect((await configRes.json()).providers).toEqual({});

		const putRes = await fetch(`${base}/api/config/providers/my-provider`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				config: {
					baseUrl: "https://custom.test/v1",
					apiKey: "test-key",
					api: "openai-completions",
					models: [{ id: "my-model", name: "My Model" }],
				},
			}),
		});
		expect(putRes.status).toBe(200);
		const saved = JSON.parse(readFileSync(join(harness!.tempDir, "models.json"), "utf-8")) as {
			providers: Record<string, { baseUrl?: string }>;
		};
		expect(saved.providers["my-provider"]?.baseUrl).toBe("https://custom.test/v1");

		const modelsPayload = (await (await fetch(`${base}/api/models`)).json()) as {
			models: Array<{ provider: string; id: string }>;
		};
		expect(modelsPayload.models.some((m) => m.provider === "my-provider" && m.id === "my-model")).toBe(true);

		const deleteRes = await fetch(`${base}/api/config/providers/my-provider`, { method: "DELETE" });
		expect(deleteRes.status).toBe(200);
		const afterDelete = JSON.parse(readFileSync(join(harness!.tempDir, "models.json"), "utf-8")) as {
			providers: Record<string, unknown>;
		};
		expect(afterDelete.providers["my-provider"]).toBeUndefined();
	});

	test("rejects invalid provider config with 400 and leaves the file untouched", async () => {
		const base = await startServer();
		const before = readFileSync(join(harness!.tempDir, "models.json"), "utf-8");
		const res = await fetch(`${base}/api/config/providers/bad-provider`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { baseUrl: "https://bad.test/v1", models: [{ id: "x", contextWindow: 0 }] } }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()).error as string) ?? "").toContain("Invalid models.json schema");
		expect(readFileSync(join(harness!.tempDir, "models.json"), "utf-8")).toBe(before);
	});

	// A models.json provider with custom models but no `api` passes the schema check yet makes
	// provider-composer throw, which empties the entire available-model list and breaks chat.
	test("rejects a schema-valid but uncompusable provider and restores models.json", async () => {
		const base = await startServer();
		await fetch(`${base}/api/config/providers/good-provider`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				config: {
					baseUrl: "https://good.test/v1",
					apiKey: "k",
					api: "openai-completions",
					models: [{ id: "good" }],
				},
			}),
		});
		const before = readFileSync(join(harness!.tempDir, "models.json"), "utf-8");

		const res = await fetch(`${base}/api/config/providers/api-less`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { baseUrl: "https://nolm.test/v1", apiKey: "k", models: [{ id: "orphan" }] } }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()).error as string) ?? "").toContain("API");
		expect(readFileSync(join(harness!.tempDir, "models.json"), "utf-8")).toBe(before);

		const modelsPayload = (await (await fetch(`${base}/api/models`)).json()) as { available: string[] };
		expect(modelsPayload.available).toContain("good-provider/good");
	});

	test("deleting an unknown provider returns 404", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/config/providers/ghost`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	test("POST /api/prompt validates input", async () => {
		const base = await startServer();
		const noJson = await fetch(`${base}/api/prompt`, { method: "POST", body: "text" });
		expect(noJson.status).toBe(415);
		const emptyText = await fetch(`${base}/api/prompt`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "  " }),
		});
		expect(emptyText.status).toBe(400);
	});

	test("POST /api/abort succeeds while idle", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/abort`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(200);
	});

	test("GET /api/events streams a hello event", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		const decoder = new TextDecoder();
		let chunk = "";
		while (!chunk.includes("data: ")) {
			const next = await reader!.read();
			if (!next.value) break;
			chunk += decoder.decode(next.value, { stream: true });
		}
		expect(chunk).toContain('"type":"hello"');
		await reader!.cancel();
	});

	test("POST /api/probe lists models from a reachable provider endpoint", async () => {
		const base = await startServer();
		let requestedUrl = "";
		let requestedAuth: string | undefined;
		const upstream = createServer((req, res) => {
			requestedUrl = req.url ?? "";
			requestedAuth = req.headers.authorization;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }, { id: "model-b" }, { id: "model-a" }] }));
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const upstreamPort = (upstream.address() as { port: number }).port;
		try {
			const res = await fetch(`${base}/api/probe`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
					apiKey: "test-key",
					api: "openai-completions",
				}),
			});
			expect(res.status).toBe(200);
			const payload = (await res.json()) as {
				reachable: boolean;
				listSupported: boolean;
				models: Array<{ id: string; name?: string }>;
			};
			expect(payload.reachable).toBe(true);
			expect(payload.listSupported).toBe(true);
			expect(payload.models).toEqual([
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: undefined },
			]);
			expect(requestedUrl).toBe("/v1/models");
			expect(requestedAuth).toBe("Bearer test-key");
		} finally {
			await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
		}
	});

	test("POST /api/probe reports unreachable servers and missing baseUrl", async () => {
		const base = await startServer();
		const missing = await fetch(`${base}/api/probe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);

		// Nothing listens on the reserved test port: the probe must report unreachable, not 500.
		const res = await fetch(`${base}/api/probe`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ baseUrl: "http://127.0.0.1:1/v1" }),
		});
		expect(res.status).toBe(200);
		const payload = (await res.json()) as { reachable: boolean; models: unknown[] };
		expect(payload.reachable).toBe(false);
		expect(payload.models).toEqual([]);
	});

	test("GET /api/sessions lists recent sessions, metadata only", async () => {
		const base = await startServer({ persistedSessions: true });
		createPersistedSession(sessionDir!, "hello from older");
		await new Promise((resolve) => setTimeout(resolve, 10));
		createPersistedSession(sessionDir!, "hello from newer");
		const payload = (await (await fetch(`${base}/api/sessions`)).json()) as {
			sessions: Array<{ id: string; firstMessage: string; messageCount: number }>;
			sessionDir: string;
			currentSessionId: string;
		};
		expect(payload.sessionDir).toBe(sessionDir);
		// Most recently modified first: the sidebar is a "recent chats" list.
		expect(payload.sessions.map((session) => session.firstMessage)).toEqual(["hello from newer", "hello from older"]);
		expect(payload.sessions[0]?.messageCount).toBe(2);
		expect(payload.currentSessionId).toBeTruthy();
		// The transcript body and the session file path stay on the server; the id is the handle.
		expect(payload.sessions[0]).not.toHaveProperty("allMessagesText");
		expect(payload.sessions[0]).not.toHaveProperty("path");
	});

	test("POST /api/session/resume resolves the session by id", async () => {
		const base = await startServer({ persistedSessions: true });
		createPersistedSession(sessionDir!, "resume me");
		const listed = (await (await fetch(`${base}/api/sessions`)).json()) as {
			sessions: Array<{ id: string; firstMessage: string }>;
		};
		const target = listed.sessions.find((session) => session.firstMessage === "resume me");
		expect(target).toBeDefined();

		const res = await fetch(`${base}/api/session/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: target?.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { cancelled: boolean; sessionFile?: string };
		expect(body.cancelled).toBe(false);
		expect(body.sessionFile?.startsWith(sessionDir!)).toBe(true);

		const unknown = await fetch(`${base}/api/session/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "00000000-0000-0000-0000-000000000000" }),
		});
		expect(unknown.status).toBe(404);

		// A raw path is not accepted: the browser can only address sessions by id.
		const pathOnly = await fetch(`${base}/api/session/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: join(sessionDir!, "x.jsonl") }),
		});
		expect(pathOnly.status).toBe(400);
	});

	// The tab icon is a server-side setting: one upload applies to every browser hitting the instance.
	test("GET /icon serves the bundled icon until a custom one is saved", async () => {
		const base = await startServer();
		const settings = (await (await fetch(`${base}/api/ui-settings`)).json()) as { icon: { set: boolean } };
		expect(settings.icon.set).toBe(false);

		const fallback = await fetch(`${base}/icon`);
		expect(fallback.status).toBe(200);
		expect(fallback.headers.get("content-type")).toContain("image/svg+xml");
		expect(fallback.headers.get("cache-control")).toBe("no-store");
	});

	test("PUT /api/ui-settings/icon persists a PNG and DELETE restores the default", async () => {
		const base = await startServer();
		const put = await fetch(`${base}/api/ui-settings/icon`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dataUrl: TINY_PNG_DATA_URL }),
		});
		expect(put.status).toBe(200);
		const saved = (await put.json()) as { icon: { set: boolean; type: string; bytes: number } };
		expect(saved.icon.set).toBe(true);
		expect(saved.icon.type).toBe("image/png");
		expect(saved.icon.bytes).toBeGreaterThan(0);

		const written = JSON.parse(readFileSync(join(harness!.tempDir, "web-ui.json"), "utf-8")) as {
			icon: { type: string; data: string };
		};
		expect(written.icon.type).toBe("image/png");
		expect(written.icon.data).toBe(TINY_PNG_DATA_URL.split(",")[1]);

		const served = await fetch(`${base}/icon`);
		expect(served.headers.get("content-type")).toContain("image/png");
		expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(TINY_PNG_DATA_URL.split(",")[1]);

		const deleted = await fetch(`${base}/api/ui-settings/icon`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(((await deleted.json()) as { icon: { set: boolean } }).icon.set).toBe(false);
		const restored = await (await fetch(`${base}/icon`)).text();
		expect(restored).toContain("<svg");
	});

	test("PUT /api/ui-settings/icon rejects non-PNG and malformed data URLs", async () => {
		const base = await startServer();
		const svg = await fetch(`${base}/api/ui-settings/icon`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }),
		});
		expect(svg.status).toBe(400);
		expect(((await svg.json()) as { error: string }).error).toContain("image/png");

		const malformed = await fetch(`${base}/api/ui-settings/icon`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dataUrl: "not-a-data-url" }),
		});
		expect(malformed.status).toBe(400);

		const missing = await fetch(`${base}/api/ui-settings/icon`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(missing.status).toBe(400);
		// Nothing was written, so the default icon is still in use.
		expect((await (await fetch(`${base}/api/ui-settings`)).json()).icon.set).toBe(false);
	});

	// ---- scheduled tasks ----------------------------------------------------------

	interface TaskPayload {
		revision?: number;
		tasks: Array<ScheduledTask & { isActive?: boolean; nextRunAt?: number }>;
		sessionDir?: string;
	}

	async function fetchTasks(base: string): Promise<TaskPayload> {
		return (await (await fetch(`${base}/api/tasks`)).json()) as TaskPayload;
	}

	/** Posts a task payload and returns status plus parsed body. */
	async function postTasks(
		base: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; payload: TaskPayload & { error?: string; createdId?: string } }> {
		const res = await fetch(`${base}/api/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			payload: (await res.json()) as TaskPayload & { error?: string; createdId?: string },
		};
	}

	async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		let value = await read();
		while (!done(value)) {
			if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for a scheduled task run`);
			await new Promise((resolve) => setTimeout(resolve, 20));
			value = await read();
		}
		return value;
	}

	/**
	 * Run session stub: writes a real transcript into the task's session directory so the run
	 * record points at a session file the resume endpoint can open, without needing a model.
	 */
	function stubTaskSessionFactory(behavior: { error?: string; transcript?: boolean } = {}) {
		const prompts: string[] = [];
		const factory: TaskSessionFactory = async ({ task, run, sessionDir, model }) => {
			prompts.push(`${task.name}|${run.trigger}|${model ? `${model.provider}/${model.id}` : "none"}`);
			const manager = SessionManager.create(process.cwd(), sessionDir);
			manager.appendSessionInfo(`[定时任务] ${task.name}`);
			const hasTranscript = behavior.transcript !== false && !behavior.error;
			if (hasTranscript) {
				manager.appendMessage({ role: "user", content: task.prompt, timestamp: Date.now() });
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `task reply to ${task.prompt}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
			}
			const messages = [
				{ role: "user", content: task.prompt },
				{ role: "assistant", content: [{ type: "text", text: `task reply to ${task.prompt}` }] },
			];
			const session: TaskSession = {
				prompt: async (text: string) => {
					if (behavior.error) throw new Error(behavior.error);
					prompts.push(`prompt:${text}`);
				},
				waitForIdle: async () => {},
				abort: async () => {},
				dispose: () => {},
				messages: messages as unknown as TaskSession["messages"],
				sessionId: manager.getSessionId(),
				sessionFile: hasTranscript ? manager.getSessionFile() : undefined,
				sessionName: manager.getSessionName(),
			};
			return session;
		};
		return { prompts, factory };
	}

	test("POST /api/tasks creates a daily task and rejects an invalid schedule", async () => {
		const base = await startServer({ persistedSessions: true });
		const created = await postTasks(base, { prompt: "生成日报", schedule: { type: "daily", time: "09:30" } });
		expect(created.status).toBe(200);
		expect(created.payload.createdId).toBeTruthy();
		const task = created.payload.tasks.find((entry) => entry.id === created.payload.createdId);
		expect(task?.name).toBe("每天 09:30"); // default name from the schedule
		expect(task?.enabled).toBe(true);
		expect(task?.runs).toEqual([]);
		// nextRunAt is epoch ms the page formats; it must be in the future and at 09:30 local.
		expect(task?.nextRunAt).toBeGreaterThan(Date.now() - 1000);
		const next = new Date(task!.nextRunAt!);
		expect([next.getHours(), next.getMinutes()]).toEqual([9, 30]);

		const badTime = await postTasks(base, { prompt: "x", schedule: { type: "daily", time: "25:00" } });
		expect(badTime.status).toBe(400);
		expect(badTime.payload.error).toContain("HH:MM");

		const badType = await postTasks(base, { prompt: "x", schedule: { type: "weekly" } });
		expect(badType.status).toBe(400);

		const noPrompt = await postTasks(base, { schedule: { type: "hourly", minute: 5 } });
		expect(noPrompt.status).toBe(400);

		// Only the two valid calls above were rejected before the store was touched.
		const listed = await fetchTasks(base);
		expect(listed.tasks).toHaveLength(1);
		// Tasks persist next to models.json, so a restart keeps the schedule.
		const stored = JSON.parse(readFileSync(join(harness!.tempDir, "scheduled-tasks.json"), "utf-8")) as TaskPayload;
		expect(stored.tasks).toHaveLength(1);
	});

	test("PUT and DELETE address a task by id", async () => {
		const base = await startServer({ persistedSessions: true });
		const created = await postTasks(base, { prompt: "备份", schedule: { type: "hourly", minute: 15 } });
		const id = created.payload.createdId!;

		const updated = await fetch(`${base}/api/tasks/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: false, name: "夜间备份" }),
		});
		expect(updated.status).toBe(200);
		const afterUpdate = ((await updated.json()) as TaskPayload).tasks.find((entry) => entry.id === id);
		expect(afterUpdate?.name).toBe("夜间备份");
		expect(afterUpdate?.enabled).toBe(false);
		expect(afterUpdate?.nextRunAt).toBeUndefined(); // disabled tasks have no next fire

		const unknown = await fetch(`${base}/api/tasks/does-not-exist`, { method: "DELETE" });
		expect(unknown.status).toBe(404);

		const removed = await fetch(`${base}/api/tasks/${id}`, { method: "DELETE" });
		expect(removed.status).toBe(200);
		expect(((await removed.json()) as TaskPayload).tasks).toHaveLength(0);
	});

	test("a due task runs on the server clock and leaves a resumable chat transcript", async () => {
		// Fixed clock inside the 09:30 minute: the tick must fire exactly once for that minute
		// even though the interval runs many times, which is what a closed page cannot fix.
		let clock = new Date(2026, 9, 27, 9, 30, 10).getTime();
		const stub = stubTaskSessionFactory();
		const base = await startServer({
			persistedSessions: true,
			taskNow: () => clock,
			createTaskSession: stub.factory,
			taskTickIntervalMs: 10,
		});
		const created = await postTasks(base, { prompt: "生成日报", schedule: { type: "daily", time: "09:30" } });
		const id = created.payload.createdId!;

		const payload = await waitFor(
			() => fetchTasks(base),
			(value) => {
				const runs = value.tasks.find((entry) => entry.id === id)?.runs ?? [];
				return runs.length === 1 && runs[0].status !== "running";
			},
		);
		const run = payload.tasks.find((entry) => entry.id === id)!.runs[0] as TaskRun;
		expect(run.status).toBe("ok");
		expect(run.trigger).toBe("schedule");
		expect(run.prompt).toBe("生成日报");
		expect(run.hasTranscript).toBe(true);
		expect(run.summary).toBe("task reply to 生成日报");
		expect(payload.revision!).toBeGreaterThan(created.payload.revision!);
		expect(stub.prompts).toContain(`prompt:生成日报`);

		// The transcript is an ordinary session: it is listed, and resume-by-id finds it.
		const listed = (await (await fetch(`${base}/api/sessions`)).json()) as {
			sessions: Array<{ id: string; name?: string; firstMessage: string }>;
		};
		const transcript = listed.sessions.find((entry) => entry.id === run.sessionId);
		expect(transcript?.firstMessage).toBe("生成日报");
		expect(transcript?.name).toBe("[定时任务] 每天 09:30");

		const resumed = await fetch(`${base}/api/session/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: run.sessionId }),
		});
		expect(resumed.status).toBe(200);

		// More ticks in the same minute must not fire again, and after the minute rolls over the
		// daily task is not due until tomorrow.
		clock += 45_000;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect((await fetchTasks(base)).tasks.find((entry) => entry.id === id)!.runs).toHaveLength(1);
		clock += 60_000;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect((await fetchTasks(base)).tasks.find((entry) => entry.id === id)!.runs).toHaveLength(1);
	});

	test("disabled tasks never fire, and POST /run executes one immediately", async () => {
		const clock = new Date(2026, 9, 27, 9, 30, 10).getTime();
		const stub = stubTaskSessionFactory();
		const base = await startServer({
			persistedSessions: true,
			taskNow: () => clock,
			createTaskSession: stub.factory,
			taskTickIntervalMs: 10,
		});
		const created = await postTasks(base, {
			prompt: "清理",
			schedule: { type: "hourly", minute: 30 },
			enabled: false,
		});
		const id = created.payload.createdId!;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect((await fetchTasks(base)).tasks.find((entry) => entry.id === id)!.runs).toHaveLength(0);

		const unknown = await fetch(`${base}/api/tasks/nope/run`, { method: "POST" });
		expect(unknown.status).toBe(404);

		const run = await fetch(`${base}/api/tasks/${id}/run`, { method: "POST" });
		expect(run.status).toBe(202);
		const payload = await waitFor(
			() => fetchTasks(base),
			(value) => {
				const runs = value.tasks.find((entry) => entry.id === id)?.runs ?? [];
				return runs.length === 1 && runs[0].status !== "running";
			},
		);
		expect(payload.tasks.find((entry) => entry.id === id)!.runs[0].trigger).toBe("manual");

		// A record can be dropped without deleting the transcript.
		const runId = payload.tasks.find((entry) => entry.id === id)!.runs[0].id;
		const deleted = await fetch(`${base}/api/tasks/${id}/runs/${runId}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect((await fetchTasks(base)).tasks.find((entry) => entry.id === id)!.runs).toHaveLength(0);
		expect((await fetch(`${base}/api/tasks/nope/runs/x`, { method: "DELETE" })).status).toBe(404);
	});

	test("a failing run is recorded with its error and does not stop later schedules", async () => {
		let clock = new Date(2026, 9, 27, 9, 30, 10).getTime();
		const stub = stubTaskSessionFactory({ error: "No API key found for the selected model" });
		const base = await startServer({
			persistedSessions: true,
			taskNow: () => clock,
			createTaskSession: stub.factory,
			taskTickIntervalMs: 10,
		});
		const created = await postTasks(base, { prompt: "日报", schedule: { type: "hourly", minute: 30 } });
		const id = created.payload.createdId!;

		const failed = await waitFor(
			() => fetchTasks(base),
			(value) => {
				const runs = value.tasks.find((entry) => entry.id === id)?.runs ?? [];
				return runs.length === 1 && runs[0].status === "error";
			},
		);
		const run = failed.tasks.find((entry) => entry.id === id)!.runs[0];
		expect(run.error).toContain("No API key");
		// The id is recorded, but nothing reached disk: the UI must not offer to open it.
		expect(run.sessionId).toBeTruthy();
		expect(run.hasTranscript).toBe(false);
		expect((await fetchTasks(base)).tasks.find((entry) => entry.id === id)!.enabled).toBe(true);

		// Next hour the task is due again and runs.
		clock += 3_600_000;
		const next = await waitFor(
			() => fetchTasks(base),
			(value) => (value.tasks.find((e) => e.id === id)?.runs ?? []).length === 2,
		);
		expect(next.tasks.find((entry) => entry.id === id)!.runs[1].status).toBe("error"); // same stub still fails
	});

	test("unknown routes return 404", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/nope`);
		expect(res.status).toBe(404);
	});
});
