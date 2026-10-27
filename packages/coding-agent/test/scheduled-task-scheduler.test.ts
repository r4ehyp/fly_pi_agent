/**
 * Scheduled-task clock rules: minute matching, next-fire computation across day/hour
 * rollovers, and API payload validation. The HTTP surface is covered in test/suite/web-mode.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	lastAssistantText,
	minuteBucket,
	nextRunAt,
	normalizeTaskInput,
	parseMinutePastHour,
	parseTimeOfDay,
	splitModelRef,
	type TaskSchedule,
	TaskScheduler,
} from "../src/modes/web/scheduled-task-scheduler.ts";

/** Local timestamp helper: schedules are matched in server local time. */
function at(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
	return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
}

const daily: TaskSchedule = { type: "daily", hour: 9, minute: 30 };
const hourly: TaskSchedule = { type: "hourly", minute: 5 };

describe("minute matching", () => {
	test("floors to the whole minute", () => {
		expect(minuteBucket(at(2026, 10, 27, 9, 30, 0))).toBe(at(2026, 10, 27, 9, 30, 0));
		expect(minuteBucket(at(2026, 10, 27, 9, 30, 59))).toBe(at(2026, 10, 27, 9, 30, 0));
		expect(minuteBucket(at(2026, 10, 27, 9, 31, 0))).toBe(at(2026, 10, 27, 9, 31, 0));
	});
});

describe("nextRunAt", () => {
	test("daily returns today's time when still ahead", () => {
		expect(nextRunAt(daily, at(2026, 10, 27, 8, 0))).toBe(at(2026, 10, 27, 9, 30));
	});

	test("daily returns tomorrow's time once it has passed", () => {
		expect(nextRunAt(daily, at(2026, 10, 27, 9, 31))).toBe(at(2026, 10, 28, 9, 30));
	});

	test("daily fires during its own minute, so a late tick still runs it", () => {
		// The scheduler compares the minute bucket of the fire time with the current bucket:
		// asking at 09:30:40 must return the 09:30 slot, not tomorrow.
		expect(nextRunAt(daily, at(2026, 10, 27, 9, 30, 40))).toBe(at(2026, 10, 27, 9, 30));
	});

	test("daily 00:00 fires just after midnight and not the previous day", () => {
		const midnight: TaskSchedule = { type: "daily", hour: 0, minute: 0 };
		expect(nextRunAt(midnight, at(2026, 10, 27, 0, 0, 30))).toBe(at(2026, 10, 27, 0, 0));
		expect(nextRunAt(midnight, at(2026, 10, 27, 23, 59))).toBe(at(2026, 10, 28, 0, 0));
	});

	test("hourly returns this hour's minute when still ahead", () => {
		expect(nextRunAt(hourly, at(2026, 10, 27, 9, 0))).toBe(at(2026, 10, 27, 9, 5));
	});

	test("hourly rolls to the next hour past its minute", () => {
		expect(nextRunAt(hourly, at(2026, 10, 27, 9, 6))).toBe(at(2026, 10, 27, 10, 5));
		// Crossing midnight: the hour rollover must keep the date correct.
		expect(nextRunAt({ type: "hourly", minute: 59 }, at(2026, 10, 27, 23, 59, 30))).toBe(at(2026, 10, 27, 23, 59));
		expect(nextRunAt({ type: "hourly", minute: 0 }, at(2026, 10, 27, 23, 30))).toBe(at(2026, 10, 28, 0, 0));
	});

	test("out-of-range schedules are rejected instead of firing at an arbitrary time", () => {
		expect(nextRunAt({ type: "daily", hour: 24, minute: 0 }, at(2026, 10, 27, 8, 0))).toBeUndefined();
		expect(nextRunAt({ type: "daily", hour: 9, minute: 60 }, at(2026, 10, 27, 8, 0))).toBeUndefined();
		expect(nextRunAt({ type: "hourly", minute: 60 }, at(2026, 10, 27, 8, 0))).toBeUndefined();
	});
});

describe("schedule input parsing", () => {
	test("parseTimeOfDay accepts 24-hour clock strings only", () => {
		expect(parseTimeOfDay("09:30")).toBe(570);
		expect(parseTimeOfDay("9:05")).toBe(545);
		expect(parseTimeOfDay("23:59:59")).toBe(1439);
		expect(parseTimeOfDay("24:00")).toBeUndefined();
		expect(parseTimeOfDay("9:5")).toBeUndefined();
		expect(parseTimeOfDay("0930")).toBeUndefined();
		expect(parseTimeOfDay(undefined)).toBeUndefined();
	});

	test("parseMinutePastHour accepts 0-59 integers and numeric strings", () => {
		expect(parseMinutePastHour(0)).toBe(0);
		expect(parseMinutePastHour("45")).toBe(45);
		expect(parseMinutePastHour(59)).toBe(59);
		expect(parseMinutePastHour(60)).toBeUndefined();
		expect(parseMinutePastHour(-1)).toBeUndefined();
		expect(parseMinutePastHour(7.5)).toBeUndefined();
		expect(parseMinutePastHour("abc")).toBeUndefined();
	});

	test("splitModelRef keeps slashes inside the model id", () => {
		expect(splitModelRef("openai/gpt-4o")).toEqual({ provider: "openai", id: "gpt-4o" });
		expect(splitModelRef("proxy/vendor/model")).toEqual({ provider: "proxy", id: "vendor/model" });
		expect(splitModelRef("noslash")).toBeUndefined();
		expect(splitModelRef("provider/")).toBeUndefined();
	});
});

describe("normalizeTaskInput", () => {
	test("normalises a daily schedule into hour/minute", () => {
		const { value, error } = normalizeTaskInput({ prompt: "跑一次", schedule: { type: "daily", time: "18:05" } });
		expect(error).toBeUndefined();
		expect(value?.schedule).toEqual({ type: "daily", hour: 18, minute: 5 });
	});

	test("normalises an hourly schedule and trims text fields", () => {
		const { value, error } = normalizeTaskInput({
			name: "  日报  ",
			prompt: "  汇总  ",
			schedule: { type: "hourly", minute: "7" },
		});
		expect(error).toBeUndefined();
		expect(value?.name).toBe("日报");
		expect(value?.prompt).toBe("汇总");
		expect(value?.schedule).toEqual({ type: "hourly", minute: 7 });
	});

	test("rejects missing time, unknown schedule type, and non-boolean enabled", () => {
		expect(normalizeTaskInput({ schedule: { type: "daily" } }).error).toContain("HH:MM");
		expect(normalizeTaskInput({ schedule: { type: "monthly" } }).error).toContain("不支持的执行方式");
		expect(normalizeTaskInput({ schedule: { type: "hourly" } }).error).toContain("minute");
		expect(normalizeTaskInput({ enabled: "yes" }).error).toContain("enabled");
		expect(normalizeTaskInput({ prompt: "   " }).error).toContain("执行内容");
	});

	test("treats an empty model or thinking level as an explicit clear", () => {
		expect(normalizeTaskInput({ model: "" }).value?.model).toBe("");
		expect(normalizeTaskInput({ model: "openai/gpt-4o" }).value?.model).toEqual({ provider: "openai", id: "gpt-4o" });
		expect(normalizeTaskInput({ model: "gpt-4o" }).error).toContain("provider/id");
		expect(normalizeTaskInput({ thinkingLevel: "high" }).value?.thinkingLevel).toBe("high");
		expect(normalizeTaskInput({ thinkingLevel: "sideways" }).error).toContain("思考级别");
	});

	test("leaves every field undefined when the body only carries what was sent", () => {
		const { value } = normalizeTaskInput({ enabled: false });
		expect(value).toEqual({ enabled: false });
	});
});

describe("scheduler snapshot for the UI", () => {
	function newScheduler(clockMs: number) {
		const dir = mkdtempSync(join(tmpdir(), "pi-task-store-"));
		const scheduler = new TaskScheduler({
			storePath: join(dir, "scheduled-tasks.json"),
			getSessionDir: () => dir,
			createSession: async () => {
				throw new Error("not used: these assertions never start a run");
			},
			now: () => clockMs,
		});
		return { scheduler, dir };
	}

	test("the displayed next run skips the minute that is currently firing", () => {
		// Inside its own minute a daily task is still "due" (that is how tick() matches it), but
		// showing that timestamp would render 「下次 今天 09:30」 after the 09:30 run already ran.
		const clock = at(2026, 10, 27, 9, 30, 20);
		const { scheduler, dir } = newScheduler(clock);
		try {
			const created = scheduler.create({ prompt: "日报", schedule: { type: "daily", time: "09:30" } });
			const task = created.task!;
			expect(nextRunAt(task.schedule, clock)).toBe(at(2026, 10, 27, 9, 30));
			const described = scheduler.describe().tasks.find((entry) => entry.id === task.id)!;
			expect(described.nextRunAt).toBe(at(2026, 10, 28, 9, 30));
			expect(described.isActive).toBe(false);
			expect(described.runningSince).toBeUndefined();
			// A disabled task has no next run at all.
			scheduler.update(task.id, { enabled: false });
			expect(scheduler.describe().tasks.find((entry) => entry.id === task.id)!.nextRunAt).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("every stored change bumps the revision so the page can ignore stale payloads", () => {
		const { scheduler, dir } = newScheduler(at(2026, 10, 27, 9, 0));
		try {
			const created = scheduler.create({ prompt: "备份", schedule: { type: "hourly", minute: 5 } });
			const afterCreate = scheduler.describe().revision;
			expect(afterCreate).toBeGreaterThan(0);
			scheduler.update(created.task!.id, { name: "夜间备份" });
			const afterUpdate = scheduler.describe().revision;
			expect(afterUpdate).toBeGreaterThan(afterCreate);
			scheduler.remove(created.task!.id);
			expect(scheduler.describe().revision).toBeGreaterThan(afterUpdate);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("lastAssistantText", () => {
	test("reads the text of the newest assistant message", () => {
		const messages = [
			{ role: "user", content: "跑一次" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "第一段" },
					{ type: "toolCall", id: "1", name: "bash" },
				],
			},
			{ role: "toolResult", content: "ok" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "第一段" },
					{ type: "text", text: "第二段" },
				],
			},
		] as unknown as Parameters<typeof lastAssistantText>[0];
		expect(lastAssistantText(messages)).toBe("第一段\n第二段");
	});

	test("returns empty text when the run produced no assistant message", () => {
		expect(lastAssistantText([])).toBe("");
		expect(lastAssistantText([{ role: "user", content: "only input" }] as never)).toBe("");
	});
});
