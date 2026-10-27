import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { saveModelsConfig } from "../src/core/model-config.ts";

describe("saveModelsConfig", () => {
	let tempDir: string;
	let modelsJsonPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-save-models-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	test("writes valid config with pretty formatting and trailing newline", async () => {
		await saveModelsConfig(modelsJsonPath, {
			providers: {
				"custom-provider": {
					baseUrl: "https://custom.test/v1",
					apiKey: "test-key",
					api: "openai-completions",
					models: [{ id: "custom-a" }],
				},
			},
		});

		const content = readFileSync(modelsJsonPath, "utf-8");
		expect(content.endsWith("\n")).toBe(true);
		expect(JSON.parse(content)).toEqual({
			providers: {
				"custom-provider": {
					baseUrl: "https://custom.test/v1",
					apiKey: "test-key",
					api: "openai-completions",
					models: [{ id: "custom-a" }],
				},
			},
		});
	});

	test("accepts optional $schema field", async () => {
		await saveModelsConfig(modelsJsonPath, {
			$schema: "https://pi.dev/schemas/models.schema.json",
			providers: {},
		});
		expect(JSON.parse(readFileSync(modelsJsonPath, "utf-8")).$schema).toBe(
			"https://pi.dev/schemas/models.schema.json",
		);
	});

	test("rejects invalid schema without touching the file", async () => {
		await expect(
			saveModelsConfig(modelsJsonPath, {
				providers: {
					"bad-provider": {
						baseUrl: "https://bad.test/v1",
						api: "openai-completions",
						models: [{ id: "bad", contextWindow: 0 }],
					},
				},
			}),
		).rejects.toThrow(/Invalid models\.json schema/);
		expect(existsSync(modelsJsonPath)).toBe(false);
	});

	test("rejects non-object config without touching an existing file", async () => {
		await saveModelsConfig(modelsJsonPath, { providers: {} });
		const before = readFileSync(modelsJsonPath, "utf-8");
		await expect(saveModelsConfig(modelsJsonPath, { providers: "not-a-map" })).rejects.toThrow(
			/Invalid models\.json schema/,
		);
		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(before);
	});
});
