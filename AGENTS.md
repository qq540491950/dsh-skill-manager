# AGENTS.md —— 本仓库的 agent 工作约束

> 写给在本仓库里干活的 AI agent。
> 每条规则都对应一次**真实踩过的坑**；括号里是失败现象，不是理论风险。
> 三级：**硬性纪律**（违反会破坏数据或环境）＞**代码边界**（抄近路会引入已知 bug）＞**风格约定**。

---

## 0. 30 秒定位

**这是什么**：一个 DSH 插件，在设置面板加一页「Skills」，**只读**浏览当前会话可见的
skill，按来源分组（项目 / 全局 / 自定义 / 随包内置）。**第一阶段没有任何写入路径。**

**双半结构**：

| 半边 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 零 import。`ctx.connection.fetch.register()` 开 `/api/skill-manager`；解析作用域后读 `ctx.skills`。 |
| 客户端 | `lib/client.js` | `window.__ModuleLoader__` 懒 CJS bundle。注册 `settings.section`（list 座位，`order: 910`）。 |

**唯一必跑的命令**：

```powershell
node tools/verify.mjs      # 期望 PASS 177/177
```

**设计依据、已实测/未实测清单、证据出处**：`README.md`（第 3 节作用域解析、第 7 节实测状态、第 9 节 asar 解包）。

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

- 改 `lib/client.js` → 热替换（但**只有在 `pnpm run dev:web` 也在跑**时才免刷新；否则要刷新页面）
- 改 `lib/index.js` → **不生效**，需重启 DSH

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

### 1.5 文件被并发编辑时按护栏重做，不要覆盖

`edit` 报 `file changed since it was read` 时：**重新读取 → 基于新内容重做**，
绝不要改成整文件写入来"绕过"护栏。

---

## 2. 代码边界（抄近路 = 已知 bug）

### 2.1 宿主半边**零 import**

本文件由 Loader 以 `file:///...` 绝对路径加载，裸模块说明符都在 app.asar 里，
从磁盘路径解析不到。只用注入进来的 Service + 全局 `URL` / `Response` / `AbortController`。
（A8–A10 钉这条。）

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

---

## 3. UI 纪律

### 3.1 绝不硬编码颜色

深色主题下 `--dsw-alias-brand-primary` **近白色**，写 `#fff` 会白底白字。
十六进制颜色**只允许作为 `var()` 的 fallback**。（A24 会在剥掉 `var(...)` 之后检查裸色值。）

### 3.2 视觉与尺寸写进注入的样式表，**绝不写 inline**

- inline `background` 的优先级**高于** CSS 的 `:hover` → 按钮永远没有悬停反馈
- inline `height` 会压过样式表

inline 只允许布局属性（白名单见 `tools/verify.mjs` 的 `INLINE_ALLOWED`）。（A27 钉这条。）

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
- 每个分组必须带上**真实根目录路径 + 存在性**，由**宿主**解析（`projectRoot` 靠向上找 `.git`，
  home 靠环境变量），客户端不自己拼；它跟着选中分组走。（B53–B62、D31、D45）
- 空分组的解释要分清三种：「根目录不存在」「根目录存在但为空」「无法判定」。（B64、D33）
- **「未判定」绝不能报成「不存在」** —— 把沙箱/能力问题说成"你没装"是误报。（B64）

### 3.9 `完整性 未完成` 必须可操作

只说"某个根目录扫描失败"等于没说。payload 里的 `providers`（按提供方汇总）是唯一能指向
**是谁没交作业**的线索：期望的文件系统提供方不在那一行里，就是它的根目录这次一个都没扫成功。（B63、D36）

### 3.10 徽标显示**提供方**，不要重复分组名

`bundled` 徽标 + 「随包内置」分组并排出现，会让人以为分类错了（第一次实测的真实反馈）。
徽标给具体提供方（`dsh-office` / `filesystem`），分组名交给分组标题。（D37/D38）

---

## 4. 改代码的流程

### 4.1 动手前先跑自检

```powershell
node tools/verify.mjs
```

改动前 PASS、改动后 FAIL，才能证明是你的改动引起的。

### 4.2 每修一个 bug，**同时加断言**

四个区：

| 区 | 覆盖 |
|---|---|
| A | 静态护栏：包清单 / 座位注册形状 / 主题与 inline 纪律 / 零 import / 只读性 / 编码 |
| B | **宿主半边行为**：假 ctx 真跑 `apply`、真发 `Request`，断言解析链、租约释放、分组、读取 |
| C | 客户端协议：假 `window.__ModuleLoader__` 真跑 factory，断言座位注册项与 require 面 |
| D | **真实渲染**：迷你渲染器展开函数组件（含 hook 顺序计数），覆盖就绪/空/失败/不完整/降级/展开正文 |

### 4.3 新断言必须做**反向验证**

故意注入违规、确认断言能**精确**报错——**然后还原**。

本次记录（20/20 通过）。反向验证里有**五个**容易自欺的陷阱，都必须避开：

1. **注入点会崩掉自检进程** → 断言根本来不及打印，看起来像"没报错"。
   例：直接注入 `scope.configEditor.edit();` 会在 `apply` 期间抛错、整进程崩掉。
   正确做法：`if (false) scope.configEditor.edit();`——源码里有这个名字，但不执行。
2. **注入锚点不唯一** → 替换到多处或替换不到，用例本身失效。
   例：`color:var(--dsw-alias-label-primary);` 在两个选择器里都出现。
   正确做法：反向验证脚本先断言锚点**恰好出现 1 次**，否则判该用例失效。
3. **断言里带半真半假的「或」** → 等于没断言。
   例：`a === undefined || b === c` 其中一支恒真。要么拆成两条，要么只留真判断。
4. **注入打错了半边** → D 区用的是**客户端夹具**，往宿主里注入 `roots` 对 D 区毫无影响。
   要验 D 区的断言，必须注入 `lib/client.js`。（第一次就这么写错，报出"没报出"。）
5. **平凡通过的断言** → **一条永远不会失败的断言等于没有断言**，比没有更糟，因为它给人
   虚假的安全感。例：B65 原本断言"fs 抛错时目录读取仍成功"——可 `pathExists` 自己已经
   吞掉了 fs 异常，外层兜底 catch 永远跑不到，删掉兜底也照样 PASS。
   正确做法：把断言拆到**能被打破**的粒度（现在 B65/B68/B69 三件事分别断言，
   其中 B68「roots 仍有 6 条」在 `pathExists` 改成抛出后确实会报错）。

推荐的注入面（B9 丢 scope / B10 不释放租约 / B18 不用权威 cwd / B33 误加过滤 /
A11 出现写入 API / A24 硬编码颜色 / A7 bundle id / D2 不发 sessionId / D12 条件式 hook /
D28 过滤空分组 / D31 不渲染根目录路径 / D36 去掉提供方汇总 / D40 标签页不带个数 /
D44 标签页点不动 / D46 默认不挑非空分组 / B53 不走 .git 祖先 /
B54 不返回 roots / B64 未判定误报为不存在 / B68 探测出错就整块丢掉）。

### 4.4 断言报错时，先判断是**断言错了**还是**代码错了**

例：B39 原本断言"无 sessionId 时 cwd 也等于某个路径"——那是断言错，
因为此时宿主**确实**拿不到权威 cwd，如实报 `undefined` 才是对的。改断言要说明理由，
并保留原有的防护意图。

### 4.5 不要为了让断言通过而放宽断言

如果断言拦住了你的改动，先判断是断言过严还是改动错了。

---

## 5. 自检工具自身的坑（写 `tools/verify.mjs` 前必读）

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

---

## 6. 交付标准

声称"做完了"之前必须给出：

1. `node tools/verify.mjs` 的输出（`PASS n/n`）
2. 反向验证结果（哪几条注入了违规、报出了什么、是否已还原）
3. 编码检查：无 BOM、无 `U+FFFD`、LF 行尾（A30–A32 会自动查源码；文档与配置另查）

   ```powershell
   node -e "const fs=require('fs');const b=fs.readFileSync('lib/client.js');const t=b.toString('utf8');console.log((b[0]===0xEF?'BOM!':'no-bom'),(t.includes(String.fromCharCode(0xFFFD))?'FFFD!':'clean'),'crlf='+(t.match(/\r\n/g)||[]).length)"
   ```

4. 改了什么、**为什么**、以及**哪些部分没有实测**

**安装与座位注册本身不等于"用户能看见"。** 没有实测的部分必须明说，
不要把推断写成结论。本仓库明确区分"已实测"与"未实测"（`README.md` 第 7 节）。

---

## 7. Git 约定

- 分支 `main`
- 提交信息用中文，结构：`feat|fix|docs: 一句话` + 空行 + 分节说明（接入点 / 数据面 / 正确性 / UI / 自检）
- 提交信息**写进 UTF-8 文件后用 `git commit -F` 传入**，不要用 `-m` 直传中文（见 1.1）
- 提交前扫密钥：本仓库不得包含真实 token / API key
- `.gitattributes` 强制 LF；不要引入 CRLF（混入会产生整文件 diff）
- 沙箱下 `git push` 的 stderr 进度输出会被 PowerShell 当成错误记录并给出 `[exit code: 1]`，
  这是**假警报**——以 `git ls-remote` 与 `git status -sb` 为准

---

## 8. 已知边界（不要试图"修好"）

| 边界 | 说明 |
|---|---|
| 宿主半边不热重载 | 见 1.2 |
| 导航图标不可由插件提供 | 见 3.4 |
| 未接 `ctx.locale` | 官方 practices 要求文案走 Client locale 服务；本插件硬编码中文，与同目录 `dsh-mcp-manager` 一致。**有意的偏离。** |
| `order` 不保证"永远最后" | 910 只是大于 MCP 的 900 |
| 项目范围 = 最近 `.git` 祖先 | 上游约束，不支持 monorepo 子项目选择 |
| 无 body 修订协议 | 上游：已加载的正文是普通历史，编辑文件不会改写旧结果 |
| `listTokens` 不是完整 token 表 | 它只列需要 light/dark 双份覆写的 alias 子集；判断 token 是否存在以官方 CSS 用法为准 |
| 宿主日志基本不可看 | 要靠自检 + 渲染测试兜住，不能靠"跑起来看看" |
| 阶段一没有写入 | 这是范围，不是缺口。要加写入时，走 `ctx.configEditor.edit()`（外科手术式 YAML 编辑），**禁止** `ctx.loader.create()/remove()`（`EntryTree.write()` 会整体重写、压平用户手写的 `insert:` 分节） |
