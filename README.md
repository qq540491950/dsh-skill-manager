# dsh-skill-manager

DSH Web 客户端插件：在**设置面板**里加一页「Skills」，按来源分组
（项目 / 全局 / 自定义 / 随包内置）浏览当前会话可见的 skill，并给每一行一个
**启用 / 关闭**开关。

**写入面只有一个**（2026-10-27 从"纯只读"扩出来的）：开关改写那份 `SKILL.md` 的
frontmatter —— 关 = 写 `disable-model-invocation: true` + `user-invocable: false`，
开 = 删掉这两个键。写入一律带 `replaceIfVersion` 版本护栏，目标文件由宿主自己按规范根
算出来（客户端只能给名字）。仍然没有 `ctx.configEditor.edit()`、不碰
`~/.dsh/profiles/**`、不碰 `ctx.loader.*`，**也没有删除**（`ctx.fs` 没有 unlink/rmdir，
真删只能起 shell 进程并绕过沙箱围栏）。`tools/verify.ts` 的 A11–A15 / A34–A36 钉这条纪律。

```powershell
npm run check              # typecheck + build + verify（交付前跑这条）
node tools/verify.ts       # 只跑自检；零依赖，不装 node_modules 也能跑
```

---

## 1. 双半结构

源码在 `src/**`，`lib/**` 是 `tools/build.ts` 生成的产物（见 §6.5）；运行时读的是后者。

| 半边 | 源码 | 产物 | 职责 |
|---|---|---|---|
| 宿主 | `src/host/index.ts`（+ `service-types.ts`） | `lib/index.js`（ESM 单文件） | **产物零 import**。用 `ctx.connection.fetch.register()` 开一条路由 `/api/skill-manager`（GET 纯读 + 两个 POST：`read` / `set-enabled`），内部解析作用域后读 `ctx.skills`，**并只读直读四个规范根目录**（§3.3）。写入面只有一处：改 `SKILL.md` 的 frontmatter（§5.1）。 |
| 客户端 | `src/client/index.ts`（+ `service-types.ts`） | `lib/client.js`（懒 CJS 工厂） | `window.__ModuleLoader__` 懒 CJS bundle（包装与 `id` 由构建脚本注入）。往 `settings.section`（list 座位，`order: 910`）注册一页，同源 `fetch` 取数并渲染。 |
| 共用 | `src/shared/types.ts` | 无（只有类型，被擦除） | 两半边共用的 payload 契约。 |

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

### 3.3 第二个数据来源：**规范根目录直读**（对上游 bug 的兜底）

只用注册表是不够的。`dsh-skill-filesystem` 的 `list()` 是

```js
for (const root of roots) for (const skill of await discoverRoot(root, this.ctx, this.name)) candidates.push(skill);
```

——**整个循环没有 per-root 的 try/catch**。任何一个根目录抛错，`dsh-skill` 就把这个
提供方的**全部**候选丢掉（只打一行 warn + 把观测标记为 incomplete）。

本机实测就是这种状态（第二次实测的用户截图）：profile 里 `customSkillDirs` 指向

```
D:\Program Files\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills
```

`ctx.fs.listDir` 在这个 asar 路径上抛
`FsError: cannot list …: Cannot mix BigInt and other types`，于是**项目根里明明存在的
skill 也一起消失**——页面上表现为「选了项目还是只有随包内置那几个」。

所以宿主半边会**自己按官方同一套根目录规则只读直读**那四个规范根（`scanRoots`）：

| 规则 | 说明 |
|---|---|
| 每根 / 每文件各自兜底 | 上游缺的正是这层隔离。根读不了 → 这个根 0 条；文件读不了 → 丢那一条。**绝不许整段 try。**（B87） |
| **注册表优先** | 同名一律以 `ctx.skills` 那一行为准，直读只补它没有的名字。提供方健康时这一路是**纯空操作**。（B84–B86） |
| 只进本次响应 | 直读的行**不** `ctx.skills.register()`——那会改模型看到的东西。 |
| 逐条对齐官方硬性要求 | frontmatter 存在、`name` kebab-case、`description` 非空、旧调用策略键名拒绝、布尔取值合法；任何一条不满足就跳过。**少列一个只是少列，多列一个才是错。**（B80） |
| `source` 必须与 rank 表一致 | 否则两个来源会落进不同分组；`roots` 探测与直读共用**同一个** projectRoot。（B91） |

直读的 frontmatter 解析是**手写的子集**（宿主半边零 import，拿不到官方的 `yaml` 包），
所以它**宁可漏也不编**。这是已知边界，见第 8 节。

> ⚠️ 这是**兜底**，不是"上游已修好"。那份 `customSkillDirs` 仍然读不出来，
> 「自定义」分组因此仍可能是 0——修它属于 profile 配置，不归本插件。

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

分组由**宿主**算（`src/host/index.ts` 的 `GROUPS`，产物 `lib/index.js`），客户端不重新推导——两边各推一次必然漂。

---

## 5. 接口契约

`/api/skill-manager`，挂在 webServer 的 `/api` 之下，因此自带 Host/Origin 围栏与浏览器鉴权，
同源 `fetch` 即可，**不需要自建 token**。

### `GET ?sessionId=<id>&preset=<id>&cwd=<path>`

三个查询参数都可选。

- `sessionId` 决定 **scope**（活 Agent → 用它当 scope；否则 `acquireScope()` 冷读租约）。
- `cwd` 只在**用户显式切换了项目**时才由客户端传（范围下拉选中某个工作区），
  它决定扫哪个项目根；此时它**优先于** session header 的权威 cwd。
  不传 = 当前会话，宿主自己取权威 cwd。
- 客户端把 `null`/空串都转成"不传"——曾经把字符串 `"null"` 当路径发出去，
  宿主会去扫一个叫 `null` 的项目根（D61 钉这条）。

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
      // 开关能不能点：只有四个规范根（项目 ×2 + 用户 ×2）里的 skill 为 true。
      // custom 由 Config 决定位置、bundled/runtime 没有文件 → false（界面置灰并说明原因）。
      "writable": true,
      "resourceKind": "directory"    // 可选
    }],
    "counts": { "project": 0, "global": 0, "custom": 3, "bundled": 0, "other": 0 },
    // 按提供方汇总。留给后续诊断消费者——**本页 UI 已不渲染它**（见 §7.1.3）。
    "providers": { "filesystem": 3, "dsh-office": 3 },
    // 规范根目录清单：真实路径 + 存在性（true/false/undefined=未判定）。
    // 客户端只用它选空状态那句话，**不再渲染路径**（用户要求，见 §7.1.3）。
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
    "capabilities": ["snapshot", "read", "set-enabled"]
  }
}
```

`complete` 来自 `ctx.skills.snapshot()`（而不是 `list()`）——只有 `snapshot()` 会告诉你
**这次发现是否完整**。`skills` 是**两个来源合并**后的结果：注册表优先，直读补缺（见 §3.3）。

> **`providerFailures` 已从 payload 删除**（2026-10-13）。它连同宿主的 `logger.exporter`
> 整条管道一起下线：那段原文唯一的存在理由就是渲染页面上那块红字，而用户明确要求去掉。
> 上游那个「一个坏根目录丢光候选」的问题改由 §3.3 的直读兜底在数据面上解决。

### `POST { "op": "read", "name": "<skill>", "sessionId": "<id>" }`

返回 `{ name, path?, content, truncated, contentLength }`。用**同一个视图**解析
（同一个 scope/cwd），否则会出现"列表里有、点开说没有"。正文上限 200 000 字符。

注册表未命中时会**回退到直读**（§3.3）：按同一套根目录规则重新找到那个文件再读，
所以直读补进来的 skill 也点得开。**路径永远由宿主自己算**，不接受调用方传来的路径。
（B92–B96 钉这条。）

失败一律 `4xx/5xx` + `{ ok: false, error }`，错误原文直接给用户看。未知 `op` → 400。

### `POST { "op": "set-enabled", "name": "<skill>", "enabled": <bool>, "sessionId": "<id>", "cwd": "<path>" }`

本插件**唯一**的写操作：改写那份 `SKILL.md` 的 frontmatter。

| 目标状态 | 写入内容 | 官方语义（`dsh-skill-filesystem` README「Skill format」） |
|---|---|---|
| `enabled: false` | `disable-model-invocation: true` + `user-invocable: false` | 模型目录与 `skill` 工具看不到它；`/名字` 也看不到它 |
| `enabled: true` | 删掉这两个键 | 官方默认两者皆允许，删键比写 `false` 更干净 |

返回 `{ name, path?, enabled, changed }`；`changed: false` = 它本来就是那个状态，**宿主没有写文件**。

纪律（A14 / A34–A36、B100–B120 钉住）：

- **只改这两行**，其余字节原样保留（`rewriteInvocation` 逐字节重建头部，正文不动）——
  所以「关 → 开」能逐字节回到原文件（B109）。
- 每次写都带 `{ kind: 'replaceIfVersion', version }` 护栏；拿不到版本就**不写**。
- 用 `writeText` 整文件替换而**不用 `editText`**：文本匹配式编辑可能撞上重复的
  `description` 片段。
- **不接受客户端给的路径**：目标文件由宿主按规范根自己算（B114）。
- 不可写的来源（`custom` / `bundled` / `runtime`）一律 409 + 说明原因，且**一个字节都不写**（B110–B113）。
- 生效不需要重启：provider watch 着每个根，`SKILL.md` 一改就 invalidate，模型下一步拿到替换后的目录。

**没有删除。** `ctx.fs` 的契约里没有 unlink/rmdir/rename，真删只能 `ctx.subprocess`
起一条 shell —— 那会绕过沙箱围栏（围栏在工具层），且 Windows 上 `Remove-Item` 对
junction 有递归删到目标目录的历史 bug。A35 就是钉"产物里不许出现删除/起进程的痕迹"。

---

## 6. 接线方式：以 **bundle** 安装（不再是手写 profile 补丁）

本包已改造成 **bundle**：`package.json` 声明 `dsh.manifestVersion: 1` 与
`dsh.bundle.patch: "./cordis.patch.yml"`。装一次同时做两件事——把包装进 profile 的
`node_modules`，并把包名写进 `dsh.profile.bundles`；它的 patch 层随后自动插入 Loader 行。
**用户不需要再手写 `cordis.patch.yml`。**

> 历史：本插件最初（2026-10-12）是以「路径行」手写挂到
> `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾的，那一版实测页面渲染成功。
> 现在是 bundle 形态；手写行必须按 §6.3 的顺序迁走。

### 6.1 bundle 自带的补丁层只有插件自己一行

`cordis.patch.yml`（`dsh.bundle.patch` 指向它）全文就这一条：

```yaml
- insert:
    - id: dsh-skill-manager
      name: '@qq540491950/dsh-skill-manager'
```

三点都钉在自检 P 区：

1. **必须在 `insert:` 下。** 顶层 `- id: X` 的语义是「覆写已存在条目」，目标不存在时
   `applyEntryPatches` 直接 warn 并丢弃 → 插件根本不出现，表现出来就是「设置里没有 Skills 页」（P3）。
2. `name` 必须等于 `package.json.name`（P4）——安装器按包名解析；`file:///…` 形式只在手写挂载时用。
3. 这一行与 profile 里那条手写行**同 id**，不能并存（§6.3）。

### 6.2 四种安装 spec

`plugin_manager(action:'install_bundle', target: …)` 的 `target` 是 **pnpm spec**，不是"包名字段"：

| 形式 | 写法 | 装前能否判定是 bundle | 适用场景 |
|---|---|---|---|
| registry | `@qq540491950/dsh-skill-manager`（可带版本范围） | ✅ 问注册表 | 发布后的主渠道 —— **本包本轮未发布** |
| git | `github:qq540491950/dsh-skill-manager#v0.1.0` | ❌ 装后才判定，不合格抛错并回滚 profile | 不需要 npm 账号 |
| 本地绝对路径 | `D:\project\dsh-plugins\dsh-skill-manager` | ✅ 直接读目录 `package.json` | 开发循环，最便宜 |
| `.tgz` | `…\qq540491950-dsh-skill-manager-0.1.0.tgz` | ❌ 同 git | 从 Release 资产装 |

装完**读返回值**判定，不要只看日志：`application` 应为 `applied`，`warnings` 里不该有
bundle skipped。宿主半边变了的话返回 `restart-required` 是正常的（装完重启一次 DSH）。

### 6.3 从手写 profile 补丁迁移（顺序不能反）

历史上 profile 末尾那条是：

```yaml
- insert:
    - id: dsh-skill-manager
      name: 'file:///D:/project/dsh-plugins/dsh-skill-manager/lib/index.js'
```

它和 bundle 插入的是**同 id 的两条条目**。`applyEntryPatches` 的顶层 `insert` 就是
`data.push(...insert)`、`buildMap` 只是 `Map.set` → **后插入者赢，不报错**：页面看着毫无变化，
只会让人以为"装了个假的"。

迁移顺序：

1. 备份 `~/.dsh/profiles/desktop/` 的 `package.json` 与 `cordis.patch.yml`（带时间戳 `.bak`）；
2. `install_bundle`（用**本地路径**最便宜：装前就能判定是不是 bundle，失败什么都不改）；
3. 确认页面在，且**只有一格**：
   `cordis_inspect_query(client, Slots, listSubTree, {"root":"settings.section"})` 里应是
   `{ id: 'skills', order: 910, active: true }`；按包名查 `Config.listConfigs` 应命中**包名**
   而不是 `file://` 路径；
4. 这时才删 profile 里那条手写行（用最小行级改动，见 AGENTS.md §1.4）。

### 6.4 卸载与升级

- 卸载：`plugin_manager(action:'remove_bundle', target:'@qq540491950/dsh-skill-manager')`
  → 插件行与客户端座位一起消失，profile 里不再有该依赖。（机制如此；本仓库**未实测**，见 §6.7。）
- 升级：**就地装新 spec**（git 路线换 `#ref`，路径路线直接重装目录）。重复**同一个** spec 才会
  报 `ambiguous-install`；换 spec 不会。
- 宿主半边（`src/host/**` → `lib/index.js`）变了：`npm run build` + **重启一次 DSH**（见 §8）。

### 6.5 目录结构与构建

```
src/host/index.ts            宿主半边源码（service-types.ts = 它用到的 Service 形状）
src/client/index.ts          客户端半边源码（service-types.ts 同上）
src/shared/types.ts          两半边共用的 payload 契约（**只有类型**）
        │  npm run build（tools/build.ts，esbuild）
        ▼
lib/index.js                 宿主产物：ESM 单文件，零 import（shared 全内联）
lib/client.js                客户端产物：懒 CJS 工厂 classic script（id 取自 package.json.name）
lib/types/**                 tsc 产出的 .d.ts（exports.types 指 lib/types/host/index.d.ts）
lib/.build-manifest.json     产物指纹：每个产物 + 每个 src 输入的 sha256
tools/build.ts               构建脚本（直接跑：node tools/build.ts）
tools/verify.ts              自检（零依赖，不装 node_modules 也能跑）
locale/en.json, zh.json      meta.title / meta.description（给 bundle 清单用）
assets/icon.svg              包图标（`icon` 字段；**不是**座位图标，见 §8）
cordis.patch.yml             bundle 的补丁层（§6.1）
.github/workflows/ci.yml     零依赖自检 → npm ci → npm run check → git diff --exit-code -- lib
```

| 命令 | 做什么 |
|---|---|
| `npm run build` | `src/**` → `lib/**`，并写 `lib/.build-manifest.json` |
| `npm run typecheck` | `tsc -b --clean && tsc -b && tsc -p tsconfig.tools.json` |
| `node tools/verify.ts` | 自检（**唯一必跑**）|
| `npm run check` | 上面三步串起来 |

两条约束写进了 tsconfig，而不是只写在这里：宿主 project 的 `lib` 只有 `ES2022` +
`types: ["node"]`、**没有 DOM**；客户端 project 正好相反（`DOM` + `types: ["react"]`、
没有 node 全局）。相对 import **必须带 `.ts`**（`allowImportingTsExtensions` +
`rewriteRelativeImportExtensions`），因为自检脚本要能直接跑 TypeScript 源码。
Node **≥22.18**：`node tools/build.ts` / `node tools/verify.ts` 靠原生类型擦除直接跑。

**`lib/**` 是生成物但入库**：它是运行时产物、也在 `files` 里，`git clone` + 路径行、
`github:` 安装都直接拿它（pnpm 不会替你 build）。所以改了 `src/**` 必须 `npm run build`
并一并提交——漂移由 `lib/.build-manifest.json`（E 区断言）和 CI 的
`git diff --exit-code -- lib` 拦住。**不要手改 `lib/**`。**

### 6.6 npm 包形态与 `npm pack` 审查清单

`files` 白名单（刻意的，不含 `src/`、`tools/`、`AGENTS.md`）：

```
lib  cordis.patch.yml  locale/*.json  assets/icon.svg  README.md  LICENSE
```

`npm pack --dry-run` 之后逐项看（**本轮已实跑**，结果见 §7.1；这里给的是"以后怎么复查"）：

- **有**：`package/lib/index.js`、`lib/client.js`、`lib/types/**`、`lib/.build-manifest.json`、
  `cordis.patch.yml`、`locale/{en,zh}.json`、`assets/icon.svg`、`README.md`、`LICENSE`；
- **没有**：`src/`、`tools/`、`node_modules/`、`.tsbuildinfo`、`*.tgz`；
- 扫密钥：不得出现真实 token / API key；
- `package.json` 里 `dsh.bundle.patch`、`dsh.client.platform`、`icon`、
  `exports["./cordis.patch.yml"]`、`exports["./locale/*.json"]` 都还在
  （P 区在源码侧已钉过一遍，这里看的是**实际打出来的包**）。

### 6.7 状态：未发布、未真装

| 项 | 状态 |
|---|---|
| 包改造（字段 / patch 层 / locale / icon / LICENSE / CI） | 已完成；静态断言在 P 区 |
| 真装进 profile | **未实测**（本轮用户明确要求不动 profile） |
| `npm publish` | **未做**：本机 `npm whoami` → `ENEEDAUTH`（未登录） |
| 图标在界面里的观感 | **未见**：v0.1.0 的 `icon` 只进 bundle 清单，座位注册不吃它 |

所以 §7.2 的"未实测"清单照旧有效。**不要因为包里有了这些字段就写成"已发布"。**

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
| 挂载后 `dsh --profile web --patch <改后的补丁文件> --dump-config` 仍 exit 0（真实 Loader 接受该文件） | 历史手写挂载那一轮（现已被 bundle 安装取代，见 §6.3） |
| **页面在真实 GUI 里渲染成功**：设置导航出现「Skills」；`resolvedBy=session-agent`、`presetId=cordis`、`cwd` 正确 | 用户 2026-10-12 实测截图 |
| **`ctx.fs` 在宿主根上确实存在**：`fs-sandbox`（`dsh-fs-sandbox`）挂在 profile 顶层（`cordis.yml:451-452`）；直读走的 `resolve`/`listDir`/`stat`/`readText` 与官方 provider 用的是同一个服务 | profile `cordis.yml` + `dsh-fs-local/lib/index.js:87909-87992`（服务契约） |
| **项目根里确实有 skill**：`D:\project\agent-go\.agents\skills` 存在，含 8 个 `SKILL.md`（`edd-prototype`/`git-commit`/`git-push`/`handoff`/`personal-weekly-report`/`req`/`wails3-upgrade`/`weekly-report`） | 直接列目录（第二次实测期间） |
| **本机确实没有项目/全局 skill（第一次实测时）**：`.dsh/skills`、`.agents/skills`（项目侧）与 `~/.dsh/skills` 都不存在，`~/.agents/skills` 存在但为空 | 直接列目录 |
| **`dsh-skill-office` 显式以 `source:"bundled"` 注册**（不是文件系统根） | `dsh-skill-office/lib/index.js:71` + `BUNDLED_SKILL_RANK` |
| 本插件自身：`npm run check` 全绿（typecheck + build + verify **PASS 333/333**），含 **A0**（package.json 解析失败不许崩）、**E 区**（产物契约 / 构建新鲜度 / banner）、**P 区**（发布形态）与本轮新增的写入面断言（A14 / A34–A36、B100–B120、D70–D82） | `npm run check` 的实际输出 |
| **2026-10-27 本轮反向验证 13/13**：A0 / P1 / P2 / P3 / P4 / P8 / P9 / P11 / P14 / E2 / E3 / E5 / P15 逐条按预期报出断言 id，且注入文件全部逐字节还原 | 记录见 `AGENTS.md` 4.4（含本轮新踩到的两个坑） |
| `npm pack --dry-run` 实际打出 **15 个文件**：`lib/index.js`、`lib/client.js`、`lib/types/**`（5 个 `.d.ts`）、`lib/.build-manifest.json`、`cordis.patch.yml`、`locale/{en,zh}.json`、`assets/icon.svg`、`README.md`、`LICENSE`、`package.json`；包内**没有** `src/`、`tools/`、`node_modules/`、`.tsbuildinfo`、`*.tgz` | `npm pack --dry-run` 的实际输出（40.3 kB tarball / 111.1 kB unpacked） |
| 历史那一轮 **11/11 反向验证**逐条精确报错（直读兜底 + 诊断下线那一版代码） | 该轮脚本输出（旧骨架，已被本轮 13/13 取代） |

### 7.1.1 上游问题：`customSkillDirs` 指向 app.asar（**不是本插件的 bug**）

第二次实测截图里 `完整性 未完成`、且只有 4 个 `bundled` skill（`dsh-office` ×3 +
`dsh-windows-acl` ×1）、**项目与全局全是 0**。原因在 profile 里 `skill-filesystem` 的
`customSkillDirs`：

```js
// cordis.yml 的 cordis preset 段（第 1330-1336 行）
customSkillDirs:
  - !!js >-
    process.getBuiltinModule('node:path').join(…createRequire(baseUrl)
      .resolve('@deepseek-ai/dsh-agent-preset/package.json')…, 'skills')
```

它解析出来的是 **asar 内的路径**：

```
D:\Program Files\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills
```

`ctx.fs.listDir` 在这个路径上抛（**原样来自页面截图**）：

```
FsError: cannot list `D:\Program Files\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-agent-preset\skills`: Cannot mix BigInt and other types, use explicit conversions
```

而 `dsh-skill-filesystem` 的 `list()` **没有 per-root try/catch**，所以这一个坏根目录
把整个 `filesystem` 提供方的候选**全部**丢掉了 —— 包括 `agent-go` 里那 8 个
**确实存在**的项目 skill。这就是用户说的「选择项目之后，依然不能正确加载项目的 skill」。

**本插件的处置**：不越界改 profile，改用 §3.3 的**直读兜底**在数据面上把项目/全局
skill 读回来。（`自定义` 那一格仍受上游影响，因为它指向的正是那个 asar 路径。）

> 第一次实测记录的「`createRequire(...).resolve()` → MODULE_NOT_FOUND」这一次**没有复现**：
> 实际解析成功了，只是解析到 asar 里、而 asar 目录列不出来。两次的**表现相同**
> （整个 filesystem 提供方消失），所以结论不变，只是根因描述更新为上面这条。

### 7.1.2 第一次实测发现的本插件缺陷（已修）

| 缺陷 | 现象 | 修法 |
|---|---|---|
| **只渲染非空分组** | 本机没有项目/全局 skill，于是「项目」「全局」两节**整块消失**，用户看到一片空白，判断为"没有全局和项目的管理" | 四个规范分组**永远渲染**（`other` 除外），各带真实根目录路径与存在性 |
| 徽标重复分组名 | `bundled` 徽标与「随包内置」分组并排，让人以为分类错了 | 徽标改显示**提供方**（`dsh-office` / `filesystem`） |
| `未完成` 不可操作 | 只说"某个根目录扫描失败"，不知道是哪个 | 新增「提供方」汇总行；期望的文件系统提供方不在里面就是它的根没扫成功 |
| 四组内容平铺 | 四个分组各自铺开、还各带一行根目录说明，一屏放不下；而且未接到新宿主时显示的是 `<projectRoot>` 这类**占位符**，又长又没信息量 | 改为**标签页 + 个数**：四个分组永远列出（含 `0`），一次只展开一个；根目录说明跟着选中分组走。默认落在**第一个非空**分组上，不会一进来就停在空标签页 |
| 项目/全局各占一格 | 两格都空，还得点两次才确认"真的没有" | 合并成一格「项目 + 全局」，一次看全四个根目录 |
| **无法跨项目看 skill** | `projectRoot` 等于当前会话的 cwd，`ECC` / `agent-go` 的 `.agents/skills` 不在本会话的扫描范围内 | 新增**范围下拉**：列出 DSH 的工作区（`useWorkspaces`，root kit 自带），选中即把该路径作为 `cwd` 传给宿主。管道本来就在——宿主的 `options.cwd` 本来就优先于 session 的权威 cwd |
| **读到失败却不上报** | `skill-filesystem` 的 `list()` 循环没有 per-root try/catch，一个根目录抛错 → 整个提供方的候选被丢弃 → 表现为"全是 0 + 未完成 + filesystem 不在提供方列表里"。而 warn 进不了宿主内置日志缓冲，**原因不可见** | 宿主挂 `ctx.logger.exporter({ levels: { default: 3 } })`，按 `skill provider "<name>" skipped:` 收原文，随 `providerFailures` 下发并渲染成红色提示 |

### 7.1.3 第二次实测发现的问题（用户反馈，已修）

用户原话：**「这个管理有问题，1、提示 2、选择项目之后，依然不能正确加载项目的 skill，
还有把冗余提示都去掉，这是作为使用者不用看到的内容」**。

| 问题 | 现象（截图） | 修法 |
|---|---|---|
| **项目 skill 加载不出来** | 范围选到 `agent-go`，`项目 + 全局` 仍是 `0`——那是 §7.1.1 的上游 bug 把整个 filesystem 提供方拖死了 | §3.3 的**直读兜底**：宿主自己按官方根目录规则只读直读，注册表优先合并。（B71–B91） |
| **列表里有、点开说没有** | （同一改动的连带风险）直读补进来的行不在注册表里，`registry.get()` 必然返回 undefined | 读取路径同样回退到直读，**路径由宿主重算**、不接受调用方传路径。（B92–B96） |
| **诊断提示是内部原文** | 页面最醒目的一块红字是 `FsError: cannot list "…app.asar…": Cannot mix BigInt and other types`——只有开发者看得懂 | **整条管道删除**：不再挂 `logger.exporter`、不再下发 `providerFailures`、页面不渲染。（B90、D47） |
| **冗余提示重复** | 红字下方还有一条「本次发现未完成。原因见上面那段提供方原文……」，说的是同一件事 | 一并删除；`complete` 仍在 payload 里，只是这一页不渲染。（D62） |
| **事实面板是排查工具** | 「作用域 / 预设 / cwd / 项目根 / 提供方 / 完整性」一行，用户不需要看到 | `ViewFacts` 整体删除。（D8、D52） |
| **根目录路径 + 存在性** | 每条根目录一行绝对路径 + 「存在/不存在」小字 | 删除渲染；三种空原因改成一句大白话（不含路径）。`roots`/`exists` 只用来**选哪句话**。（D31、D32、D65） |
| 副标题是元信息 | 「只读浏览已发现的 skill。第一阶段不含任何写入。」 | 删除。 |
| **降级提示** | 「没有解析到 Agent 预设作用域……请先打开一个会话再刷新」 | 删除（直读上线后「只读全局层」不再等于空表）。（D23） |

**边界**：删掉的只是**提示**，不是**数据**。列表、计数、标签页、范围下拉、正文展开
全部照常渲染（D63/D48/D49 反向钉住）。

### 7.1.4 第三次实测反馈：加「启用 / 关闭」开关（2026-10-27）

用户原话：**「现在 skill 管理已经完成，但是能否添加一个启用、关闭的 switch，另外删除这个功能是否支持」**。

| 问题 | 结论 | 动作 |
|---|---|---|
| 开关能不能做 | **能**，而且不用发明状态：官方 frontmatter 就有 `disable-model-invocation` / `user-invocable` 两个键（`dsh-skill-filesystem` README「Skill format」）。本机 `~/.dsh/skills/ask-matt`、`wait-what` 就写着 `disable-model-invocation: true`，所以它们出现在页面上却不在模型目录里——这条链路是**既有实测事实** | 宿主新增 `op: "set-enabled"`（§5）；客户端行尾加开关 |
| 删除支持不支持 | **不支持**：`ctx.fs` 的完整契约只有 read/write/edit，**没有 unlink/rmdir/rename**。真删只能 `ctx.subprocess` 起 shell，那会绕过沙箱围栏（围栏在工具层），且 Windows 上 `Remove-Item` 对 junction 有递归删到目标目录的历史 bug —— 而本机 `~/.dsh/skills/*` **全是 junction** | 明确**不做**删除；A35 钉"产物里不许出现删除/起进程的痕迹"。页面保留文件路径，需要删时由用户自己删 |
| 开关语义选哪种 | 用户选了**一个总开关**：关 = 模型 + `/命令` 都关 | 关 → 写两个键；开 → 删两个键（官方默认即两者皆允许） |
| 哪些行不能开 | `custom`（位置由 `Config.customSkillDirs` 决定，宿主算不出路径）、`bundled` / `runtime`（随包或运行时注册，没有可改写的文件） | 这些行的开关**置灰**并用 `title` 说明原因（D73/D74）；点了没反应比没有开关更糟 |

### 7.2 未实测（不要当成已完成）

| 项 | 为什么没测 | 怎么补 |
|---|---|---|
| **开关在真实宿主上写文件** | 自检里的 `ctx.fs` 是替身（写进内存里的 `files` 表）。真实 `fs-sandbox` 的 `writeText` 需要 `stat` 给出 `version`、并按 `sandboxPolicy` 围栏——本插件调用时不带 policy，落到后端的 agentless 兜底（本 profile 默认 `danger-full-access`）。**这一条是读契约得出的，不是实测** | 重启后到 设置 → Skills 点一次某个项目/全局 skill 的开关，看 `SKILL.md` 里是否多出两行、模型下一步的目录里是否少了它 |
| **`~/.dsh/skills/*` 是 junction** | 本机 11 个目录全是 junction（`lstat` 类型为 symlink）。`resolve()` 会跟随到真实目标，所以写入落在**目标文件**上（多半是某个 dotfiles 仓库里的技能源）——这符合预期，但没实测过 | 点一个 `user-dsh` 的开关，检查 junction 目标文件是否被改、链接本身没被破坏 |
| **关掉再打开是否逐字节还原** | 单测里是逐字节比对的（B109），但没在真实文件上跑过（真实文件可能用 CRLF 或块标量 description） | 对同一个 skill 关→开，`git diff` 应为空 |
| **修复后的页面（直读兜底 + 诊断下线那一版）** | 那些改动都在**宿主半边**（`src/host/index.ts` → 产物 `lib/index.js`）：宿主半边不热重载，产物也不会自己重新构建 —— 必须 `npm run build` **并且**重启 DSH 才看得到 | `npm run build` 后重启 DSH，看 设置 → Skills，并切一次范围下拉 |
| **直读在真实 `fs-sandbox` 上的读权限** | 自检里 `ctx.fs` 是替身。`fs-sandbox` 的 README 说「读取、列出、元数据操作与 `fs-local` 完全一致；变更围栏不限制观察」，所以直读应当畅通——但**这一条是读文档得出的，不是实测**。若被拒，表现是直读那一路**安静地 0 条**（每根各自兜底，不会报错） | 重启后看 `项目 + 全局` 是否出现 `agent-go` 的那 8 个 skill |
| **真实 `SKILL.md` 的 frontmatter 是否能被手写解析器吃下** | 自检用的是我自己造的夹具。本机那 8 个文件的真实写法只做过**人工抽查**，没有跑过对比 | 重启后逐个对照：直读列出来的名字应等于官方 `skill` 工具能加载的名字 |
| **`agentPresets.acquireScope(默认 preset)` 在本 profile 是否成功** | 实测走的是活 Agent 路径（已成功），冷读租约那条一次都没被触发 | 不选 session 直接看页面 |
| **preset 自带 skill 能否恢复** | 取决于上游 `customSkillDirs` 的修复（见 7.1.1） | 修好 profile 后「自定义」分组会出现内容 |
| **深浅两套主题下的实际观感** | 主题切换未测 | 切换主题看一遍 |
| `B52` 截断边界之外的超大正文 | 只测了 200010 字符一例 | 可选 |
| **bundle 真装进 profile** | 本轮用户明确要求不动 profile，所以一次都没装过；"装完页面就能用"目前是**推断** | 按 §6.3 备份 profile → `install_bundle`（本地路径）→ 查座位只有一格 → 再删手写行 |
| **`npm publish` / 按 registry 名再装一次** | 本机 `npm whoami` → `ENEEDAUTH`，没有登录 | 登录后 `npm publish --access public`，再 `install_bundle` 包名复验 |
| **`npm pack` 的实际内容** | 没跑（清单见 §6.6） | `npm pack` + 解包逐项对照 §6.6 |
| **包图标在界面里的渲染** | 没看过：`icon` 只进 bundle 清单，座位注册字段里没有它 | 装好后看插件列表/卡片里的图标 |

**安装与座位注册本身不等于"用户能看见"。** 没有实测的部分必须明说。

> ⚠️ 改的是**宿主半边**时：`npm run build` **并且**重启 DSH 才生效（见 §6.5、§8）。
> 客户端那一半（`src/client/index.ts` → `lib/client.js`）也**先要 build**，之后随页面刷新更新；
> 但**没有宿主的新数据面，页面就只是少了那些提示而已**——项目 skill 仍然出不来。

---

## 8. 已知边界（不要试图"修好"）

| 边界 | 说明 |
|---|---|
| **导航图标不可由插件提供** | 注册字段白名单里没有 `icon`，`navIcon(id)` 对未知 id 一律兜底成齿轮。本页因此显示齿轮。`dsh-mcp-manager` 用「给自己那一格打 data 属性 + CSS 覆盖」绕过去了，本插件**刻意不学**——那条路依赖官方 DOM 结构，官方一改就静默失效。若官方将来支持 `icon`，改用注册参数。 |
| **未接 `ctx.locale`** | 官方 practices 要求用户可见文案走 Client locale 服务。本插件文案硬编码中文，与同目录的 `dsh-mcp-manager` 一致。这是一处**有意的偏离**。包里的 `locale/{en,zh}.json` 只喂 bundle 清单的 `meta.title` / `meta.description`，**不是** Client locale 服务。 |
| 宿主半边不热重载 | `dsh-hmr` 只监听 DSH 安装目录与 profile 补丁文件；本仓库目录不在其中，且 Node 的 ESM 按 URL 缓存模块。改 `src/host/**` 后要 `npm run build` + 重启 DSH（被加载的是产物 `lib/index.js`）。 |
| 客户端半边会热重载 | 改 `src/client/**` 同样**先要 `npm run build`**；之后**只在 `pnpm run dev:web` 也在跑**时，client-plugin 变更才会免刷新生效；否则要刷新页面。 |
| **`lib/**` 是生成物** | 源码在 `src/**`。手改 `lib/**` 会被下一次 `npm run build` 覆盖，且 E 区的指纹断言与 CI 的 `git diff --exit-code -- lib` 都会红。 |
| **手写行与 bundle 安装同 id 冲突** | 两条同 id 条目**不报错**，后插入者赢——表现是"装完看着毫无变化"。迁移顺序见 §6.3。 |
| **bundle 未真装、包未发布** | 见 §6.7：没装进任何 profile，也没 `npm publish`。所有"装完就能用"的说法目前都是**推断**。 |
| `order` 不保证"永远最后" | 910 只是大于 MCP 的 900。别的插件开更大就会排到后面。 |
| 同 `(id, priority)` 冲突会抛错 | `id` 的唯一性约束在 `(id, priority)`；`order` 可以重复。所以 `id: "skills"` 不能与别的插件重名。 |
| 无 session 时没有权威 cwd | 宿主没有「当前工作区」概念。此时 `cwd: undefined`，项目类 skill 可能少列——`resolvedBy` 会如实说明。 |
| 项目范围 = 最近 `.git` 祖先 | 上游约束，不支持 monorepo 子项目选择；没有 `.git` 的工作区回退到 cwd。 |
| **上游 provider 会被一个坏根目录整条拖死** | `dsh-skill-filesystem.list()` 没有 per-root try/catch。本插件用 §3.3 的直读兜底，**但那不等于上游修好了**：`customSkillDirs`（本机指向 app.asar 内的 `<agent-preset>/skills`）仍然读不出来，「自定义」分组因此仍可能是 0。 |
| **直读的 frontmatter 解析是手写子集** | 宿主半边零 import，拿不到官方的 `yaml` 包。只实现了 `key: value` / 块标量（`\|`、`>`）/ 引号标量。**比官方严格或宽松的写法都会导致「少列」或「多列」**；因此逐条对齐官方硬性要求，并且宁可漏也不编（B80）。 |
| **直读不覆盖 `自定义` / `随包内置`** | 前者路径由 `Config.customSkillDirs` 决定，宿主读不到展开值；后者由 `dsh-skill-office` 这类提供方**在内存里**注册。两者都只能来自注册表。 |
| **直读结果是"盘上有什么"，不是"模型能用什么"** | 提供方健康时两者一致（注册表优先，直读是空操作）。提供方被上游拖死时，直读能把项目/全局 skill **显示**出来，但那个会话的模型**仍然看不到它们**——本插件不改模型可见的目录（绝不 `ctx.skills.register()`）。 |
| **开关只对四个规范根生效** | `custom` 的路径由 `Config.customSkillDirs` 决定（宿主读不到展开值），`bundled`/`runtime` 没有文件。这三类行的 `writable: false`，开关置灰。 |
| **不做删除** | `ctx.fs` 没有 unlink/rmdir/rename。真删要起 shell 进程，会绕过沙箱围栏，且对 junction 有递归删目标的风险。要真删请用户自己删文件（页面给了路径）。 |
| **总开关会抹掉手写的 `user-invocable: false`** | "开"= 删掉两个键（官方默认两者皆允许）。若某个 skill 原本只写了 `user-invocable: false`（想保留给模型自动调用、但不进 `/` 菜单），把开关关掉再打开会把这条意图抹平。单开关语义的**已知代价**，不是 bug。 |

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
| **`ctx.fs` 服务契约**（`resolve` / `stat` / `lstat` / `listDir` / `readText`；`resolve` 收路径、其余收 resolved target） | `@deepseek-ai/dsh-fs-local/lib/index.js:87909-87992`（第二次实测本轮抽出核对） |
| **`dsh-skill-filesystem` 的发现流程**（根目录顺序、`<name>/SKILL.md` 与 `<name>.md`、`.system` 跳过、frontmatter 硬性要求） | `@deepseek-ai/dsh-skill-filesystem/lib/index.js:70377-70472`（roots）/ `:70865-70898`（discoverRoot）/ `:70948-70989`（parseSkillFile）/ `:71064-71090`（parseFrontmatter） |
| **`list()` 没有 per-root try/catch** | 同文件 `:70386-70391` |
| 提供方抛错后候选被整体丢弃 + 只打一行 warn | `@deepseek-ai/dsh-skill/lib/index.js:71691-71720` |
| `ctx.fs` 挂在 profile 顶层（`fs-sandbox`） | `~/.dsh/profiles/desktop/cordis.yml:451-452` |
| 插件开发规范 | `@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/**` |

---

## 10. 常用命令

```powershell
# 自检（唯一必跑；零依赖，不装 node_modules 也能跑 —— Node ≥22.18 原生类型擦除）
node tools/verify.ts

# 改动前先跑一次当基线：改动前 PASS、改动后 FAIL，才能证明是改动引起的

# src/** → lib/**（改了源码就必须跑，产物要一并提交）
npm run build

# 类型检查（含 tools/**）：tsc -b --clean && tsc -b && tsc -p tsconfig.tools.json
npm run typecheck

# 三步串起来，交付前跑这条
npm run check

# 产包审查（清单见 §6.6）
npm pack

# 编码检查（提交前；产物是生成的，也要查）
node -e "const fs=require('fs');for (const p of ['src/host/index.ts','src/client/index.ts','lib/index.js','lib/client.js']) { const b=fs.readFileSync(p); const t=b.toString('utf8'); console.log(p, (b[0]===0xEF?'BOM!':'no-bom'), (t.includes(String.fromCharCode(0xFFFD))?'FFFD!':'clean'), 'crlf='+(t.match(/\r\n/g)||[]).length) }"
```

> 从 app.asar 里取官方源码的偏移算法见 §9。**别用 `node -e` 写注入/替换脚本**：
> PowerShell 会吃掉反引号，锚点静默变成 0 次命中——写成独立脚本文件（`.mjs` / `.ts`）再跑。
> 注入要打在 `src/**` 上、然后 `npm run build`：直接改 `lib/**` 会被 E 区指纹断言抓出来，
> 于是分不清"注入没生效"还是"没重新构建"（AGENTS.md §4.3）。

查活台账：

```
cordis_inspect_query(platform: client, provider: Slots, method: listSubTree, input: {"root":"settings.section"})
cordis_inspect_query(platform: host,   provider: Service, method: listService, input: {"service":"skills"})
plugin_manager(action: "list_plugins")
```
