# dsh-skill-manager

DSH Web 客户端插件：在**设置面板**里加一页「Skills」，**只读**浏览当前会话可见的 skill，
按来源分组（项目 / 全局 / 自定义 / 随包内置）。

**第一阶段范围**：只做查看。没有任何创建、编辑、删除、启停路径——没有
`ctx.configEditor.edit()`，不碰 `~/.dsh/profiles/**`，不碰 `ctx.loader.*`。
`tools/verify.mjs` 的 A11–A15 就是钉这条纪律的。

```powershell
node tools/verify.mjs      # 期望 PASS 141/141
```

---

## 1. 双半结构

| 半边 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 零 import。用 `ctx.connection.fetch.register()` 开一条只读路由 `/api/skill-manager`，内部解析作用域后读 `ctx.skills`。 |
| 客户端 | `lib/client.js` | `window.__ModuleLoader__` 懒 CJS bundle。往 `settings.section`（list 座位，`order: 910`）注册一页，同源 `fetch` 取数并渲染。 |

---

## 2. 为什么必须有宿主半边（通道选型）

`ctx.skills`（`@deepseek-ai/dsh-skill`）**没有任何 `@Remote` 方法**，浏览器半边够不着它。

官方确实有一条客户端入口：`ctx.remote.skills.list({ sessionId })`，宿主实现就是
`@deepseek-ai/dsh-api-session-controller` 的 `SessionSkillCatalog`。但它**故意裁掉了
`source` / `provider` / `invocation`**：

```js
// dsh-api-session-controller/lib/types/skill-catalog.js:163-169
skills: skills.map(skill => ({
    name: skill.name,
    ...skill.path === undefined ? {} : { path: skill.path },
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    modelInvocable: skill.invocation.modelInvocable,
}))
```

而「全局 vs 项目」的**唯一权威依据就是 `source`**。所以第一阶段选了自建路由，
返回完整摘要。代价是多一个半边；收益是分组是数据驱动的，不靠猜路径前缀。

（另一条备选是只用官方 Remote、展示成不分组的平铺列表——那就不需要 `lib/index.js`。
本仓库没有选它，因为「按全局/项目分组」正是本阶段的目标。）

---

## 3. 关键约束：**读 skill 必须带 scope**

`@deepseek-ai/dsh-skill` 的层语义（`lib/index.js:110-116`）：

> A registration files into the layer of its calling context's scope (scopeOf): host rows and
> repository plugins land in the **global layer**, while a plugin mounted by an **agent preset's
> standing composition** lands in **that preset's layer**. A read merges the global layer with
> the viewing scope's chain.

而本机 profile 里 `skill-filesystem` 恰恰**不在宿主根上**：

| 位置 | 状态 |
|---|---|
| `cordis.yml:245-246` 顶层 `skill-filesystem` | `include:skill-filesystem` → **enabled: false** |
| `cordis.yml:1317-1323` `cordis` preset 内 | **活的**，`customSkillDirs` 指向 `@deepseek-ai/dsh-agent-preset/skills` |

`plugin_manager` 的实测输出印证了这一点：`include:skill-filesystem` 是
`{"enabled":false,"fiberPhase":null}`。

**结论**：不带 `scope` 读 `ctx.skills` 只会合并全局 layer，那里**一个提供方都没有** →
**空表**。这不是"可能"，是本机的确定行为。

### 3.1 作用域解析链（逐字对齐官方）

解析流程照抄官方 `SessionSkillCatalog.list()` 那条被验证过的链路，只做两处扩展：
允许显式指定 `preset` / `cwd`，以及没有活 Agent 时用 `acquireScope()` 取冷读租约。

| 路径 | 触发条件 | scope | 注册表 | `resolvedBy` |
|---|---|---|---|---|
| 1 | `sessionId` 命中**活 Agent** | **那个 Agent 对象** | `agentPresets.serviceFor(agent, 'skills')` | `session-agent` |
| 2 | 有 `agentPresets` | `acquireScope(presetId).key`（**读完释放**） | `ctx.skills` | `preset-lease` |
| 3 | 都不行 | `undefined` | `ctx.skills` | `global-layer` |

官方原文的对应关系（`skill-catalog.js:151-161`）：

```js
const live = this.ctx.agents.get(sessionId);
const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills');
const skillRegistry = scoped ?? this.ctx.get('skills');
const lease = live === undefined ? await this.scopeFor(agentPreset) : undefined;
const scope = live ?? lease?.key;
const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable);
```

注意 `const scope = live ?? lease?.key`——**活 Agent 对象本身就是合法的 scope key**
（`dsh-agent/lib/index.js:232` 的 `scopeTarget(agent, agent)`）。

两处刻意的差异：

1. **不过滤 `isUserInvocable`。** 官方那条 Remote 服务的是 `/` 补全菜单，只该给用户可调用的；
   只读浏览页应当**全部显示**，包括 `disable-model-invocation` 的 skill。B33/B34 钉这条。
2. **cwd 从 `SessionHeader` 取，不从 projection 取。** 官方走
   `observation.projections.values.agentPreset` 并要求 `projections` 存在（不存在就抛错）；
   `SessionHeader` 本身就有 `cwd` 与 `agentPreset`，少一个失败点。projection 仍作第二来源。

### 3.2 cwd 只能来自 session

宿主侧**没有「当前工作区」这个概念**——选择留在客户端的 `uiWorkspace.selection` 里，
`workspaceRegistry` 只能给出"全部工作区"。所以正路是客户端把 `sessionId` 传上来，
宿主用 `sessionQuery.observeSession(sessionId)` 取权威 `header.cwd`。

`workspaceRegistry.list()[0]?.path` 只作最后的兜底，且**没有 sessionId 时如实报
`cwd: undefined`**，不编一个猜来的路径（B39 钉这条）。

`observeSession()` 返回的是 **caller-owned observation 租约**（`Disposable`），
`acquireScope()` 返回的是 **revision 租约**，两者都必须读完即放（B10/B20 钉这条）。

---

## 4. 分组语义

`source` 取值与根目录的对应关系来自 `dsh-skill-filesystem/README.zh.md`「根目录与优先级」：

| Rank | `source` | 根目录 | 本插件归组 |
|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | **项目** |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | **项目** |
| 300 | `custom` | `Config.customSkillDirs` | 自定义 |
| 400 | `user-dsh` | `<dshHome>/skills` | **全局** |
| 500 | `user-agents` | `<agentsHome>/skills` | **全局** |
| 600 | `bundled` | `<bundledSkillDir>` / `$DSH_BUNDLED_SKILL_DIR` | 随包内置 |

（`projectRoot` = 最近的含 `.git` 的祖先目录，没有则用 cwd。）

`custom` / `bundled` / `runtime` **不硬塞进项目或全局**：本机 `customSkillDirs` 指向
`@deepseek-ai/dsh-agent-preset/skills`，把那里的随包 skill 谎报成"项目 skill"是错的。
未识别的 source 落 `other` 并原样显示标签。

分组由**宿主**算（`lib/index.js` 的 `GROUPS`），客户端不重新推导——两边各推一次必然漂。

---

## 5. 接口契约

`/api/skill-manager`，挂在 webServer 的 `/api` 之下，因此自带 Host/Origin 围栏与浏览器鉴权，
同源 `fetch` 即可，**不需要自建 token**。

### `GET ?sessionId=<id>&preset=<id>&cwd=<path>`

三个查询参数都可选；`sessionId` 是唯一重要的那个。

```jsonc
{
  "ok": true,
  "data": {
    "skills": [{
      "index": 0,
      "name": "cordis-plugin-development",
      "description": "…",
      "whenToUse": "…",              // 可选
      "path": "C:/…/SKILL.md",       // 可选
      "source": "custom",
      "group": "custom",            // project | global | custom | bundled | other
      "provider": "filesystem",
      "modelInvocable": true,
      "userInvocable": true,
      "resourceKind": "directory"    // 可选
    }],
    "counts": { "project": 0, "global": 0, "custom": 3, "bundled": 0, "other": 0 },
    // 按提供方汇总。`complete:false` 时这是唯一能指向"是谁没交作业"的线索。
    "providers": { "filesystem": 3, "dsh-office": 3 },
    // 规范根目录清单：真实路径 + 存在性（true/false/undefined=未判定）。
    // 没有它，「分组是空的」和「分组没实现」在界面上看不出区别。
    "roots": [
      { "group": "project", "source": "project-dsh", "path": "D:/project/demo/.dsh/skills", "exists": false },
      { "group": "project", "source": "project-agents", "path": "D:/project/demo/.agents/skills", "exists": false },
      { "group": "global", "source": "user-dsh", "path": "C:/Users/admin/.dsh/skills", "exists": false },
      { "group": "global", "source": "user-agents", "path": "C:/Users/admin/.agents/skills", "exists": true },
      // 这两个根的位置由配置决定，宿主读不到展开后的值 → 只给说明，不编路径。
      { "group": "custom", "source": "custom", "note": "由 Config.customSkillDirs 决定" },
      { "group": "bundled", "source": "bundled", "note": "随包分发 / 运行时注册" }
    ],
    "projectRoot": "D:/project",     // 从 cwd 向上找到的含 .git 的祖先；无 cwd 时为 undefined
    "complete": true,               // false = 某根目录扫描失败/未完成，列表可能不完整
    "resolvedBy": "session-agent",   // session-agent | preset-lease | global-layer
    "presetId": "cordis",           // 可选
    "cwd": "D:/project/…",          // 可选；无 sessionId 时为 undefined
    "route": "/api/skill-manager",
    "capabilities": ["snapshot", "read"]
  }
}
```

`complete` 来自 `ctx.skills.snapshot()`（而不是 `list()`）——只有 `snapshot()` 会告诉你
**这次发现是否完整**，UI 据此明说"列表可能不完整"。

### `POST { "op": "read", "name": "<skill>", "sessionId": "<id>" }`

返回 `{ name, path?, content, truncated, contentLength }`。用**同一个视图**解析
（同一个 scope/cwd），否则会出现"列表里有、点开说没有"。正文上限 200 000 字符。

失败一律 `4xx/5xx` + `{ ok: false, error }`，错误原文直接给用户看。未知 `op` → 400。

---

## 6. 接线方式（**当前尚未接线，需要你决定**）

本插件**还没有挂进 profile**。宿主半边不参与热重载，挂载要重启 DSH——这两件事都不该我替你做。

接线方式与同目录的 `dsh-mcp-manager` 完全一致（「路径行」：Loader 行指向磁盘上的宿主入口，
不需要 pnpm / node_modules），在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里加：

```yaml
# ---------------------------------------------------------------------------
# skill 只读浏览插件：在设置面板加一页「Skills」（order 910，排在 MCP 页之后）。
#   - 宿主半边：D:\project\dsh-plugins\dsh-skill-manager\lib\index.js
#     （零 import；用 ctx.connection.fetch.register 开 /api/skill-manager）
#   - 客户端 bundle 由 @deepseek-ai/dsh-client-modules 从该包 package.json 的
#     exports["./client"] 定位，并由 Host 在 /plugins 下发布。
# 自检：node D:\project\dsh-plugins\dsh-skill-manager\tools\verify.mjs
# 移除：删掉下面这个条目即可（settings.section 是 list 座位，不遮蔽任何官方 UI）。
# ---------------------------------------------------------------------------
- insert:
    - id: dsh-skill-manager
      name: 'file:///D:/project/dsh-plugins/dsh-skill-manager/lib/index.js'
```

注意：**补丁层新增条目必须用 `insert:` 追加**；裸 `- id: ...` 会被当作"覆写已存在条目"，
目标不存在时 warn 并丢弃。

---

## 7. 已实测 / 未实测（严格区分）

### 7.1 已实测

| 项 | 证据 |
|---|---|
| `settings.section` 是 `kind: list` / `scope: root`，注册字段只有 `id`(必填)/`order`/`label`，**没有 `icon`** | `Slots.listSubTree` 活台账 |
| 该座位当前占用者：`account/-10`、`general/0`、`models/10`、`plugins/15`、`agent-presets/20`、`mcp/900`（`mcp` = 本地插件 `dsh-mcp-manager`） | 同上，所以 `order: 910` 排在 MCP 之后 |
| 该座位的 `standardProps` **包含 `useSessions`**；`ownerProps` 只有 `{ close }` | 同上（客户端「当前 session」判据的来源） |
| `ctx.skills` / `ctx.agentPresets` / `ctx.agents` / `ctx.sessionQuery` / `ctx.connection` 都存在 | Host `Service.listService` |
| `include:skill-filesystem` 在宿主顶层 `enabled:false`；活的实例在 preset 内 | `plugin_manager(list_plugins)` + `cordis.yml:1317-1323` |
| 官方 skill 根目录 rank 表 | `dsh-skill-filesystem/README.zh.md:50-56`（**修复解包偏移后复核**，见 §9） |
| 官方作用域解析链 | `dsh-api-session-controller/lib/types/skill-catalog.js:116-185` |
| `source` / `provider` 被官方 Remote 裁掉 | 同文件 `:163-169` |
| 座位声明在 `sidebar.settings.children` 里，未声明的座位直接 register 会抛错 | `dsh-client-ui-settings-general/lib/client.js:1136-1139` |
| `navIcon(id)` 硬编码查表、未知 id 兜底齿轮 | 同文件 `:244-270` |
| 挂载后 `dsh --profile web --patch <改后的补丁文件> --dump-config` 仍 exit 0（真实 Loader 接受该文件） | 见 §6 |
| **页面在真实 GUI 里渲染成功**：设置导航出现「Skills」；`resolvedBy=session-agent`、`presetId=cordis`、`cwd` 正确 | 用户 2026-10-12 实测截图 |
| **本机确实没有项目/全局 skill**：`.dsh/skills`、`.agents/skills`（项目侧）与 `~/.dsh/skills` 都不存在，`~/.agents/skills` 存在但为空 | 直接列目录 |
| **`dsh-skill-office` 显式以 `source:"bundled"` 注册**（不是文件系统根） | `dsh-skill-office/lib/index.js:71` + `BUNDLED_SKILL_RANK` |
| 本插件自身：**170/170 断言全绿**，且 **17/17 反向验证**逐条精确报错 | `node tools/verify.mjs` |

### 7.1.1 第一次实测发现的上游问题（**不是本插件的 bug**）

截图里 `完整性 未完成`、且只有 4 个 `bundled` skill、看不到 preset 自带的
`cordis-plugin-development` 等 —— 这是 profile 里 `skill-filesystem` 的
`customSkillDirs` 解析失败：

```js
// cordis.yml 的 cordis preset 段（第 1330-1336 行）
customSkillDirs:
  - !!js >-
    process.getBuiltinModule('node:path').join(
      process.getBuiltinModule('node:path').dirname(
        process.getBuiltinModule('node:module').createRequire(baseUrl)
          .resolve('@deepseek-ai/dsh-agent-preset/package.json')),
      'skills')
```

复现（假设 `baseUrl` = profile 的 `cordis.yml` URL）：

```
createRequire('file:///C:/Users/admin/.dsh/profiles/desktop/cordis.yml')
  .resolve('@deepseek-ai/dsh-agent-preset/package.json')
  → MODULE_NOT_FOUND
```

因为 profile 的 `node_modules/@deepseek-ai` 里只有 `cosmokit / dsh-web-search-exa /
schemastery`，从 profile 目录逐级向上都找不到 `dsh-agent-preset`。

**独立佐证**（不依赖 `baseUrl` 的假设）：本会话的 `skill` 工具加载
`cordis-plugin-development` 返回 `unknown or no longer available`
—— 活的 skill 目录里确实没有它。所以 `完整性 未完成` 是本插件**如实报出**了
这个上游状态。修不修、怎么修属于 profile 配置，本插件不越界。

### 7.1.2 第一次实测发现的本插件缺陷（已修）

| 缺陷 | 现象 | 修法 |
|---|---|---|
| **只渲染非空分组** | 本机没有项目/全局 skill，于是「项目」「全局」两节**整块消失**，用户看到一片空白，判断为"没有全局和项目的管理" | 四个规范分组**永远渲染**（`other` 除外），各带真实根目录路径与存在性 |
| 徽标重复分组名 | `bundled` 徽标与「随包内置」分组并排，让人以为分类错了 | 徽标改显示**提供方**（`dsh-office` / `filesystem`） |
| `未完成` 不可操作 | 只说"某个根目录扫描失败"，不知道是哪个 | 新增「提供方」汇总行；期望的文件系统提供方不在里面就是它的根没扫成功 |
| 四组内容平铺 | 四个分组各自铺开、还各带一行根目录说明，一屏放不下；而且未接到新宿主时显示的是 `<projectRoot>` 这类**占位符**，又长又没信息量 | 改为**标签页 + 个数**：四个分组永远列出（含 `0`），一次只展开一个；根目录说明跟着选中分组走。默认落在**第一个非空**分组上，不会一进来就停在空标签页 |

### 7.2 未实测（不要当成已完成）

| 项 | 为什么没测 | 怎么补 |
|---|---|---|
| **修复后的页面（170/170 这一次）** | 新增的 `roots`/`providers`/`projectRoot` 由**宿主**产出，而宿主半边不热重载 —— 必须重启 DSH 才看得到 | 重启 DSH 后看 设置 → Skills |
| **`ctx.fs` 在真实宿主里对工作区外路径的行为** | 自检里是替身。真实沙箱可能拒绝 `lstat` 工作区之外的路径 → 存在性会显示「未判定」而不是「不存在」 | 重启后看根目录那一栏；全是「未判定」就是这个原因 |
| **`agentPresets.acquireScope(默认 preset)` 在本 profile 是否成功** | 实测走的是活 Agent 路径（已成功），冷读租约那条一次都没被触发 | 不选 session 直接看页面 |
| **preset 自带 skill 能否恢复** | 取决于上游 `customSkillDirs` 的修复（见 7.1.1） | 修好 profile 后「自定义」分组会出现内容 |
| **深浅两套主题下的实际观感** | 主题切换未测 | 切换主题看一遍 |
| `B52` 截断边界之外的超大正文 | 只测了 200010 字符一例 | 可选 |

**安装与座位注册本身不等于"用户能看见"。** 没有实测的部分必须明说。

---

## 8. 已知边界（不要试图"修好"）

| 边界 | 说明 |
|---|---|
| **导航图标不可由插件提供** | 注册字段白名单里没有 `icon`，`navIcon(id)` 对未知 id 一律兜底成齿轮。本页因此显示齿轮。`dsh-mcp-manager` 用「给自己那一格打 data 属性 + CSS 覆盖」绕过去了，本插件**刻意不学**——那条路依赖官方 DOM 结构，官方一改就静默失效。若官方将来支持 `icon`，改用注册参数。 |
| **未接 `ctx.locale`** | 官方 practices 要求用户可见文案走 Client locale 服务。本插件文案硬编码中文，与同目录的 `dsh-mcp-manager` 一致。这是一处**有意的偏离**。 |
| 宿主半边不热重载 | `dsh-hmr` 只监听 DSH 安装目录与 profile 补丁文件；本仓库目录不在其中，且 Node 的 ESM 按 URL 缓存模块。改 `lib/index.js` 必须重启 DSH。 |
| 客户端半边会热重载 | 但**只在 `pnpm run dev:web` 也在跑**时，client-plugin 变更才会免刷新生效；否则要刷新页面。 |
| `order` 不保证"永远最后" | 910 只是大于 MCP 的 900。别的插件开更大就会排到后面。 |
| 同 `(id, priority)` 冲突会抛错 | `id` 的唯一性约束在 `(id, priority)`；`order` 可以重复。所以 `id: "skills"` 不能与别的插件重名。 |
| 无 session 时没有权威 cwd | 宿主没有「当前工作区」概念。此时 `cwd: undefined`，项目类 skill 可能少列——`resolvedBy` 会如实说明。 |
| 项目范围 = 最近 `.git` 祖先 | 上游约束，不支持 monorepo 子项目选择；没有 `.git` 的工作区回退到 cwd。 |

---

## 9. 证据索引：怎么从 app.asar 里取官方源码

官方源码在 `D:\Program Files\DeepSeek Harness\resources\app.asar` 里。`read` 工具直接读会失败，
必须先解包。asar 的头部布局：

```
[0..3]   UInt32LE = 4
[4..7]   UInt32LE = size pickle 的值
[8..11]  UInt32LE = header string pickle 的 payload = 4 + strLen
[12..15] UInt32LE = strLen
[16..]   JSON 目录，然后是数据区
```

**数据区偏移 = `16 + strLen`。**

> ⚠️ 本次踩到的坑：一开始写成 `8 + payloadSize`（= `12 + strLen`），**整整少 4 字节**。
> 症状极具迷惑性——每个解包出来的文件都以"上一个文件的最后 4 字节"开头，并丢掉自己最后
> 4 字节，看起来像"边界错位一行"的连续字节流。它让 `README.zh.md` 的首行变成
> `ls>`、`skill-catalog.js` 的首行变成 `.map/** … */`。
> **本文档 §4 的 rank 表是修复偏移后重新复核的。** 自证方式：解一个已知 JSON 并 `JSON.parse`，
> 检查 md 的首行是 `---`、末行是 `</details>`。

本次用到的关键出处：

| 结论 | 出处 |
|---|---|
| 根目录 rank 表 / `source` 取值 | `@deepseek-ai/dsh-skill-filesystem/README.zh.md:50-56` |
| `SkillSummary` 全字段（含 `source`/`provider`） | `@deepseek-ai/dsh-skill/lib/index.js` 的 `toSummary` |
| 作用域解析链 / `isUserInvocable` 过滤 | `@deepseek-ai/dsh-api-session-controller/lib/types/skill-catalog.js:116-185` |
| `settings.section` 运行时声明 | `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1136-1139` |
| `navIcon(id)` 硬编码 + 齿轮兜底 | 同文件 `:244-270` |
| 座位注册字段白名单（无 `icon`） | `@deepseek-ai/dsh-client-ui-slots/lib/index.js:205-220` |
| 「当前 session」判据（`retainedBy.mainView`） | 官方 6 处，含 `@deepseek-ai/dsh-client-ui-cordis/lib/client.js:742` |
| 插件开发规范 | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/**` |

---

## 10. 常用命令

```powershell
# 自检（唯一必跑）
node tools/verify.mjs

# 改动前先跑一次当基线：改动前 PASS、改动后 FAIL，才能证明是改动引起的
```

查活台账：

```
cordis_inspect_query(platform: client, provider: Slots, method: listSubTree, input: {"root":"settings.section"})
cordis_inspect_query(platform: host,   provider: Service, method: listService, input: {"service":"skills"})
plugin_manager(action: "list_plugins")
```
