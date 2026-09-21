// dsh-global-system-prompt client half: registers the "全局提示词" section in the web
// settings panel. Hand-written __ModuleLoader__ factory (no build step); the
// only external require is react, which the loader module table provides.
//
// Contract: window.__ModuleLoader__.load({ id, factory }) with `id` equal to the
// package name, and the factory's exports carrying name/inject/apply.
window.__ModuleLoader__.load({ id: "dsh-global-system-prompt", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	let react = require("react");
	const h = react.createElement;
	const { useState, useEffect, useCallback } = react;

	const name = "global-prompt";
	const inject = ["slots"];

	const text = {
		nav: "全局提示词",
		description: "每个会话的系统提示词都会带上这段文字（cc-switch 的全局提示词）。",
		promptFile: "提示词文件",
		position: "段落位置 order",
		instructionsFile: "全局指令文件",
		instructionsPresent: "已存在",
		instructionsMissing: "尚未创建",
		instructionsHint: "注入内容会自动附上这两个文件的绝对路径，模型不用再去猜「全局 AGENTS.md」在哪。",
		projectSync: "项目 AGENTS.md（自动同步）",
		projectSyncIdle: "本进程还没有同步过任何会话项目",
		projectSyncHint: "每个会话开始时会在它所在项目根（从会话工作目录向上找 .git，找不到就用会话目录本身）的 AGENTS.md 里维护一段带标记的区块，内容就是下面这段提示词：写一次，项目里所有工具都读得到。手工删掉该区块，下一步会被重新写回。",
		projectBlock: "写入项目的区块",
		loading: "加载中…",
		save: "保存",
		saving: "保存中…",
		reload: "重新读取",
		unsaved: "有未保存的修改",
		saved: "已保存——下一次请求（下一轮对话）即生效，无需重启。",
		readFailed: "读取失败：",
		saveFailed: "保存失败：",
		notCreated: "文件还不存在，保存后会创建它。",
		fallback: "文件尚不存在，当前生效的是插件配置里的兜底文本。",
		disabled: "该插件行已 enabled: false，这段提示词当前不会注入。",
		truncated: "文件超过 maxBytes，超出的部分不会被注入。",
		empty: "内容为空——相当于不注入任何提示词内容（文件位置说明仍会附加）。",
		characters: "字符",
		injected: "实际注入",
		bytes: "字节",
		preview: "实际注入预览（模型看到的原文）",
	};

	const TEXTAREA_STYLE = {
		width: "100%",
		minHeight: "360px",
		boxSizing: "border-box",
		fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
		fontSize: "13px",
		lineHeight: 1.55,
		padding: "10px",
		background: "transparent",
		color: "inherit",
		border: "1px solid rgba(128, 128, 128, 0.35)",
		borderRadius: "6px",
		resize: "vertical",
	};

	const ROW_STYLE = {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		marginTop: "10px",
		flexWrap: "wrap",
	};

	const BUTTON_STYLE = {
		padding: "6px 16px",
		borderRadius: "6px",
		cursor: "pointer",
		fontSize: "13px",
	};

	const GHOST_BUTTON_STYLE = Object.assign({}, BUTTON_STYLE, {
		background: "transparent",
		color: "inherit",
		border: "1px solid rgba(128, 128, 128, 0.35)",
	});

	const NOTE_STYLE = {
		margin: "0 0 8px",
		fontSize: "13px",
		opacity: 0.75,
	};

	const META_STYLE = {
		fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
		fontSize: "12px",
		opacity: 0.7,
		wordBreak: "break-all",
	};

	const PREVIEW_STYLE = {
		margin: "6px 0 0",
		padding: "10px",
		maxHeight: "240px",
		overflow: "auto",
		whiteSpace: "pre-wrap",
		wordBreak: "break-word",
		fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
		fontSize: "12px",
		lineHeight: 1.5,
		background: "rgba(128, 128, 128, 0.08)",
		border: "1px solid rgba(128, 128, 128, 0.25)",
		borderRadius: "6px",
	};

	function badgeStyle(kind) {
		return {
			fontSize: "12px",
			padding: "2px 8px",
			borderRadius: "999px",
			border: "1px solid rgba(128, 128, 128, 0.35)",
			color: kind === "warn" ? "#e5484d" : "inherit",
			opacity: kind === "warn" ? 1 : 0.8,
		};
	}

	/** "12.3 kB" — the panel only needs a human-sized magnitude. */
	function formatBytes(value) {
		if (typeof value !== "number" || !isFinite(value) || value < 0) return "";
		if (value < 1024) return String(value) + " B";
		if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " kB";
		return (value / (1024 * 1024)).toFixed(1) + " MB";
	}

	/** What the sync last did to one project file, in the panel's language. */
	const SYNC_ACTIONS = {
		created: "已创建",
		updated: "已更新",
		unchanged: "已是最新",
		removed: "已移除",
		skipped: "已跳过",
		error: "失败",
	};

	function syncActionLabel(action) {
		return SYNC_ACTIONS[action] || String(action || "");
	}

	/** "D:\repo\AGENTS.md · 已更新", one entry per project this process touched. */
	function describeTargets(sync) {
		const targets = sync && Array.isArray(sync.targets) ? sync.targets : [];
		if (targets.length === 0) return text.projectSyncIdle;
		return targets.map((entry) => entry.path + " · " + syncActionLabel(entry.action)).join("  |  ");
	}

	function GlobalPromptSection() {
		const [content, setContent] = useState("");
		const [loadedContent, setLoadedContent] = useState("");
		const [meta, setMeta] = useState(null);
		const [loaded, setLoaded] = useState(false);
		const [busy, setBusy] = useState(false);
		const [notice, setNotice] = useState({ kind: "idle", text: "" });

		const load = useCallback(() => {
			return fetch("/global-prompt", { cache: "no-store" })
				.then((response) => {
					if (!response.ok) throw new Error("HTTP " + response.status);
					return response.json();
				})
				.then((data) => {
					setContent(String(data.content || ""));
					setLoadedContent(String(data.content || ""));
					setMeta(data);
					setLoaded(true);
					return data;
				});
		}, []);

		useEffect(() => {
			let cancelled = false;
			load().catch((error) => {
				if (cancelled) return;
				setNotice({ kind: "error", text: text.readFailed + error.message });
				setLoaded(true);
			});
			return () => { cancelled = true; };
		}, [load]);

		const reload = useCallback(() => {
			setBusy(true);
			setNotice({ kind: "idle", text: "" });
			load()
				.catch((error) => { setNotice({ kind: "error", text: text.readFailed + error.message }); })
				.finally(() => { setBusy(false); });
		}, [load]);

		const save = useCallback(() => {
			setBusy(true);
			setNotice({ kind: "idle", text: "" });
			fetch("/global-prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content }),
			})
				.then((response) => {
					if (!response.ok) throw new Error("HTTP " + response.status);
					return response.json();
				})
				.then((data) => {
					if (data.error) throw new Error(data.error);
					setLoadedContent(content);
					setMeta(data);
					setNotice({ kind: "ok", text: text.saved });
				})
				.catch((error) => { setNotice({ kind: "error", text: text.saveFailed + error.message }); })
				.finally(() => { setBusy(false); });
		}, [content]);

		const dirty = content !== loadedContent;
		const notCreated = meta !== null && meta.exists === false;
		const hasFallback = notCreated && meta.fallbackBytes > 0;
		const instructions = meta !== null && meta.instructionsPath
			? h("p", { style: META_STYLE },
				text.instructionsFile + "：" + meta.instructionsPath
				+ " · " + (meta.instructionsExists
					? text.instructionsPresent + " " + formatBytes(meta.instructionsBytes)
					: text.instructionsMissing)
				+ (meta.includeInstructions ? " · 已并入注入内容" : ""))
			: null;
		const project = meta !== null && meta.projectAgents && meta.projectAgents.enabled
			? h("div", null,
				h("p", { style: META_STYLE },
					text.projectSync + "：" + describeTargets(meta.projectAgents)),
				h("p", { style: NOTE_STYLE }, text.projectSyncHint))
			: null;

		return h("div", { style: { maxWidth: "760px" } },
			h("p", { style: NOTE_STYLE }, text.description),
			meta === null ? null : h("p", { style: META_STYLE },
				text.promptFile + "：" + meta.path + "  ·  " + text.position + "：" + String(meta.order)),
			instructions,
			project,
			meta !== null && meta.announcePaths && meta.instructionsPath
				? h("p", { style: NOTE_STYLE }, text.instructionsHint)
				: null,
			meta !== null && meta.enabled === false
				? h("p", { style: badgeStyle("warn") }, text.disabled)
				: null,
			notCreated ? h("p", { style: NOTE_STYLE }, hasFallback ? text.fallback : text.notCreated) : null,
			meta !== null && meta.truncated ? h("p", { style: badgeStyle("warn") }, text.truncated) : null,
			!loaded
				? h("p", { style: { opacity: 0.6 } }, text.loading)
				: h("textarea", {
					style: TEXTAREA_STYLE,
					value: content,
					onChange: (event) => { setContent(event.target.value); },
					spellCheck: false,
					placeholder: "# 全局提示词\n\n写给每一个会话的固定指令，例如：\n- 始终用中文回答。\n- 改动前先读文件，不要凭猜测改代码。",
				}),
			h("div", { style: ROW_STYLE },
				h("button", {
					style: Object.assign({}, BUTTON_STYLE, {
						background: "var(--accent, #2f81f7)",
						color: "#fff",
						border: "none",
						opacity: busy || !dirty ? 0.6 : 1,
					}),
					disabled: busy || !dirty,
					onClick: save,
				}, busy ? text.saving : text.save),
				h("button", {
					style: Object.assign({}, GHOST_BUTTON_STYLE, { opacity: busy ? 0.6 : 1 }),
					disabled: busy,
					onClick: reload,
				}, text.reload),
				meta === null ? null : h("span", { style: META_STYLE },
					text.characters + " " + String(content.length)
					+ "  ·  " + text.injected + " " + formatBytes(meta.injectedBytes)),
				dirty ? h("span", { style: badgeStyle("warn") }, text.unsaved) : null,
			),
			loaded && content.trim().length === 0
				? h("p", { style: NOTE_STYLE }, text.empty)
				: null,
			notice.kind === "ok"
				? h("p", { style: Object.assign({}, NOTE_STYLE, { marginTop: "8px" }) }, notice.text)
				: notice.kind === "error"
					? h("p", { style: Object.assign({}, NOTE_STYLE, { marginTop: "8px", color: "#e5484d" }) }, notice.text)
					: null,
			meta === null || typeof meta.injected !== "string" || meta.injected.length === 0
				? null
				: h("details", { style: { marginTop: "12px" } },
					h("summary", { style: { cursor: "pointer", fontSize: "13px", opacity: 0.8 } }, text.preview),
					h("pre", { style: PREVIEW_STYLE }, meta.injected)),
			meta === null || typeof meta.projectAgentsBlock !== "string" || meta.projectAgentsBlock.length === 0
				? null
				: h("details", { style: { marginTop: "12px" } },
					h("summary", { style: { cursor: "pointer", fontSize: "13px", opacity: 0.8 } }, text.projectBlock),
					h("pre", { style: PREVIEW_STYLE }, meta.projectAgentsBlock)),
		);
	}

	function apply(ctx) {
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "global-prompt",
			order: 40,
			label: () => text.nav,
		}, () => h(GlobalPromptSection, null)));
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}
});
