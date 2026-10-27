"use strict";

// ---- helpers ----------------------------------------------------------------

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
			out.push("<br>");
		} else {
			closeList();
			out.push(`<div>${inline(line)}</div>`);
		}
	}
	if (inCode) out.push(`<pre><code>${codeBuf.join("\n")}</code></pre>`);
	closeList();
	return out.join("");
}

function el(tag, className, textContent) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (textContent !== undefined) node.textContent = textContent;
	return node;
}

function detailsBlock(summaryText, contentNodes, open) {
	const details = el("details", "block");
	if (open) details.open = true;
	const summary = el("summary");
	summary.textContent = summaryText;
	details.appendChild(summary);
	for (const node of contentNodes) details.appendChild(node);
	return details;
}

async function api(path, options) {
	const res = await fetch(path, options);
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
	}, 3500);
}

// ---- chat state --------------------------------------------------------------

let busy = false;
let currentModelKey = null; // "provider/id"
const messagesEl = $("messages");
const streamingByMessageRole = new Map(); // one live assistant bubble

function setBusy(value) {
	busy = value;
	$("stop-btn").disabled = !busy;
	$("status-line").textContent = busy ? "运行中…" : "";
}

function messageTextContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function renderToolCallBlock(toolCall, result) {
	const nodes = [el("pre", undefined, `参数:\n${JSON.stringify(toolCall.arguments ?? toolCall.partialArguments, null, 2)}`)];
	if (result !== undefined) {
		const resultText = messageTextContent(result.content) || JSON.stringify(result.content);
		nodes.push(el("pre", undefined, `${result.isError ? "错误输出" : "结果"}:\n${resultText}`));
	}
	return detailsBlock(`工具调用: ${toolCall.name || toolCall.toolName || "(流式)"}`, nodes);
}

function renderAssistantBody(message) {
	const frag = el("div", "markdown");
	for (const part of message.content || []) {
		if (part.type === "text") {
			const div = el("div");
			div.innerHTML = renderMarkdown(part.text);
			frag.appendChild(div);
		} else if (part.type === "thinking") {
			frag.appendChild(detailsBlock("思考过程", [el("pre", undefined, part.thinking || part.text || "")]));
		} else if (part.type === "toolCall" || part.type === "toolcall") {
			frag.appendChild(renderToolCallBlock(part));
		}
	}
	if ((message.stopReason === "error" || message.stopReason === "aborted") && message.errorMessage) {
		frag.appendChild(el("div", "msg error", `错误: ${message.errorMessage}`));
	}
	return frag;
}

function renderMessage(msg) {
	if (msg.role === "user") {
		const node = el("div", "msg user");
		node.appendChild(el("div", "role", "用户"));
		const body = el("div", "markdown");
		body.innerHTML = renderMarkdown(messageTextContent(msg.content));
		node.appendChild(body);
		return node;
	}
	if (msg.role === "assistant") {
		const node = el("div", "msg assistant");
		node.appendChild(el("div", "role", `助手 ${msg.provider ? msg.provider + "/" : ""}${msg.model || ""}`));
		node.appendChild(renderAssistantBody(msg));
		node.dataset.provider = msg.provider || "";
		node.dataset.model = msg.model || "";
		return node;
	}
	if (msg.role === "toolResult") {
		const node = el("div", "msg toolresult");
		const text = messageTextContent(msg.content);
		node.appendChild(
			detailsBlock(`工具结果: ${msg.toolName || ""}${msg.isError ? " (错误)" : ""}`, [el("pre", undefined, text)], text.length < 400),
		);
		node.dataset.toolCallId = msg.toolCallId || "";
		return node;
	}
	// Other session entry messages (branch summaries etc.): show text only.
	const node = el("div", "msg assistant");
	node.appendChild(el("div", "role", msg.role || "消息"));
	node.appendChild(el("div", undefined, messageTextContent(msg.content)));
	return node;
}

function renderTranscript(messages) {
	messagesEl.innerHTML = "";
	streamingByMessageRole.clear();
	for (const msg of messages) {
		if (msg.role === "system") continue;
		messagesEl.appendChild(renderMessage(msg));
	}
	scrollToBottom();
}

function scrollToBottom() {
	const chat = $("chat");
	chat.scrollTop = chat.scrollHeight;
}

function applyState(state) {
	setBusy(state.isStreaming);
	renderTranscript(state.messages || []);
	currentModelKey = state.model ? `${state.model.provider}/${state.model.id}` : null;
	populateThinkingSelect(state.availableThinkingLevels || [], state.thinkingLevel);
	if (modelsPayload) populateModelSelect();
}

async function refreshState() {
	const state = await api("/api/state");
	applyState(state);
}

// ---- streaming events --------------------------------------------------------

let liveAssistantEl = null;
let liveMessage = null;

function ensureLiveBubble() {
	if (liveAssistantEl) return;
	liveAssistantEl = el("div", "msg assistant");
	liveAssistantEl.appendChild(el("div", "role", "助手 (流式)"));
	liveAssistantEl._body = el("div", "markdown");
	liveAssistantEl.appendChild(liveAssistantEl._body);
	messagesEl.appendChild(liveAssistantEl);
	scrollToBottom();
}

function rebuildLiveBody() {
	if (!liveAssistantEl || !liveMessage) return;
	liveAssistantEl._body.innerHTML = "";
	for (const part of liveMessage.content) {
		if (part.type === "text") {
			const div = el("div");
			div.innerHTML = renderMarkdown(part.text);
			liveAssistantEl._body.appendChild(div);
		} else if (part.type === "thinking") {
			liveAssistantEl._body.appendChild(detailsBlock("思考过程", [el("pre", undefined, part.thinking || "")]));
		} else if (part.type === "toolCall") {
			liveAssistantEl._body.appendChild(renderToolCallBlock(part));
		}
	}
	scrollToBottom();
}

function handleEvent(event) {
	switch (event.type) {
		case "hello":
			currentModelKey = event.state.model ? `${event.state.model.provider}/${event.state.model.id}` : null;
			populateThinkingSelect(event.state.availableThinkingLevels || [], event.state.thinkingLevel);
			break;
		case "session_replaced":
			liveAssistantEl = null;
			liveMessage = null;
			applyState(event.state);
			loadModels();
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
					content.push(e.type === "thinking_start" ? { type: "thinking", thinking: "" } : e.type === "toolcall_start" ? { type: "toolCall", id: e.id, name: e.toolName, partialArguments: "" } : { type: "text", text: "" });
				}
			} else if (e.type === "text_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "text") part.text += e.delta;
			} else if (e.type === "thinking_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "thinking") part.thinking += e.delta;
			} else if (e.type === "toolcall_delta") {
				const part = liveMessage.content[e.contentIndex];
				if (part && part.type === "toolCall") {
					try {
						part.partialArguments = (part.partialArguments || "") + e.delta;
					} catch (_err) {
						/* ignore malformed streaming args */
					}
				}
			}
			rebuildLiveBody();
			break;
		}
		case "message_end":
			if (event.message.role === "assistant" && liveAssistantEl) {
				liveAssistantEl.replaceWith(renderMessage(event.message));
				liveAssistantEl = null;
				liveMessage = null;
			} else if (event.message.role !== "assistant") {
				messagesEl.appendChild(renderMessage(event.message));
			}
			scrollToBottom();
			break;
		case "agent_start":
			setBusy(true);
			break;
		case "agent_settled":
			setBusy(false);
			refreshState().catch(() => toast("状态刷新失败", true));
			break;
		case "thinking_level_changed":
			populateThinkingSelect($("thinking-select")._levels || [], event.level);
			break;
		case "auto_retry_start":
			$("status-line").textContent = `请求失败，第 ${event.attempt}/${event.maxAttempts} 次重试（${Math.round(event.delayMs / 1000)}s 后）：${event.errorMessage}`;
			break;
		case "auto_retry_end":
			if (!event.success) toast(`重试最终失败: ${event.finalError || "未知错误"}`, true);
			break;
		case "compaction_start":
			$("status-line").textContent = "正在压缩上下文…";
			break;
		case "compaction_end":
			$("status-line").textContent = event.aborted ? "上下文压缩已中止" : "上下文压缩完成";
			break;
		case "web_error":
			toast(event.message, true);
			break;
		case "extension_error":
			toast(`扩展错误 (${event.extensionPath}): ${event.error}`, true);
			break;
		default:
			break;
	}
}

function connectEvents() {
	const dot = $("conn-dot");
	const source = new EventSource("/api/events");
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

// ---- top bar -----------------------------------------------------------------

let modelsPayload = null;

function populateModelSelect() {
	const select = $("model-select");
	select.innerHTML = "";
	if (!modelsPayload) return;
	const available = new Set(modelsPayload.available);
	const byProvider = new Map();
	for (const model of modelsPayload.models) {
		if (!byProvider.has(model.provider)) byProvider.set(model.provider, []);
		byProvider.get(model.provider).push(model);
	}
	for (const [provider, models] of byProvider) {
		const group = document.createElement("optgroup");
		const auth = modelsPayload.providers[provider] && modelsPayload.providers[provider].auth;
		group.label = `${provider}${auth && auth.configured ? "" : " (未配置)"}`;
		for (const model of models) {
			const option = document.createElement("option");
			option.value = `${model.provider}/${model.id}`;
			option.textContent = model.name || model.id;
			option.disabled = !available.has(option.value);
			group.appendChild(option);
		}
		select.appendChild(group);
	}
	if (currentModelKey) select.value = currentModelKey;
	if (select.selectedOptions.length === 0 || select.value !== currentModelKey) {
		select.selectedIndex = -1;
	}
}

function populateThinkingSelect(levels, current) {
	const select = $("thinking-select");
	select._levels = levels;
	select.innerHTML = "";
	for (const level of levels) {
		const option = document.createElement("option");
		option.value = level;
		option.textContent = `thinking: ${level}`;
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
		await refreshState();
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

async function sendMessage() {
	const input = $("input");
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	try {
		const result = await apiPost("/api/prompt", { text });
		if (result.disposition === "queued") toast("已排队（steer）");
	} catch (error) {
		toast(error.message, true);
		input.value = text;
	}
}

$("send-btn").addEventListener("click", sendMessage);
$("input").addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		sendMessage();
	}
});

$("banner-close").addEventListener("click", () => {
	$("security-banner").hidden = true;
});

// ---- settings drawer ----------------------------------------------------------

const drawer = $("settings-drawer");
let editingProviderId = null; // null when creating a new provider

$("settings-btn").addEventListener("click", () => {
	drawer.hidden = false;
	loadConfig();
});
$("settings-close").addEventListener("click", () => {
	drawer.hidden = true;
});
drawer.addEventListener("click", (event) => {
	if (event.target === drawer) drawer.hidden = true;
});

async function loadModels() {
	try {
		modelsPayload = await api("/api/models");
		populateModelSelect();
	} catch (error) {
		toast(`加载模型失败: ${error.message}`, true);
	}
}

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
	const list = $("provider-list");
	list.innerHTML = "";
	const providerIds = new Set(Object.keys(config.providers || {}));
	const modelAuth = modelsPayload ? modelsPayload.providers : {};
	for (const id of Object.keys(modelAuth)) providerIds.add(id);

	for (const id of [...providerIds].sort()) {
		const entry = (config.providers || {})[id];
		const auth = modelAuth[id] && modelAuth[id].auth;
		const row = el("div", "provider-row");
		row.appendChild(el("span", "name", id));
		if (entry && entry.name && entry.name !== id) row.appendChild(el("span", undefined, entry.name));
		row.appendChild(el("span", "models-count", entry && entry.models ? `${entry.models.length} 个自定义模型` : "models.json 未配置"));
		const badge = el("span", `badge ${auth && auth.configured ? "ok" : "no"}`, auth && auth.configured ? `已认证${auth.label ? ` (${auth.label})` : ""}` : "未认证");
		row.appendChild(badge);
		const editBtn = el("button", undefined, "编辑");
		editBtn.addEventListener("click", () => openProviderForm(id, entry || {}));
		row.appendChild(editBtn);
		list.appendChild(row);
	}
	loadModels();
}

function showConfigError(message) {
	const box = $("config-error");
	box.textContent = message;
	box.hidden = false;
}

function modelCard(model) {
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
	const costInput = mk("Cost 输入/输出/缓存读/缓存写 (per 1M)", model.cost ? [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].join(",") : "", "0,0,0,0");
	card.appendChild(grid);

	const checks = el("div", "checks");
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

	const removeBtn = el("button", "remove danger", "移除模型");
	removeBtn.type = "button";
	removeBtn.addEventListener("click", () => card.remove());
	checks.appendChild(removeBtn);
	card.appendChild(checks);

	card.collect = () => {
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

function openProviderForm(id, entry) {
	editingProviderId = id;
	$("form-title").textContent = `编辑 Provider: ${id}`;
	$("provider-form").hidden = false;
	const idInput = $("f-id");
	idInput.value = id;
	idInput.disabled = true;
	$("f-name").value = entry.name || "";
	$("f-baseurl").value = entry.baseUrl || "";
	$("f-api").value = entry.api || "";
	$("f-apikey").value = entry.apiKey || "";
	$("f-headers").value = Object.entries(entry.headers || {}).map(([k, v]) => `${k}=${v}`).join("\n");
	const modelsList = $("models-list");
	modelsList.innerHTML = "";
	for (const model of entry.models || []) {
		modelsList.appendChild(modelCard(model));
	}
	$("form-error").hidden = true;
	$("delete-provider-btn").style.display = entry.baseUrl || entry.models ? "" : "";
	$("provider-form").scrollIntoView();
}

function closeProviderForm() {
	$("provider-form").hidden = true;
	editingProviderId = null;
}

$("add-provider-btn").addEventListener("click", () => {
	editingProviderId = null;
	$("form-title").textContent = "新增 Provider";
	$("provider-form").hidden = false;
	const idInput = $("f-id");
	idInput.value = "";
	idInput.disabled = false;
	$("f-name").value = "";
	$("f-baseurl").value = "";
	$("f-api").value = "";
	$("f-apikey").value = "";
	$("f-headers").value = "";
	$("models-list").innerHTML = "";
	$("form-error").hidden = true;
	$("delete-provider-btn").style.display = "none";
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
	const headers = {};
	for (const line of $("f-headers").value.split("\n")) {
		const idx = line.indexOf("=");
		if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	if (Object.keys(headers).length > 0) config.headers = headers;
	try {
		const models = [];
		for (const card of $("models-list").children) {
			models.push(card.collect());
		}
		if (models.length > 0) config.models = models;
	} catch (error) {
		errorBox.textContent = error.message;
		errorBox.hidden = false;
		return;
	}
	try {
		await api(`/api/config/providers/${encodeURIComponent(id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config }),
		});
		toast(`已保存 provider: ${id}`);
		closeProviderForm();
		drawer.hidden = true;
		await loadModels();
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
		drawer.hidden = true;
		await loadModels();
	} catch (error) {
		toast(error.message, true);
	}
});

// ---- boot ---------------------------------------------------------------------

loadModels();
refreshState().catch((error) => toast(`加载状态失败: ${error.message}`, true));
connectEvents();
