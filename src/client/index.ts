/**
 * 浏览器半边（Client half）——DSH 自带的「懒 CJS」模块协议。
 *
 * 契约（实测自 `@deepseek-ai/dsh-client-modules`、官方 `dsh-client-ui-*` 与既有本地插件）：
 *   1. 产物是普通 classic script（**不是 ESM**）；执行时只做一件事：向
 *      `window.__ModuleLoader__` 注册一个 factory。
 *   2. factory 首次被 materialize 时执行，返回的 exports 就是模块导出。
 *   3. `id` **必须等于**本包 package.json 的 `name` —— 由 `tools/build.ts` 注入，本文件不重复写。
 *   4. `require` 只能取平台种子模块（这里只用 `react`）。
 *
 * 源码里之所以看不到 `window.__ModuleLoader__`：包装层是 `tools/build.ts` 里的一个常量
 * （`wrapClient`）。自己包而不是让打包器直接产出，是为了让包装文本能被自检逐字断言（A5–A7）。
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
 * 去解析权威的 `cwd` 与 preset（详见 `src/host/index.ts`）。
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

import { createElement, useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApiResponse, CatalogPayload, GroupKey, RootRow, SkillBody, SkillRow } from '../shared/types.ts'
import type { ClientContext } from './service-types.ts'

/** `JSX` 的运行时长啥样：`h(...)` 就是 `react.createElement`（classic 风格，不碰 jsx-runtime）。 */
const h = createElement

/** 宿主半边开的同源只读路由。 */
const ROUTE = '/api/skill-manager'
/** 座位身份：`id` 必须是 list 座位里的唯一键；`label` 出现在设置导航上。 */
const SECTION_ID = 'skills'
const SECTION_LABEL = 'Skills'
const STYLE_ELEMENT_ID = 'dsh-skill-manager-styles'

/**
 * 超时预算。没有它的话，一旦宿主侧的目录解析卡住，`fetch` 永不 settle，
 * 页面会永远停在「读取中…」，用户只能刷新整页。
 */
const REQUEST_TIMEOUT_MS = 20000

/**
 * 界面上的分组。
 *
 * **「项目」和「全局」合并成一格**：两者都是"我自己的 skill"，分开摆的结果是
 * 每格都空、还得点两次才能确认"真的没有"。合并后一格就能看全四个根目录。
 *
 * `groups` 是这一格覆盖的**宿主** `group` 取值（宿主仍按 `source` 精确分类，
 * 客户端只决定怎么摆）。数组顺序 = 界面顺序。
 */
interface TabDef {
  key: string
  label: string
  groups: readonly GroupKey[]
  optional?: boolean
}

const TABS: readonly TabDef[] = [
  { key: 'workspace', label: '项目 + 全局', groups: ['project', 'global'] },
  { key: 'custom', label: '自定义', groups: ['custom'] },
  { key: 'bundled', label: '随包内置', groups: ['bundled'] },
  { key: 'other', label: '其他', groups: ['other'], optional: true },
]
// 这里原本还有三张表：`GROUP_HINTS`（根目录占位符说明）、`EXISTS_LABELS`
// （存在/不存在/未判定）、`RESOLVED_LABELS`（作用域解析方式），以及
// `hasProviderFailures()`。**全部已按用户要求删除**：它们是给开发者看的诊断
// （`<projectRoot>/.dsh/skills` 这类占位符、`FsError: cannot list "…app.asar…":
// Cannot mix BigInt and other types` 这类原文），不是给使用者看的内容。
//
// 现在的纪律是：**这一页只呈现「有哪些 skill」，不呈现「我们是怎么查的」**。
// 唯一允许出现的提示是页面级读取失败（那是用户真的需要知道、且能重试的）。

/** 页面相位（互斥，同一时刻只有一个）。 */
interface CatalogState {
  phase: 'loading' | 'ready' | 'failed'
  data?: CatalogPayload | undefined
  error?: string | undefined
}

/**
 * 「展开正文」的相位，独立于页面相位。
 *
 * 刻意保持成宽松的对象形状（每个相位只填自己那几个字段），与原来的 JS 行为一一对应：
 * `name: null` 表示没有展开项。
 */
interface OpenState {
  name: string | null
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  path?: string | undefined
  error?: string | undefined
  content?: string | undefined
  truncated?: boolean | undefined
  contentLength?: number | undefined
}

/** 一个工作区下拉项。`path` 决定宿主扫哪个项目，`title` 只是给人看的。 */
interface WorkspaceItem {
  path: string
  title: string
}

/** 一页标签（含它自己的候选与一句空状态解释）。 */
interface Tab {
  key: string
  label: string
  groups: readonly GroupKey[]
  items: SkillRow[]
  roots: RootRow[]
  empty: string
}

/** 把任意异常整理成给用户看的一句话。 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}s）：宿主没有在预期时间内完成目录读取。`
  }
  return error instanceof Error ? error.message : String(error)
}

function signalOf(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined
}

/**
 * 造一份带可选超时信号的 fetch init。
 *
 * 不能直接写 `{ ...init, signal: signalOf() }`：`exactOptionalPropertyTypes` 下
 * `signal: undefined` 与「没有 signal」是两件事，而 `RequestInit['signal']` 只接受
 * `AbortSignal | null`。这里显式分两路，运行时行为与原来的 JS 一致。
 */
function requestInit(init: RequestInit): RequestInit {
  const signal = signalOf()
  return signal === undefined ? init : { ...init, signal }
}

/**
 * 官方的「当前 session」判据：sessions 快照里 `retainedBy.mainView > 0` 的那一行。
 *
 * 这是有意的**约定**而非字段——`ClientSessions` 明确不管选中态，选中态落在
 * uiWorkspace/uiSession；`mainView` 这个 retention source 由
 * `dsh-client-ui-workspace` 的 `replaceMain()` 写入。全仓 6 处官方代码用同一判据
 * （settings-general / layout / session / workspace / cordis），所以这里照抄。
 *
 * 快照形状来自平台（`unknown`）：这里只读它一个字段，读不到就当"没有主视图会话"。
 * @returns sessionId，或 undefined（基线未到 / 没有主视图会话）。
 */
function findMainSessionId(state: unknown): string | undefined {
  const byId = (state as { byId?: Record<string, unknown> | null } | undefined)?.byId
  if (byId === null || byId === undefined) return undefined
  for (const key of Object.keys(byId)) {
    const row = byId[key] as { id?: unknown; retainedBy?: { mainView?: unknown } | undefined } | undefined
    const retained = row?.retainedBy?.mainView
    if (row !== null && row !== undefined && (typeof retained === 'number' ? retained : 0) > 0) {
      return typeof row.id === 'string' && row.id !== '' ? row.id : key
    }
  }
  return undefined
}

/**
 * `useSessions` / `useWorkspaces` 的公共形状：传一个 selector，取一个值。
 *
 * 参数写成 `unknown` 而不是 `any`：快照形状属于平台，本组件只做**逐字段收窄**，
 * 不假装知道它的完整类型。
 */
type SelectorHook<TValue> = (selector: (snapshot: unknown) => TValue) => TValue | undefined

/**
 * `useSessions` 缺失时的替身。
 *
 * 它**不是** React hook（不调用任何 hook），所以调用它不会影响本组件的 hook 计数；
 * 存在的意义是让「拿到 root kit」与「没拿到」两条路径在源码上长得一样，
 * 免得为了省一次调用而写出条件式 hook 调用。
 */
function useNoSession<TValue>(_selector: (snapshot: unknown) => TValue): TValue | undefined {
  return undefined
}

/**
 * 工作区快照 → 下拉选项。
 *
 * 宿主侧只需要 `path`（它决定扫哪个项目），`title` 只是给人看的。
 * 快照形状（ui-workspace/lib/client.js:434）：{ workspaceId, path, title, sessionIds, createdAt }。
 * 没有清单、或基线还没到（`items` 为空）时返回空数组——界面就只剩"当前会话"一项。
 */
function listWorkspaceItems(state: unknown): WorkspaceItem[] {
  const items = (state as { items?: readonly unknown[] | undefined } | undefined)?.items
  if (!Array.isArray(items)) return []
  const out: WorkspaceItem[] = []
  for (const item of items) {
    const row = item as { path?: unknown; title?: unknown } | undefined
    const path = typeof row?.path === 'string' ? row.path : ''
    const title = typeof row?.title === 'string' && row.title !== '' ? row.title : lastSegment(path)
    if (path === '') continue
    out.push({ path, title })
  }
  return out
}

/** 路径最后一段（两种分隔符都认）。用来给工作区起个短名。 */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut < 0 ? trimmed : trimmed.slice(cut + 1)
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
`

/**
 * 幂等注入样式表。
 *
 * 用固定 id + 「已存在就复用」而不是每次 append：客户端半边**会热重载**，
 * 每次 HMR 都 append 一份会让样式表无界增长。
 */
function ensureStyles(): void {
  if (typeof document === 'undefined' || document.head === null) return
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing !== null) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ELEMENT_ID
  style.textContent = CSS
  document.head.append(style)
}

/** `null` / `undefined` 都表示"看当前会话"——必须转成"不传"，否则会把字符串 "null" 当路径发出去。 */
function normalizeCwd(cwd: string | null | undefined): string | undefined {
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * 读一次目录。
 *
 * `sessionId` 决定 scope（不传就落到宿主降级路径）；`cwd` **只在用户显式换了
 * 项目时才传** —— 宿主侧 `options.cwd` 优先于 session header 的权威 cwd。
 * 不传就是"当前会话"，宿主自己取权威 cwd，客户端不掺和。
 */
async function fetchCatalog(sessionId: string | undefined, cwd: string | null): Promise<CatalogPayload> {
  const params = new URLSearchParams()
  if (sessionId !== undefined) params.set('sessionId', sessionId)
  const effectiveCwd = normalizeCwd(cwd)
  if (effectiveCwd !== undefined) params.set('cwd', effectiveCwd)
  const query = params.toString() === '' ? '' : `?${params.toString()}`
  const response = await fetch(
    `${ROUTE}${query}`,
    requestInit({ headers: { accept: 'application/json' } }),
  )
  const body = (await response.json().catch(() => null)) as ApiResponse<CatalogPayload> | null
  if (body === null || body.ok !== true) {
    throw new Error((body === null || body.ok !== false ? undefined : body.error) ?? `宿主返回 HTTP ${response.status}`)
  }
  return body.data
}

/** 读一份 skill 正文。带 `sessionId`/`cwd` 是为了用**同一个视图**解析，避免「列表有、点开没有」。 */
async function fetchSkill(sessionId: string | undefined, name: string, cwd: string | null): Promise<SkillBody> {
  const response = await fetch(
    ROUTE,
    requestInit({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', name, sessionId, cwd: normalizeCwd(cwd) }),
    }),
  )
  const body = (await response.json().catch(() => null)) as ApiResponse<SkillBody> | null
  if (body === null || body.ok !== true) {
    throw new Error((body === null || body.ok !== false ? undefined : body.error) ?? `宿主返回 HTTP ${response.status}`)
  }
  return body.data
}

/** 小徽标。 */
function badge(text: string): ReactNode {
  return h('span', { className: 'dskm-badge', key: text }, text)
}

/**
 * 这一行为什么不给模型自动调用——**照实说**，不把两种情形塞进一句话。
 *
 * 官方那两个 frontmatter 键本来就是两条独立通道：
 *
 * | 键 | 关掉之后 |
 * |---|---|
 * | `disable-model-invocation: true` | 模型看不到它（不在模型目录，`skill` 工具也调不到） |
 * | `user-invocable: false` | 人手输入的 `/名字` 也看不到它 |
 *
 * 所以"模型关着"有两副面孔：作者只想让**人**用（`仅 /命令 可用`），或者两条都不给
 * （`模型与 /命令 都不可用`——本机 `~/.dsh/skills/ask-matt` 就是这一种，两个键都写了）。
 * 一律写成「仅用户可调用」对后一种是**假话**：把"你能 `/` 调它"说成事实，比不说话更糟。
 * @returns 徽标文案；开着模型调用时返回 undefined（那就什么也不用说）。
 */
function modelHint(skill: SkillRow): string | undefined {
  if (skill.modelInvocable !== false) return undefined
  return skill.userInvocable === false ? '模型与 /命令 都不可用' : '仅 /命令 可用'
}

interface SkillCardProps {
  skill: SkillRow
  open: OpenState
  onToggle: (skill: SkillRow) => Promise<void>
}

/**
 * 一条 skill。点击展开正文——正文按需拉取，不跟着列表一起下来
 * （一个 skill 的 `SKILL.md` 可能几十 KB，全量预取会把列表拖垮）。
 */
function SkillCard({ skill, open, onToggle }: SkillCardProps): ReactNode {
  const expanded = open.name === skill.name && open.phase !== 'idle'
  const hint = modelHint(skill)
  return h(
    'li',
    { className: 'dskm-card' },
    h(
      'div',
      { className: 'dskm-row' },
      h(
        'div',
        { className: 'dskm-meta' },
        h('div', { className: 'dskm-name', title: skill.name }, skill.name),
        h(
          'div',
          { className: 'dskm-desc', title: skill.description },
          skill.description === '' ? '（无描述）' : skill.description,
        ),
      ),
      h(
        'div',
        { className: 'dskm-badges' },
        badge(skill.provider ?? skill.source),
        hint === undefined ? null : badge(hint),
        h(
          'button',
          {
            type: 'button',
            className: 'dskm-btn',
            onClick: () => onToggle(skill),
            'aria-expanded': expanded ? 'true' : 'false',
          },
          expanded ? '收起' : '查看',
        ),
      ),
    ),
    expanded ? h(SkillDetail, { open, skill }) : null,
  )
}

interface SkillDetailProps {
  open: OpenState
  skill: SkillRow
}

/** 展开后的正文面板。三种相位各自只有一个渲染点（错误不重复渲染）。 */
function SkillDetail({ open, skill }: SkillDetailProps): ReactNode {
  const pathLine = open.path ?? skill.path
  return h(
    'div',
    { className: 'dskm-detail' },
    pathLine === undefined ? null : h('div', { className: 'dskm-path dskm-mono' }, pathLine),
    open.phase === 'loading' ? h('div', { className: 'dskm-empty' }, '读取中…') : null,
    open.phase === 'failed' ? h('div', { className: 'dskm-notice dskm-notice--error' }, open.error) : null,
    open.phase === 'ready'
      ? h(
          'div',
          null,
          h('pre', { className: 'dskm-pre' }, open.content),
          open.truncated === true
            ? h('div', { className: 'dskm-path' }, `正文过长，已截断显示（完整 ${String(open.contentLength)} 字符）。`)
            : null,
        )
      : null,
  )
}

/** 座位组件的 props：root kit 能提供的两个 selector hook（拿不到就退化成 `useNoSession`）。 */
interface SkillSectionProps {
  useSessions?: unknown
  useWorkspaces?: unknown
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
function SkillSection(props: SkillSectionProps): ReactNode {
  // 无论有没有 root kit，都走同一个调用序列（见 useNoSession 注释）。
  const useSessions: SelectorHook<string | undefined> =
    typeof props?.useSessions === 'function'
      ? (props.useSessions as SelectorHook<string | undefined>)
      : useNoSession
  const sessionId = useSessions(findMainSessionId)
  // root kit 还提供 `useWorkspaces`（活台账 standardProps 已确认）——
  // 这是「切换查看哪个项目」的数据源。快照形状来自 ui-workspace/lib/client.js:434：
  // 每项 { workspaceId, path, title, sessionIds, createdAt }。
  const useWorkspaces: SelectorHook<WorkspaceItem[]> =
    typeof props?.useWorkspaces === 'function'
      ? (props.useWorkspaces as SelectorHook<WorkspaceItem[]>)
      : useNoSession
  const workspaceItems = useWorkspaces(listWorkspaceItems) ?? []

  const [state, setState] = useState<CatalogState>({ phase: 'loading' })
  const [open, setOpen] = useState<OpenState>({ name: null, phase: 'idle' })
  const [nonce, setNonce] = useState(0)
  // `null` = 用户还没点过标签页，此时按"第一个非空分组"取默认选中（见下方 activeTab）。
  const [picked, setPicked] = useState<string | null>(null)
  // `null` = 看当前会话（宿主自己取权威 cwd）。选了别的项目才显式传 cwd。
  const [pickedCwd, setPickedCwd] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })
    // 切换 session/项目时把展开态收掉：正文属于上一个视图，留着会串。
    setOpen({ name: null, phase: 'idle' })
    fetchCatalog(sessionId, pickedCwd)
      .then((data) => {
        if (alive) setState({ phase: 'ready', data })
      })
      .catch((error: unknown) => {
        if (alive) setState({ phase: 'failed', error: describeError(error) })
      })
    return () => {
      alive = false
    }
  }, [sessionId, nonce, pickedCwd])

  const onToggle = useCallback(
    (skill: SkillRow): Promise<void> => {
      if (open.name === skill.name && open.phase !== 'idle') {
        setOpen({ name: null, phase: 'idle' })
        return Promise.resolve()
      }
      setOpen({ name: skill.name, phase: 'loading' })
      // 返回 promise：调用方（以及自检的渲染测试）可以 await 到正文落定。
      return fetchSkill(sessionId, skill.name, pickedCwd)
        .then((data) =>
          setOpen({
            name: skill.name,
            phase: 'ready',
            path: data.path,
            content: data.content,
            truncated: data.truncated,
            contentLength: data.contentLength,
          }),
        )
        .catch((error: unknown) => setOpen({ name: skill.name, phase: 'failed', error: describeError(error) }))
    },
    [sessionId, pickedCwd, open.name, open.phase],
  )

  const data = state.phase === 'ready' ? state.data : undefined
  const tabs = data === undefined ? [] : buildTabs(data.skills, data.roots)
  // 选中的标签页：用户点过就用他点的；否则**默认落在第一个非空的那一格**，
  // 免得一进来正好停在一个空标签页上，看起来又像"没有 skill"。
  // 用 `picked === null` 表示"还没点过"，这样不用为默认值写 effect。
  const activeTab: Tab | undefined =
    tabs.find((tab) => tab.key === picked) ?? tabs.find((tab) => tab.items.length > 0) ?? tabs[0]
  // `data` 与 `activeTab` 都就绪时才画标签页。这里用 `tab === undefined ? null : …` 而不是
  // `showTabs ? … : null`：后者在类型上根本收窄不了 `activeTab`，读 `activeTab.key` 会被判为
  // 可能 undefined —— 换成对 `tab` 本身的判别式，行为一字不变（两者等价）。
  const tab = data !== undefined ? activeTab : undefined
  // 「当前会话」那项的括号里显示什么：优先用宿主回传的 cwd（它才是实际生效的），
  // 没有就显示当前会话的项目目录名。仅在未切换范围时有意义。
  const currentSessionLabel = pickedCwd === null && data?.cwd !== undefined ? lastSegment(data.cwd) : undefined

  return h(
    'div',
    { className: 'dskm-page' },
    h('div', { className: 'dskm-heading' }, h('h2', { className: 'dskm-title' }, 'Skills')),

    // 页面级读取失败是**唯一**允许出现的提示：用户需要知道，且能点「刷新」重试。
    // 提供方原文、作用域/cwd/提供方/完整性这些诊断**一律不再渲染**（用户要求）。
    state.phase === 'failed' ? h('div', { className: 'dskm-notice dskm-notice--error' }, state.error) : null,

    h(
      'div',
      { className: 'dskm-toolbar' },
      h(
        'div',
        { className: 'dskm-toolbarText' },
        state.phase === 'loading' ? '读取中…' : data === undefined ? '' : `共 ${data.skills.length} 个 skill`,
      ),
      h(
        'div',
        { className: 'dskm-actions' },
        // 范围选择：看当前会话，还是看某个工作区的 skill。
        // 值就是**工作区路径**——它决定宿主扫哪个项目；不传 = 当前会话。
        workspaceItems.length > 0
          ? h(
              'label',
              { className: 'dskm-scope' },
              h('span', { className: 'dskm-scopeLabel' }, '范围'),
              h(
                'select',
                {
                  className: 'dskm-select',
                  value: pickedCwd ?? '',
                  disabled: state.phase === 'loading',
                  'aria-label': '选择查看哪个项目的 skill',
                  onChange: (event: { target?: { value?: unknown } | null }) => {
                    const value = event?.target?.value
                    // 空串 = 回到「当前会话」。
                    setPickedCwd(typeof value === 'string' && value !== '' ? value : null)
                  },
                },
                h(
                  'option',
                  { value: '' },
                  `当前会话${currentSessionLabel === undefined ? '' : `（${currentSessionLabel}）`}`,
                ),
                workspaceItems.map((item) =>
                  h('option', { key: item.path, value: item.path }, `${item.title}（${lastSegment(item.path)}）`),
                ),
              ),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dskm-btn',
            disabled: state.phase === 'loading',
            onClick: () => setNonce((value) => value + 1),
          },
          '刷新',
        ),
      ),
    ),

    // 分组只以**标签页 + 个数**呈现：规范标签页全部列出（含 0），
    // 但一次只展开一个。这样"空"仍然一眼可见，又不会把内容全堆在页面上。
    tab === undefined
      ? null
      : h(
          'div',
          { className: 'dskm-tabs', role: 'tablist' },
          tabs.map((entry) =>
            h(
              'button',
              {
                type: 'button',
                key: entry.key,
                role: 'tab',
                className: entry.key === tab.key ? 'dskm-tab dskm-tab--active' : 'dskm-tab',
                'aria-selected': entry.key === tab.key ? 'true' : 'false',
                onClick: () => setPicked(entry.key),
              },
              h('span', null, entry.label),
              h('span', { className: 'dskm-tabCount' }, `${entry.items.length}`),
            ),
          ),
        ),

    tab === undefined
      ? null
      : h(
          'div',
          { className: 'dskm-panel' },
          tab.items.length === 0
            ? h('div', { className: 'dskm-groupEmpty' }, tab.empty)
            : h(
                'ul',
                { className: 'dskm-rows' },
                tab.items.map((skill) => h(SkillCard, { key: skill.name, skill, open, onToggle })),
              ),
        ),
  )
}

// 这里原本有 `RootLines`（根目录清单：真实路径 + 存在性）与 `ViewFacts`
// （作用域 / 预设 / cwd / 项目根 / 提供方 / 完整性）。**两者整体删除**：
// 它们是排查用的诊断面板，不是给使用者看的内容（用户原话：
// 「把冗余提示都去掉，这是作为使用者不用看到的内容」）。
//
// 存在的「空」仍然照常可见——标签页上带着个数，点开后由 `emptyNote` 用一句
// 大白话说明是哪一种空。**「空」和「不存在」依然分得开**，只是不再甩路径和标签。

/**
 * 把宿主的 `group` 字段装配成界面上的标签页。
 *
 * **规范标签页永远返回**（哪怕为空），`other` 只在真有内容时出现。
 * 每一格带上：自己的候选、以及一句空状态解释（`roots` 只用来选这句话，
 * 不再渲染路径）。
 */
function buildTabs(skills: readonly SkillRow[], roots: readonly RootRow[]): Tab[] {
  const all: readonly SkillRow[] = Array.isArray(skills) ? skills : []
  const allRoots: readonly RootRow[] = Array.isArray(roots) ? roots : []
  const tabs: Tab[] = []
  for (const def of TABS) {
    const items = all.filter((skill) => def.groups.includes(skill.group))
    if (def.optional === true && items.length === 0) continue
    const tabRoots = allRoots.filter((root) => def.groups.includes(root.group))
    tabs.push({
      key: def.key,
      label: def.label,
      groups: def.groups,
      items,
      roots: tabRoots,
      empty: emptyNote(tabRoots),
    })
  }
  return tabs
}

/** 这一格为什么空——三种原因分开说，否则用户只能猜。**不出现任何路径**。 */
function emptyNote(roots: readonly RootRow[]): string {
  if (!Array.isArray(roots) || roots.length === 0) return '没有发现 skill。'
  if (roots.every((root) => root.exists === false)) {
    return '没有发现 skill：这些目录都还不存在。'
  }
  if (roots.some((root) => root.exists === true)) {
    return '没有发现 skill：目录存在，但里面没有合法的 skill。'
  }
  return '没有发现 skill：暂时读不到这些目录。'
}

/**
 * 客户端插件体：把「Skills」注册成设置面板里的一个 list 座位条目。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ensureStyles()
  // 只注入 slots：数据面走同源 fetch，不需要 remote / connection 注入。
  // 用 ctx.inject 而不是模块级 inject，是为了在缺 slots 的宿主里保持 inactive
  // 而不是激活后抛错（与 dsh-mcp-manager 同一写法）。
  ctx.inject(['slots'], (scope) => {
    // 必须走 inject：`settings.section` 由官方 settings-general 的
    // `sidebar.settings.children` 声明，未声明的座位直接 register 会抛
    // `slot "..." is not declared`。inject 会等声明就绪。
    scope.slots.inject('settings.section', () =>
      scope.slots.register(
        {
          name: 'settings.section',
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
    )
  })
}
