/**
 * Web mode (pi --mode web) endpoint tests: static UI under the /fly_pi base path, session
 * state, recent-session listing/resume, and models.json provider CRUD through the HTTP API.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WEB_BASE_PATH } from "../../src/cli/args.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runWebMode } from "../../src/modes/web/web-server.ts";
import { createHarness, type Harness } from "./harness.ts";

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
	 * the way the browser does.
	 */
	async function startServer(options: { persistedSessions?: boolean } = {}): Promise<string> {
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
		const server = await runWebMode(runtimeHost, { port: 0 });
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

	test("unknown routes return 404", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/nope`);
		expect(res.status).toBe(404);
	});
});
