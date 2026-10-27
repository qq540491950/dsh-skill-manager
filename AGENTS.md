# AGENTS.md —— 本仓库的 agent 工作约束

> 写给在本仓库里干活的 AI agent。
> 每条规则都对应一次**真实踩过的坑**；括号里是失败现象，不是理论风险。
> 三级：**硬性纪律**（违反会破坏数据或环境）＞**代码边界**（抄近路会引入已知 bug）＞**风格约定**。

---

## 0. 30 秒定位

**这是什么**：一个 DSH 插件，在设置面板加一页「Skills」，**只读**浏览当前会话可见的
skill，按来源分组（项目 / 全局 / 自定义 / 随包内置）。**第一阶段没有任何写入路径。**

**双半结构**（源码在 `src/**`，`lib/**` 是 `tools/build.ts` 生成的产物，见 2.11）：

| 半边 | 源码 | 产物（运行时读的就是它） | 职责 |
|---|---|---|---|
| 宿主 | `src/host/index.ts`（+ `src/host/service-types.ts`） | `lib/index.js` | **产物零 import**。`ctx.connection.fetch.register()` 开 `/api/skill-manager`；解析作用域后读 `ctx.skills`，**并只读直读四个规范根目录**（见 2.10）。 |
| 客户端 | `src/client/index.ts`（+ `src/client/service-types.ts`） | `lib/client.js` | `window.__ModuleLoader__` 懒 CJS bundle（包装由构建脚本注入，`id` 取自 `package.json.name`）。注册 `settings.section`（list 座位，`order: 910`）。 |
| 共用 | `src/shared/types.ts` | 无（只有类型，被擦除） | payload 契约：两边各写一遍必然漂。 |

**唯一必跑的命令**：

```powershell
node tools/verify.ts      # 期望 PASS n/n（以实际输出为准）
```

**设计依据、已实测/未实测清单、证据出处**：`README.md`（第 3 节作用域解析、第 6 节安装与包形态、第 7 节实测状态、第 9 节 asar 解包）。

---

## 1. 硬性纪律（违反会破坏数据或环境）

### 1.1 本机 `pwsh` 是 Windows PowerShell 5.1，禁止用它读写 UTF-8 源文件

`Get-Content -Raw` / `Set-Content` 默认走 **ANSI 码页**，对含中文的 UTF-8 文件会造成中文乱码、
**吃掉换行导致行合并**、无法解码的字节被 `?` 替换——**不可逆**。

- ✅ 读：`read` 工具，或 `node -e "fs.readFileSync(p,'utf8')"`
- ✅ 写：`write` / `edit` 工具（自带版本护栏），或 **Node 的 `fs.writeFileSync(p, s, 'utf8')`**
- ❌ 不要用 PowerShell 做"读改写回"的往返

### 1.2 宿主半边**不会**热重载；客户端半边会

`dsh-hmr` 只监听 DSH 安装目录 + profile 补丁文件；本仓库目录不在其中，且 Node 的 ESM
按 URL 缓存模块。

- 改 `src/client/index.ts` → `npm run build` → 重载的 `lib/client.js` 才热替换
  （但**只有在 `pnpm run dev:web` 也在跑**时才免刷新；否则要刷新页面）
- 改 `src/host/index.ts` → 必须 `npm run build` **并且**重启 DSH。宿主半边既不热重载，
  也不会自己重新构建：只重启不 build 跑的还是旧产物，只 build 不重启什么都不会变

### 1.3 不要重启 DSH

当前会话就运行在被重启的 DSH 里。需要宿主侧生效时，**告知用户**让他们决定。

### 1.4 不要擅自改 `~/.dsh/profiles/**`

那是用户的**实时配置**（本插件的接线就加在 `desktop/cordis.patch.yml` 末尾，2026-10-12 已挂载；
该文件是活的，应用会并发写入——实测期间 `llm-pi-ai` 条目就被写过一次）。
确需改动时：① 先备份到带时间戳的 `.bak`；② 只用 `edit` 做**最小行级**改动（在文件末尾纯追加）；
③ 用**官方同一个 `yaml` 解析器**验证（解包自 app.asar），并与备份逐条深比较；
④ 告知用户备份路径与回滚方式。

**补丁层的行语义**（`cordis-plugin-include` 的 `applyEntryPatches`）：

| 写法 | 语义 |
|---|---|
| `- insert: [...]`（无 id） | 追加到顶层条目列表 |
| `- id: X` + `insert: [...]` | 追加进已存在 group 条目 X 的 config |
| `- id: X`（无 insert） | **覆写**已存在条目 X；X 不存在则 warn 并**丢弃** |

> 本插件那一行现在**也存在于本仓库的 `cordis.patch.yml`**（bundle 自带的补丁层，见 2.12）：
> 手写行与 bundle 安装是**同 id 的两条条目**，后插入者赢且不报错，所以两者不能并存。

### 1.5 文件被并发编辑时按护栏重做，不要覆盖

`edit` 报 `file changed since it was read` 时：**重新读取 → 基于新内容重做**，
绝不要改成整文件写入来"绕过"护栏。

---

## 2. 代码边界（抄近路 = 已知 bug）

### 2.1 **产物**必须零 import（源码可以用 `import type`）

`lib/index.js` 由 Loader 以 `file:///...` 绝对路径（bundle 安装后是包名）加载，裸模块说明符
都在 app.asar 里，从磁盘路径解析不到。所以**产物里一行 import 都不许有**，只用注入进来的
Service + 全局 `URL` / `Response` / `AbortController`。

源码不是这么写的：`src/host/index.ts` 里可以写 `import type { … } from '../shared/types.ts'`，
`src/shared/types.ts` 里只有类型。**「产物零 import」由两件事保证**：esbuild `bundle: true`
把相对模块内联进单文件 + `verbatimModuleSyntax` 让类型导入整行被擦掉。
（A8–A10 查产物文本——往源码里加一行**值**导入（裸模块），产物里就会留下 `import`/`require`，
这几条立刻红；产物是不是从当前 `src/**` 构建出来的，由 E 区守。）

### 2.2 读 skill **必须带 scope**

`@deepseek-ai/dsh-skill-filesystem` 在本机**不是**挂在宿主根上（顶层 `enabled:false`），
而是挂在 agent preset 的 standing composition 里 → 它只进那个 preset 的 layer。
**不带 `scope` 读只会合并全局 layer，那里一个提供方都没有 → 空表。**

正路：客户端传 `sessionId` → 宿主 `sessionQuery.observeSession()` 取权威 cwd →
活 Agent 用 Agent 对象当 scope，否则 `agentPresets.acquireScope()` 取冷读租约。
详见 `README.md` 第 3 节。（B9/B15/B18 钉这条。）

> 事故：如果这里写错，页面不会报错——它只会**安静地显示空列表**，看起来像"用户没装 skill"。

### 2.3 两种租约都必须读完即放

- `sessionQuery.observeSession()` → **caller-owned observation**（`Disposable`）
- `agentPresets.acquireScope()` → **revision 租约**（`AsyncDisposable`）

拖着不释放会钉住一次 revision。（B10/B20 钉这条。）

### 2.4 cwd 只能来自 session；没有就如实报 `undefined`

宿主侧**没有「当前工作区」概念**（选择在客户端的 `uiWorkspace.selection` 里）。
`workspaceRegistry.list()[0].path` 只是兜底，且**不要编造**：没有 sessionId 时
`cwd` 就是 `undefined`。（B39 钉这条。）

### 2.5 不要用 `ctx.remote.skills.list()` 取分组数据

那条官方 Remote **故意裁掉了 `source`/`provider`/`invocation`**
（`dsh-api-session-controller/lib/types/skill-catalog.js:163-169`），而「全局 vs 项目」
的唯一权威依据就是 `source`。要用它就只能放弃分组。

### 2.6 不要加 `isUserInvocable` 过滤

官方那条 Remote 会 `.filter(isUserInvocable)`——那是给 `/` 补全菜单用的。
**只读浏览页必须显示全部**，包括 `disable-model-invocation` 的 skill。（B33/B34 钉这条。）

### 2.7 客户端的 `ROUTE` 必须是同源相对路径

宿主路由挂在 webServer 的 `/api` 之下，同源请求自带浏览器鉴权。
不要拼绝对地址，也不要自建 token。（A33 钉这条。）

> 副作用：Node 的原生 `fetch` **解析不了相对 URL**，所以自检里凡是触发客户端 `fetch` 的
> 地方，都必须把假 `fetch` 装着（D 区踩过：点击发生在假 fetch 已被还原之后，
> 报出 `Failed to parse URL from "/api/skill-manager"`）。

### 2.8 跨项目的 `cwd` 必须显式归一化：`null` 不是"不传"

范围下拉用 `""` 表示"当前会话"，用 `null` 表示"还没选过"。这两者都必须转成"不传"——
`fetchCatalog` 里 `cwd !== undefined` 的判断会把字符串 `"null"` 当路径发出去，
宿主会去扫一个名叫 `null` 的项目根。（D61 钉这条，实测抓到过。）

> 副作用：只在用户显式切换了项目时才传 `cwd`。不传时宿主自己从 session header
> 取权威 cwd——那是唯一可信的来源（见 2.4）。

### 2.9 范围选择的数据源是 root kit 的 `useWorkspaces`

`settings.section` 是 `scope: "root"`，所以页组件能拿到 root kit 的 `useWorkspaces`
（活台账 `standardProps` 已确认）。快照形状来自 `ui-workspace/lib/client.js:434`：
每项 `{ workspaceId, path, title, sessionIds, createdAt }`——`path` 决定扫哪个项目，
`title` 可能是**空串**（用路径最后一段兜底）。

### 2.10 目录数据面是**两个来源**：注册表 + 规范根目录直读，且**注册表优先**

**上游有一个不能指望的坑**：`dsh-skill-filesystem` 的 `list()` 是

```js
for (const root of roots) for (const skill of await discoverRoot(root, this.ctx, this.name)) candidates.push(skill);
```

——**整个循环没有 per-root 的 try/catch**。任何一个根目录抛错，`dsh-skill` 就把这个
提供方的**全部**候选丢掉（只打一行 warn + 标记 incomplete）。本机实测：
profile 的 `customSkillDirs` 指向 `app.asar` 内的 `<agent-preset>/skills`，
`ctx.fs.listDir` 在 asar 路径上抛 `FsError: cannot list …: Cannot mix BigInt and other types`
→ 项目根里**明明存在**的 skill 一起消失。用户实测表现：「选了项目还是只有随包内置那几个」。

所以宿主半边**自己按官方同一套根目录规则只读直读**那四个规范根（`scanRoots`）：

- **每个根、每个文件各自兜底**——这正是上游缺的那层隔离，绝不能再退回整段 try。
  （B87 钉这条；去掉兜底会让每个带 cwd 的用例一起报错。）
- 合并规则是**注册表优先**：同名一律以 `ctx.skills` 那一行为准，直读只补它没有的名字。
  提供方健康时这一路是**纯空操作**。（B84/B85/B86 钉这条。）
- 直读的行**只进本次 HTTP 响应**，绝不 `ctx.skills.register()`（那会改模型看到的东西）。
- **正文读取也要认直读出来的行**：`registry.get()` 对它们必然返回 undefined，
  所以 `readSkill` 在注册表未命中时要**按同一套根目录规则重新找到那个文件**再读。
  「列表里有、点开说没有」是最难看的失败形态。（B92–B94 钉这条。）
  注意**绝不接受客户端传来的路径**——唯一可信的来源是宿主自己算出来的规范根。
- 解析 `SKILL.md` 时**逐条对齐官方硬性要求**（frontmatter 存在、`name` kebab-case、
  `description` 非空、旧调用策略键名拒绝、布尔取值合法），任何一条不满足就跳过：
  **少列一个只是少列，多列一个才是错。**（B80 钉这条。）
- 直读结果里的 `source` 必须与官方 rank 表一致，否则两个来源会落进不同分组。
  （B91 钉这条：`roots` 探测与直读必须用**同一个** projectRoot。）

> 这条是对上游 bug 的**兜底**，不是"上游已修好"。上游那份 `customSkillDirs` 仍然会让
> 「自定义」分组读不出来（那个路径本插件读不到）。

### 2.11 构建流水线与产物契约：`src/**` → `lib/**`

| 源码 | 产物 | 形态 |
|---|---|---|
| `src/host/index.ts`（+ `src/host/service-types.ts`、`src/shared/types.ts`） | `lib/index.js` | esbuild ESM 单文件，`src/shared/**` 全部内联 |
| `src/client/index.ts`（+ `src/client/service-types.ts`、`src/shared/types.ts`） | `lib/client.js` | esbuild CJS 单文件 → `wrapClient()` 包成懒 CJS 工厂 classic script |
| 两边的 `src/**` | `lib/types/**` | `tsc -b` 的 `emitDeclarationOnly` 产物（`exports.types` 指这里） |

- **绝不手改 `lib/**`**。它是生成物：下一次 `npm run build` 直接覆盖，而且
  `lib/.build-manifest.json`（每个产物的 sha256 + 它依赖的每个 src 输入的 sha256）会立刻对不上。
  E 区钉这条（E1 manifest 覆盖两个产物 / E2 每个产物的 sha256 与当前文件一致 /
  E3–E4 src 下每个 `.ts` 都被某个产物登记为输入 / E5 产物带 build.ts 的「不要直接编辑」banner），
  CI 还多一道 `git diff --exit-code -- lib`：改了 `src/**` 忘了 build，红在那里，而不是让用户拿到过期产物。
- `lib/**` **入库**（它是运行时产物，也在 `files` 里）：`git clone` + 路径行挂载、`github:`
  安装都直接拿它——pnpm **不会**替你 build。
- 构建参数是刻意的，别"顺手优化"：`minify: false`（自检按文本断言常量名与文案）、
  `charset: 'utf8'`（默认会把中文转成 `\uXXXX`，按文案断言的自检会**静默**失效）、
  客户端 `external: ['react']`（唯一允许的 `require`）、客户端 `id` 由构建脚本从
  `package.json.name` 注入（**不要在源码里写第二份**）。
- 相对 import **必须带 `.ts` 扩展名**（`allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`）：自检脚本要能**直接跑 TS 源码**，而 Node 的 ESM
  解析器不认无扩展名的相对路径。
- Node **≥22.18**（原生类型擦除）：`node tools/build.ts` / `node tools/verify.ts`
  都是零构建直接跑，不需要先编译。

命令（`package.json`）：`npm run build`（src→lib + 指纹）、
`npm run typecheck`（`tsc -b --clean && tsc -b && tsc -p tsconfig.tools.json`）、
`npm run verify`（= `node tools/verify.ts`）、`npm run check`（前三步串起来）。

### 2.12 发布形态是 bundle：`cordis.patch.yml` 自带插件行

包名 `@qq540491950/dsh-skill-manager`，`type: module`，`main: lib/index.js`。
**装一次 = 把包装进 profile 的 `node_modules` + 把包名选进 `dsh.profile.bundles`**，
它的 patch 层随后自动插入 Loader 行 —— 用户**不再手写 profile 补丁**。

`package.json` 的关键字段（P 区逐条钉住，别"简化"）：

| 字段 | 值 | 为什么 |
|---|---|---|
| `dsh.manifestVersion` | `1` | bundle 清单版本 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 这就是"层"。缺了装上也只是一个普通 npm 包 |
| `dsh.client.platform` | `"web"` | 客户端半边活在 web GUI 里 |
| `main` / `types` | `lib/index.js` / `lib/types/host/index.d.ts` | |
| `exports` | `.`、`./client`、`./cordis.patch.yml`、`./locale/*.json`、`./package.json` | 后两个必须暴露，否则安装器读不到补丁层与文案 |
| `files` | `lib`、`cordis.patch.yml`、`locale/*.json`、`assets/icon.svg`、`README.md`、`LICENSE` | 白名单：`src/**`、`tools/**`、`AGENTS.md` **不发** |
| `engines` | `node >=22.18`、`dsh ^0.2.0-rc.2` | `dsh` 必须是**范围**：精确 pin 在升一个 rc 后会被判 incompatible |
| `peerDependencies` | **只有** `@deepseek-ai/cordis ~4.0.4` | 多钉 `@deepseek-ai/dsh-*` = 每次 DSH 升级都失效 |

`cordis.patch.yml` 里**只有插件自己一行，而且必须写在 `insert:` 下**（P3/P4 钉住）：

```yaml
- insert:
    - id: dsh-skill-manager
      name: '@qq540491950/dsh-skill-manager'
```

顶层 `- id: X` 是"覆写已存在条目"，目标不存在时 warn 并**丢弃**（见 1.4）——写成那样插件
根本不会出现，表现就是「设置里没有 Skills 页」。

**⚠️ 手写行与 bundle 安装不能并存。** profile 里那条
`- insert: [{ id: dsh-skill-manager, name: 'file:///…/lib/index.js' }]` 与 bundle 插入的是
**同 id 的两条条目**，后插入者赢、**不报错**，只会让人以为"装了个假的"。
迁移顺序：① 备份 profile → ② `install_bundle` → ③ 确认页面在 → ④ **再**删手写行。

安装/卸载/升级（`install_bundle` 的 `target` 是 **pnpm spec**，不是包名字段）：

| spec 形式 | 例子 | 装前能否判定是 bundle |
|---|---|---|
| registry | `@qq540491950/dsh-skill-manager` | ✅ 问注册表 |
| git | `github:qq540491950/dsh-skill-manager#v0.1.0` | ❌ 装后判定，不合格抛错并回滚 profile |
| 本地绝对路径 | `D:\project\dsh-plugins\dsh-skill-manager` | ✅ 直接读目录 `package.json` |
| `.tgz` | `…\qq540491950-dsh-skill-manager-0.1.0.tgz` | ❌ 同 git |

升级 = **就地装新 spec**（git 路线换 `#ref`）；重复**同一个** spec 才会 `ambiguous-install`。
卸载 `plugin_manager(action:'remove_bundle', target:'@qq540491950/dsh-skill-manager')`。
宿主半边变了 → 装完**重启一次 DSH**（1.2）。

**状态：尚未发布、尚未安装验证。** 本机 `npm whoami` → `ENEEDAUTH`（未登录），
profile 本轮**没有被改动**，所以"装进 profile 后页面真的能用"这件事**未实测**。
写文档时不许把它写成已验证。

---

## 3. UI 纪律

### 3.1 绝不硬编码颜色

深色主题下 `--dsw-alias-brand-primary` **近白色**，写 `#fff` 会白底白字。
十六进制颜色**只允许作为 `var()` 的 fallback**。（A24 会在剥掉 `var(...)` 之后检查裸色值。）

### 3.2 视觉与尺寸写进注入的样式表，**绝不写 inline**

- inline `background` 的优先级**高于** CSS 的 `:hover` → 按钮永远没有悬停反馈
- inline `height` 会压过样式表

inline 只允许布局属性（白名单见 `tools/verify.ts` 的 `INLINE_ALLOWED`）。（A27 钉这条。）

### 3.3 `order` 与席位

座位现状（**活台账**，`Slots.listSubTree`）：`account/-10`、`general/0`、`models/10`、
`plugins/15`、`agent-presets/20`、`mcp/900`（本地 `dsh-mcp-manager`）。本插件 `910`。
**唯一性约束在 `(id, priority)`，不在 `order`**；同 `(id, priority)` 重复会抛错。

### 3.4 座位注册字段白名单里**没有 `icon`**

`dsh-client-ui-slots/lib/index.js:205-220` 枚举了
`key/id/order/label/priority/select/inject/children/store/locale/registrant`，写 `icon` 会被**静默丢弃**。
导航图标由官方 `navIcon(id)` 硬编码查表、未知 id 兜底成齿轮。
**不要学 `dsh-mcp-manager` 的「打 data 属性 + CSS 覆盖」**——那依赖官方 DOM 结构，一改就静默失效。（C13 钉这条。）

### 3.5 必须走 `slots.inject("settings.section", …)`，不能直接 `register`

该座位由官方 `settings-general` 的 `sidebar.settings.children` 声明
（`lib/client.js:1136-1139`）。**未声明的座位直接 register 会抛
`slot "..." is not declared`。**（A22 钉这条。）

### 3.6 自适应

每个**可收缩的** flex 容器显式 `min-width:0`（`flex:none` 的操作区/徽标区除外）；
长文本 `text-overflow:ellipsis`，长路径 `overflow-wrap:anywhere`。（A28 钉这条。）

> 这条断言抓到过真 bug：`.dskm-rows` 漏了 `min-width:0`——是我自己写完断言后跑的第一次
> 自检报出来的，不是事后补的。

### 3.7 同一条错误只允许**一个**渲染点

一个错误状态配两个渲染点 = 同一句话在页面上出现两遍。规则：**错误跟着它的来源走，且只有一个出口。**
（D20 用"出现次数 == 1"钉这条。）

### 3.8 **空分组必须照常渲染**，否则「空」和「不存在」长得一模一样

这是第一次真实实测暴露的问题：本机确实没有项目/全局 skill，而初版**只渲染非空分组**，
于是「项目」「全局」两节整块消失。用户看到一片空白，只能得出"这个功能没做"——
**他的判断没有错，是界面在撒谎。**

规则：

- 四个规范分组（项目 / 全局 / 自定义 / 随包内置）**永远列出**，`other` 才按需出现。（D27–D30）
- 呈现形式是**标签页 + 个数**，一次只展开一个——**个数必须留在标签上**。
  点开才看得见"0"就等于又把空分组藏起来了。（D39/D40）
- 默认选中**第一个非空分组**，否则一进来正好停在空标签页上，看起来又像"没有 skill"。（D46）
- 空分组的解释要分清三种：**「目录都不存在」「目录存在但里面没有合法的 skill」「暂时读不到」**。
  （B64、D33、D50、D65）
- **「未判定」绝不能报成「不存在」** —— 把沙箱/能力问题说成"你没装"是误报。（B64）

> **规则变更（2026-10-13，用户实测反馈）**：这一节原本还要求「每个分组必须带上**真实根目录路径 + 存在性**，
> 客户端跟着选中分组渲染」（旧 D31/D45）。用户明确表示那些绝对路径与「存在/不存在」小字是
> **使用者不用看到的内容**，已整体从界面移除。
> **防护意图保留**：三种空原因仍然分开说，只是改成一句大白话、不含任何路径；
> `roots`/`exists` 仍在 payload 里，客户端只用它**选哪句话**，不再渲染。
> **页面上任何位置都不许再出现根目录路径**——D31（存在那一支）、D65（都不存在那一支）、
> D32（不许出现「存在/不存在/未判定」标签）分别钉住，两支都覆盖到了。

### 3.9 ~~`完整性 未完成` 必须可操作~~（已废止）

这一节原本要求把「完整性 未完成」连同 `providers` 汇总渲染出来，作为"是谁没交作业"的线索。

**2026-10-13 用户实测反馈后整体下线**：那条红色提示渲染的是 `FsError: cannot list
"…app.asar…": Cannot mix BigInt and other types` 这类**内部原文**，用户原话是
「把冗余提示都去掉，这是作为使用者不用看到的内容」。

处置：

- 界面上**不再渲染**任何诊断：没有 `providerFailures`、没有 `providers` 汇总、没有
  「本次发现未完成」、没有作用域/预设/cwd/项目根那一行事实面板。（D8、D47、D52 钉这条。）
- **根因没有放着不管**：那条提示想解释的「一个坏根目录把项目 skill 一起丢掉」，
  改由 2.10 的**直读兜底**在数据面上解决。（B71–B88 钉这条。）
- 宿主仍然如实产出 `complete` 与 `providers`（它们是读接口的一部分，将来别的消费者要用），
  只是这一页不渲染。**`providerFailures` 连同 `logger.exporter` 整条管道已删除**——
  它唯一的存在理由就是渲染那块红字。（B90 钉这条。）

### 3.10 徽标显示**提供方**，不要重复分组名

`bundled` 徽标 + 「随包内置」分组并排出现，会让人以为分类错了（第一次实测的真实反馈）。
徽标给具体提供方（`dsh-office` / `filesystem`），分组名交给分组标题。（D37/D38）

---

## 4. 改代码的流程

### 4.1 动手前先跑自检

```powershell
node tools/verify.ts       # 只跑自检（零依赖，不用装 node_modules）
npm run check              # typecheck + build + verify，交付前跑这条
```

改动前 PASS、改动后 FAIL，才能证明是你的改动引起的。

### 4.2 每修一个 bug，**同时加断言**

六个区：

| 区 | 覆盖 |
|---|---|
| A | 静态护栏：包清单 / 座位注册形状 / 主题与 inline 纪律 / 零 import / 只读性 / 编码 |
| B | **宿主半边行为**：假 ctx 真跑 `apply`、真发 `Request`，断言解析链、租约释放、分组、读取、**直读兜底与合并规则** |
| C | 客户端协议：假 `window.__ModuleLoader__` 真跑 factory，断言座位注册项与 require 面 |
| D | **真实渲染**：迷你渲染器展开函数组件（含 hook 顺序计数），覆盖就绪/空/失败/**无诊断**/展开正文 |
| E | **产物契约 / 构建新鲜度**：`lib/.build-manifest.json` 覆盖两个产物、每个产物的 sha256 与 `lib/**` 现状一致、`src/**` 下每个 `.ts` 都被登记为输入（改了 src 忘了 build 立刻红）、产物带 build banner |
| P | **发布形态**：`dsh.bundle.patch` 与 patch 行形状（在 `insert:` 里、`id`/`name` 对齐）、`locale`、`icon`、`files`、`exports`、`engines`、`peerDependencies` 只允许 `@deepseek-ai/cordis`、密钥扫描 |

A–D 查**行为**，E/P 查**"能不能交出去"**：E 拦"产物与源码不符"，P 拦"包字段被顺手简化"。

### 4.3 新断言必须做**反向验证**

故意注入违规、确认断言能**精确**报错——**然后还原**。

本次记录（**11/11** 通过；脚本逐条打印「注入了什么 → 报出哪几条 → 是否已还原」）。反向验证里有**五个**容易自欺的陷阱，都必须避开：

1. **注入点会崩掉自检进程** → 断言根本来不及打印，看起来像"没报错"。
   例：直接注入 `scope.configEditor.edit();` 会在 `apply` 期间抛错、整进程崩掉。
   正确做法：`if (false) scope.configEditor.edit();`——源码里有这个名字，但不执行。
   **本轮又踩到一次**：注入「去掉 per-root 兜底」后请求全变 409，自检崩在 B24
   （`data.skills.map` 上抛 TypeError），**一条 FAIL 行都没打出来**，第一版反向脚本
   把它记成了"注入没生效"。修法见 5.5。
2. **注入锚点不唯一** → 替换到多处或替换不到，用例本身失效。
   例：`color:var(--dsw-alias-label-primary);` 在两个选择器里都出现。
   正确做法：反向验证脚本先断言锚点**恰好出现 1 次**，否则判该用例失效。
   **本轮也踩到**：用 PowerShell 写注入脚本时反引号被吃掉，锚点静默变成 0 次命中，
   看起来像"注入了但不报错"。**注入脚本要写成独立文件**（`.mjs` / `.ts`）再跑，
   不要塞进 `node -e` 字符串。
3. **断言里带半真半假的「或」** → 等于没断言。
   例：`a === undefined || b === c` 其中一支恒真。要么拆成两条，要么只留真判断。
4. **注入打错了半边** → D 区用的是**客户端夹具**，往宿主里注入 `roots` 对 D 区毫无影响。
   要验 D 区的断言，必须注入客户端半边。（第一次就这么写错，报出"没报出"。）
   **产物是生成的**：注入一律打在 `src/**` 上再 `npm run build`——直接改 `lib/client.js`
   会被 E 区的指纹断言（以及 CI 的 `git diff --exit-code -- lib`）抓出来，于是你分不清
   是"注入没生效"还是"没重新构建"。
5. **平凡通过的断言** → **一条永远不会失败的断言等于没有断言**，比没有更糟，因为它给人
   虚假的安全感。例：B65 原本断言"fs 抛错时目录读取仍成功"——可 `pathExists` 自己已经
   吞掉了 fs 异常，外层兜底 catch 永远跑不到，删掉兜底也照样 PASS。
   正确做法：把断言拆到**能被打破**的粒度（现在 B65/B68/B69 三件事分别断言，
   其中 B68「roots 仍有 6 条」在 `pathExists` 改成抛出后确实会报错）。
   **本轮新增的一类**：同一属性有两个渲染分支时，只断言其中一支 = 另一半没护栏。
   D31 原本只覆盖「目录存在」那一支的空状态，把路径拼进「都不存在」那一支它看不见，
   于是补了 D65。

推荐的注入面（B9 丢 scope / B10 不释放租约 / B18 不用权威 cwd / B33 误加过滤 /
A11 出现写入 API / A24 硬编码颜色 / A7 bundle id / D2 不发 sessionId / D12 条件式 hook /
D28 过滤空分组 / D32 渲染存在性标签 / D40 标签页不带个数 /
D44 标签页点不动 / D46 默认不挑非空分组 / D53 不渲染范围下拉 / D56 换项目不带 cwd /
D61 把 null 当 cwd 发出去 / D60 正文不带 cwd / B53 不走 .git 祖先 /
B54 不返回 roots / B64 未判定误报为不存在 / B68 探测出错就整块丢掉）。

**本轮新增的注入面**（直读与诊断下线）：

| 注入 | 应当报出 |
|---|---|
| 停用 `scanRoots`（回到"只有注册表"） | B71–B78b、B87、B88 |
| 去掉「注册表优先」去重 | B84 |
| 去掉 `listDirViaFs` 的 per-root 兜底 | B87（且会让所有带 cwd 的用例一起报错） |
| 放宽 skill 名校验 | B80 |
| 把路径拼进「目录存在」那一支的空状态 | D31、D34 |
| 把路径拼进「都不存在」那一支的空状态 | D65 |
| 把「完整性 未完成」/ 事实面板塞回页面 | D8、D47、D52、D62 |
| 把 `providerFailures` 塞回 payload | B90 |
| 正文读取不回退到直读 | B92–B94 |

> ⚠️ **锚点会随代码过期**：每轮重构之后，上一轮的注入锚点可能已不存在
> （`if (sessionId !== undefined) params.set(...)`、`buildTabs` 取代 buckets 都发生过）。
> 跑反向验证时如果报「锚点出现 0 次」，先改用例再下结论。

### 4.4 本轮（TypeScript 化 + 改为 bundle 发布）的反向验证记录

针对**新增的 A0 / E 区 / P 区**断言：**13/13 全部按预期报出，且全部逐字节还原**。
脚本是一次性文件（`tools/.tmp/reverse.mjs`，跑完即删），每个用例的固定动作：
① 先确认锚点在目标文件里**恰好出现 1 次**（否则判该用例无效）→ ② 注入 → ③ 跑
`node tools/verify.ts` → ④ 从 stderr 的失败行里读回断言 id → ⑤ **无条件还原**并与注入前
字节比对。

| 注入 | 应当报出 | 实测报出 |
|---|---|---|
| `package.json` 缺 `name` 字段 | A0 | A0（连带 A1/A7/P4/C2） |
| `dsh.bundle.patch` 指向不存在的文件 | P1 | P1（连带 P3/P4） |
| `dsh.manifestVersion` 改成 `2` | P2 | P2 |
| 插件行写成顶层 `- id:`（不是 `insert:` 下） | P3 | P3（连带 P4） |
| 补丁行 `name` 与包名不符 | P4 | P4 |
| `files` 漏掉 `LICENSE` | P8[LICENSE] | P8[LICENSE] |
| `files` 里混进 `src` | P9 | P9 |
| `license` 字段清空 | P11 | P11 |
| `peerDependencies` 多钉一个 `@deepseek-ai/dsh-*` | P14 | P14 |
| 手改 `lib/index.js` | E2[lib/index.js] | E2[lib/index.js] |
| 改 `src/shared/types.ts` 但不 build | E3（两个产物各一条） | E3[lib/index.js ← …]、E3[lib/client.js ← …] |
| 产物丢了 build banner | E5[lib/client.js] | E5[lib/client.js]（连带 E2） |
| 发布文件里混进密钥（README 插 `tvly-`） | P15[README.md] | P15[README.md] |

本轮新踩到两个"看起来像没报出"的坑（补进上面的陷阱清单）：

1. **有的注入面根本到不了被测代码**：想用「把 `package.json` 写成非法 JSON」测 A0，
   结果 **Node 自己**就因 `ERR_INVALID_PACKAGE_CONFIG` 起不来（最近的 `package.json`
   非法时连入口都不解析）。那是注入面无效，不是断言无效——改成「删 `name` 字段」才验得到。
2. **失败行 id 里可能带空格**（`E3[lib/index.js <- src/shared/types.ts]`）。反向脚本若用
   `^\s+x (\S+?):` 抓 id，就会把 E3/E4 这类 id **全漏掉**，看起来像"没报出"。用
   `^ {2}x (.+?): `。

> A0 这条本身也是这一轮补的：`package.json` 读不到 / 解析不了时，自检**不许**在解引用处
> 崩掉（崩掉的输出里一条失败行都没有，见 5.5）。现在解析失败会落成一条干净的
> `x A0: …`，后面的断言照常跑完。

### 4.5 测交互时，**事件闭包是当次渲染的**

`onChange` / `onClick` 闭包捕获的是**那一次渲染**的状态。先抓按钮节点、再触发状态变更、
最后用旧节点去点 —— 测的是过去。**必须在状态变更 + 重新 mount 之后重新查一遍 DOM。**
（D60 踩过：拿着切换前抓的「查看」按钮去点，POST 里没有 cwd。）

另外：JSON 断言别用 `stringify(…).includes(...)`——JSON 会把 `/` 转义成 `\/`，永远匹配不上。

### 4.6 断言报错时，先判断是**断言错了**还是**代码错了**

例：B39 原本断言"无 sessionId 时 cwd 也等于某个路径"——那是断言错，
因为此时宿主**确实**拿不到权威 cwd，如实报 `undefined` 才是对的。改断言要说明理由，
并保留原有的防护意图。

### 4.7 不要为了让断言通过而放宽断言

如果断言拦住了你的改动，先判断是断言过严还是改动错了。

---

## 5. 自检工具自身的坑（写 `tools/verify.ts` 前必读）

### 5.1 D 区必须用**活的** react 重新加载 bundle

bundle 在 factory 执行时就把 `require("react")` 的结果**闭包进组件**了。
如果 D 区复用了 C 区那个替身 react（`useState` 返回 `[undefined, noop]`），
组件里的 hook 会永远返回 `undefined`，报出
`TypeError: Cannot read properties of undefined (reading 'name')`。

正确做法：`renderSection()` 每次都 `loadClientModule(runtime.react)` 重新加载一遍，
再用它注册出来的组件。C 区才用替身。

### 5.2 渲染循环必须让出一个**宏任务**

effect 里的数据链是 `async/await` + `.then(setState)`。只 `await` 一个非 promise 的返回值
（cleanup 函数）**只推进一个微任务**，状态还没落定，循环就会在「读取中…」那一帧
判定为"稳定"并返回——于是 D3–D10 全挂在"没渲染出列表"上。

正确做法：每轮 `await new Promise((r) => setTimeout(r, 0))`。

### 5.3 静态检查先**剥掉注释**

否则注释里提到的 API 名（如"没有 `ctx.configEditor.edit()`"）会被当成真实调用，
写出**永远误报**的断言。`stripComments()` 就是干这个的。

### 5.4 迷你渲染器的 hook 计位要抓得住条件式 hook

`renderTree` 每次渲染把 `inst.index` 记进 `inst.history`，D12 断言
`history` 里所有值相等。注入一个条件式 `useState` 后能打出
`[5,6,6] —— 存在条件式 hook`，说明这条守卫是有效的。

### 5.5 失败响应**没有 `data`**，断言不许在上面抛 TypeError

路由失败时返回 `{ ok:false, error }`，**没有 `data`**。直接写
`const data = result.body.data; data.skills.map(...)` 的话，一旦被测行为回归、
请求变成 409，自检就会**崩在第一处解引用上**——后面的断言全部来不及跑，
输出里连一条 `x …` 都没有。反向验证时这会被误判成"注入没生效"（本轮真踩到）。

修法：`getJson()` 在 `data` 缺失时补成文档里的**空形状**
（`{ skills: [], counts: {}, providers: {}, roots: [], complete: false }`），
让断言报出「实际 0 条 / undefined」这类**干净**的失败。

补默认值不会掩盖回归：`skills` / `roots` / `complete` 各自都有专门断言
（B24 / B38 / B54），字段一缺就是一条明确的失败。

> 反向验证脚本同样要区分「报出了 FAIL 行」和「进程崩了」——后者必须单独判为
> **该用例无效**，不能记成"没报出"。

---

## 6. 交付标准

声称"做完了"之前必须给出：

1. `npm run check` 全绿（typecheck + build + verify），外加 `node tools/verify.ts` 的
   `PASS n/n`（**以实际输出为准**，不要抄一个数字）
2. 反向验证结果（哪几条注入了违规、报出了什么、是否已还原）
3. 编码检查：无 BOM、无 `U+FFFD`、LF 行尾（A30–A32 查 `src/**`；**产物是生成的、也要查**——
   真正发到用户机器上的是 `lib/**`；文档与配置另查）

   ```powershell
   node -e "const fs=require('fs');for (const p of ['src/host/index.ts','src/client/index.ts','lib/index.js','lib/client.js','README.md','AGENTS.md']) { const b=fs.readFileSync(p); const t=b.toString('utf8'); console.log(p, (b[0]===0xEF?'BOM!':'no-bom'), (t.includes(String.fromCharCode(0xFFFD))?'FFFD!':'clean'), 'crlf='+(t.match(/\r\n/g)||[]).length) }"
   ```

4. 改了什么、**为什么**、以及**哪些部分没有实测**。动过 `src/**` 的话，还要确认 `lib/**`
   已重新构建并**一并提交**（只提交源码会让 E 区与 CI 的 `git diff --exit-code -- lib` 变红）

**安装与座位注册本身不等于"用户能看见"。** 没有实测的部分必须明说，
不要把推断写成结论。本仓库明确区分"已实测"与"未实测"（`README.md` 第 7 节）。

---

## 7. Git 约定

- 分支 `main`
- 提交信息用中文，结构：`feat|fix|docs: 一句话` + 空行 + 分节说明（接入点 / 数据面 / 正确性 / UI / 自检）
- 提交信息**写进 UTF-8 文件后用 `git commit -F` 传入**，不要用 `-m` 直传中文（见 1.1）
- 提交前扫密钥：本仓库不得包含真实 token / API key
- `lib/**` 是**生成物但入库**：改了 `src/**` 就 `npm run build` 后一并提交（见 2.11）
- `.gitattributes` 强制 LF；不要引入 CRLF（混入会产生整文件 diff）
- 沙箱下 `git push` 的 stderr 进度输出会被 PowerShell 当成错误记录并给出 `[exit code: 1]`，
  这是**假警报**——以 `git ls-remote` 与 `git status -sb` 为准

---

## 8. 已知边界（不要试图"修好"）

| 边界 | 说明 |
|---|---|
| 宿主半边不热重载 | 见 1.2（改 `src/host/**` 要 build **并且**重启） |
| 导航图标不可由插件提供 | 见 3.4 |
| 未接 `ctx.locale` | 官方 practices 要求文案走 Client locale 服务；本插件硬编码中文，与同目录 `dsh-mcp-manager` 一致。**有意的偏离。** |
| `order` 不保证"永远最后" | 910 只是大于 MCP 的 900 |
| 项目范围 = 最近 `.git` 祖先 | 上游约束，不支持 monorepo 子项目选择 |
| 无 body 修订协议 | 上游：已加载的正文是普通历史，编辑文件不会改写旧结果 |
| `listTokens` 不是完整 token 表 | 它只列需要 light/dark 双份覆写的 alias 子集；判断 token 是否存在以官方 CSS 用法为准 |
| 宿主日志基本不可看 | 要靠自检 + 渲染测试兜住，不能靠"跑起来看看" |
| **`lib/**` 是生成物** | 源码在 `src/**`，改完必须 `npm run build`。手改 `lib/**` 会被下一次构建覆盖，且 E 区 + CI 的 `git diff --exit-code -- lib` 会红（见 2.11） |
| **bundle 安装未实测、包未发布** | 还没装进任何 profile，也没 `npm publish`（本机 `npm whoami` → `ENEEDAUTH`）。"装完页面就能用"目前是**推断**，不是实测（见 2.12） |
| **包图标渲染未见** | `assets/icon.svg` 只是 bundle 清单字段；座位注册字段白名单里没有 `icon`（3.4），它不进导航图标。界面里实际什么样**没看过** |
| **上游 provider 会被一个坏根目录整条拖死** | `dsh-skill-filesystem.list()` 没有 per-root try/catch。**本插件用直读兜底（见 2.10），但那不等于上游修好了**：`customSkillDirs`（本机指向 app.asar 内的 `<agent-preset>/skills`）仍然读不出来，「自定义」分组因此仍可能是 0。修它属于 profile 配置，不归本插件。 |
| **直读的 frontmatter 解析是子集** | 宿主半边零 import，拿不到官方的 `yaml` 包，只实现了 `key: value` / 块标量 / 引号标量。比官方严格或宽松的写法都会导致「少列」或「多列」。因此**逐条对齐官方的硬性要求**（B80），并且**宁可漏也不编**。 |
| 阶段一没有写入 | 这是范围，不是缺口。要加写入时，走 `ctx.configEditor.edit()`（外科手术式 YAML 编辑），**禁止** `ctx.loader.create()/remove()`（`EntryTree.write()` 会整体重写、压平用户手写的 `insert:` 分节） |
