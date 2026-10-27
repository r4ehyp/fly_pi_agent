"use strict";

// Vanilla single-page client for `pi --mode web`. No build step, no framework:
// server state comes from GET <base>/api/state, live updates from the <base>/api/events SSE
// stream. The whole app is hosted under a path prefix (/fly_pi/), so every request is built
// from the page URL instead of a hardcoded root path.

// ---- helpers ----------------------------------------------------------------

/** "/fly_pi" when the page is served from "/fly_pi/", "" when it is served from the root. */
const UI_BASE = new URL(".", window.location.href).pathname.replace(/\/$/, "");

function withBase(path) {
	return `${UI_BASE}${path}`;
}

function $(id) {
	return document.getElementById(id);
}

function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function el(tag, className, textContent) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent !== undefined) node.textContent = textContent;
	return node;
}

function fmtTokens(n) {
	if (!Number.isFinite(n)) return "-";
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return String(n);
}

/** Minimal markdown renderer: fenced code, inline code, bold, headings, lists, links. */
function renderMarkdown(text) {
	const escaped = escapeHtml(text || "");
	const lines = escaped.split("\n");
	const out = [];
	let inCode = false;
	let codeBuf = [];
	let inList = false;

	const closeList = () => {
		if (inList) {
			out.push("</ul>");
			inList = false;
		}
	};

	const inline = (s) =>
		s
			.replace(/`([^`]+)`/g, (_m, c) => `<code class="inline">${c}</code>`)
			.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`)
			.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);

	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			if (inCode) {
				out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
				codeBuf = [];
				inCode = false;
			} else {
				closeList();
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			codeBuf.push(line);
			continue;
		}
		const heading = line.match(/^(#{1,3})\s+(.*)$/);
		const bullet = line.match(/^\s*[-*]\s+(.*)$/);
		if (heading) {
			closeList();
			const level = heading[1].length + 1; // h2..h4
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
		} else if (bullet) {
			if (!inList) {
				out.push("<ul>");
				inList = true;
			}
			out.push(`<li>${inline(bullet[1])}</li>`);
		} else if (line.trim() === "") {
			closeList();
		} else {
			closeList();
			out.push(`<p>${inline(line)}</p>`);
		}
	}
	if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
	closeList();
	return out.join("");
}

/** Adds a hover "copy" button to every fenced block. Runs on the nodes we just built. */
function decorateCodeBlocks(root) {
	for (const pre of root.querySelectorAll("pre")) {
		const btn = el("button", "copy-btn", "复制");
		btn.type = "button";
		btn.addEventListener("click", () => {
			const code = pre.querySelector("code")?.textContent ?? "";
			navigator.clipboard
				?.writeText(code)
				.then(() => {
					btn.textContent = "已复制";
					setTimeout(() => {
						btn.textContent = "复制";
					}, 1200);
				})
				.catch(() => toast("复制失败", true));
		});
		pre.appendChild(btn);
	}
}

function detailsBlock(summaryText, contentNodes, open, extraClass) {
	const details = el("details", `block${extraClass ? ` ${extraClass}` : ""}`);
	if (open) details.open = true;
	const summary = el("summary");
	summary.textContent = summaryText;
	details.appendChild(summary);
	for (const node of contentNodes) details.appendChild(node);
	return details;
}

async function api(path, options) {
	const res = await fetch(withBase(path), options);
	let payload = null;
	try {
		payload = await res.json();
	} catch (_e) {
		/* non-JSON response */
	}
	if (!res.ok) {
		throw new Error((payload && payload.error) || `HTTP ${res.status}`);
	}
	return payload;
}

function apiPost(path, body) {
	return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
}

function toast(message, isError) {
	const node = $("toast");
	node.textContent = message;
	node.style.borderColor = isError ? "var(--red)" : "var(--accent)";
	node.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => {
		node.hidden = true;
	}, 4000);
}

// ---- chat state --------------------------------------------------------------

let busy = false;
let currentModelKey = null; // "provider/id"
let currentContextWindow = 0;
let lastContextTokens = 0;
const messagesEl = $("messages");
const toolBlocksById = new Map(); // toolCallId -> <details>, updated when the result arrives
const toolTimingById = new Map(); // toolCallId -> { ms, isError }; survives the post-turn re-render

function modelKey(model) {
	return model ? `${model.provider}/${model.id}` : null;
}

function setBusy(value) {
	busy = value;
	$("stop-btn").disabled = !busy;
	$("send-btn").disabled = busy || !hasUsableModel();
	const status = $("status-line");
	status.classList.toggle("busy", value);
	status.textContent = value ? "正在思考 / 执行工具…" : "";
}

function hasUsableModel() {
	if (!currentModelKey || !modelsPayload) return false;
	return modelsPayload.available.includes(currentModelKey);
}

function messageTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function toolStateText(ms, isError) {
	if (ms === undefined) return isError ? "失败" : "完成";
	return `${isError ? "失败" : "完成"} ${Math.round(ms)}ms`;
}

function applyToolState(card, { ms, isError }) {
	const state = card.querySelector(".state");
	if (!state) return;
	state.className = `state ${isError ? "bad" : "ok"}`;
	state.textContent = toolStateText(ms, isError);
	card.classList.toggle("bad", Boolean(isError));
}

function toolCard(toolCall, result) {
	const id = toolCall.id || toolCall.toolCallId || "";
	const name = toolCall.name || toolCall.toolName || "tool";
	const nodes = [el("pre", undefined, JSON.stringify(toolCall.arguments ?? toolCall.partialArguments ?? {}, null, 2))];
	if (result !== undefined) nodes.push(resultNode(result));
	const details = detailsBlock("", nodes, false, "tool");
	const summary = details.querySelector("summary");
	summary.append(el("span", "kind", name), el("span", "state", ""));
	if (id) {
		details.dataset.toolCallId = id;
		toolBlocksById.set(id, details);
	}
	const timing = id ? toolTimingById.get(id) : undefined;
	if (timing) applyToolState(details, timing);
	else if (result !== undefined) applyToolState(details, { ms: undefined, isError: Boolean(result.isError) });
	else {
		const state = details.querySelector(".state");
		state.className = "state running";
		state.textContent = "执行中…";
	}
	return details;
}

function resultNode(result) {
	const text = messageTextContent(result.content) || JSON.stringify(result.content, null, 2);
	return el("pre", undefined, `${result.isError ? "错误输出" : "结果"}:\n${text}`);
}

function usageLine(message) {
	const usage = message.usage;
	if (!usage) return null;
	const parts = [];
	const prompt = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
	if (prompt) parts.push(`输入 ${fmtTokens(prompt)}`);
	if (usage.output) parts.push(`输出 ${fmtTokens(usage.output)}`);
	if (usage.cost && usage.cost.total) parts.push(`费用 $${usage.cost.total.toFixed(4)}`);
	if (parts.length === 0) return null;
	return el("span", "num", parts.join(" · "));
}

function assistantBody(message) {
	const frag = el("div", "markdown");
	for (const part of message.content || []) {
		if (part.type === "text") {
			const div = el("div");
			div.innerHTML = renderMarkdown(part.text);
			// Decorate only this text block: tool cards are reused across streaming redraws and
			// would otherwise accumulate a copy button per delta.
			decorateCodeBlocks(div);
			frag.appendChild(div);
		} else if (part.type === "thinking") {
			frag.appendChild(detailsBlock("思考过程", [el("pre", undefined, part.thinking || part.text || "")], false, "thinking"));
		} else if (part.type === "toolCall" || part.type === "toolcall") {
			const id = part.id || "";
			const existing = toolBlocksById.get(id);
			if (existing) frag.appendChild(existing);
			else frag.appendChild(toolCard(part, undefined));
		}
	}
	return frag;
}

function messageNode(msg) {
	if (msg.role === "user") {
		const node = el("div", "msg user");
		node.appendChild(el("div", "avatar", "你"));
		const body = el("div", "body");
		const bubble = el("div", "bubble");
		const inner = el("div", "markdown");
		inner.innerHTML = renderMarkdown(messageTextContent(msg.content));
		bubble.appendChild(inner);
		body.appendChild(bubble);
		node.appendChild(body);
		return node;
	}
	if (msg.role === "assistant") {
		const node = el("div", "msg assistant");
		node.appendChild(el("div", "avatar", "AI"));
		const body = el("div", "body");
		const meta = el("div", "meta");
		meta.appendChild(el("span", "who", "助手"));
		if (msg.model) meta.appendChild(el("span", undefined, `${msg.provider ? `${msg.provider} · ` : ""}${msg.model}`));
		const usage = usageLine(msg);
		if (usage) meta.appendChild(usage);
		body.appendChild(meta);
		const bubble = el("div", "bubble");
		bubble.appendChild(assistantBody(msg));
		if ((msg.stopReason === "error" || msg.stopReason === "aborted") && msg.errorMessage) {
			bubble.appendChild(el("div", "error-text", `错误: ${msg.errorMessage}`));
			node.classList.add("error");
		}
		body.appendChild(bubble);
		node.appendChild(body);
		return node;
	}
	// Tool results attach to their tool card when one is on screen.
	if (msg.role === "toolResult") {
		const card = toolBlocksById.get(msg.toolCallId);
		if (card) {
			card.appendChild(resultNode(msg));
			const timing = toolTimingById.get(msg.toolCallId);
			applyToolState(card, { ms: timing && timing.ms, isError: Boolean(msg.isError) });
			return null;
		}
		const node = el("div", "msg assistant");
		node.appendChild(el("div", "avatar", "T"));
		const body = el("div", "body");
		const details = detailsBlock(`工具结果: ${msg.toolName || ""}`, [resultNode(msg)], false, "tool");
		body.appendChild(details);
		node.appendChild(body);
		return node;
	}
	const node = el("div", "msg assistant");
	node.appendChild(el("div", "avatar", "·"));
	const body = el("div", "body");
	const bubble = el("div", "bubble");
	bubble.appendChild(el("div", "meta", msg.role || "消息"));
	bubble.appendChild(el("div", undefined, messageTextContent(msg.content)));
	body.appendChild(bubble);
	node.appendChild(body);
	return node;
}

function appendMessage(msg) {
	const node = messageNode(msg);
	if (!node) return;
	const chat = $("chat");
	const stuckToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
	hideEmptyState();
	messagesEl.appendChild(node);
	if (stuckToBottom) scrollToBottom();
}

function scrollToBottom() {
	const chat = $("chat");
	chat.scrollTop = chat.scrollHeight;
}

// ---- empty state -------------------------------------------------------------

function renderEmptyState() {
	const box = el("div", "empty-state");
	box.id = "empty-state";
	box.appendChild(el("h2", undefined, "开始使用 Pi Agent"));
	const list = el("ol");
	const configured = hasUsableModel();
	const step1 = el("li", configured ? "done" : undefined, configured ? "已配置可用模型" : "尚未配置可用模型，请在「模型设置」中添加 Provider");
	const step2 = el("li", undefined, "在顶部选择模型和思考级别");
	const step3 = el("li", undefined, "在下方输入消息开始对话");
	list.append(step1, step2, step3);
	box.appendChild(list);
	if (!configured) {
		const btn = el("button", "primary", "打开模型设置");
		btn.type = "button";
		btn.addEventListener("click", openSettings);
		box.appendChild(btn);
	}
	messagesEl.appendChild(box);
}

function hideEmptyState() {
	const box = $("empty-state");
	if (box) box.remove();
}

function maybeShowEmptyState() {
	if (!messagesEl.querySelector(".msg")) {
		hideEmptyState();
		renderEmptyState();
	}
}

// ---- alert bar ---------------------------------------------------------------

let alertDismissed = false;

function updateAlert() {
	const bar = $("alert-bar");
	if (modelsPayload && modelsPayload.error) {
		bar.hidden = false;
		bar.className = "error";
		$("alert-text").textContent = `模型配置错误：${modelsPayload.error}`;
		$("alert-action").hidden = false;
		return;
	}
	if (!hasUsableModel()) {
		if (alertDismissed) {
			bar.hidden = true;
			return;
		}
		bar.hidden = false;
		bar.className = "";
		$("alert-text").textContent = "当前没有可用模型，无法开始对话。请先配置 Provider 并在顶部选择模型。";
		$("alert-action").hidden = false;
		return;
	}
	bar.hidden = true;
}

$("alert-action").addEventListener("click", openSettings);
$("alert-close").addEventListener("click", () => {
	alertDismissed = true;
	updateAlert();
});

// ---- state + models ----------------------------------------------------------

function updateUsage() {
	const box = $("usage");
	if (!currentContextWindow) {
		box.hidden = true;
		return;
	}
	box.hidden = false;
	box.innerHTML = "";
	box.appendChild(el("span", undefined, `上下文 ${fmtTokens(lastContextTokens)} / ${fmtTokens(currentContextWindow)}`));
	const meter = el("span", "meter");
	const fill = el("i");
	fill.style.width = `${Math.min(100, (lastContextTokens / currentContextWindow) * 100).toFixed(1)}%`;
	meter.appendChild(fill);
	box.appendChild(meter);
}

function applyState(state) {
	setBusy(state.isStreaming);
	currentModelKey = modelKey(state.model);
	currentSessionId = state.sessionId || null;
	currentSessionFile = state.sessionFile || null;
	currentSessionName = state.sessionName || null;
	syncSessionUrl(screenSessionHandle());
	renderSessionList();
	currentContextWindow = state.model && state.model.id !== "unknown" ? state.model.contextWindow || 0 : 0;
	populateThinkingSelect(state.availableThinkingLevels || [], state.thinkingLevel);
	renderTranscript(state.messages || []);
	if (modelsPayload) populateModelSelect();
	updateAlert();
	updateComposer();
	updateUsage();
}

function renderTranscript(messages) {
	const chat = $("chat");
	const wasAtBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
	const previousScrollTop = chat.scrollTop;
	messagesEl.innerHTML = "";
	toolBlocksById.clear();
	lastContextTokens = 0;
	for (const msg of messages) {
		if (msg.role === "system") continue;
		if (msg.role === "assistant" && msg.usage) {
			lastContextTokens = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
		}
		const node = messageNode(msg);
		if (node) messagesEl.appendChild(node);
	}
	maybeShowEmptyState();
	// A full re-render must not throw away where the user was reading.
	chat.scrollTop = wasAtBottom ? chat.scrollHeight : previousScrollTop;
}

async function refreshState() {
	const state = await api("/api/state");
	applyState(state);
}

async function loadModels() {
	try {
		modelsPayload = await api("/api/models");
	} catch (error) {
		toast(`加载模型失败: ${error.message}`, true);
		return;
	}
	populateModelSelect();
	updateAlert();
	updateComposer();
	maybeShowEmptyState();
}

function updateComposer() {
	const usable = hasUsableModel();
	$("input").disabled = !usable;
	$("send-btn").disabled = !usable || busy;
	$("composer-box").classList.toggle("disabled", !usable);
	$("composer-hint").textContent = usable ? "" : "需先配置并选择模型";
}

// ---- streaming events --------------------------------------------------------

let liveNode = null;
let liveMessage = null;

function ensureLiveBubble() {
	if (liveNode) return;
	hideEmptyState();
	liveNode = el("div", "msg assistant");
	liveNode.appendChild(el("div", "avatar", "AI"));
	const body = el("div", "body");
	const meta = el("div", "meta");
	meta.appendChild(el("span", "who", "助手"));
	meta.appendChild(el("span", undefined, "生成中…"));
	body.appendChild(meta);
	const bubble = el("div", "bubble");
	bubble._body = el("div", "markdown cursor");
	bubble.appendChild(bubble._body);
	body.appendChild(bubble);
	liveNode.appendChild(body);
	messagesEl.appendChild(liveNode);
	scrollToBottom();
}

function rebuildLiveBody() {
	if (!liveNode || !liveMessage) return;
	const body = liveNode.querySelector(".cursor");
	const frag = assistantBody({ content: liveMessage.content });
	body.innerHTML = "";
	// Move, never iterate a live collection while appending: children shift index as they move.
	while (frag.firstChild) body.appendChild(frag.firstChild);
	scheduleScroll();
}

let scrollQueued = false;

/** Streaming redraws on every delta; scroll at most once per frame. */
function scheduleScroll() {
	if (scrollQueued) return;
	scrollQueued = true;
	requestAnimationFrame(() => {
		scrollQueued = false;
		scrollToBottom();
	});
}

function handleEvent(event) {
	switch (event.type) {
		case "hello":
			currentModelKey = modelKey(event.state.model);
			currentSessionId = event.state.sessionId || currentSessionId;
			currentSessionFile = event.state.sessionFile || currentSessionFile;
			syncSessionUrl(screenSessionHandle());
			populateThinkingSelect(event.state.availableThinkingLevels || [], event.state.thinkingLevel);
			updateAlert();
			// A (re)connect means a possibly restarted server whose revisions start over, so forget
			// the old one and pull a fresh task list if the dialog is open.
			tasksRevision = -1;
			if (!tasksModal.hidden) loadTasks();
			break;
		case "session_replaced":
			liveNode = null;
			liveMessage = null;
			applyState(event.state);
			loadModels();
			loadSessions();
			break;
		case "tasks_changed":
			// The server pushes this on every task edit and on every run start/finish.
			applyTasks(event);
			break;
		case "message_start":
			if (event.message.role === "assistant") {
				ensureLiveBubble();
				liveMessage = { content: [] };
			}
			break;
		case "message_update": {
			const e = event.assistantMessageEvent;
			if (!liveMessage) {
				ensureLiveBubble();
				liveMessage = { content: [] };
			}
			if (e.type === "text_start" || e.type === "thinking_start" || e.type === "toolcall_start") {
				const content = liveMessage.content;
				while (content.length <= e.contentIndex) {
					content.push(
						e.type === "thinking_start"
							? { type: "thinking", thinking: "" }
							: e.type === "toolcall_start"
								? { type: "toolCall", id: e.id, name: e.toolName, partialArguments: "" }
								: { type: "text", text: "" },
					);
				}
			} else if (e.type === "text_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "text") part.text += e.delta;
			} else if (e.type === "thinking_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "thinking") part.thinking += e.delta;
			} else if (e.type === "toolcall_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "toolCall") part.partialArguments = (part.partialArguments || "") + e.delta;
			}
			rebuildLiveBody();
			break;
		}
		case "tool_execution_end": {
			toolTimingById.set(event.toolCallId, { ms: event.durationMs, isError: event.isError });
			const card = toolBlocksById.get(event.toolCallId);
			if (card) applyToolState(card, { ms: event.durationMs, isError: event.isError });
			break;
		}
		case "message_end": {
			const msg = event.message;
			if (msg.role === "assistant" && liveNode) {
				const done = messageNode(msg);
				liveNode.replaceWith(done);
				liveNode = null;
				liveMessage = null;
				if (msg.usage) lastContextTokens = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
				updateUsage();
			} else {
				appendMessage(msg);
			}
			scrollToBottom();
			break;
		}
		case "agent_start":
			setBusy(true);
			break;
		case "agent_settled":
			setBusy(false);
			maybeTrackNewSession();
			refreshState().catch(() => toast("状态刷新失败", true));
			break;
		case "thinking_level_changed":
			populateThinkingSelect($("thinking-select")._levels || [], event.level);
			break;
		case "auto_retry_start":
			$("status-line").textContent = `请求失败，第 ${event.attempt}/${event.maxAttempts} 次重试（${Math.round(event.delayMs / 1000)}s 后）：${event.errorMessage}`;
			break;
		case "auto_retry_end":
			if (!event.success) reportError(`重试最终失败: ${event.finalError || "未知错误"}`);
			break;
		case "compaction_start":
			$("status-line").textContent = "正在压缩上下文…";
			break;
		case "compaction_end":
			$("status-line").textContent = event.aborted ? "上下文压缩已中止" : "上下文压缩完成";
			break;
		case "web_error":
			reportError(event.message);
			break;
		case "extension_error":
			reportError(`扩展错误 (${event.extensionPath}): ${event.error}`);
			break;
		default:
			break;
	}
}

/** Errors need to outlive a toast: the transcript keeps a red card. */
function reportError(message) {
	toast(message, true);
	const node = el("div", "msg error");
	node.appendChild(el("div", "avatar", "!"));
	const body = el("div", "body");
	const bubble = el("div", "bubble");
	bubble.appendChild(el("div", "meta", "错误"));
	bubble.appendChild(el("div", undefined, message));
	body.appendChild(bubble);
	node.appendChild(body);
	hideEmptyState();
	messagesEl.appendChild(node);
	scrollToBottom();
	if (message.includes("No API key") || message.includes("available model")) loadModels();
}

function connectEvents() {
	const dot = $("conn-dot");
	const source = new EventSource(withBase("/api/events"));
	source.onopen = () => {
		dot.className = "dot on";
		dot.title = "已连接";
	};
	source.onerror = () => {
		dot.className = "dot off";
		dot.title = "连接断开，自动重连中…";
	};
	source.onmessage = (msg) => {
		let event;
		try {
			event = JSON.parse(msg.data);
		} catch (_e) {
			return;
		}
		handleEvent(event);
	};
}

// ---- pickers -----------------------------------------------------------------

let modelsPayload = null;

function populateModelSelect() {
	const select = $("model-select");
	select.innerHTML = "";
	if (!modelsPayload) return;
	const available = new Set(modelsPayload.available);
	const byProvider = new Map();
	for (const model of modelsPayload.models) {
		if (!available.has(`${model.provider}/${model.id}`)) continue;
		if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
		byProvider.get(model.provider).push(model);
	}
	if (byProvider.size === 0) {
		const option = document.createElement("option");
		option.textContent = "无可用模型";
		option.value = "";
		select.appendChild(option);
		select.disabled = true;
		return;
	}
	select.disabled = false;
	for (const [provider, models] of byProvider) {
		const group = document.createElement("optgroup");
		group.label = provider;
		for (const model of models) {
			const option = document.createElement("option");
			option.value = `${model.provider}/${model.id}`;
			option.textContent = model.name || model.id;
			group.appendChild(option);
		}
		select.appendChild(group);
	}
	if (currentModelKey) select.value = currentModelKey;
	if (select.value !== currentModelKey) select.selectedIndex = -1;
}

function populateThinkingSelect(levels, current) {
	const select = $("thinking-select");
	select._levels = levels;
	select.innerHTML = "";
	for (const level of levels) {
		const option = document.createElement("option");
		option.value = level;
		option.textContent = level;
		select.appendChild(option);
	}
	if (current) select.value = current;
}

$("model-select").addEventListener("change", async () => {
	const value = $("model-select").value;
	if (!value.includes("/")) return;
	const [provider, ...rest] = value.split("/");
	try {
		await apiPost("/api/model", { provider, modelId: rest.join("/") });
		currentModelKey = value;
		await loadModels();
		await refreshState();
		toast(`已切换模型: ${value}`);
	} catch (error) {
		toast(error.message, true);
		populateModelSelect();
	}
});

$("thinking-select").addEventListener("change", async () => {
	try {
		await apiPost("/api/thinking", { level: $("thinking-select").value });
	} catch (error) {
		toast(error.message, true);
	}
});

$("new-session-btn").addEventListener("click", async () => {
	if (!confirm("确定新建会话？当前会话将保存到会话目录。")) return;
	try {
		await apiPost("/api/session/new", {});
	} catch (error) {
		toast(error.message, true);
	}
});

$("stop-btn").addEventListener("click", () => {
	apiPost("/api/abort", {}).catch((error) => toast(error.message, true));
});

// ---- composer ----------------------------------------------------------------

function autogrow() {
	const input = $("input");
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}

async function sendMessage() {
	const input = $("input");
	const text = input.value.trim();
	if (!text) return;
	if (!hasUsableModel()) {
		toast("请先配置模型并在顶部选择", true);
		openSettings();
		return;
	}
	input.value = "";
	autogrow();
	try {
		const result = await apiPost("/api/prompt", { text });
		if (result.disposition === "queued") toast("已排队（steer）");
	} catch (error) {
		toast(error.message, true);
		input.value = text;
		autogrow();
		if (error.message.includes("可用模型")) openSettings();
	}
}

$("send-btn").addEventListener("click", sendMessage);
$("input").addEventListener("input", autogrow);
$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
});

// ---- session sidebar --------------------------------------------------------

let sessionsPayload = null; // { sessions, sessionDir, currentSessionId }
let sessionsError = "";
let currentSessionId = null; // session on screen, from the latest state
let currentSessionFile = null; // its file, null while the session is not persisted yet
let currentSessionName = null;
let urlSessionId = new URLSearchParams(window.location.search).get("session"); // session in the address bar
let pendingUrlPush = false; // the next session change gets its own history entry

/**
 * Only a saved session has a URL: an unsaved one (no message yet, or `--no-session`) cannot be
 * resumed, so putting its id in the address bar would create a dead bookmark and a dead history
 * entry.
 */
function screenSessionHandle() {
	return currentSessionFile ? currentSessionId : null;
}

/**
 * Mirror the open session in the address bar (`/fly_pi/?session=<id>`), so a session can be
 * bookmarked, reloaded, and reached with the back/forward buttons. The session goes in the query
 * string and not in a path segment because the page's assets are relative URLs. `pendingUrlPush`
 * marks the change as a user navigation, so it gets a history entry instead of replacing the
 * current one.
 */
function syncSessionUrl(sessionId) {
	const push = pendingUrlPush;
	pendingUrlPush = false;
	if (sessionId === urlSessionId) return;
	urlSessionId = sessionId;
	const query = sessionId ? `session=${encodeURIComponent(sessionId)}` : "";
	history[push ? "pushState" : "replaceState"](null, "", `${UI_BASE}/${query ? `?${query}` : ""}`);
}

function relTime(iso) {
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return "";
	const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
	if (minutes < 1) return "刚刚";
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	const days = Math.round(hours / 24);
	if (days < 31) return `${days} 天前`;
	return new Date(time).toLocaleDateString("zh-CN");
}

function sessionTitle(sessionEntry) {
	if (sessionEntry.name) return sessionEntry.name;
	const first = (sessionEntry.firstMessage || "").replace(/\s+/g, " ").trim();
	return first || "(空会话)";
}

function sessionRow(sessionEntry, active, clickable) {
	const row = el(clickable ? "button" : "div", `session-row${active ? " active" : ""}`);
	if (clickable) row.type = "button";
	row.appendChild(el("span", "title", sessionTitle(sessionEntry)));
	const sub = [];
	if (sessionEntry.sub) sub.push(sessionEntry.sub);
	else {
		if (sessionEntry.modified) sub.push(relTime(sessionEntry.modified));
		sub.push(`${sessionEntry.messageCount || 0} 条消息`);
	}
	row.appendChild(el("span", "sub", sub.join(" · ")));
	row.title = sessionTitle(sessionEntry);
	if (clickable) row.addEventListener("click", () => resumeSession(sessionEntry.id, true));
	return row;
}

function renderSessionList() {
	const list = $("session-list");
	list.innerHTML = "";
	if (!sessionsPayload) {
		list.appendChild(el("div", "session-list-hint", sessionsError || "加载中…"));
		return;
	}
	const { sessions, sessionDir, currentSessionId: listedCurrent } = sessionsPayload;
	if (!sessionDir) {
		list.appendChild(el("div", "session-list-hint", "当前会话未持久化，没有可恢复的历史会话。"));
		return;
	}
	const activeId = listedCurrent || currentSessionId;
	if (!activeId || !sessions.some((sessionEntry) => sessionEntry.id === activeId)) {
		// A new session only gets its file on the first message: keep it pinned at the top.
		list.appendChild(sessionRow({ name: currentSessionName || "当前会话", sub: "进行中" }, true, false));
	}
	for (const sessionEntry of sessions) {
		list.appendChild(sessionRow(sessionEntry, sessionEntry.id === activeId, sessionEntry.id !== activeId));
	}
	if (sessions.length === 0) list.appendChild(el("div", "session-list-hint", "该目录还没有已保存的会话。"));
}

async function loadSessions() {
	try {
		sessionsPayload = await api("/api/sessions");
		sessionsError = "";
	} catch (error) {
		sessionsPayload = null;
		sessionsError = `会话列表加载失败：${error.message}`;
	}
	renderSessionList();
}

/**
 * Switch to a session by id. `push` adds a history entry (user click); a switch triggered by the
 * back/forward buttons or by loading a session URL only replaces the address bar.
 */
async function resumeSession(sessionId, push) {
	if (!sessionId || sessionId === currentSessionId) return;
	if (busy && !confirm("当前回合正在进行，切换会话会中止它。继续？")) {
		syncSessionUrl(screenSessionHandle()); // undo a back/forward navigation the user did not confirm
		return;
	}
	pendingUrlPush = push === true;
	try {
		const result = await apiPost("/api/session/resume", { sessionId });
		if (result.cancelled) {
			toast("切换会话被扩展取消", true);
		} else {
			currentSessionId = sessionId;
			currentSessionFile = result.sessionFile || currentSessionFile;
		}
	} catch (error) {
		toast(error.message, true);
	}
	// The `session_replaced` event usually updates the address bar first; this also covers a switch
	// that failed, putting the session that is really on screen back into the URL.
	syncSessionUrl(screenSessionHandle());
}

// A new or renamed session is only on disk after its first turn: pull the list once when the
// current session is still missing from it, instead of rescanning the directory every turn.
function maybeTrackNewSession() {
	if (!sessionsPayload || !sessionsPayload.sessionDir) return;
	if (currentSessionId && sessionsPayload.sessions.some((sessionEntry) => sessionEntry.id === currentSessionId)) return;
	loadSessions();
}

$("refresh-sessions-btn").addEventListener("click", loadSessions);
$("sidebar-toggle").addEventListener("click", () => {
	const hidden = $("app").classList.toggle("sidebar-hidden");
	localStorage.setItem("pi-web-sidebar-hidden", hidden ? "1" : "");
});
if (localStorage.getItem("pi-web-sidebar-hidden")) $("app").classList.add("sidebar-hidden");

// Back/forward: the address bar already changed, so follow it with the matching session.
window.addEventListener("popstate", () => {
	urlSessionId = new URLSearchParams(window.location.search).get("session");
	if (!urlSessionId) {
		// A bare URL means the session it came from was never saved and cannot be restored, so put
		// the session that is on screen back into the address bar instead of pointing at nothing.
		syncSessionUrl(screenSessionHandle());
		return;
	}
	resumeSession(urlSessionId, false);
});

// ---- scheduled tasks ---------------------------------------------------------
// The schedule runs in the server process, so this dialog is only a view over
// GET/POST/PUT/DELETE <base>/api/tasks. It refreshes on the `tasks_changed` SSE event,
// which the server broadcasts whenever a task is edited or a run starts/finishes.

const tasksModal = $("tasks-modal");
let tasksPayload = null; // { tasks: [...], sessionDir }
let tasksRevision = -1; // scheduler snapshot revision, used to drop stale payloads
let editingTaskId = null; // null while creating a new task
const seenFinishedRuns = new Set(); // run ids already pulled into the chat sidebar

/**
 * Apply a task snapshot (from GET, from an action response, or from the tasks_changed event).
 * The server stamps every snapshot with a growing revision: the run started by 「立即执行一次」
 * often finishes while that POST is still in flight, so its (older) body must not overwrite the
 * newer event the page already rendered.
 */
function applyTasks(snapshot) {
	if (!snapshot) return;
	const revision = Number(snapshot.revision);
	if (Number.isFinite(revision)) {
		if (revision <= tasksRevision) return;
		tasksRevision = revision;
	}
	tasksPayload = {
		tasks: snapshot.tasks || [],
		sessionDir: snapshot.sessionDir === undefined ? tasksPayload && tasksPayload.sessionDir : snapshot.sessionDir,
	};
	renderTasks();
	// A finished run with a transcript is a new session on disk: refresh the sidebar once.
	let addedTranscript = false;
	for (const task of tasksPayload.tasks) {
		for (const run of task.runs || []) {
			if (!run.hasTranscript || seenFinishedRuns.has(`${task.id}/${run.id}`)) continue;
			seenFinishedRuns.add(`${task.id}/${run.id}`);
			addedTranscript = true;
		}
	}
	if (addedTranscript) loadSessions();
}

async function loadTasks() {
	try {
		applyTasks(await api("/api/tasks"));
	} catch (error) {
		showTaskFormError(`定时任务加载失败：${error.message}`);
	}
}

function taskById(id) {
	if (!tasksPayload) return null;
	return tasksPayload.tasks.find((task) => task.id === id) || null;
}

/** "HH:MM" for a daily schedule, "MM" for an hourly one, in the shape the form edits. */
function taskScheduleParts(task) {
	const schedule = task.schedule || { type: "daily", hour: 9, minute: 0 };
	const pad = (n) => String(n).padStart(2, "0");
	if (schedule.type === "hourly") return { type: "hourly", time: "", minute: String(schedule.minute) };
	return { type: "daily", time: `${pad(schedule.hour)}:${pad(schedule.minute)}`, minute: "" };
}

/** "今天 09:30" / "明天 09:30" / "11月3日 09:30". */
function fmtWhen(timestampMs) {
	if (!Number.isFinite(timestampMs)) return "";
	const date = new Date(timestampMs);
	const pad = (n) => String(n).padStart(2, "0");
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const today = new Date();
	const tomorrow = new Date(Date.now() + 86400000);
	if (date.toDateString() === today.toDateString()) return `今天 ${clock}`;
	if (date.toDateString() === tomorrow.toDateString()) return `明天 ${clock}`;
	return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

function fmtDuration(ms) {
	if (!Number.isFinite(ms)) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
}

function runStatusText(run) {
	if (run.status === "running") return "执行中…";
	return run.status === "ok" ? "成功" : "失败";
}

function taskRow(task) {
	const row = el("div", `task-row${editingTaskId === task.id ? " active" : ""}${task.enabled ? "" : " off"}`);
	row.appendChild(el("span", "name", task.name));
	const badge = el("span", `badge${task.enabled ? " ok" : ""}`, task.isActive ? "执行中" : task.enabled ? "已启用" : "已停用");
	row.appendChild(badge);
	const sub = [];
	if (task.schedule.type === "hourly") sub.push(`每小时第 ${String(task.schedule.minute).padStart(2, "0")} 分`);
	else sub.push(`每天 ${String(task.schedule.hour).padStart(2, "0")}:${String(task.schedule.minute).padStart(2, "0")}`);
	if (task.enabled && task.nextRunAt) sub.push(`下次 ${fmtWhen(task.nextRunAt)}`);
	sub.push(`${(task.runs || []).length} 条记录`);
	if (task.model) sub.push(task.model.id);
	row.appendChild(el("span", "sub", sub.join(" · ")));
	row.addEventListener("click", () => openTaskForm(task.id));
	return row;
}

function renderTaskList() {
	const list = $("task-list");
	list.innerHTML = "";
	if (!tasksPayload) {
		list.appendChild(el("div", "pane-hint", "加载中…"));
		return;
	}
	if (tasksPayload.tasks.length === 0) {
		list.appendChild(el("div", "pane-hint", "还没有定时任务，点击「+ 新增」创建一个。"));
		return;
	}
	for (const task of tasksPayload.tasks) list.appendChild(taskRow(task));
}

function renderTaskRuns() {
	const section = $("task-runs-section");
	const box = $("task-runs");
	const task = taskById(editingTaskId);
	section.hidden = !task;
	box.innerHTML = "";
	if (!task) return;
	const runs = [...(task.runs || [])].reverse(); // newest first: records are a log
	$("task-runs-hint").textContent = `最近 ${Math.min(runs.length, 30)} 次（服务端保留最新 30 次）`;
	if (runs.length === 0) box.appendChild(el("div", "pane-hint", "还没有执行记录。可点「立即执行一次」验证任务能否跑通。"));
	for (const run of runs) box.appendChild(runRow(task, run));
}

function runRow(task, run) {
	const row = el("div", `run-row ${run.status}`);
	const head = el("div", "run-head");
	head.appendChild(el("span", `run-state ${run.status}`, runStatusText(run)));
	head.appendChild(el("span", "run-when", `${relTime(run.startedAt)} · ${new Date(run.startedAt).toLocaleString("zh-CN")}`));
	if (run.trigger === "manual") head.appendChild(el("span", "run-tag", "手动"));
	if (run.durationMs !== undefined) head.appendChild(el("span", "run-tag", fmtDuration(run.durationMs)));
	const openBtn = el("button", "run-open", "查看聊天记录");
	openBtn.type = "button";
	// Only a run whose session file reached disk can be resumed: a failed or empty run has an id
	// but nothing to open, and pointing at it would 404.
	if (!run.hasTranscript) {
		openBtn.disabled = true;
		openBtn.title = run.status === "running" ? "执行中，完成后可查看" : "本次执行没有产生会话记录";
	} else {
		openBtn.title = run.sessionName || "打开本次执行生成的聊天会话";
		openBtn.addEventListener("click", async () => {
			tasksModal.hidden = true;
			await resumeSession(run.sessionId, true);
		});
	}
	head.appendChild(openBtn);
	const delBtn = el("button", "icon run-del", "×");
	delBtn.type = "button";
	delBtn.title = "删除这条执行记录";
	delBtn.addEventListener("click", async () => {
		if (!confirm("删除这条执行记录？会话文件本身不会被删除。")) return;
		await saveTaskApi(`/api/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.id)}`, { method: "DELETE" });
	});
	head.appendChild(delBtn);
	row.appendChild(head);
	if (run.summary) row.appendChild(el("div", "run-summary", run.summary));
	if (run.error) row.appendChild(el("div", "run-error", `错误：${run.error}`));
	return row;
}

function renderTasks() {
	renderTaskList();
	renderTaskRuns();
	const note = $("tasks-note");
	if (tasksPayload && !tasksPayload.sessionDir) {
		note.textContent = "当前实例以 --no-session 启动，会话不落盘：定时任务仍会按时执行，但无法保存执行记录。";
		note.className = "hint-box warn";
		note.hidden = false;
	} else {
		note.hidden = true;
	}
}

function populateTaskModelSelect(selected) {
	const select = $("tf-model");
	select.innerHTML = "";
	const follow = document.createElement("option");
	follow.value = "";
	follow.textContent = "跟随界面当前模型";
	select.appendChild(follow);
	if (!modelsPayload) return;
	const available = new Set(modelsPayload.available);
	for (const model of modelsPayload.models) {
		if (!available.has(`${model.provider}/${model.id}`)) continue;
		const option = document.createElement("option");
		option.value = `${model.provider}/${model.id}`;
		option.textContent = `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ""}`;
		select.appendChild(option);
	}
	select.value = selected || "";
	if (select.value !== (selected || "")) select.selectedIndex = 0;
}

function showTaskFormError(message) {
	const box = $("task-form-error");
	if (!message) {
		box.hidden = true;
		return;
	}
	box.textContent = message;
	box.hidden = false;
}

function syncScheduleFields() {
	const hourly = $("tf-schedule").value === "hourly";
	$("tf-time-field").hidden = hourly;
	$("tf-minute-field").hidden = !hourly;
}

async function saveTaskApi(path, options) {
	try {
		const payload = await api(path, { ...options, headers: { "Content-Type": "application/json" } });
		applyTasks(payload);
		return payload;
	} catch (error) {
		showTaskFormError(error.message);
		toast(error.message, true);
		return null;
	}
}

function openTaskForm(taskId) {
	editingTaskId = taskId;
	showTaskFormError("");
	const form = $("task-form");
	form.hidden = false;
	$("task-form-empty").hidden = true;
	const task = taskId ? taskById(taskId) : null;
	$("task-form-title").textContent = task ? `编辑任务：${task.name}` : "新增定时任务";
	$("tf-name").value = task ? task.name : "";
	$("tf-prompt").value = task ? task.prompt : "";
	const parts = task ? taskScheduleParts(task) : { type: "daily", time: "09:00", minute: "0" };
	$("tf-schedule").value = parts.type;
	$("tf-time").value = parts.time || "09:00";
	$("tf-minute").value = parts.minute || "0";
	syncScheduleFields();
	populateTaskModelSelect(task && task.model ? `${task.model.provider}/${task.model.id}` : "");
	$("delete-task-btn").hidden = !task;
	$("toggle-task-btn").hidden = !task;
	$("run-task-btn").hidden = !task;
	$("abort-task-btn").hidden = !task || !task.isActive;
	if (task) $("toggle-task-btn").textContent = task.enabled ? "停用" : "启用";
	renderTaskList();
	renderTaskRuns();
}

function closeTaskForm() {
	editingTaskId = null;
	$("task-form").hidden = true;
	$("task-runs-section").hidden = true;
	$("task-form-empty").hidden = false;
	showTaskFormError("");
	renderTaskList();
}

$("tasks-btn").addEventListener("click", () => {
	tasksModal.hidden = false;
	closeTaskForm();
	renderTasks();
	loadTasks();
});
$("tasks-close").addEventListener("click", () => {
	tasksModal.hidden = true;
});
tasksModal.addEventListener("click", (event) => {
	if (event.target === tasksModal) tasksModal.hidden = true;
});
$("add-task-btn").addEventListener("click", () => openTaskForm(null));
$("cancel-task-btn").addEventListener("click", closeTaskForm);
$("tf-schedule").addEventListener("change", syncScheduleFields);

$("task-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	showTaskFormError("");
	const type = $("tf-schedule").value;
	const schedule = type === "hourly" ? { type, minute: Number($("tf-minute").value) } : { type, time: $("tf-time").value };
	const body = {
		name: $("tf-name").value.trim(),
		prompt: $("tf-prompt").value.trim(),
		schedule,
		model: $("tf-model").value,
	};
	if (!body.name) delete body.name; // server names it after the schedule
	const path = editingTaskId ? `/api/tasks/${encodeURIComponent(editingTaskId)}` : "/api/tasks";
	const payload = await saveTaskApi(path, { method: editingTaskId ? "PUT" : "POST", body: JSON.stringify(body) });
	if (!payload) return;
	toast(editingTaskId ? "已保存定时任务" : "已创建定时任务");
	closeTaskForm();
});

$("toggle-task-btn").addEventListener("click", async () => {
	const task = taskById(editingTaskId);
	if (!task) return;
	const payload = await saveTaskApi(`/api/tasks/${encodeURIComponent(task.id)}`, {
		method: "PUT",
		body: JSON.stringify({ enabled: !task.enabled }),
	});
	if (!payload) return;
	const updated = taskById(editingTaskId);
	if (updated) $("toggle-task-btn").textContent = updated.enabled ? "停用" : "启用";
	toast(updated && updated.enabled ? `已启用定时任务：${updated.name}` : `已停用定时任务：${updated ? updated.name : task.name}`);
});

$("run-task-btn").addEventListener("click", async () => {
	const task = taskById(editingTaskId);
	if (!task) return;
	const button = $("run-task-btn");
	button.disabled = true;
	const payload = await saveTaskApi(`/api/tasks/${encodeURIComponent(task.id)}/run`, { method: "POST", body: "{}" });
	button.disabled = false;
	if (payload) toast("已开始执行，可在执行记录中查看进度");
});

$("abort-task-btn").addEventListener("click", async () => {
	const task = taskById(editingTaskId);
	if (!task) return;
	await saveTaskApi(`/api/tasks/${encodeURIComponent(task.id)}/abort`, { method: "POST", body: "{}" });
});

$("delete-task-btn").addEventListener("click", async () => {
	const task = taskById(editingTaskId);
	if (!task || !confirm(`删除定时任务「${task.name}」？执行记录会一起删除。`)) return;
	const payload = await saveTaskApi(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
	if (payload) {
		closeTaskForm();
		toast("已删除定时任务");
	}
});

// ---- appearance: theme + tab icon -------------------------------------------------

const THEME_STORAGE_KEY = "pi-web-theme";
/** Square PNG the browser renders: one size is enough for a tab icon. */
const ICON_SIZE = 128;

// ids must match the `data-theme` blocks in style.css; swatches are the preview chips only.
const THEMES = [
	{ id: "dark-slate", name: "石墨深蓝", kind: "深色", swatches: ["#0e1116", "#1b222b", "#5b9dff", "#46c98b"] },
	{ id: "dark-midnight", name: "午夜黑", kind: "深色", swatches: ["#06080b", "#12181f", "#2dd4bf", "#34d399"] },
	{ id: "dark-plum", name: "紫檀", kind: "深色", swatches: ["#17111c", "#261d31", "#c084fc", "#f472b6"] },
	{ id: "light-paper", name: "米纸", kind: "浅色", swatches: ["#f6f3ee", "#f0ebe3", "#b45309", "#15803d"] },
	{ id: "light-sky", name: "晴空", kind: "浅色", swatches: ["#f3f6fb", "#e9eef7", "#2563eb", "#059669"] },
	{ id: "light-mint", name: "薄荷", kind: "浅色", swatches: ["#f2f7f4", "#e6efe9", "#0d9488", "#16a34a"] },
];

function savedTheme() {
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	return THEMES.some((theme) => theme.id === stored) ? stored : THEMES[0].id;
}

function applyTheme(id) {
	document.documentElement.setAttribute("data-theme", id);
	localStorage.setItem(THEME_STORAGE_KEY, id);
	for (const card of $("theme-grid").children) card.classList.toggle("active", card.dataset.theme === id);
}

function renderThemeGrid() {
	const grid = $("theme-grid");
	grid.innerHTML = "";
	for (const theme of THEMES) {
		const card = el("button", "theme-card");
		card.type = "button";
		card.dataset.theme = theme.id;
		const swatches = el("div", "swatches");
		for (const color of theme.swatches) {
			const chip = el("i");
			chip.style.background = color;
			swatches.appendChild(chip);
		}
		card.appendChild(swatches);
		const row = el("div", "row");
		row.appendChild(el("span", "t-name", theme.name));
		row.appendChild(el("span", "t-kind", theme.kind));
		card.appendChild(row);
		card.title = `切换到主题：${theme.name}`;
		card.addEventListener("click", () => {
			applyTheme(theme.id);
			toast(`已切换主题：${theme.name}`);
		});
		grid.appendChild(card);
	}
}

/**
 * Icon URL, cache-busted after a change: browsers cache favicons aggressively, so a plain
 * reload of the same URL can keep showing the old icon.
 */
let iconCacheBust = 0;

function iconUrl() {
	const url = withBase("/icon");
	return iconCacheBust ? `${url}?v=${iconCacheBust}` : url;
}

function refreshIconPreview() {
	$("icon-preview").src = iconUrl();
	$("favicon-link").href = iconUrl();
}

async function loadUiSettings() {
	try {
		const settings = await api("/api/ui-settings");
		const icon = settings.icon || {};
		$("icon-state").textContent = icon.set ? `已保存自定义图标（${Math.round((icon.bytes || 0) / 1024)} KB）` : "当前使用内置图标";
		$("icon-reset-btn").disabled = !icon.set;
	} catch (error) {
		$("icon-state").textContent = `图标状态读取失败：${error.message}`;
	}
}

function showIconHint(message, kind) {
	const hint = $("icon-hint");
	if (!message) {
		hint.hidden = true;
		return;
	}
	hint.textContent = message;
	hint.className = `hint-box appearance-note ${kind}`;
	hint.hidden = false;
}

/**
 * Draw the picked image onto a square canvas and return a PNG data URL. Rasterizing here keeps
 * the server out of image decoding (it only ever stores a small PNG) and normalises ICO/SVG input.
 */
function rasterizeIcon(file) {
	return new Promise((resolve, reject) => {
		const objectUrl = URL.createObjectURL(file);
		const image = new Image();
		const done = (error, dataUrl) => {
			URL.revokeObjectURL(objectUrl);
			if (error) reject(error);
			else resolve(dataUrl);
		};
		image.onload = () => {
			// A sizeless SVG reports 0; treat it as already square so the draw does not vanish.
			const sourceW = image.naturalWidth || ICON_SIZE;
			const sourceH = image.naturalHeight || ICON_SIZE;
			const canvas = document.createElement("canvas");
			canvas.width = ICON_SIZE;
			canvas.height = ICON_SIZE;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				done(new Error("当前浏览器不支持 canvas"));
				return;
			}
			const scale = Math.min(ICON_SIZE / sourceW, ICON_SIZE / sourceH);
			const w = sourceW * scale;
			const h = sourceH * scale;
			ctx.drawImage(image, (ICON_SIZE - w) / 2, (ICON_SIZE - h) / 2, w, h);
			done(undefined, canvas.toDataURL("image/png"));
		};
		image.onerror = () => done(new Error(`无法解码图片：${file.name}`));
		image.src = objectUrl;
	});
}

async function uploadIcon(file) {
	const button = $("icon-pick-btn");
	button.disabled = true;
	showIconHint("正在处理图片…", "");
	try {
		const dataUrl = await rasterizeIcon(file);
		const result = await api("/api/ui-settings/icon", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ dataUrl }),
		});
		iconCacheBust = Date.now();
		refreshIconPreview();
		await loadUiSettings();
		showIconHint(`已保存图标（${result.icon.set ? Math.round((result.icon.bytes || 0) / 1024) : 0} KB）。标签页若未立即更新，刷新一次即可。`, "ok");
	} catch (error) {
		showIconHint(`保存失败: ${error.message}`, "bad");
	}
	button.disabled = false;
}

const appearanceModal = $("appearance-modal");

function openAppearance() {
	appearanceModal.hidden = false;
	showIconHint("", "");
	refreshIconPreview();
	loadUiSettings();
}

$("appearance-btn").addEventListener("click", openAppearance);
$("appearance-close").addEventListener("click", () => {
	appearanceModal.hidden = true;
});
appearanceModal.addEventListener("click", (event) => {
	if (event.target === appearanceModal) appearanceModal.hidden = true;
});
$("icon-pick-btn").addEventListener("click", () => $("icon-file").click());
$("icon-file").addEventListener("change", () => {
	const file = $("icon-file").files[0];
	$("icon-file").value = ""; // allow picking the same file again
	if (file) uploadIcon(file);
});
$("icon-reset-btn").addEventListener("click", async () => {
	const button = $("icon-reset-btn");
	button.disabled = true;
	try {
		await api("/api/ui-settings/icon", { method: "DELETE" });
		iconCacheBust = Date.now();
		refreshIconPreview();
		await loadUiSettings();
		showIconHint("已恢复内置图标。", "ok");
	} catch (error) {
		showIconHint(`恢复失败: ${error.message}`, "bad");
		button.disabled = false;
	}
});

renderThemeGrid();
applyTheme(savedTheme());

// ---- settings modal -----------------------------------------------------------

const modal = $("settings-modal");
let editingProviderId = null; // null when creating a new provider

function openSettings() {
	modal.hidden = false;
	// Auth status comes from /api/models; refresh it first so the list is not stale.
	loadModels().then(loadConfig);
}

$("settings-btn").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => {
	modal.hidden = true;
});
modal.addEventListener("click", (event) => {
	if (event.target === modal) modal.hidden = true;
});
document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (!appearanceModal.hidden) appearanceModal.hidden = true;
	if (!tasksModal.hidden) tasksModal.hidden = true;
	if (!modal.hidden) modal.hidden = true;
});

async function loadConfig() {
	const errorBox = $("config-error");
	errorBox.hidden = true;
	let config;
	try {
		config = await api("/api/config");
	} catch (error) {
		showConfigError(error.message);
		return;
	}
	if (config.runtimeError) showConfigError(config.runtimeError);
	const providers = config.providers || {};
	const modelAuth = modelsPayload ? modelsPayload.providers : {};
	const authOf = (id) => (modelAuth[id] ? modelAuth[id].auth : undefined);
	const isConfigured = (id) => Boolean(providers[id]) || Boolean(authOf(id) && authOf(id).configured);
	providerIndex = [...Object.keys(providers), ...Object.keys(modelAuth)]
		.filter((id, index, all) => all.indexOf(id) === index)
		.map((id) => ({ id, entry: providers[id], auth: authOf(id) }))
		// models.json entries and authenticated providers first; the long tail of built-in
		// providers is hidden by default so the one you just configured stays findable.
		.sort((a, b) => Number(isConfigured(b.id)) - Number(isConfigured(a.id)) || a.id.localeCompare(b.id));
	renderProviderList();
}

let providerIndex = []; // { id, entry, auth }
let showAllProviders = false;

function renderProviderList() {
	const list = $("provider-list");
	list.innerHTML = "";
	const filter = $("provider-filter").value.trim().toLowerCase();
	const hidden = providerIndex.filter((item) => !item.entry && !(item.auth && item.auth.configured));
	const visible = providerIndex.filter((item) => showAllProviders || !hidden.includes(item));
	const matched = visible.filter((item) => !filter || item.id.toLowerCase().includes(filter) || (item.entry && item.entry.name ? item.entry.name.toLowerCase().includes(filter) : false));

	if (matched.length === 0) list.appendChild(el("div", "pane-hint", "无匹配 Provider"));
	for (const item of matched) {
		const { id, entry, auth } = item;
		const row = el("div", `provider-row${editingProviderId === id ? " active" : ""}`);
		row.appendChild(el("span", "name", entry && entry.name ? entry.name : id));
		row.appendChild(el("span", `badge${auth && auth.configured ? " ok" : ""}`, auth && auth.configured ? `已认证${auth.label ? ` (${auth.label})` : ""}` : "未认证"));
		const sub = [];
		if (entry && entry.baseUrl) sub.push(entry.baseUrl);
		else sub.push("内置 Provider，models.json 未覆盖");
		if (entry && entry.models) sub.push(`${entry.models.length} 个模型`);
		if (entry && entry.api) sub.push(entry.api);
		row.appendChild(el("span", "sub", sub.join(" · ")));
		row.addEventListener("click", () => openProviderForm(id, entry || {}));
		list.appendChild(row);
	}

	const toggle = $("show-all-providers");
	toggle.hidden = showAllProviders || hidden.length === 0;
	toggle.textContent = `显示全部内置 Provider (${hidden.length})`;
}

$("provider-filter").addEventListener("input", renderProviderList);
$("show-all-providers").addEventListener("click", () => {
	showAllProviders = true;
	renderProviderList();
});

function showConfigError(message) {
	const box = $("config-error");
	box.textContent = message;
	box.hidden = false;
}

function modelCard(model, preselected) {
	const card = el("div", "model-card");
	const grid = el("div", "grid");

	const mk = (labelText, value, placeholder, type) => {
		const field = el("div", "field");
		const label = el("label", undefined, labelText);
		const input = document.createElement("input");
		input.type = type || "text";
		input.placeholder = placeholder || "";
		if (value !== undefined) input.value = value;
		field.appendChild(label);
		field.appendChild(input);
		grid.appendChild(field);
		return input;
	};

	const idInput = mk("模型 ID", model.id, "例如 gpt-4o");
	const nameInput = mk("显示名称", model.name, "可选");
	const contextInput = mk("Context Window", model.contextWindow, "128000", "number");
	const maxTokensInput = mk("Max Tokens", model.maxTokens, "16384", "number");
	const costInput = mk("Cost 输入/输出/缓存读/缓存写 (每 1M)", model.cost ? [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].join(",") : "", "0,0,0,0");
	card.appendChild(grid);

	const checks = el("div", "checks");
	const includeLabel = el("label");
	const includeCheck = document.createElement("input");
	includeCheck.type = "checkbox";
	includeCheck.checked = preselected === undefined ? true : preselected;
	includeLabel.appendChild(includeCheck);
	includeLabel.appendChild(document.createTextNode(" 加入配置"));
	checks.appendChild(includeLabel);

	const reasoningLabel = el("label");
	const reasoningCheck = document.createElement("input");
	reasoningCheck.type = "checkbox";
	reasoningCheck.checked = model.reasoning === true;
	reasoningLabel.appendChild(reasoningCheck);
	reasoningLabel.appendChild(document.createTextNode(" reasoning (支持思考)"));
	checks.appendChild(reasoningLabel);

	const inputChecks = [];
	for (const modality of ["text", "image"]) {
		const label = el("label");
		const check = document.createElement("input");
		check.type = "checkbox";
		check.checked = !model.input ? modality === "text" : model.input.includes(modality);
		label.appendChild(check);
		label.appendChild(document.createTextNode(modality));
		checks.appendChild(label);
		inputChecks.push({ modality, check });
	}

	const removeBtn = el("button", "remove danger", "移除");
	removeBtn.type = "button";
	removeBtn.addEventListener("click", () => card.remove());
	checks.appendChild(removeBtn);
	card.appendChild(checks);

	card.collect = () => {
		if (!includeCheck.checked) return null;
		const entry = { id: idInput.value.trim() };
		if (!entry.id) throw new Error("模型 ID 不能为空");
		if (nameInput.value.trim()) entry.name = nameInput.value.trim();
		entry.reasoning = reasoningCheck.checked;
		entry.input = inputChecks.filter((i) => i.check.checked).map((i) => i.modality);
		if (contextInput.value) entry.contextWindow = Number(contextInput.value);
		if (maxTokensInput.value) entry.maxTokens = Number(maxTokensInput.value);
		const costParts = costInput.value.split(",").map((s) => Number(s.trim()));
		if (costParts.length === 4 && costParts.every((n) => Number.isFinite(n))) {
			entry.cost = { input: costParts[0], output: costParts[1], cacheRead: costParts[2], cacheWrite: costParts[3] };
		}
		return entry;
	};
	return card;
}

$("add-model-btn").addEventListener("click", () => {
	$("models-list").appendChild(modelCard({}));
});

function parseFormHeaders() {
	const headers = {};
	for (const line of $("f-headers").value.split("\n")) {
		const idx = line.indexOf("=");
		if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return headers;
}

function showProbeHint(message, kind) {
	const hint = $("probe-hint");
	if (!message) {
		hint.hidden = true;
		return;
	}
	hint.textContent = message;
	hint.className = `hint-box ${kind}`;
	hint.hidden = false;
}

$("test-provider-btn").addEventListener("click", async () => {
	const baseUrl = $("f-baseurl").value.trim();
	if (!baseUrl) {
		toast("请先填写 Base URL", true);
		return;
	}
	const button = $("test-provider-btn");
	button.disabled = true;
	button.textContent = "测试中…";
	showProbeHint("", "");
	try {
		const result = await apiPost("/api/probe", {
			baseUrl,
			apiKey: $("f-apikey").value.trim(),
			api: $("f-api").value,
			headers: parseFormHeaders(),
		});
		const models = result.models || [];
		if (!result.reachable) {
			$("models-list").innerHTML = "";
			showProbeHint(result.message || "服务器不可达", "bad");
			return;
		}
		if (models.length === 0) {
			showProbeHint(
				result.listSupported
					? "服务器可达，但未返回任何模型，请手动添加模型"
					: result.message || "服务器可达，但不支持模型列表接口，请手动添加模型",
				"warn",
			);
			return;
		}
		const chosen = new Set(
			[...($("models-list").children)]
				.map((card) => {
					try {
						return card.collect();
					} catch (_error) {
						return null;
					}
				})
				.filter(Boolean)
				.map((entry) => entry.id),
		);
		$("models-list").innerHTML = "";
		for (const model of models) {
			$("models-list").appendChild(modelCard({ id: model.id, name: model.name }, chosen.size > 0 ? chosen.has(model.id) : true));
		}
		showProbeHint(`连接成功，发现 ${models.length} 个模型。勾选的模型会随保存写入配置；上下文长度等参数请自行确认。`, "ok");
	} catch (error) {
		showProbeHint(`探测失败: ${error.message}`, "bad");
	}
	button.disabled = false;
	button.textContent = "测试连接并拉取模型";
});

function openProviderForm(id, entry) {
	editingProviderId = id;
	$("form-title").textContent = `编辑 Provider: ${id}`;
	$("provider-form").hidden = false;
	$("form-empty").hidden = true;
	const idInput = $("f-id");
	idInput.value = id;
	idInput.disabled = true;
	$("f-name").value = entry.name || "";
	$("f-baseurl").value = entry.baseUrl || "";
	$("f-api").value = entry.api || "openai-completions";
	$("f-apikey").value = entry.apiKey || "";
	$("f-headers").value = Object.entries(entry.headers || {}).map(([k, v]) => `${k}=${v}`).join("\n");
	const modelsList = $("models-list");
	modelsList.innerHTML = "";
	showProbeHint("", "");
	for (const model of entry.models || []) {
		modelsList.appendChild(modelCard(model));
	}
	$("form-error").hidden = true;
	$("delete-provider-btn").hidden = !entry.baseUrl && !entry.models;
	for (const row of $("provider-list").children) row.classList.remove("active");
	$("provider-form").scrollIntoView({ block: "start" });
}

function closeProviderForm() {
	$("provider-form").hidden = true;
	$("form-empty").hidden = false;
	editingProviderId = null;
	for (const row of $("provider-list").children) row.classList.remove("active");
}

$("add-provider-btn").addEventListener("click", () => {
	editingProviderId = null;
	$("form-title").textContent = "新增 Provider";
	$("provider-form").hidden = false;
	$("form-empty").hidden = true;
	const idInput = $("f-id");
	idInput.value = "";
	idInput.disabled = false;
	$("f-name").value = "";
	$("f-baseurl").value = "";
	$("f-api").value = "openai-completions";
	$("f-apikey").value = "";
	$("f-headers").value = "";
	$("models-list").innerHTML = "";
	showProbeHint("", "");
	$("form-error").hidden = true;
	$("delete-provider-btn").hidden = true;
	for (const row of $("provider-list").children) row.classList.remove("active");
});

$("cancel-provider-btn").addEventListener("click", closeProviderForm);

$("provider-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const errorBox = $("form-error");
	errorBox.hidden = true;
	const id = $("f-id").value.trim();
	if (!id) {
		errorBox.textContent = "Provider ID 不能为空";
		errorBox.hidden = false;
		return;
	}
	const config = {};
	if ($("f-name").value.trim()) config.name = $("f-name").value.trim();
	if ($("f-baseurl").value.trim()) config.baseUrl = $("f-baseurl").value.trim();
	if ($("f-api").value) config.api = $("f-api").value;
	if ($("f-apikey").value.trim()) config.apiKey = $("f-apikey").value.trim();
	const headers = parseFormHeaders();
	if (Object.keys(headers).length > 0) config.headers = headers;
	try {
		const models = [];
		for (const card of $("models-list").children) {
			const entry = card.collect();
			if (entry) models.push(entry);
		}
		if (models.length > 0) config.models = models;
	} catch (error) {
		errorBox.textContent = error.message;
		errorBox.hidden = false;
		return;
	}
	try {
		const result = await api(`/api/config/providers/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config }),
		});
		await loadModels();
		await refreshState();
		await loadConfig();
		if (result.runtimeError) {
			showConfigError(result.runtimeError);
			toast("已保存，但模型列表仍有错误", true);
		} else if (result.selectedModel) {
			toast(`已保存并自动选择模型 ${result.selectedModel.provider}/${result.selectedModel.id}`);
		} else {
			toast(`已保存 provider: ${id}`);
		}
		closeProviderForm();
		modal.hidden = true;
	} catch (error) {
		errorBox.textContent = error.message;
		errorBox.hidden = false;
	}
});

$("delete-provider-btn").addEventListener("click", async () => {
	const id = editingProviderId;
	if (!id || !confirm(`从 models.json 删除 provider ${id}？`)) return;
	try {
		await api(`/api/config/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
		toast(`已删除 provider: ${id}`);
		closeProviderForm();
		await loadModels();
		await refreshState();
		await loadConfig();
	} catch (error) {
		toast(error.message, true);
	}
});

// ---- boot ---------------------------------------------------------------------

(async function boot() {
	connectEvents();
	loadSessions();
	await loadModels();
	try {
		await refreshState();
	} catch (error) {
		toast(`加载状态失败: ${error.message}`, true);
	}
	// A session URL (?session=<id>) opens that session instead of the one the server started with.
	if (urlSessionId && urlSessionId !== currentSessionId) await resumeSession(urlSessionId, false);
	else syncSessionUrl(screenSessionHandle());
	$("input").focus();
})();
