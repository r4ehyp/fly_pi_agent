/**
 * Scheduled tasks for web mode: user-defined prompts that fire on the server clock.
 *
 * Why this lives in the server process and not in the page: a browser `setInterval` dies
 * with the tab, and the schedules have to survive that. Task definitions are persisted in
 * `scheduled-tasks.json` (next to `models.json`) and matched against the tick loop below.
 *
 * A run never goes through the chat session the UI is bound to — `AgentSessionRuntime`
 * holds exactly one session, so posting there would either mix the task into the
 * conversation the user is typing in or get queued behind it. Every run therefore gets its
 * own throwaway `AgentSession` through the injected `TaskSessionFactory`.
 *
 * Each run writes a session file into the same session directory as the chat sessions and
 * names it after the task, so a run's transcript is an ordinary chat: the UI opens it with
 * the existing `/api/session/resume` + `?session=<id>` path.
 *
 * Scheduling is minute-resolution against the *server local* clock. A fire is remembered
 * per minute bucket, so a tick that runs a few seconds late inside the same minute still
 * fires exactly once, and a restart inside that minute does not double-fire. A run therefore
 * starts within TASK_TICK_INTERVAL_MS of its minute, never before it. Windows that
 * were missed entirely (server down, task created after today's time already passed) are
 * not caught up: a timer that fires three late runs on wake is worse than one skipped run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isValidThinkingLevel } from "../../cli/args.ts";

/**
 * Check frequency for due tasks. A fire lands within this much of its minute (the scan itself is
 * an in-memory loop, so a short interval is cheap) but never before it.
 */
export const TASK_TICK_INTERVAL_MS = 10_000;

export type TaskSchedule =
	/** Every day at HH:MM, server local time. */
	| { type: "daily"; hour: number; minute: number }
	/** Every hour at MM minutes past the hour. */
	| { type: "hourly"; minute: number };

export type TaskRunStatus = "running" | "ok" | "error";

/** One execution of a task: how it ended, plus the transcript that can be resumed. */
export interface TaskRun {
	id: string;
	taskId: string;
	/** "schedule" for a tick fire, "manual" for the 立即执行 button. */
	trigger: "schedule" | "manual";
	startedAt: string;
	finishedAt?: string;
	status: TaskRunStatus;
	/** The prompt actually sent, so a record stays readable after the task is edited. */
	prompt: string;
	sessionId?: string;
	/** True only when the run's session file exists on disk; the id alone is not proof. */
	hasTranscript?: boolean;
	/** Session title, so the record shows what the chat sidebar will say. */
	sessionName?: string;
	summary?: string;
	error?: string;
	durationMs?: number;
}

export interface ScheduledTask {
	id: string;
	name: string;
	enabled: boolean;
	schedule: TaskSchedule;
	prompt: string;
	/** Pinned model for the run. When absent the run follows the model selected in the UI. */
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	createdAt: string;
	updatedAt: string;
	/** Bounded history: oldest records are dropped past MAX_RUNS_PER_TASK. */
	runs: TaskRun[];
}

/** The session handle a run needs. `AgentSession` satisfies it. */
export interface TaskSession {
	prompt(text: string, options?: { source?: "interactive" | "rpc" | "extension" }): Promise<void>;
	waitForIdle(): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	readonly messages: AgentMessage[];
	readonly sessionFile?: string;
	readonly sessionId: string;
	readonly sessionName?: string;
}

/**
 * Creates a fresh, persisted session for one run. The implementation owns SessionManager
 * creation (and therefore the session naming); the scheduler only drives the session.
 */
export type TaskSessionFactory = (context: {
	task: ScheduledTask;
	run: TaskRun;
	sessionDir: string;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
}) => Promise<TaskSession>;

export interface TaskSchedulerOptions {
	/** Path of `scheduled-tasks.json`. */
	storePath: string;
	/** Where run transcripts go: the session directory of this instance. */
	getSessionDir(): string | undefined;
	createSession: TaskSessionFactory;
	/** Model used when the task does not pin one (normally the UI's current model). */
	getDefaultModel?(): { provider: string; id: string } | undefined;
	/** Called after any change — CRUD, a run starting, a run finishing — so the UI can refresh. */
	onChanged?: () => void;
	/** Clock injection for tests. */
	now?: () => number;
}

/** A task as the page sees it: the stored fields plus live scheduler state. */
export interface TaskListView extends ScheduledTask {
	isActive: boolean;
	/** Epoch ms of the next fire, or undefined while the task is disabled. */
	nextRunAt?: number;
	/** Start time of the run in flight, if any. */
	runningSince?: string;
}

/**
 * A snapshot of the task list. `revision` increases with every state change, which lets a page
 * drop a late-arriving response: the run started by `POST /run` usually finishes while that
 * request is still in flight, so its body describes an older state than the SSE event that
 * already arrived — without it the stale response overwrites the fresh one and the record sticks
 * at 执行中.
 */
export interface TaskListSnapshot {
	revision: number;
	tasks: TaskListView[];
}

interface TaskStoreFile {
	version: number;
	tasks: ScheduledTask[];
}

const MAX_RUNS_PER_TASK = 30;
const MAX_TASKS = 50;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 8000;
const SUMMARY_LENGTH = 400;

// ---- pure schedule helpers -----------------------------------------------------

/** Floor to the whole minute: "already fired for this minute" survives a late tick. */
export function minuteBucket(timestampMs: number): number {
	return Math.floor(timestampMs / 60_000) * 60_000;
}

/** Parse "HH:MM" (also "H:MM" and "HH:MM:SS") into minute-of-day. */
export function parseTimeOfDay(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
	if (!match) return undefined;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return undefined;
	return hour * 60 + minute;
}

/** Parse a minute-of-hour (number or numeric string) for the hourly schedule. */
export function parseMinutePastHour(value: unknown): number | undefined {
	const number = typeof value === "number" ? value : Number(typeof value === "string" ? value.trim() : NaN);
	if (!Number.isInteger(number) || number < 0 || number > 59) return undefined;
	return number;
}

/**
 * Next fire at or after `fromMs`, server local time. Daily schedules roll to tomorrow once
 * today's time has passed; hourly schedules roll to the next hour.
 */
export function nextRunAt(schedule: TaskSchedule, fromMs: number): number | undefined {
	const now = new Date(fromMs);
	if (schedule.type === "hourly") {
		if (schedule.minute < 0 || schedule.minute > 59) return undefined;
		const candidate = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			now.getHours(),
			schedule.minute,
			0,
			0,
		);
		if (candidate.getTime() >= minuteBucket(fromMs)) return candidate.getTime();
		candidate.setHours(candidate.getHours() + 1);
		return candidate.getTime();
	}
	if (schedule.hour < 0 || schedule.hour > 23 || schedule.minute < 0 || schedule.minute > 59) return undefined;
	const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), schedule.hour, schedule.minute, 0, 0);
	if (candidate.getTime() >= minuteBucket(fromMs)) return candidate.getTime();
	candidate.setDate(candidate.getDate() + 1);
	return candidate.getTime();
}

/** Display description of a schedule; also the default task name. */
export function describeSchedule(schedule: TaskSchedule): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	if (schedule.type === "hourly") return `每小时第 ${pad(schedule.minute)} 分`;
	return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`;
}

/** "YYYY-MM-DD HH:MM" in server local time: used for run transcripts and record labels. */
export function formatLocalTime(timestampMs: number): string {
	const date = new Date(timestampMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Split "provider/id" (model ids may contain slashes) into a model reference. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
	const idx = ref.indexOf("/");
	if (idx <= 0 || idx === ref.length - 1) return undefined;
	return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

/** Text of the last assistant message: the result line of a run record. */
export function lastAssistantText(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as unknown as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content
			.filter((part): part is { type: "text"; text: string } => {
				const entry = part as { type?: string; text?: string };
				return entry?.type === "text" && typeof entry.text === "string";
			})
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

// ---- API payload validation ----------------------------------------------------

/** Task fields as accepted from the API. `undefined` means "keep the current value". */
export interface TaskInput {
	name?: string;
	enabled?: boolean;
	schedule?: TaskSchedule;
	prompt?: string;
	/** "" clears the pin, so the run follows the model selected in the UI. */
	model?: { provider: string; id: string } | "";
	/** "" clears the pin, so the run follows the level selected in the UI. */
	thinkingLevel?: ThinkingLevel | "";
}

/** Validate a create/update payload, reporting the first problem in Chinese (UI language). */
export function normalizeTaskInput(body: Record<string, unknown>): { value?: TaskInput; error?: string } {
	const out: TaskInput = {};
	if (body.name !== undefined) {
		if (typeof body.name !== "string" || !body.name.trim()) return { error: "任务名称必须是非空字符串" };
		if (body.name.trim().length > MAX_NAME_LENGTH) return { error: `任务名称最长 ${MAX_NAME_LENGTH} 个字符` };
		out.name = body.name.trim();
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") return { error: "enabled 必须是 true 或 false" };
		out.enabled = body.enabled;
	}
	if (body.prompt !== undefined) {
		if (typeof body.prompt !== "string" || !body.prompt.trim()) return { error: "执行内容必须是非空字符串" };
		if (body.prompt.trim().length > MAX_PROMPT_LENGTH) return { error: `执行内容最长 ${MAX_PROMPT_LENGTH} 个字符` };
		out.prompt = body.prompt.trim();
	}
	if (body.schedule !== undefined) {
		const schedule = body.schedule;
		if (!schedule || typeof schedule !== "object") return { error: "schedule 必须是对象" };
		const entry = schedule as Record<string, unknown>;
		if (entry.type === "daily") {
			const timeOfDay = parseTimeOfDay(entry.time ?? entry.hourMinute);
			if (timeOfDay === undefined) return { error: "「每天」执行需要 time，格式 HH:MM（24 小时制），例如 09:30" };
			out.schedule = { type: "daily", hour: Math.floor(timeOfDay / 60), minute: timeOfDay % 60 };
		} else if (entry.type === "hourly") {
			const minute = parseMinutePastHour(entry.minute);
			if (minute === undefined) return { error: "「每小时」执行需要 minute，取值 0-59" };
			out.schedule = { type: "hourly", minute };
		} else {
			return { error: `不支持的执行方式: ${String(entry.type)}（可选 daily、hourly）` };
		}
	}
	if (body.model !== undefined) {
		if (body.model === null || body.model === "") {
			out.model = "";
		} else if (typeof body.model !== "string") {
			return { error: `model 需要是 provider/id 形式的字符串（例如 openai/gpt-4o），或留空表示跟随界面模型` };
		} else {
			const ref = splitModelRef(body.model.trim());
			if (!ref) return { error: `无法解析模型 "${body.model}"，需要 provider/id 形式（例如 openai/gpt-4o）` };
			out.model = ref;
		}
	}
	if (body.thinkingLevel !== undefined) {
		if (body.thinkingLevel === null || body.thinkingLevel === "") {
			out.thinkingLevel = "";
		} else if (typeof body.thinkingLevel !== "string" || !isValidThinkingLevel(body.thinkingLevel)) {
			return { error: `无效的思考级别: ${String(body.thinkingLevel)}` };
		} else {
			out.thinkingLevel = body.thinkingLevel;
		}
	}
	return { value: out };
}

// ---- scheduler -------------------------------------------------------------------

export class TaskScheduler {
	private readonly options: TaskSchedulerOptions;
	private store: TaskStoreFile;
	/** Bumped on every persisted change; see TaskListSnapshot. */
	private revision = 0;
	/** `${taskId}:${minuteBucket}` already dispatched; pruned on every tick. */
	private readonly fired = new Set<string>();
	/** Runs in flight, one per task: a slow run must not stack up behind its own schedule. */
	private readonly active = new Map<string, { run: TaskRun; session?: TaskSession }>();

	constructor(options: TaskSchedulerOptions) {
		this.options = options;
		this.store = this.load();
	}

	private now(): number {
		return this.options.now ? this.options.now() : Date.now();
	}

	/** Unreadable state is reported and reset, never fatal: the server must still serve chat. */
	private load(): TaskStoreFile {
		const path = this.options.storePath;
		if (!existsSync(path)) return { version: 1, tasks: [] };
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<TaskStoreFile>;
			const tasks = Array.isArray(parsed?.tasks)
				? parsed.tasks.filter((task) => task && typeof task.id === "string" && Array.isArray(task.runs))
				: [];
			return { version: 1, tasks };
		} catch (error) {
			console.warn(`Ignoring unreadable ${path}: ${(error as Error).message}`);
			return { version: 1, tasks: [] };
		}
	}

	private save(): void {
		const path = this.options.storePath;
		this.revision += 1;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(this.store, null, 2)}\n`, "utf-8");
	}

	list(): ScheduledTask[] {
		return this.store.tasks;
	}

	get(id: string): ScheduledTask | undefined {
		return this.store.tasks.find((task) => task.id === id);
	}

	/** Snapshot for the UI: tasks (with their runs) plus the next fire of each enabled task. */
	describe(): TaskListSnapshot {
		const nowMs = this.now();
		// Displayed from the start of the *next* minute: inside the fire's own minute nextRunAt()
		// still points at the window that just ran (that is how tick() recognises it as due), which
		// would show 「下次 今天 16:20」 right after the 16:20 run.
		const displayFrom = minuteBucket(nowMs) + 60_000;
		return {
			revision: this.revision,
			tasks: this.store.tasks.map((task) => ({
				...task,
				isActive: this.active.has(task.id),
				nextRunAt: task.enabled ? nextRunAt(task.schedule, displayFrom) : undefined,
				runningSince: this.active.get(task.id)?.run.startedAt,
			})),
		};
	}

	create(body: Record<string, unknown>): { task?: ScheduledTask; error?: string } {
		if (this.store.tasks.length >= MAX_TASKS) {
			return { error: `任务数量已达上限 ${MAX_TASKS} 个，请先删除部分任务` };
		}
		const { value: input, error } = normalizeTaskInput(body);
		if (error || !input) return { error };
		if (!input.prompt) return { error: "缺少必填字段: prompt（要执行的指令内容）" };
		if (!input.schedule) return { error: "缺少必填字段: schedule（执行时间）" };
		const nowIso = new Date(this.now()).toISOString();
		const task: ScheduledTask = {
			id: randomUUID().slice(0, 8),
			name: input.name ?? describeSchedule(input.schedule),
			enabled: input.enabled ?? true,
			schedule: input.schedule,
			prompt: input.prompt,
			createdAt: nowIso,
			updatedAt: nowIso,
			runs: [],
		};
		if (input.model) task.model = input.model;
		if (input.thinkingLevel) task.thinkingLevel = input.thinkingLevel;
		this.store.tasks.push(task);
		this.save();
		this.options.onChanged?.();
		return { task };
	}

	update(id: string, body: Record<string, unknown>): { task?: ScheduledTask; error?: string } {
		const task = this.get(id);
		if (!task) return { error: `未找到定时任务: ${id}` };
		const { value: input, error } = normalizeTaskInput(body);
		if (error || !input) return { error, task };
		if (input.name !== undefined) task.name = input.name;
		if (input.enabled !== undefined) task.enabled = input.enabled;
		if (input.prompt !== undefined) task.prompt = input.prompt;
		if (input.schedule !== undefined) task.schedule = input.schedule;
		if (input.model !== undefined) {
			if (input.model === "") delete task.model;
			else task.model = input.model;
		}
		if (input.thinkingLevel !== undefined) {
			if (input.thinkingLevel === "") delete task.thinkingLevel;
			else task.thinkingLevel = input.thinkingLevel;
		}
		task.updatedAt = new Date(this.now()).toISOString();
		// The edited schedule must be able to fire in the current minute, so the dedup keys
		// describing the *old* schedule are dropped.
		this.clearFired(id);
		this.save();
		this.options.onChanged?.();
		return { task };
	}

	remove(id: string): { removed: boolean } {
		const index = this.store.tasks.findIndex((task) => task.id === id);
		if (index < 0) return { removed: false };
		this.store.tasks.splice(index, 1);
		this.clearFired(id);
		this.save();
		this.options.onChanged?.();
		return { removed: true };
	}

	deleteRun(taskId: string, runId: string): { removed: boolean } {
		const task = this.get(taskId);
		if (!task) return { removed: false };
		const index = task.runs.findIndex((run) => run.id === runId);
		if (index < 0) return { removed: false };
		task.runs.splice(index, 1);
		this.save();
		this.options.onChanged?.();
		return { removed: true };
	}

	/**
	 * Dispatch everything due in the current minute. Called from the existing heartbeat, so an
	 * idle server does no work beyond an in-memory scan; only a due task creates a session.
	 */
	tick(): void {
		const nowMs = this.now();
		const bucket = minuteBucket(nowMs);
		for (const key of this.fired) {
			const separator = key.indexOf(":");
			if (Number(key.slice(separator + 1)) !== bucket) this.fired.delete(key);
		}
		for (const task of this.store.tasks) {
			const key = `${task.id}:${bucket}`;
			// fired.has() is what makes "once per minute" true: the interval fires every tick,
			// and the due window stays open for the whole minute.
			if (!task.enabled || this.fired.has(key) || this.active.has(task.id)) continue;
			const due = nextRunAt(task.schedule, nowMs);
			if (due === undefined || minuteBucket(due) !== bucket) continue;
			this.fired.add(key);
			this.start(task, "schedule");
		}
	}

	/** Fire immediately, ignoring both the schedule and the enabled flag. */
	runNow(taskId: string): { started: boolean; error?: string } {
		const task = this.get(taskId);
		if (!task) return { started: false, error: `未找到定时任务: ${taskId}` };
		if (this.active.has(task.id)) return { started: false, error: "该任务的一次执行仍在进行中" };
		// Skip this minute's scheduled fire as well, so the tick does not start a second run.
		this.fired.add(`${task.id}:${minuteBucket(this.now())}`);
		this.start(task, "manual");
		return { started: true };
	}

	/** Abort the run in flight for a task. */
	async abort(taskId: string): Promise<{ aborted: boolean }> {
		const entry = this.active.get(taskId);
		if (!entry?.session) return { aborted: false };
		await entry.session.abort().catch(() => undefined);
		return { aborted: true };
	}

	private clearFired(taskId: string): void {
		const prefix = `${taskId}:`;
		for (const key of this.fired) {
			if (key.startsWith(prefix)) this.fired.delete(key);
		}
	}

	private start(task: ScheduledTask, trigger: "schedule" | "manual"): void {
		const run: TaskRun = {
			id: randomUUID().slice(0, 8),
			taskId: task.id,
			trigger,
			startedAt: new Date(this.now()).toISOString(),
			status: "running",
			prompt: task.prompt,
		};
		this.active.set(task.id, { run });
		task.runs.push(run);
		if (task.runs.length > MAX_RUNS_PER_TASK) task.runs.splice(0, task.runs.length - MAX_RUNS_PER_TASK);
		this.save();
		this.options.onChanged?.();
		// Not awaited: a run that takes minutes must not hold up the tick, and the HTTP handler
		// that triggers a manual run has to answer immediately.
		void this.execute(task, run).finally(() => {
			this.active.delete(task.id);
			this.options.onChanged?.();
		});
	}

	private async execute(task: ScheduledTask, run: TaskRun): Promise<void> {
		const startedMs = this.now();
		const finish = (status: TaskRunStatus, error?: string) => {
			run.status = status;
			run.error = error;
			run.durationMs = this.now() - startedMs;
			run.finishedAt = new Date(this.now()).toISOString();
			this.save();
		};
		const sessionDir = this.options.getSessionDir();
		if (!sessionDir) {
			finish("error", "当前实例的会话未持久化（--no-session），无法保存定时任务的执行记录。");
			return;
		}
		let session: TaskSession | undefined;
		try {
			session = await this.options.createSession({
				task,
				run,
				sessionDir,
				model: task.model ?? this.options.getDefaultModel?.(),
				thinkingLevel: task.thinkingLevel,
			});
			// Publish the handle before the first request so 「中止」 can reach a running task.
			const entry = this.active.get(task.id);
			if (entry) entry.session = session;
			await session.prompt(task.prompt, { source: "rpc" });
			await session.waitForIdle();
			this.setRunSession(run, session);
			if (!run.hasTranscript) {
				finish("error", "执行没有产生可查看的记录：模型可能未配置、请求被中止，或第一条消息就没有写出。");
				return;
			}
			finish("ok");
		} catch (error) {
			if (session) this.setRunSession(run, session);
			finish("error", error instanceof Error ? error.message : String(error));
		} finally {
			session?.dispose();
		}
	}

	/**
	 * Record which transcript a run produced, for the 查看聊天记录 link. SessionManager.create()
	 * names the file up front, so the path being set is not proof: only a file that exists on
	 * disk can be resumed by id.
	 */
	private setRunSession(run: TaskRun, session: TaskSession): void {
		run.sessionId = session.sessionId;
		run.sessionName = session.sessionName;
		run.hasTranscript = Boolean(session.sessionFile && existsSync(session.sessionFile));
		run.summary = truncate(lastAssistantText(session.messages), SUMMARY_LENGTH);
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
