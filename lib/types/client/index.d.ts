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
import type { ClientContext } from './service-types.ts';
/**
 * 客户端插件体：把「Skills」注册成设置面板里的一个 list 座位条目。
 * @param ctx - 客户端根上下文。
 */
export declare function apply(ctx: ClientContext): void;
