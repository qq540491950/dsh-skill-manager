/**
 * 浏览器半边（Client half）——DSH 自带的「懒 CJS」模块协议。
 *
 * 契约（实测自 `@deepseek-ai/dsh-client-modules`、官方 `dsh-client-ui-*` 与既有本地插件）：
 *   1. 这是一个普通 classic script，**不是 ESM**；执行时只做一件事：向
 *      `window.__ModuleLoader__` 注册一个 factory。
 *   2. factory 首次被 materialize 时执行，返回的 exports 就是模块导出。
 *   3. `id` **必须等于**本包 package.json 的 `name`。
 *   4. `require` 只能取平台种子模块（这里只用 `react`）。
 *
 * ## 本插件做什么
 *
 * 往 `settings.section`（**list 座位**）注册一页「Skills」，只读展示已发现的 skill，
 * 按来源分组（项目 / 全局 / 自定义 / 随包内置）。`order: 910` 让它落在设置列表里
 * MCP 页（`dsh-mcp-manager`，`order: 900`）之后。
 *
 * ## 为什么设置页拿得到「当前 session」
 *
 * `settings.section` 被官方声明为 `{ kind: "list", scope: "root" }`
 * （`dsh-client-ui-settings-general/lib/client.js` 的 `sidebar.settings.children`），
 * 所以页组件拿到的是 **root standard kit**，其中包含 ui-session 提供的 `useSessions`。
 * 「当前 session」在全仓没有专门字段，官方的统一判据是 sessions 快照里
 * `retainedBy.mainView > 0` 的那一行——`dsh-client-ui-cordis` 的 `CordisPanel`
 * 就是「root 座位组件自己解析当前 session」的现成先例，本组件照抄该判据。
 *
 * 为什么要 sessionId：`ctx.skills` 的读取**必须带 scope**。
 * `@deepseek-ai/dsh-skill-filesystem` 在本机是挂在 agent preset 的 standing composition
 * 里的（不在宿主根上），按层语义它只进那个 preset 的 layer；不带 scope 读取只会合并
 * 全局 layer，而全局 layer 里一个提供方都没有 → **空表**。宿主半边因此需要 sessionId
 * 去解析权威的 `cwd` 与 preset（详见 `lib/index.js`）。
 *
 * ## 为什么不用 `ctx.remote.skills.list()`
 *
 * 官方那条 Remote 通道**故意裁掉了 `source` / `provider`**
 * （见 `dsh-api-session-controller/lib/types/skill-catalog.js` 里逐字段挑拣的那段），
 * 而「全局 vs 项目」的分组依据恰恰只有 `source`。所以本插件自建
 * `/api/skill-manager`（宿主半边用 `ctx.connection.fetch.register()` 开），
 * 返回**完整摘要**，且**不做 `isUserInvocable` 过滤**——只读浏览页应当显示全部，
 * 包括 `disable-model-invocation` 的 skill（那条过滤是 `/` 补全菜单才需要的）。
 *
 * ## 样式纪律（踩过的坑，与 dsh-mcp-manager 同源）
 *
 *   - 绝不硬编码颜色：深色主题下 `brand-primary` 近白色，写 `#fff` 会白底白字。
 *     十六进制**只允许作为 `var()` 的 fallback**。
 *   - 视觉与尺寸都写进注入的样式表，**绝不写 inline**：inline 的 `background`
 *     会压过 `:hover`（按钮没有悬停反馈），inline 的 `height` 会压过样式表。
 *   - 每个块级子项显式 `min-width:0`（flex 子项默认 `min-width:auto`，内容一宽就撑破容器）。
 *   - 长路径/长描述一律 `overflow-wrap:anywhere`。
 *
 * ## 已知偏离（刻意为之，不是疏漏）
 *
 *   - **未接 `ctx.locale`**：官方 practices 要求用户可见文案走 Client locale 服务。
 *     本插件与同目录的 `dsh-mcp-manager` 保持一致（该仓库同样未接 locale），
 *     文案硬编码中文。这是一处**有意的偏离**，留到后续阶段处理。
 *   - **不替换导航图标**：`settings.section` 的注册字段白名单里**没有 `icon`**
 *     （`dsh-client-ui-slots/lib/index.js` 枚举了 `key/id/order/label/priority/
 *     select/inject/children/store/locale/registrant`），导航图标由官方 `navIcon(id)`
 *     硬编码查表、未知 id 兜底成齿轮。本页因此显示兜底齿轮——**刻意不学
 *     dsh-mcp-manager 的「打 data 属性 + CSS 覆盖」**，那条路依赖官方 DOM 结构，
 *     官方一改就静默失效；第一阶段不值得付这个代价。
 */
window.__ModuleLoader__.load({
	id: "dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		const h = react.createElement;
		const { useCallback, useEffect, useState } = react;

		/** 宿主半边开的同源只读路由。 */
		const ROUTE = "/api/skill-manager";
		/** 座位身份：`id` 必须是 list 座位里的唯一键；`label` 出现在设置导航上。 */
		const SECTION_ID = "skills";
		const SECTION_LABEL = "Skills";
		const STYLE_ELEMENT_ID = "dsh-skill-manager-styles";

		/**
		 * 超时预算。没有它的话，一旦宿主侧的目录解析卡住，`fetch` 永不 settle，
		 * 页面会永远停在「读取中…」，用户只能刷新整页。
		 */
		const REQUEST_TIMEOUT_MS = 20000;

		/**
		 * 分组标签与来源注释。
		 *
		 * 分组键由**宿主**按 `SkillSource` 算出（见 `lib/index.js` 的 `GROUPS`），
		 * 客户端不重新推导——两边各推一次必然会漂。
		 */
		const GROUP_LABELS = {
			project: "项目",
			global: "全局",
			custom: "自定义",
			bundled: "随包内置",
			other: "其他",
		};
		/**
		 * 分组顺序 = 界面上的分节顺序。
		 *
		 * 这四个是**规范分组**，无论有没有内容都会渲染出来（`other` 只在真有内容时出现）。
		 * 原因：只渲染非空分组时，「这个分组是空的」和「这个分组根本没实现」在界面上
		 * 长得一模一样——用户看到一片空白，无法判断是自己没装 skill，还是根目录不存在，
		 * 还是提供方挂了。这正是第一阶段第一次实测就暴露出来的问题。
		 */
		const GROUP_ORDER = ["project", "global", "custom", "bundled"];
		/** 旧宿主不带 `roots` 时的兜底说明（新宿主由 host 给出真实路径与存在性）。 */
		const GROUP_HINTS = {
			project: "<projectRoot>/.dsh/skills · <projectRoot>/.agents/skills",
			global: "<dshHome>/skills · <agentsHome>/skills",
			custom: "Config.customSkillDirs",
			bundled: "随包分发 / 运行时注册",
			other: "未识别的来源标签",
		};
		/** 根目录存在性 → 界面上的小字。 */
		const EXISTS_LABELS = { true: "存在", false: "不存在", undefined: "未判定" };

		/** 宿主解析出作用域的方式 → 给用户看的一句话；`global-layer` 要点明「为什么可能是空的」。 */
		const RESOLVED_LABELS = {
			"session-agent": "当前会话（活 Agent）",
			"preset-lease": "Agent 预设的冷读租约",
			"global-layer": "仅全局层（没有解析到 Agent 预设）",
		};

		/** 把任意异常整理成给用户看的一句话。 */
		function describeError(error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：宿主没有在预期时间内完成目录读取。`;
			}
			return error instanceof Error ? error.message : String(error);
		}

		const signalOf = () =>
			typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
				? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
				: undefined;

		/**
		 * 官方的「当前 session」判据：sessions 快照里 `retainedBy.mainView > 0` 的那一行。
		 *
		 * 这是有意的**约定**而非字段——`ClientSessions` 明确不管选中态，选中态落在
		 * uiWorkspace/uiSession；`mainView` 这个 retention source 由
		 * `dsh-client-ui-workspace` 的 `replaceMain()` 写入。全仓 6 处官方代码用同一判据
		 * （settings-general / layout / session / workspace / cordis），所以这里照抄。
		 * @returns sessionId，或 undefined（基线未到 / 没有主视图会话）。
		 */
		function findMainSessionId(state) {
			const byId = state?.byId;
			if (byId === null || byId === undefined) return undefined;
			for (const key of Object.keys(byId)) {
				const row = byId[key];
				if (row !== null && row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) {
					return row.id ?? key;
				}
			}
			return undefined;
		}

		/**
		 * `useSessions` 缺失时的替身。
		 *
		 * 它**不是** React hook（不调用任何 hook），所以调用它不会影响本组件的 hook 计数；
		 * 存在的意义是让「拿到 root kit」与「没拿到」两条路径在源码上长得一样，
		 * 免得为了省一次调用而写出条件式 hook 调用。
		 */
		function useNoSession(_selector) {
			return undefined;
		}

		/**
		 * 视觉层。class 统一 `dskm-` 前缀，避免与官方样式冲突。
		 * 数值取自官方小号控件与 `dsh-mcp-manager` 已实测的紧凑档基准：
		 * 按钮 28px 高 / 12px 字号 / `0 10px` 内边距；行 `min-height:28px`；
		 * 卡片 `padding:8px 12px` + `settings-card-*`。
		 */
		const CSS = `
.dskm-page { box-sizing:border-box; width:100%; max-width:720px; min-width:0; display:flex; flex-direction:column; gap:12px; padding:4px 0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:18px; }
.dskm-heading { display:flex; flex-direction:column; gap:2px; min-width:0; }
.dskm-title { margin:0; font-size:13px; font-weight:500; line-height:18px; }
.dskm-subtitle { margin:0; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:16px; overflow-wrap:anywhere; }
.dskm-view { box-sizing:border-box; min-width:0; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 10px; padding:8px 12px; border-radius:var(--dsw-radius-md, 6px); background:var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); font-size:12px; line-height:16px; }
.dskm-viewKey { flex:none; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.dskm-viewValue { min-width:0; color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; }
.dskm-mono { font-family:ui-monospace, monospace; }
.dskm-notice { box-sizing:border-box; min-width:0; padding:8px 12px; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md, 6px); font-size:12px; line-height:16px; overflow-wrap:anywhere; }
.dskm-notice--error { color:var(--dsw-alias-state-error-primary, #d9534f); border-color:currentColor; }
.dskm-notice--warn { color:var(--dsw-alias-label-secondary); border-color:currentColor; }
.dskm-toolbar { display:flex; align-items:center; gap:8px; min-width:0; }
.dskm-toolbarText { flex:1 1 auto; min-width:0; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskm-actions { display:flex; align-items:center; justify-content:flex-end; flex:none; gap:4px; }
.dskm-btn { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; flex:none; white-space:nowrap; height:28px; min-width:44px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm, 4px); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dskm-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dskm-btn:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
.dskm-btn:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.dskm-btn:disabled { opacity:.4; cursor:not-allowed; }
/* 分组选择：标签页 + 个数。四个分组永远都在（含 0），一次只展开一个。 */
.dskm-tabs { display:flex; flex-wrap:wrap; gap:4px; min-width:0; }
.dskm-tab { box-sizing:border-box; display:inline-flex; align-items:center; gap:6px; flex:none; white-space:nowrap; height:28px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm, 4px); background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dskm-tab:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dskm-tab:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.dskm-tab--active { border-color:transparent; background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color:var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); font-weight:500; }
.dskm-tab--active:hover { background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))); }
.dskm-tabCount { flex:none; font-size:11px; opacity:.7; }
.dskm-panel { display:flex; flex-direction:column; gap:8px; min-width:0; }
.dskm-groupHint { min-width:0; font-size:11px; line-height:16px; color:var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))); overflow-wrap:anywhere; }
/* 根目录清单：路径 + 存在性。让"这个分组为什么是空的"不再需要猜。 */
.dskm-roots { display:flex; flex-direction:column; gap:1px; min-width:0; }
.dskm-root { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; min-width:0; }
.dskm-rootPath { min-width:0; font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); overflow-wrap:anywhere; }
.dskm-rootState { flex:none; font-size:11px; line-height:16px; color:var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))); }
.dskm-rootState--off { color:var(--dsw-alias-state-error-primary, #d9534f); }
.dskm-rootHint { min-width:0; font-size:11px; line-height:16px; color:var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))); overflow-wrap:anywhere; }
.dskm-groupEmpty { min-width:0; color:var(--dsw-alias-label-dimmed, var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))); font-size:12px; line-height:16px; overflow-wrap:anywhere; }
.dskm-rows { display:flex; flex-direction:column; gap:8px; margin:0; padding:0; min-width:0; list-style:none; }
.dskm-card { box-sizing:border-box; min-width:0; display:flex; flex-direction:column; gap:2px; padding:8px 12px; border:.5px solid var(--dsw-alias-settings-card-stroke); border-radius:var(--dsw-radius-lg, 8px); background:var(--dsw-alias-settings-card-fill); }
.dskm-row { box-sizing:border-box; min-width:0; display:flex; align-items:center; gap:10px; min-height:28px; }
.dskm-meta { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; }
.dskm-name { font-size:13px; font-weight:500; line-height:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskm-desc { font-size:12px; line-height:16px; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskm-badges { display:flex; align-items:center; flex:none; gap:4px; }
.dskm-badge { flex:none; display:inline-flex; align-items:center; height:18px; padding:0 6px; border-radius:var(--dsw-radius-sm, 4px); background:var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:11px; line-height:18px; white-space:nowrap; }
.dskm-detail { box-sizing:border-box; min-width:0; display:flex; flex-direction:column; gap:6px; margin-top:8px; padding:10px 12px; border-radius:var(--dsw-radius-lg, 8px); background:var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1)); }
.dskm-path { font-size:11px; line-height:16px; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); overflow-wrap:anywhere; }
.dskm-pre { margin:0; max-height:320px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace, monospace; font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.dskm-empty { padding:8px 0; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:16px; }
`;

		/**
		 * 幂等注入样式表。
		 *
		 * 用固定 id + 「已存在就复用」而不是每次 append：客户端半边**会热重载**，
		 * 每次 HMR 都 append 一份会让样式表无界增长。
		 */
		function ensureStyles() {
			if (typeof document === "undefined" || document.head === null) return;
			const existing = document.getElementById(STYLE_ELEMENT_ID);
			if (existing !== null) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const style = document.createElement("style");
			style.id = STYLE_ELEMENT_ID;
			style.textContent = CSS;
			document.head.append(style);
		}

		/** 读一次目录。`sessionId` 是宿主解析 scope 与 cwd 的唯一依据（见文件头）。 */
		async function fetchCatalog(sessionId) {
			const query = sessionId === undefined ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
			const response = await fetch(`${ROUTE}${query}`, {
				headers: { accept: "application/json" },
				signal: signalOf(),
			});
			const body = await response.json().catch(() => null);
			if (body === null || body.ok !== true) {
				throw new Error(body?.error ?? `宿主返回 HTTP ${response.status}`);
			}
			return body.data;
		}

		/** 读一份 skill 正文。带 `sessionId` 是为了用**同一个视图**解析，避免「列表有、点开没有」。 */
		async function fetchSkill(sessionId, name) {
			const response = await fetch(ROUTE, {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify({ op: "read", name, sessionId }),
				signal: signalOf(),
			});
			const body = await response.json().catch(() => null);
			if (body === null || body.ok !== true) {
				throw new Error(body?.error ?? `宿主返回 HTTP ${response.status}`);
			}
			return body.data;
		}

		/** 小徽标。 */
		function badge(text) {
			return h("span", { className: "dskm-badge", key: text }, text);
		}

		/**
		 * 一条 skill。点击展开正文——正文按需拉取，不跟着列表一起下来
		 * （一个 skill 的 `SKILL.md` 可能几十 KB，全量预取会把列表拖垮）。
		 */
		function SkillCard({ skill, open, onToggle }) {
			const expanded = open.name === skill.name && open.phase !== "idle";
			return h(
				"li",
				{ className: "dskm-card" },
				h(
					"div",
					{ className: "dskm-row" },
					h(
						"div",
						{ className: "dskm-meta" },
						h("div", { className: "dskm-name", title: skill.name }, skill.name),
						h(
							"div",
							{ className: "dskm-desc", title: skill.description },
							skill.description === "" ? "（无描述）" : skill.description,
						),
					),
					h(
						"div",
						{ className: "dskm-badges" },
						badge(skill.provider ?? skill.source),
						skill.modelInvocable === false ? badge("仅用户可调用") : null,
						h(
							"button",
							{
								type: "button",
								className: "dskm-btn",
								onClick: () => onToggle(skill),
								"aria-expanded": expanded ? "true" : "false",
							},
							expanded ? "收起" : "查看",
						),
					),
				),
				expanded ? h(SkillDetail, { open, skill }) : null,
			);
		}

		/** 展开后的正文面板。三种相位各自只有一个渲染点（错误不重复渲染）。 */
		function SkillDetail({ open, skill }) {
			const pathLine = open.path ?? skill.path;
			return h(
				"div",
				{ className: "dskm-detail" },
				pathLine === undefined
					? null
					: h("div", { className: "dskm-path dskm-mono" }, pathLine),
				open.phase === "loading" ? h("div", { className: "dskm-empty" }, "读取中…") : null,
				open.phase === "failed"
					? h("div", { className: "dskm-notice dskm-notice--error" }, open.error)
					: null,
				open.phase === "ready"
					? h(
							"div",
							null,
							h("pre", { className: "dskm-pre" }, open.content),
							open.truncated === true
								? h(
										"div",
										{ className: "dskm-path" },
										`正文过长，已截断显示（完整 ${open.contentLength} 字符）。`,
									)
								: null,
						)
					: null,
			);
		}

		/**
		 * 设置页主体。
		 *
		 * 相位模型（互斥，**同一时刻只有一个**）：
		 *   loading  首次/刷新读取中
		 *   ready    拿到目录
		 *   failed   目录读取失败（保留 error 原文）
		 * 「展开正文」的相位独立于页面相位，存在 `open` 里。
		 */
		function SkillSection(props) {
			// 无论有没有 root kit，都走同一个调用序列（见 useNoSession 注释）。
			const useSessions = typeof props?.useSessions === "function" ? props.useSessions : useNoSession;
			const sessionId = useSessions(findMainSessionId);

			const [state, setState] = useState({ phase: "loading" });
			const [open, setOpen] = useState({ name: null, phase: "idle" });
			const [nonce, setNonce] = useState(0);
			// `null` = 用户还没点过标签页，此时按"第一个非空分组"取默认选中（见下方 activeGroup）。
			const [picked, setPicked] = useState(null);

			useEffect(() => {
				let alive = true;
				setState({ phase: "loading" });
				// 切换 session 时把展开态收掉：正文属于上一个视图，留着会串。
				setOpen({ name: null, phase: "idle" });
				fetchCatalog(sessionId)
					.then((data) => {
						if (alive) setState({ phase: "ready", data });
					})
					.catch((error) => {
						if (alive) setState({ phase: "failed", error: describeError(error) });
					});
				return () => {
					alive = false;
				};
			}, [sessionId, nonce]);

			const onToggle = useCallback(
				(skill) => {
					if (open.name === skill.name && open.phase !== "idle") {
						setOpen({ name: null, phase: "idle" });
						return Promise.resolve();
					}
					setOpen({ name: skill.name, phase: "loading" });
					// 返回 promise：调用方（以及自检的渲染测试）可以 await 到正文落定。
					return fetchSkill(sessionId, skill.name)
						.then((data) =>
							setOpen({
								name: skill.name,
								phase: "ready",
								path: data.path,
								content: data.content,
								truncated: data.truncated,
								contentLength: data.contentLength,
							}),
						)
						.catch((error) => setOpen({ name: skill.name, phase: "failed", error: describeError(error) }));
				},
				[sessionId, open.name, open.phase],
			);

			const data = state.phase === "ready" ? state.data : undefined;
			const groups = data === undefined ? [] : groupSkills(data.skills, data.roots);
			// 选中的分组：用户点过就用他点的；否则**默认落在第一个非空分组**上，
			// 免得一进来正好停在一个空标签页上，看起来又像"没有 skill"。
			// 用 `picked === null` 表示"还没点过"，这样不用为默认值写 effect。
			const activeGroup =
				groups.find((group) => group.key === picked) ??
				groups.find((group) => group.items.length > 0) ??
				groups[0];
			const showGroups = data !== undefined && activeGroup !== undefined;

			return h(
				"div",
				{ className: "dskm-page" },
				h(
					"div",
					{ className: "dskm-heading" },
					h("h2", { className: "dskm-title" }, "Skills"),
					h(
						"p",
						{ className: "dskm-subtitle" },
						"只读浏览已发现的 skill，按来源分组。第一阶段不含任何写入。",
					),
				),

				data === undefined ? null : h(ViewFacts, { data }),
				state.phase === "failed"
					? h("div", { className: "dskm-notice dskm-notice--error" }, state.error)
					: null,
				data !== undefined && data.complete === false
					? h(
							"div",
							{ className: "dskm-notice dskm-notice--warn" },
							"本次发现未完成：有 skill 根目录扫描失败或还没扫完，下面的分组可能不是全部。请对照上面的「提供方」——如果你期望的文件系统提供方没有出现在里面，说明它的根目录这次一个都没扫成功。",
						)
					: null,
				data !== undefined && data.resolvedBy === "global-layer"
					? h(
							"div",
							{ className: "dskm-notice dskm-notice--warn" },
							"没有解析到 Agent 预设作用域，只读了全局层——本机 skill 提供方挂在预设里，因此这里很可能是空的。请先打开一个会话，再回到本页刷新。",
						)
					: null,

				h(
					"div",
					{ className: "dskm-toolbar" },
					h(
						"div",
						{ className: "dskm-toolbarText" },
						state.phase === "loading"
							? "读取中…"
							: data === undefined
								? ""
								: `共 ${data.skills.length} 个 skill`,
					),
					h(
						"div",
						{ className: "dskm-actions" },
						h(
							"button",
							{
								type: "button",
								className: "dskm-btn",
								disabled: state.phase === "loading",
								onClick: () => setNonce((value) => value + 1),
							},
							"刷新",
						),
					),
				),

				state.phase === "ready" && data.skills.length === 0
					? h(
							"div",
							{ className: "dskm-empty" },
							"当前视图里没有发现任何 skill。",
						)
					: null,

				// 分组只以**标签页 + 个数**呈现：四个分组全部列出（含 0），
				// 但一次只展开一个。这样「项目 0 / 全局 0」这种"空"仍然一眼可见，
				// 又不会把四段内容全堆在页面上。
				showGroups
					? h(
							"div",
							{ className: "dskm-tabs", role: "tablist" },
							groups.map((group) =>
								h(
									"button",
									{
										type: "button",
										key: group.key,
										role: "tab",
										className:
											group.key === activeGroup.key
												? "dskm-tab dskm-tab--active"
												: "dskm-tab",
										"aria-selected": group.key === activeGroup.key ? "true" : "false",
										onClick: () => setPicked(group.key),
									},
									h("span", null, GROUP_LABELS[group.key] ?? group.key),
									h("span", { className: "dskm-tabCount" }, `${group.items.length}`),
								),
							),
						)
					: null,

				showGroups
					? h(
							"div",
							{ className: "dskm-panel" },
							// 根目录清单跟着**选中的那一组**走：空的时候它是唯一的解释，
							// 有内容时它是"这些 skill 到底从哪读来的"。
							h(RootLines, { data, group: activeGroup.key }),
							activeGroup.items.length === 0
								? h("div", { className: "dskm-groupEmpty" }, activeGroup.empty)
								: h(
										"ul",
										{ className: "dskm-rows" },
										activeGroup.items.map((skill) =>
											h(SkillCard, { key: skill.name, skill, open, onToggle }),
										),
									),
						)
					: null,
			);
		}

		/**
		 * 一个分组的根目录清单（真实路径 + 存在性）。
		 *
		 * 路径由**宿主**解析（`projectRoot` 靠向上找 `.git`，home 靠环境变量），
		 * 客户端不自己拼——两边各拼一次必然又漂。
		 * 旧宿主不带 `roots` 时退回静态说明。
		 */
		function RootLines({ data, group }) {
			const roots = Array.isArray(data.roots) ? data.roots.filter((root) => root.group === group) : [];
			if (roots.length === 0) {
				const hint = GROUP_HINTS[group];
				return hint === undefined ? null : h("div", { className: "dskm-rootHint dskm-mono" }, hint);
			}
			return h(
				"div",
				{ className: "dskm-roots" },
				roots.map((root, index) =>
					h(
						"div",
						{ className: "dskm-root", key: `${root.source}-${index}` },
						h(
							"span",
							{ className: "dskm-rootPath dskm-mono" },
							root.path ?? root.note ?? "(未知位置)",
						),
						root.path === undefined
							? null
							: h(
									"span",
									{
										className:
											root.exists === true
												? "dskm-rootState"
												: "dskm-rootState dskm-rootState--off",
									},
									EXISTS_LABELS[String(root.exists)] ?? "",
								),
					),
				),
			);
		}

		/**
		 * 视图事实行：把宿主**实际怎么解析的**摆出来
		 * （作用域 / 预设 / cwd / 项目根 / 提供方 / 完整性）。
		 * 没有这行，「列表是空的」和「列表不全」都变成无法诊断的黑盒。
		 *
		 * 「提供方」是排查 `完整性 未完成` 的关键：`dsh-skill-office`、`filesystem`
		 * 这类名字直接指出**谁交了作业**。期望的文件系统提供方不在这行里，
		 * 就说明它的根目录这次一个都没扫成功。
		 */
		function ViewFacts({ data }) {
			const providers =
				data.providers === undefined || Object.keys(data.providers).length === 0
					? "（无）"
					: Object.entries(data.providers)
							.map(([name, count]) => `${name}x${count}`)
							.join("、");
			const facts = [
				["作用域", RESOLVED_LABELS[data.resolvedBy] ?? data.resolvedBy],
				["预设", data.presetId ?? "（未解析到）"],
				["cwd", data.cwd ?? "（未知）"],
				["项目根", data.projectRoot ?? "（未解析到）"],
				["提供方", providers],
				["完整性", data.complete === false ? "未完成" : "完整"],
			];
			return h(
				"div",
				{ className: "dskm-view" },
				facts.map(([key, value]) =>
					h(
						"span",
						{ key, style: { display: "inline-flex", gap: "4px", minWidth: 0 } },
						h("span", { className: "dskm-viewKey" }, key),
						h("span", { className: "dskm-viewValue dskm-mono" }, String(value)),
					),
				),
			);
		}

		/**
		 * 按宿主给好的 `group` 字段分桶。
		 *
		 * **四个规范分组永远返回**（哪怕为空），`other` 只在真有内容时出现。
		 * `empty` 是空状态下那句解释——必须分清「根目录不存在」与「根目录存在但为空」。
		 */
		function groupSkills(skills, roots) {
			const buckets = new Map();
			for (const skill of skills) {
				const key = typeof skill.group === "string" ? skill.group : "other";
				const list = buckets.get(key);
				if (list === undefined) buckets.set(key, [skill]);
				else list.push(skill);
			}
			const keys = GROUP_ORDER.concat(buckets.has("other") ? ["other"] : []);
			return keys.map((key) => ({
				key,
				items: buckets.get(key) ?? [],
				empty: emptyNote(key, roots),
			}));
		}

		/** 空分组到底为什么空——三种原因分开说，否则用户只能猜。 */
		function emptyNote(group, roots) {
			const list = Array.isArray(roots) ? roots.filter((root) => root.group === group) : [];
			if (list.length === 0) return "没有发现 skill。";
			if (list.every((root) => root.exists === false)) {
				return "没有发现 skill：上面这些根目录都不存在。";
			}
			if (list.some((root) => root.exists === true)) {
				return "没有发现 skill：根目录存在，但里面没有合法的 skill。";
			}
			return "没有发现 skill。";
		}

		//#region 插件体
		/**
		 * 客户端插件体：把「Skills」注册成设置面板里的一个 list 座位条目。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ensureStyles();
			// 只注入 slots：数据面走同源 fetch，不需要 remote / connection 注入。
			// 用 ctx.inject 而不是模块级 inject，是为了在缺 slots 的宿主里保持 inactive
			// 而不是激活后抛错（与 dsh-mcp-manager 同一写法）。
			ctx.inject(["slots"], (scope) => {
				// 必须走 inject：`settings.section` 由官方 settings-general 的
				// `sidebar.settings.children` 声明，未声明的座位直接 register 会抛
				// `slot "..." is not declared`。inject 会等声明就绪。
				scope.slots.inject("settings.section", () =>
					scope.slots.register(
						{
							name: "settings.section",
							// list 座位必须给唯一 id（唯一性约束在 (id, priority)，不在 order）。
							id: SECTION_ID,
							// 官方区间：account -10 / general 0 / models 10 / plugins 15 /
							// agent-presets 20；本地 MCP 页占 900。910 → 本页排在 MCP 之后。
							order: 910,
							// label 可以是 thunk（官方会按 locale 重新求值）。
							label: () => SECTION_LABEL,
						},
						SkillSection,
					),
				);
			});
		}
		//#endregion

		exports.apply = apply;
		return module.exports;
	},
});
