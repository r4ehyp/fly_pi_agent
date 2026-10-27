/**
 * Web mode (pi --mode web) endpoint tests: static UI, session state, and models.json
 * provider CRUD through the HTTP API.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runWebMode } from "../../src/modes/web/web-server.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("web mode", () => {
	let harness: Harness | undefined;
	let closeServer: (() => Promise<void>) | undefined;

	afterEach(async () => {
		if (closeServer) {
			await closeServer();
			closeServer = undefined;
		}
		harness?.cleanup();
		harness = undefined;
	});

	async function startServer(): Promise<string> {
		harness = await createHarness({ modelsJson: { providers: {} } });
		// The web server only needs the session, the agent dir for models.json, and session
		// replacement hooks; the rest of AgentSessionRuntime is not exercised by these tests.
		const runtimeHost = {
			session: harness.session,
			services: { agentDir: harness.tempDir },
			setRebindSession: () => {},
			newSession: async () => ({ cancelled: false }),
		} as unknown as AgentSessionRuntime;
		const server = await runWebMode(runtimeHost, { port: 0 });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		closeServer = () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		return `http://127.0.0.1:${address.port}`;
	}

	test("serves the UI page", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("Pi Agent Web UI");
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

	test("unknown routes return 404", async () => {
		const base = await startServer();
		const res = await fetch(`${base}/api/nope`);
		expect(res.status).toBe(404);
	});
});
