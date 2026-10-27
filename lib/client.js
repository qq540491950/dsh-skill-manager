/**
 * 本文件由 `tools/build.ts` 从 `src/client/index.ts` 生成 —— **不要直接编辑**。
 *
 * 契约：classic script（不是 ESM）；执行时只向 `window.__ModuleLoader__.load` 注册一个 factory；
 * `id` 等于包名；`require` 只解析基座模块表（这里只用 react）。
 * 设计说明见 src/client/index.ts 与 README.md。
 */
window.__ModuleLoader__.load({
	id: "@qq540491950/dsh-skill-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var h = import_react.createElement;
var ROUTE = "/api/skill-manager";
var SECTION_ID = "skills";
var SECTION_LABEL = "Skills";
var STYLE_ELEMENT_ID = "dsh-skill-manager-styles";
var REQUEST_TIMEOUT_MS = 2e4;
var TABS = [
  { key: "workspace", label: "项目 + 全局", groups: ["project", "global"] },
  { key: "custom", label: "自定义", groups: ["custom"] },
  { key: "bundled", label: "随包内置", groups: ["bundled"] },
  { key: "other", label: "其他", groups: ["other"], optional: true }
];
function describeError(error) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1e3}s）：宿主没有在预期时间内完成目录读取。`;
  }
  return error instanceof Error ? error.message : String(error);
}
function signalOf() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : void 0;
}
function requestInit(init) {
  const signal = signalOf();
  return signal === void 0 ? init : { ...init, signal };
}
function findMainSessionId(state) {
  const byId = state?.byId;
  if (byId === null || byId === void 0) return void 0;
  for (const key of Object.keys(byId)) {
    const row = byId[key];
    const retained = row?.retainedBy?.mainView;
    if (row !== null && row !== void 0 && (typeof retained === "number" ? retained : 0) > 0) {
      return typeof row.id === "string" && row.id !== "" ? row.id : key;
    }
  }
  return void 0;
}
function useNoSession(_selector) {
  return void 0;
}
function listWorkspaceItems(state) {
  const items = state?.items;
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const item of items) {
    const row = item;
    const path = typeof row?.path === "string" ? row.path : "";
    const title = typeof row?.title === "string" && row.title !== "" ? row.title : lastSegment(path);
    if (path === "") continue;
    out.push({ path, title });
  }
  return out;
}
function lastSegment(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}
var CSS = `
.dskm-page { box-sizing:border-box; width:100%; max-width:720px; min-width:0; display:flex; flex-direction:column; gap:12px; padding:4px 0; color:var(--dsw-alias-label-primary); font-size:13px; line-height:18px; }
.dskm-heading { display:flex; flex-direction:column; gap:2px; min-width:0; }
.dskm-title { margin:0; font-size:13px; font-weight:500; line-height:18px; }
.dskm-mono { font-family:ui-monospace, monospace; }
/* 页面级读取失败：唯一允许出现的提示（用户需要知道，且能重试）。 */
.dskm-notice { box-sizing:border-box; min-width:0; padding:8px 12px; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-md, 6px); font-size:12px; line-height:16px; overflow-wrap:anywhere; }
.dskm-notice--error { color:var(--dsw-alias-state-error-primary, #d9534f); border-color:currentColor; }
.dskm-toolbar { display:flex; align-items:center; gap:8px; min-width:0; }
.dskm-toolbarText { flex:1 1 auto; min-width:0; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dskm-actions { display:flex; align-items:center; justify-content:flex-end; flex:none; gap:4px; }
.dskm-btn { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; flex:none; white-space:nowrap; height:28px; min-width:44px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm, 4px); background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dskm-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
.dskm-btn:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover)); }
.dskm-btn:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.dskm-btn:disabled { opacity:.4; cursor:not-allowed; }
/* 范围选择：当前会话 / 各工作区。官方 .input 的尺寸（28px / border-l4 / radius-md）。 */
.dskm-scope { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.dskm-scopeLabel { flex:none; color:var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size:12px; line-height:16px; }
.dskm-select { box-sizing:border-box; max-width:220px; height:28px; padding:0 8px; border:.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l3)); border-radius:var(--dsw-radius-md, 6px); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dskm-select:disabled { opacity:.4; cursor:not-allowed; }
.dskm-select:focus-visible { border-color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); outline:none; }
/* 分组选择：标签页 + 个数。三个分组永远都在（含 0），一次只展开一个。 */
.dskm-tabs { display:flex; flex-wrap:wrap; gap:4px; min-width:0; }
.dskm-tab { box-sizing:border-box; display:inline-flex; align-items:center; gap:6px; flex:none; white-space:nowrap; height:28px; padding:0 10px; border:.5px solid var(--dsw-alias-border-l3); border-radius:var(--dsw-radius-sm, 4px); background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; line-height:18px; cursor:pointer; }
.dskm-tab:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dskm-tab:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset:1px; }
.dskm-tab--active { border-color:transparent; background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color:var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); font-weight:500; }
.dskm-tab--active:hover { background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))); }
.dskm-tabCount { flex:none; font-size:11px; opacity:.7; }
.dskm-panel { display:flex; flex-direction:column; gap:8px; min-width:0; }
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
function normalizeCwd(cwd) {
  return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
}
async function fetchCatalog(sessionId, cwd) {
  const params = new URLSearchParams();
  if (sessionId !== void 0) params.set("sessionId", sessionId);
  const effectiveCwd = normalizeCwd(cwd);
  if (effectiveCwd !== void 0) params.set("cwd", effectiveCwd);
  const query = params.toString() === "" ? "" : `?${params.toString()}`;
  const response = await fetch(
    `${ROUTE}${query}`,
    requestInit({ headers: { accept: "application/json" } })
  );
  const body = await response.json().catch(() => null);
  if (body === null || body.ok !== true) {
    throw new Error((body === null || body.ok !== false ? void 0 : body.error) ?? `宿主返回 HTTP ${response.status}`);
  }
  return body.data;
}
async function fetchSkill(sessionId, name, cwd) {
  const response = await fetch(
    ROUTE,
    requestInit({
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ op: "read", name, sessionId, cwd: normalizeCwd(cwd) })
    })
  );
  const body = await response.json().catch(() => null);
  if (body === null || body.ok !== true) {
    throw new Error((body === null || body.ok !== false ? void 0 : body.error) ?? `宿主返回 HTTP ${response.status}`);
  }
  return body.data;
}
function badge(text) {
  return h("span", { className: "dskm-badge", key: text }, text);
}
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
          skill.description === "" ? "（无描述）" : skill.description
        )
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
            "aria-expanded": expanded ? "true" : "false"
          },
          expanded ? "收起" : "查看"
        )
      )
    ),
    expanded ? h(SkillDetail, { open, skill }) : null
  );
}
function SkillDetail({ open, skill }) {
  const pathLine = open.path ?? skill.path;
  return h(
    "div",
    { className: "dskm-detail" },
    pathLine === void 0 ? null : h("div", { className: "dskm-path dskm-mono" }, pathLine),
    open.phase === "loading" ? h("div", { className: "dskm-empty" }, "读取中…") : null,
    open.phase === "failed" ? h("div", { className: "dskm-notice dskm-notice--error" }, open.error) : null,
    open.phase === "ready" ? h(
      "div",
      null,
      h("pre", { className: "dskm-pre" }, open.content),
      open.truncated === true ? h("div", { className: "dskm-path" }, `正文过长，已截断显示（完整 ${String(open.contentLength)} 字符）。`) : null
    ) : null
  );
}
function SkillSection(props) {
  const useSessions = typeof props?.useSessions === "function" ? props.useSessions : useNoSession;
  const sessionId = useSessions(findMainSessionId);
  const useWorkspaces = typeof props?.useWorkspaces === "function" ? props.useWorkspaces : useNoSession;
  const workspaceItems = useWorkspaces(listWorkspaceItems) ?? [];
  const [state, setState] = (0, import_react.useState)({ phase: "loading" });
  const [open, setOpen] = (0, import_react.useState)({ name: null, phase: "idle" });
  const [nonce, setNonce] = (0, import_react.useState)(0);
  const [picked, setPicked] = (0, import_react.useState)(null);
  const [pickedCwd, setPickedCwd] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    let alive = true;
    setState({ phase: "loading" });
    setOpen({ name: null, phase: "idle" });
    fetchCatalog(sessionId, pickedCwd).then((data2) => {
      if (alive) setState({ phase: "ready", data: data2 });
    }).catch((error) => {
      if (alive) setState({ phase: "failed", error: describeError(error) });
    });
    return () => {
      alive = false;
    };
  }, [sessionId, nonce, pickedCwd]);
  const onToggle = (0, import_react.useCallback)(
    (skill) => {
      if (open.name === skill.name && open.phase !== "idle") {
        setOpen({ name: null, phase: "idle" });
        return Promise.resolve();
      }
      setOpen({ name: skill.name, phase: "loading" });
      return fetchSkill(sessionId, skill.name, pickedCwd).then(
        (data2) => setOpen({
          name: skill.name,
          phase: "ready",
          path: data2.path,
          content: data2.content,
          truncated: data2.truncated,
          contentLength: data2.contentLength
        })
      ).catch((error) => setOpen({ name: skill.name, phase: "failed", error: describeError(error) }));
    },
    [sessionId, pickedCwd, open.name, open.phase]
  );
  const data = state.phase === "ready" ? state.data : void 0;
  const tabs = data === void 0 ? [] : buildTabs(data.skills, data.roots);
  const activeTab = tabs.find((tab2) => tab2.key === picked) ?? tabs.find((tab2) => tab2.items.length > 0) ?? tabs[0];
  const tab = data !== void 0 ? activeTab : void 0;
  const currentSessionLabel = pickedCwd === null && data?.cwd !== void 0 ? lastSegment(data.cwd) : void 0;
  return h(
    "div",
    { className: "dskm-page" },
    h("div", { className: "dskm-heading" }, h("h2", { className: "dskm-title" }, "Skills")),
    // 页面级读取失败是**唯一**允许出现的提示：用户需要知道，且能点「刷新」重试。
    // 提供方原文、作用域/cwd/提供方/完整性这些诊断**一律不再渲染**（用户要求）。
    state.phase === "failed" ? h("div", { className: "dskm-notice dskm-notice--error" }, state.error) : null,
    h(
      "div",
      { className: "dskm-toolbar" },
      h(
        "div",
        { className: "dskm-toolbarText" },
        state.phase === "loading" ? "读取中…" : data === void 0 ? "" : `共 ${data.skills.length} 个 skill`
      ),
      h(
        "div",
        { className: "dskm-actions" },
        // 范围选择：看当前会话，还是看某个工作区的 skill。
        // 值就是**工作区路径**——它决定宿主扫哪个项目；不传 = 当前会话。
        workspaceItems.length > 0 ? h(
          "label",
          { className: "dskm-scope" },
          h("span", { className: "dskm-scopeLabel" }, "范围"),
          h(
            "select",
            {
              className: "dskm-select",
              value: pickedCwd ?? "",
              disabled: state.phase === "loading",
              "aria-label": "选择查看哪个项目的 skill",
              onChange: (event) => {
                const value = event?.target?.value;
                setPickedCwd(typeof value === "string" && value !== "" ? value : null);
              }
            },
            h(
              "option",
              { value: "" },
              `当前会话${currentSessionLabel === void 0 ? "" : `（${currentSessionLabel}）`}`
            ),
            workspaceItems.map(
              (item) => h("option", { key: item.path, value: item.path }, `${item.title}（${lastSegment(item.path)}）`)
            )
          )
        ) : null,
        h(
          "button",
          {
            type: "button",
            className: "dskm-btn",
            disabled: state.phase === "loading",
            onClick: () => setNonce((value) => value + 1)
          },
          "刷新"
        )
      )
    ),
    // 分组只以**标签页 + 个数**呈现：规范标签页全部列出（含 0），
    // 但一次只展开一个。这样"空"仍然一眼可见，又不会把内容全堆在页面上。
    tab === void 0 ? null : h(
      "div",
      { className: "dskm-tabs", role: "tablist" },
      tabs.map(
        (entry) => h(
          "button",
          {
            type: "button",
            key: entry.key,
            role: "tab",
            className: entry.key === tab.key ? "dskm-tab dskm-tab--active" : "dskm-tab",
            "aria-selected": entry.key === tab.key ? "true" : "false",
            onClick: () => setPicked(entry.key)
          },
          h("span", null, entry.label),
          h("span", { className: "dskm-tabCount" }, `${entry.items.length}`)
        )
      )
    ),
    tab === void 0 ? null : h(
      "div",
      { className: "dskm-panel" },
      tab.items.length === 0 ? h("div", { className: "dskm-groupEmpty" }, tab.empty) : h(
        "ul",
        { className: "dskm-rows" },
        tab.items.map((skill) => h(SkillCard, { key: skill.name, skill, open, onToggle }))
      )
    )
  );
}
function buildTabs(skills, roots) {
  const all = Array.isArray(skills) ? skills : [];
  const allRoots = Array.isArray(roots) ? roots : [];
  const tabs = [];
  for (const def of TABS) {
    const items = all.filter((skill) => def.groups.includes(skill.group));
    if (def.optional === true && items.length === 0) continue;
    const tabRoots = allRoots.filter((root) => def.groups.includes(root.group));
    tabs.push({
      key: def.key,
      label: def.label,
      groups: def.groups,
      items,
      roots: tabRoots,
      empty: emptyNote(tabRoots)
    });
  }
  return tabs;
}
function emptyNote(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return "没有发现 skill。";
  if (roots.every((root) => root.exists === false)) {
    return "没有发现 skill：这些目录都还不存在。";
  }
  if (roots.some((root) => root.exists === true)) {
    return "没有发现 skill：目录存在，但里面没有合法的 skill。";
  }
  return "没有发现 skill：暂时读不到这些目录。";
}
function apply(ctx) {
  ensureStyles();
  ctx.inject(["slots"], (scope) => {
    scope.slots.inject(
      "settings.section",
      () => scope.slots.register(
        {
          name: "settings.section",
          // list 座位必须给唯一 id（唯一性约束在 (id, priority)，不在 order）。
          id: SECTION_ID,
          // 官方区间：account -10 / general 0 / models 10 / plugins 15 /
          // agent-presets 20；本地 MCP 页占 900。910 → 本页排在 MCP 之后。
          order: 910,
          // label 可以是 thunk（官方会按 locale 重新求值）。
          label: () => SECTION_LABEL
        },
        SkillSection
      )
    );
  });
}

		Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });
		return module.exports;
	}
});
