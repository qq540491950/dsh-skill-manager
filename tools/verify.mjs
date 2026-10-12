/**
 * 自检（`node tools/verify.mjs`）。零依赖，只用 Node 内置模块。
 *
 * ## 为什么要有这个文件
 *
 * 本插件的宿主半边**不会热重载**（dsh-hmr 只监听 DSH 安装目录与 profile 补丁文件，
 * 本仓库目录不在其中，且 Node 的 ESM 按 URL 缓存模块）。宿主侧一旦改错，唯一能立刻
 * 发现的手段就是把它当成纯函数真跑一遍。客户端半边虽然会热重载，但"跑起来看看"
 * 兜不住回归——所以两条半边都在这里用替身真跑，包括**真实渲染**。
 *
 * ## 断言分区
 *
 * | 区 | 覆盖 |
 * |---|---|
 * | A | 静态护栏：包清单 / 座位注册形状 / 主题与 inline 纪律 / 零 import / 只读性 / 编码 |
 * | B | **宿主半边行为**：假 ctx 真跑 `apply`，真发 `Request`，断言作用域解析链、租约释放、分组、读取 |
 * | C | 客户端半边协议：假 `window.__ModuleLoader__` 真跑 factory，断言座位注册项与 require 面 |
 * | D | **真实渲染**：迷你渲染器递归展开函数组件（含 hooks 顺序计数），覆盖就绪/空/失败/不完整/降级/展开正文 |
 *
 * ## 断言必须被怀疑
 *
 * 每条断言都要有**反向验证**记录（故意注入违规 → 确认精确报错 → 还原）。
 * 所以：静态检查先**剥掉注释**（曾把注释里的 API 名当成真实调用，写出永远误报的断言）；
 * 断言里的「或」分支必须逐条有意义（`a === undefined || b === c` 这种半真半假的写法
 * 等于没断言）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let passed = 0
const failures = []

/**
 * @param id - 断言编号（A1 / B7 / C3 / D2…），失败时直接指出是哪一条。
 * @param ok - 判定结果。
 * @param detail - 失败时打印的「实际是什么」，不含具体值就没法定位。
 */
function check(id, ok, detail) {
  if (ok === true) passed++
  else failures.push(`${id}: ${detail}`)
}

/** 剥掉块注释与行注释。静态检查必须跑在剥完的源码上（见文件头）。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 反复剥掉**最内层**的 `var(...)`，直到没有；用于判断颜色是不是只出现在 fallback 里。 */
function stripVarCalls(source) {
  let out = source
  for (let i = 0; i < 20; i++) {
    const next = out.replace(/var\([^()]*\)/g, '')
    if (next === out) break
    out = next
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// A 区：静态护栏
// ─────────────────────────────────────────────────────────────────────────────

const hostSrc = readText('lib/index.js')
const clientSrc = readText('lib/client.js')
const pkg = JSON.parse(readText('package.json'))
const hostCode = stripComments(hostSrc)
const clientCode = stripComments(clientSrc)

check('A1', pkg.name === 'dsh-skill-manager', `package.json name = ${JSON.stringify(pkg.name)}`)
check('A2', pkg.type === 'module', `type = ${JSON.stringify(pkg.type)}`)
check('A3', pkg.main === 'lib/index.js', `main = ${JSON.stringify(pkg.main)}`)
check('A4', pkg.exports?.['.'] === './lib/index.js', `exports["."] = ${JSON.stringify(pkg.exports?.['.'])}`)
check('A5', pkg.exports?.['./client'] === './lib/client.js', `exports["./client"] = ${JSON.stringify(pkg.exports?.['./client'])}`)
// 客户端 bundle 要被 dsh-client-modules 认出来，必须有 dsh.client.platform === 'web'。
check('A6', pkg.dsh?.client?.platform === 'web', `dsh.client.platform = ${JSON.stringify(pkg.dsh?.client?.platform)}`)

// factory 的 id 必须逐字等于包名，否则 dsh-client-modules 找不到这个模块。
const loaderId = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(clientCode)?.[1]
check('A7', loaderId === pkg.name, `__ModuleLoader__ id = ${JSON.stringify(loaderId)}，package name = ${JSON.stringify(pkg.name)}`)

// 宿主半边零 import / 零 require：裸模块说明符都在 app.asar 里，从磁盘路径解析不到。
check('A8', !/^\s*import\s/m.test(hostCode), 'lib/index.js 出现了 import 语句')
check('A9', !/\brequire\s*\(/.test(hostCode), 'lib/index.js 出现了 require() 调用')
check('A10', !/\bfrom\s+['"]/.test(hostCode), 'lib/index.js 出现了 from "..." 形式')

// 第一阶段只读：不得出现任何写入路径。
for (const [id, needle] of [
  ['A11', 'configEditor'],
  ['A12', 'loader.create'],
  ['A13', 'loader.remove'],
  ['A14', 'writeText'],
  ['A15', 'editText'],
]) {
  check(id, !hostCode.includes(needle), `lib/index.js 含写入 API "${needle}"，第一阶段必须只读`)
}

// 宿主路由必须挂在 /api 之下（assertFetchRoute 的校验）。
const routeLiteral = /const ROUTE = '([^']+)'/.exec(hostCode)?.[1]
check('A16', typeof routeLiteral === 'string' && routeLiteral.startsWith('/api/'), `ROUTE = ${JSON.stringify(routeLiteral)}`)
// 客户端必须走**同源相对路径**：宿主路由挂在 webServer 的 /api 之下，
// 同源请求自带浏览器鉴权，不需要（也不该）拼绝对地址或自建 token。
const clientRoute = /const ROUTE = "([^"]+)"/.exec(clientCode)?.[1]
check('A33', typeof clientRoute === 'string' && clientRoute.startsWith('/'), `客户端 ROUTE = ${JSON.stringify(clientRoute)}，必须是同源相对路径`)

// 客户端不得加载任何 Harness Client 包（官方 practices 明令禁止）。
const requires = [...clientCode.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1])
check('A17', requires.length > 0 && requires.every((name) => name === 'react'), `客户端 require 面 = ${JSON.stringify([...new Set(requires)])}，只允许 react`)
check('A18', !/@deepseek-ai\//.test(clientCode), '客户端源码引用了 @deepseek-ai/ 包名')

// 座位注册形状：list 座位必须有唯一 id；order 要排在 MCP 页（900）之后。
const sectionId = /const SECTION_ID = "([^"]+)"/.exec(clientCode)?.[1]
const sectionOrder = Number(/order:\s*(\d+)/.exec(clientCode)?.[1])
const sectionLabel = /const SECTION_LABEL = "([^"]+)"/.exec(clientCode)?.[1]
check('A19', sectionId === 'skills', `SECTION_ID = ${JSON.stringify(sectionId)}`)
check('A20', Number.isInteger(sectionOrder) && sectionOrder > 900, `order = ${sectionOrder}，必须 > 900（MCP 页占 900）`)
check('A21', sectionLabel === 'Skills', `SECTION_LABEL = ${JSON.stringify(sectionLabel)}`)
check('A22', /slots\.inject\(\s*"settings\.section"/.test(clientCode), '客户端没有通过 slots.inject("settings.section", …) 注册（直接 register 会因座位未声明而抛错）')

// 主题纪律：颜色只允许作为 var() 的 fallback，绝不能是裸色值。
const css = /const CSS = `([\s\S]*?)`;/.exec(clientCode)?.[1] ?? ''
check('A23', css !== '', '没找到注入的 CSS 常量')
const bareColor = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.exec(stripVarCalls(css))
check('A24', bareColor === null, `CSS 里出现了裸色值 ${JSON.stringify(bareColor?.[0])}（硬编码颜色在深色主题下会白底白字；只允许写进 var() 的 fallback）`)
check('A25', css.includes('--dsw-alias-'), 'CSS 没有使用任何 --dsw-alias-* 主题 token')
// class 前缀，避免与官方样式冲突。
check('A26', !/\.(?!dskm-)[a-z][a-z0-9-]*\s*\{/.test(css), 'CSS 里有不带 dskm- 前缀的 class 选择器')

// inline 样式只允许布局属性（视觉/尺寸写 inline 会压过样式表与 :hover）。
const INLINE_ALLOWED = new Set(['display', 'gap', 'flex', 'flexWrap', 'alignItems', 'justifyContent', 'minWidth', 'maxWidth', 'minHeight', 'overflow', 'gridTemplateColumns'])
const badInline = []
for (const match of clientCode.matchAll(/style:\s*\{([^}]*)\}/g)) {
  for (const prop of [...match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1])) {
    if (!INLINE_ALLOWED.has(prop)) badInline.push(prop)
  }
}
check('A27', badInline.length === 0, `inline style 用了非布局属性 ${JSON.stringify(badInline)}`)

// 自适应纪律：flex 子项默认 min-width:auto，长内容会撑破容器。
// 例外：`flex:none` 的容器（操作区/徽标区）本来就不参与收缩，不需要这个护栏。
const flexBlocks = [...css.matchAll(/\.dskm-[A-Za-z]+[^{]*\{([^}]*)\}/g)].filter((m) => /display:flex/.test(m[1]))
const noMin = flexBlocks
  .filter((m) => !/min-width:0/.test(m[1]))
  .filter((m) => !/flex:none/.test(m[1]))
  .map((m) => m[0].split('{')[0].trim())
check('A28', noMin.length === 0, `这些可收缩的 flex 容器没有显式 min-width:0：${JSON.stringify(noMin)}`)

// 分组映射必须与官方 rank 表的 source 取值一致（少一个就会静默落进 other）。
const hostGroups = /const GROUPS = \{([\s\S]*?)\}/.exec(hostCode)?.[1] ?? ''
for (const source of ['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'custom', 'bundled', 'runtime']) {
  check(`A29[${source}]`, hostGroups.includes(source), `GROUPS 缺少 source "${source}"`)
}

// 编码纪律。
for (const rel of ['lib/index.js', 'lib/client.js', 'package.json', 'tools/verify.mjs']) {
  const buf = fs.readFileSync(path.join(ROOT, rel))
  const text = buf.toString('utf8')
  check(`A30[${rel}]`, buf[0] !== 0xef, `${rel} 带 BOM`)
  check(`A31[${rel}]`, !text.includes('\uFFFD'), `${rel} 含替换字符 U+FFFD（编码已损坏）`)
  check(`A32[${rel}]`, !text.includes('\r\n'), `${rel} 含 CRLF（本仓库统一 LF）`)
}

// ─────────────────────────────────────────────────────────────────────────────
// B 区：宿主半边行为（假 ctx 真跑）
// ─────────────────────────────────────────────────────────────────────────────

/** 造一条 `SkillSummary` 夹具（字段与 `ctx.skills` 的 `toSummary` 对齐）。 */
function skill(name, source, invocation = { modelInvocable: true, userInvocable: true }) {
  return {
    name,
    description: `${name} 的描述`,
    whenToUse: `何时用 ${name}`,
    path: `C:/skills/${name}/SKILL.md`,
    source,
    provider: 'filesystem',
    invocation,
    resourceBase: { kind: 'directory', path: `C:/skills/${name}` },
  }
}

const SKILLSET = [
  skill('alpha', 'project-dsh'),
  skill('beta', 'project-agents'),
  skill('gamma', 'user-dsh'),
  skill('delta', 'custom'),
  skill('epsilon', 'bundled'),
  skill('zeta', 'weird-source'),
  skill('eta', 'user-agents', { modelInvocable: false, userInvocable: false }),
]

/** 临时改环境变量并跑一段异步逻辑。根目录路径由 env 决定，测试必须自己控制。 */
async function withEnv(vars, run) {
  const saved = new Map()
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** 搭一套宿主替身；每个成员都记录自己的调用，断言才有「实际发生了什么」可看。 */
function makeHost(options = {}) {
  const calls = {
    snapshot: [],
    scopedSnapshot: [],
    get: [],
    scopedGet: [],
    acquireScope: [],
    observeSession: [],
    serviceFor: [],
    lstat: [],
    resolve: [],
    listDir: [],
    stat: [],
    readText: [],
  }
  const fixtures = options.skills ?? SKILLSET
  const contents = options.contents ?? {}

  /** 两个注册表（全局的 / preset 组内的）行为一致，只是记账通道不同。 */
  const registry = (recordSnapshot, recordGet) => ({
    async snapshot(o) {
      recordSnapshot(o)
      return { skills: options.skills ?? SKILLSET, complete: options.complete ?? true }
    },
    async get(name, o) {
      recordGet(name, o)
      const found = fixtures.find((item) => item.name === name)
      if (found === undefined) return undefined
      return { ...found, content: contents[name] ?? `# ${name}\n\n正文内容` }
    },
  })

  const lease = {
    key: { leaseKey: true },
    disposed: 0,
    async [Symbol.asyncDispose]() {
      this.disposed++
    },
  }
  const observation = {
    header: { cwd: 'D:/project/demo', agentPreset: 'preset-cordis' },
    disposed: 0,
    [Symbol.dispose]() {
      this.disposed++
    },
  }
  const scopedRegistry = registry(
    (o) => calls.scopedSnapshot.push(o),
    (name, o) => calls.scopedGet.push({ name, options: o }),
  )
  const liveAgent = { id: 'session-live', ctx: { tag: 'agent-ctx' }, __scoped: scopedRegistry }
  const skills = registry(
    (o) => calls.snapshot.push(o),
    (name, o) => calls.get.push({ name, options: o }),
  )

  const presets =
    options.noPresets === true
      ? undefined
      : {
          async resolve() {
            return { id: 'preset-standard' }
          },
          async remoteExportList() {
            return { presets: [{ id: 'preset-standard', isDefault: true }] }
          },
          async acquireScope(id) {
            calls.acquireScope.push(id)
            return lease
          },
          serviceFor(agent, name) {
            calls.serviceFor.push({ agent, name })
            return agent.__scoped
          },
          composedPreset() {
            return 'preset-cordis'
          },
        }

  const agents = {
    get(id) {
      return id === liveAgent.id ? liveAgent : undefined
    },
  }

  const sessionQuery =
    options.noSessionQuery === true
      ? undefined
      : {
          async observeSession(id, o) {
            calls.observeSession.push({ id, options: o })
            return observation
          },
        }

  const routes = []
  const existingPaths = options.existingPaths ?? []
  /** 直读路径用的目录表：`目录路径 → [{ name, type }]`。没登记 = 这个根不存在。 */
  const dirs = options.dirs ?? {}
  /** 直读路径用的文件表：`文件路径 → 正文`。 */
  const files = options.files ?? {}
  /** 这些路径**连 resolve 都失败**（模拟沙箱拒绝 / 路径不可达）。 */
  const unresolvable = options.unresolvable ?? []

  /**
   * `ctx.fs` 替身，形状逐条对齐 `dsh-fs-local`：
   *  - `lstat(path)` 收**路径**（`pathExists` 用它探存在性）
   *  - `resolve(path)` 收路径、回 `{ targetKey, displayPath }`
   *  - `listDir` / `stat` / `readText` 收**解析后的 target**
   *
   * 没登记的目录/文件一律抛错——真实世界里「根不存在」就是这个形状，
   * 而 `scanRoot` 必须把它降级成「这个根没有候选」，而不是把整页带下去。
   * `noFs` 时整个服务缺席（直读与存在性探测都应优雅降级）。
   */
  const fs = options.noFs === true
    ? undefined
    : {
        async lstat(target) {
          calls.lstat.push(target)
          if (options.fsThrows === true) throw new Error('sandbox denied')
          return existingPaths.includes(target) ? { isDirectory: true } : undefined
        },
        async resolve(path) {
          calls.resolve.push(path)
          if (unresolvable.includes(path)) throw new Error(`cannot resolve ${path}`)
          return { targetKey: path, displayPath: path }
        },
        async listDir(target) {
          calls.listDir.push(target.displayPath)
          const entries = dirs[target.displayPath]
          if (entries === undefined) throw new Error(`cannot list ${target.displayPath}`)
          return entries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            target: { targetKey: `${target.displayPath}/${entry.name}`, displayPath: `${target.displayPath}/${entry.name}` },
          }))
        },
        async stat(target) {
          calls.stat.push(target.displayPath)
          return files[target.displayPath] === undefined ? undefined : { type: 'file' }
        },
        async readText(target) {
          calls.readText.push(target.displayPath)
          const text = files[target.displayPath]
          if (text === undefined) throw new Error(`cannot read ${target.displayPath}`)
          return text
        },
      }
  const scope = {
    skills,
    get(name) {
      return { agentPresets: presets, agents, sessionQuery, workspaceRegistry: undefined, fs }[name]
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    inject(names, cb) {
      cb(scope)
    },
    get: scope.get,
  }
  return { ctx, routes, calls, lease, observation, liveAgent, scopedRegistry, skills, fs }
}

const hostModule = await import(new URL('../lib/index.js', import.meta.url).href)

check('B0', typeof hostModule.apply === 'function', 'lib/index.js 没有导出 apply')
check('B0b', Array.isArray(hostModule.inject), 'lib/index.js 没有导出 inject 数组')

const GET = (query = '') => new Request(`http://127.0.0.1/api/skill-manager${query}`, { method: 'GET' })
const POST = (payload) =>
  new Request('http://127.0.0.1/api/skill-manager', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

/**
 * 跑一次 GET，返回 `{ status, body }`。
 *
 * ⚠️ 失败响应是 `{ ok:false, error }`，**没有 `data`**。这里统一补成文档里的**空形状**，
 * 好让断言干干净净地报「某个字段不对」，而不是在 `body.data.skills` 上抛 TypeError
 * 把整个自检进程带下去——后者会让**后面的断言根本来不及跑**，反向验证时极具欺骗性
 * （踩过：注入「一个根抛错」，自检直接崩在 B24，看起来像"注入没生效"）。
 *
 * 补默认值不会掩盖回归：`skills` / `roots` / `complete` 各自都有**专门的**断言
 * （B24 / B38 / B54），字段一缺就是一条干净的失败。
 */
async function getJson(host, query = '') {
  const response = await host.routes[0].fetch(GET(query))
  const body = await response.json()
  if (body !== null && typeof body === 'object' && body.data === undefined) {
    body.data = { skills: [], counts: {}, providers: {}, roots: [], complete: false }
  }
  return { status: response.status, body }
}

// —— 路由注册 ——
const baseHost = makeHost()
hostModule.apply(baseHost.ctx)
check('B1', baseHost.routes.length === 1, `apply 注册了 ${baseHost.routes.length} 条路由，期望 1`)
check('B2', baseHost.routes[0]?.path === '/api/skill-manager', `注册路径 = ${JSON.stringify(baseHost.routes[0]?.path)}`)
check(
  'B3',
  Array.isArray(baseHost.routes[0]?.methods) && baseHost.routes[0].methods.includes('GET') && baseHost.routes[0].methods.includes('POST'),
  `methods = ${JSON.stringify(baseHost.routes[0]?.methods)}`,
)
check('B4', baseHost.routes[0]?.requestBody === 'buffered', `requestBody = ${JSON.stringify(baseHost.routes[0]?.requestBody)}`)
check('B5', typeof baseHost.routes[0]?.fetch === 'function', '路由没有 fetch 处理函数')

// —— 路径 2：没有 sessionId → 默认 preset 的冷读租约 ——
const leaseHost = makeHost()
hostModule.apply(leaseHost.ctx)
const leaseResult = await getJson(leaseHost)
check('B6', leaseResult.body.ok === true, `GET 失败：${JSON.stringify(leaseResult.body)}`)
check('B7', leaseResult.body.data.resolvedBy === 'preset-lease', `resolvedBy = ${JSON.stringify(leaseResult.body.data.resolvedBy)}`)
check('B8', leaseHost.calls.acquireScope.length === 1 && leaseHost.calls.acquireScope[0] === 'preset-standard', `acquireScope 调用 = ${JSON.stringify(leaseHost.calls.acquireScope)}（应取默认 preset）`)
// 不带 scope 读会是空表，所以必须把租约的 key 当作 scope 传下去。
check('B9', leaseHost.calls.snapshot[0]?.scope === leaseHost.lease.key, 'snapshot 收到的 scope 不是 acquireScope 返回的 key —— 本机会因此读到空表')
check('B10', leaseHost.lease.disposed === 1, `租约释放了 ${leaseHost.lease.disposed} 次，期望 1（不释放会钉住 preset revision）`)
check('B11', leaseHost.calls.observeSession.length === 0, '没有 sessionId 时不应调用 observeSession')

// —— 路径 1：sessionId 命中活 Agent（最高保真）——
const liveHost = makeHost({ skills: [skill('alpha', 'project-dsh')] })
hostModule.apply(liveHost.ctx)
const liveResult = await getJson(liveHost, '?sessionId=session-live')
check('B12', liveResult.body.data.resolvedBy === 'session-agent', `resolvedBy = ${JSON.stringify(liveResult.body.data.resolvedBy)}`)
check('B13', liveHost.calls.scopedSnapshot.length === 1, `预设组内的注册表被读了 ${liveHost.calls.scopedSnapshot.length} 次，期望 1（活 Agent 应走 serviceFor）`)
check('B14', liveHost.calls.snapshot.length === 0, '活 Agent 路径不应再读全局注册表')
check('B15', liveHost.calls.scopedSnapshot[0]?.scope === liveHost.liveAgent, 'scope 不是那个活 Agent —— 官方 SessionSkillCatalog 正是传 Agent 对象当 scope')
check('B16', liveHost.calls.serviceFor[0]?.name === 'skills', `serviceFor 的名字 = ${JSON.stringify(liveHost.calls.serviceFor[0]?.name)}，期望 "skills"`)
check('B17', liveHost.calls.acquireScope.length === 0, '活 Agent 路径不该再取冷读租约')
check('B18', liveHost.calls.scopedSnapshot[0]?.cwd === 'D:/project/demo', `cwd = ${JSON.stringify(liveHost.calls.scopedSnapshot[0]?.cwd)}，应取 session header 的权威 cwd`)
check('B19', liveHost.calls.observeSession[0]?.id === 'session-live', `observeSession 的 id = ${JSON.stringify(liveHost.calls.observeSession[0]?.id)}`)
check('B20', liveHost.observation.disposed === 1, `observation 释放了 ${liveHost.observation.disposed} 次，期望 1`)

// —— 路径 3：没有 agentPresets → 诚实降级到全局层 ——
const bareHost = makeHost({ noPresets: true, noSessionQuery: true })
hostModule.apply(bareHost.ctx)
const bareResult = await getJson(bareHost)
check('B21', bareResult.body.data.resolvedBy === 'global-layer', `resolvedBy = ${JSON.stringify(bareResult.body.data.resolvedBy)}`)
check('B22', bareHost.calls.snapshot[0]?.scope === undefined, `降级路径不应编造 scope，实际传了 ${JSON.stringify(bareHost.calls.snapshot[0]?.scope)}`)
check('B23', bareResult.status === 200, `降级时仍应 200，实际 ${bareResult.status}`)

// —— 分组与统计 ——
const fixtureHost = makeHost()
hostModule.apply(fixtureHost.ctx)
const fixtureResult = await getJson(fixtureHost)
const data = fixtureResult.body.data
const byName = Object.fromEntries(data.skills.map((item) => [item.name, item]))
check('B24', data.skills.length === SKILLSET.length, `返回 ${data.skills.length} 条，期望 ${SKILLSET.length}`)
check('B25', byName.alpha?.group === 'project', `alpha.group = ${JSON.stringify(byName.alpha?.group)}`)
check('B26', byName.beta?.group === 'project', `beta.group = ${JSON.stringify(byName.beta?.group)}`)
check('B27', byName.gamma?.group === 'global', `gamma.group = ${JSON.stringify(byName.gamma?.group)}`)
check('B28', byName.eta?.group === 'global', `eta.group = ${JSON.stringify(byName.eta?.group)}`)
check('B29', byName.delta?.group === 'custom', `delta.group = ${JSON.stringify(byName.delta?.group)}`)
check('B30', byName.epsilon?.group === 'bundled', `epsilon.group = ${JSON.stringify(byName.epsilon?.group)}`)
check('B31', byName.zeta?.group === 'other', `未识别 source 应落 other，实际 ${JSON.stringify(byName.zeta?.group)}`)
check(
  'B32',
  data.counts.project === 2 && data.counts.global === 2 && data.counts.custom === 1 && data.counts.bundled === 1 && data.counts.other === 1,
  `counts = ${JSON.stringify(data.counts)}`,
)
// 官方那条 Remote 会 filter(isUserInvocable)；只读浏览页**故意不过滤**。
check('B33', byName.eta !== undefined, 'userInvocable:false 的 skill 被过滤掉了——只读浏览页必须全部显示')
check('B34', byName.eta?.userInvocable === false, `eta.userInvocable = ${JSON.stringify(byName.eta?.userInvocable)}`)
check('B35', byName.alpha?.whenToUse === '何时用 alpha', 'whenToUse 没有透传')
check('B36', byName.alpha?.provider === 'filesystem', 'provider 没有透传')
check('B37', byName.alpha?.path === 'C:/skills/alpha/SKILL.md', `path = ${JSON.stringify(byName.alpha?.path)}`)
check('B38', data.complete === true, `complete = ${JSON.stringify(data.complete)}`)
// 没有 sessionId 就没有权威 cwd：宿主侧没有「当前工作区」概念（选择在客户端），
// 此时必须**如实报 undefined**，而不是编一个猜来的路径。
check('B39', data.cwd === undefined, `无 session 时 cwd = ${JSON.stringify(data.cwd)}，应如实为 undefined`)
check('B40', Array.isArray(data.capabilities) && data.capabilities.includes('read'), `capabilities = ${JSON.stringify(data.capabilities)}`)

// —— 完整性未达成必须透传（UI 靠它决定要不要说"列表可能不完整"）——
const partialHost = makeHost({ complete: false })
hostModule.apply(partialHost.ctx)
const partialResult = await getJson(partialHost)
check('B41', partialResult.body.data.complete === false, 'complete:false 没有透传到响应')

// —— POST op:"read" ——
const readHost = makeHost({ skills: [skill('alpha', 'project-dsh')] })
hostModule.apply(readHost.ctx)
const readResponse = await readHost.routes[0].fetch(POST({ op: 'read', name: 'alpha', sessionId: 'session-live' }))
const readBody = await readResponse.json()
check('B42', readResponse.status === 200 && readBody.ok === true, `read 失败：${JSON.stringify(readBody)}`)
check('B43', readBody.data.content.includes('正文内容'), `content = ${JSON.stringify(readBody.data.content)}`)
check('B44', readBody.data.truncated === false, `truncated = ${JSON.stringify(readBody.data.truncated)}`)
// 读取必须和列表用同一个视图，否则会出现"列表里有、点开说没有"。
check('B45', readHost.calls.scopedGet[0]?.options?.scope === readHost.liveAgent, 'read 用的 scope 与列表不一致')
check('B46', readHost.calls.scopedGet[0]?.options?.cwd === 'D:/project/demo', `read 的 cwd = ${JSON.stringify(readHost.calls.scopedGet[0]?.options?.cwd)}`)

// —— 找不到 / 未知操作 ——
const missingHost = makeHost()
hostModule.apply(missingHost.ctx)
const missingResponse = await missingHost.routes[0].fetch(POST({ op: 'read', name: 'nope' }))
const missingBody = await missingResponse.json()
check('B47', missingResponse.status === 409 && missingBody.ok === false, `找不到时应 409 + ok:false，实际 ${missingResponse.status}`)
check('B48', String(missingBody.error).includes('nope'), `错误原文应点名那个 skill，实际 ${JSON.stringify(missingBody.error)}`)

const unknownResponse = await missingHost.routes[0].fetch(POST({ op: 'nope' }))
check('B49', unknownResponse.status === 400, `未知 op 应 400，实际 ${unknownResponse.status}`)

// —— 正文截断 ——
const bigContent = 'x'.repeat(200_000 + 10)
const bigHost = makeHost({ skills: [skill('big', 'user-dsh')], contents: { big: bigContent } })
hostModule.apply(bigHost.ctx)
const bigResponse = await bigHost.routes[0].fetch(POST({ op: 'read', name: 'big' }))
const bigBody = await bigResponse.json()
check('B50', bigBody.data.truncated === true, '超长正文没有标记 truncated')
check('B51', bigBody.data.content.length === 200_000, `截断长度 = ${bigBody.data.content.length}，期望 200000`)
check('B52', bigBody.data.contentLength === bigContent.length, `contentLength = ${bigBody.data.contentLength}`)

// —— 规范根目录探测：让「0 个」可解释（第一次实测暴露的直接问题）——
// 必须带 sessionId：项目根是从 session 的权威 cwd 往上找 `.git` 得来的，
// 没有 session 就没有 cwd，也就没有项目根（见下面的 B66）。
const rootsOptions = { existingPaths: ['D:/project/.git', 'C:/dsh/skills'] }
const rootsHost = makeHost(rootsOptions)
hostModule.apply(rootsHost.ctx)
const rootsResult = await withEnv(
  { DSH_HOME: 'C:/dsh', DSH_AGENTS_HOME: 'C:/agents', USERPROFILE: 'C:/home' },
  () => getJson(rootsHost, '?sessionId=session-live'),
)
const rootsData = rootsResult.body.data
const rootBySource = Object.fromEntries((rootsData.roots ?? []).map((root) => [root.source, root]))
check('B53', rootsData.projectRoot === 'D:/project', `projectRoot = ${JSON.stringify(rootsData.projectRoot)}（应从 cwd 向上找到含 .git 的祖先）`)
check('B54', Array.isArray(rootsData.roots) && rootsData.roots.length === 6, `roots 条数 = ${rootsData.roots?.length}，期望 6`)
check('B55', rootBySource['project-dsh']?.path === 'D:/project/.dsh/skills', `project-dsh path = ${JSON.stringify(rootBySource['project-dsh']?.path)}`)
check('B56', rootBySource['project-dsh']?.exists === false, `project-dsh exists = ${JSON.stringify(rootBySource['project-dsh']?.exists)}`)
check('B57', rootBySource['project-agents']?.path === 'D:/project/.agents/skills', `project-agents path = ${JSON.stringify(rootBySource['project-agents']?.path)}`)
check('B58', rootBySource['user-dsh']?.path === 'C:/dsh/skills', `user-dsh path = ${JSON.stringify(rootBySource['user-dsh']?.path)}`)
check('B59', rootBySource['user-dsh']?.exists === true, `user-dsh exists = ${JSON.stringify(rootBySource['user-dsh']?.exists)}`)
check('B60', rootBySource['user-agents']?.path === 'C:/agents/skills', `user-agents path = ${JSON.stringify(rootBySource['user-agents']?.path)}`)
check('B61', rootBySource.custom?.note !== undefined && rootBySource.custom?.path === undefined, 'custom 根的位置由配置决定，不该假装知道路径')
check('B62', rootBySource.bundled?.note !== undefined, 'bundled 根应给出说明')
// 提供方汇总是排查「完整性 未完成」的唯一线索。
check('B63', rootsData.providers?.filesystem === SKILLSET.length, `providers = ${JSON.stringify(rootsData.providers)}`)

// 没有 cwd 就没有项目根：必须如实为 undefined，不能拿工作区列表瞎猜（见 B39 同一条纪律）。
const noCwdHost = makeHost(rootsOptions)
hostModule.apply(noCwdHost.ctx)
const noCwdResult = await withEnv({ DSH_HOME: 'C:/dsh', USERPROFILE: 'C:/home' }, () => getJson(noCwdHost))
const noCwdRoot = Object.fromEntries((noCwdResult.body.data.roots ?? []).map((root) => [root.source, root]))
check('B66', noCwdResult.body.data.projectRoot === undefined, `无 cwd 时 projectRoot = ${JSON.stringify(noCwdResult.body.data.projectRoot)}，应如实为 undefined`)
check('B67', noCwdRoot['project-dsh']?.path === undefined, '无 cwd 时项目根路径不应编造')

// 没有 fs 服务时必须是「未判定」，不能报成「不存在」——把权限/能力问题说成"你没装"是误报。
const noFsHost = makeHost({ ...rootsOptions, noFs: true })
hostModule.apply(noFsHost.ctx)
const noFsResult = await withEnv(
  { DSH_HOME: 'C:/dsh', DSH_AGENTS_HOME: 'C:/agents', USERPROFILE: 'C:/home' },
  () => getJson(noFsHost, '?sessionId=session-live'),
)
const noFsRoot = Object.fromEntries((noFsResult.body.data.roots ?? []).map((root) => [root.source, root]))['project-dsh']
check('B64', noFsRoot?.exists === undefined, `没有 fs 服务时 exists = ${JSON.stringify(noFsRoot?.exists)}，应为 undefined（未判定）`)

// 根目录探测失败绝不能把整次目录读取带下去。
// 注意这里断言的是**三件事**：目录读取照常成功、roots 仍有 6 条、存在性为「未判定」。
// 只断言"状态 200 + skills 还在"是不够的——`pathExists` 自己吞掉异常时，
// 外层的兜底 catch 永远跑不到，那条断言会**平凡通过**（第一次写就是这么假通过的）。
const fsThrowsHost = makeHost({ ...rootsOptions, fsThrows: true })
hostModule.apply(fsThrowsHost.ctx)
const fsThrowsResult = await withEnv({ DSH_HOME: 'C:/dsh', DSH_AGENTS_HOME: 'C:/agents', USERPROFILE: 'C:/home' }, () =>
  getJson(fsThrowsHost, '?sessionId=session-live'),
)
const fsThrowsData = fsThrowsResult.body.data
const fsThrowsRoot = Object.fromEntries((fsThrowsData.roots ?? []).map((root) => [root.source, root]))
check('B65', fsThrowsResult.status === 200 && fsThrowsData.skills.length === SKILLSET.length, 'fs 抛错时目录读取仍应成功返回')
check('B68', fsThrowsData.roots?.length === 6, `fs 抛错时 roots 条数 = ${fsThrowsData.roots?.length}，仍应给出 6 条（存在性降级为未判定，而不是整块消失）`)
check('B69', fsThrowsRoot['project-dsh']?.exists === undefined, `fs 抛错时 exists = ${JSON.stringify(fsThrowsRoot['project-dsh']?.exists)}，应为 undefined（未判定）`)

// ── 规范根目录**直读**：把项目 skill 从「上游整条丢光」里救回来 ─────────────
//
// 背景（用户实测截图带来的真实 bug）：`dsh-skill-filesystem` 的 `list()` 是
// `for (root of roots) for (skill of await discoverRoot(root))`，**没有 per-root
// try/catch**。本机 profile 里 `customSkillDirs` 指向 app.asar 内的路径，`ctx.fs.listDir`
// 在它上面抛错 → 该提供方的**全部**候选（含项目根里明明存在的 skill）一起被丢掉。
// 页面上表现为「选了项目还是只有随包内置那几个」。
//
// 本插件的处置：自己按官方同一套根目录规则只读直读一遍，**注册表优先**地合并。
const PROJECT_ROOT = 'D:/project/agent-go'
const PROJECT_AGENTS_ROOT = `${PROJECT_ROOT}/.agents/skills`
const PROJECT_DSH_ROOT = `${PROJECT_ROOT}/.dsh/skills`
const AGENTS_HOME_ROOT = 'C:/agents/skills'
const DSH_HOME_ROOT = 'C:/dsh/skills'

/** 造一份 `SKILL.md`。 */
const md = (name, description, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n正文\n`

const scanHost = makeHost({
  // 让项目根解析得到：官方与直读都靠「最近的含 .git 祖先」。
  existingPaths: [`${PROJECT_ROOT}/.git`],
  // 注册表里只剩 bundled —— 正是上游把 filesystem 提供方整个丢掉之后的样子。
  skills: [skill('office-docx', 'bundled')],
  complete: false,
  dirs: {
    [PROJECT_AGENTS_ROOT]: [
      { name: 'git-commit', type: 'directory' },
      { name: 'handoff', type: 'directory' },
      { name: 'flat-skill.md', type: 'file' },
      { name: 'notes.txt', type: 'file' },
      { name: 'no-frontmatter', type: 'directory' },
      { name: 'Bad_Name', type: 'directory' },
      { name: 'no-description', type: 'directory' },
      { name: 'legacy-keys', type: 'directory' },
    ],
    [AGENTS_HOME_ROOT]: [{ name: 'global-one', type: 'directory' }],
    // `.system` 是 `<dshHome>/skills` 独有的保留目录（官方 `skipSystem` 只挂在这个根上）。
    [DSH_HOME_ROOT]: [{ name: '.system', type: 'directory' }, { name: 'dsh-one', type: 'directory' }],
  },
  files: {
    [`${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`]: md('git-commit', '提交代码'),
    [`${PROJECT_AGENTS_ROOT}/handoff/SKILL.md`]: md('handoff', '交接上下文', 'whenToUse: 需要交接时\n'),
    [`${PROJECT_AGENTS_ROOT}/flat-skill.md`]: md('flat-skill', '平铺在根下的 skill'),
    // ↓ 以下四个都必须被跳过：官方解析器也会跳过它们，**少列一个只是少列，多列一个才是错**。
    [`${PROJECT_AGENTS_ROOT}/no-frontmatter/SKILL.md`]: '没有 frontmatter 的正文\n',
    [`${PROJECT_AGENTS_ROOT}/Bad_Name/SKILL.md`]: md('Bad_Name', '名字不是 kebab-case'),
    [`${PROJECT_AGENTS_ROOT}/no-description/SKILL.md`]: '---\nname: no-description\n---\n',
    [`${PROJECT_AGENTS_ROOT}/legacy-keys/SKILL.md`]: md('legacy-keys', '用了旧键名', 'modelInvocable: false\n'),
    [`${AGENTS_HOME_ROOT}/global-one/SKILL.md`]: md('global-one', '用户级 skill'),
    [`${DSH_HOME_ROOT}/dsh-one/SKILL.md`]: md('dsh-one', 'DSH_HOME 下的 skill'),
    [`${DSH_HOME_ROOT}/.system/SKILL.md`]: md('system-skill', '不该出现'),
  },
})
hostModule.apply(scanHost.ctx)
// 用户级根的位置由 env 决定，必须在**请求期间**设好（宿主半边每请求现算一次）。
const scanResult = await withEnv({ DSH_HOME: 'C:/dsh', DSH_AGENTS_HOME: 'C:/agents' }, () =>
  getJson(scanHost, `?sessionId=session-live&cwd=${encodeURIComponent(PROJECT_ROOT)}`),
)
const scanData = scanResult.body.data
const scanByName = Object.fromEntries(scanData.skills.map((row) => [row.name, row]))

check('B70', scanResult.status === 200 && scanResult.body.ok === true, `直读用例的 GET 失败：${JSON.stringify(scanResult.body).slice(0, 200)}`)
// 这一条就是用户报的那个 bug：注册表给不出项目 skill，直读必须补上。
check('B71', scanByName['git-commit'] !== undefined, `项目 skill 没被直读补进来，实际 = ${JSON.stringify(scanData.skills.map((r) => r.name))}`)
check('B72', scanByName['git-commit']?.group === 'project', `git-commit.group = ${JSON.stringify(scanByName['git-commit']?.group)}，应落进「项目」`)
check('B73', scanByName['git-commit']?.source === 'project-agents', `source = ${JSON.stringify(scanByName['git-commit']?.source)}（必须与官方 rank 表一致，否则分组会漂）`)
check('B74', scanByName['git-commit']?.path === `${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`, `path = ${JSON.stringify(scanByName['git-commit']?.path)}`)
check('B75', scanByName['git-commit']?.description === '提交代码', `description = ${JSON.stringify(scanByName['git-commit']?.description)}`)
// 平铺的 `<name>.md` 也是官方认的形状。
check('B76', scanByName['flat-skill']?.group === 'project', `根下的平铺 .md 没被识别，实际 = ${JSON.stringify(scanByName['flat-skill'])}`)
check('B77', scanByName['handoff']?.whenToUse === '需要交接时', `whenToUse 没有透传，实际 = ${JSON.stringify(scanByName['handoff']?.whenToUse)}`)
// 用户级两个根照样直读；注册表里那一条原样保留（两个来源合起来才是全貌）。
check('B78', scanByName['global-one']?.group === 'global', `global-one.group = ${JSON.stringify(scanByName['global-one']?.group)}`)
check(
  'B78b',
  scanByName['dsh-one']?.group === 'global' && scanByName['dsh-one']?.source === 'user-dsh',
  `DSH_HOME 下的 skill 没被直读：${JSON.stringify(scanByName['dsh-one'])}`,
)
check('B79', scanByName['office-docx']?.group === 'bundled', '注册表原有的行不该被直读挤掉')
// 一个非法文件都不许编出来。
check(
  'B80',
  ['no-frontmatter', 'Bad_Name', 'no-description', 'legacy-keys', 'system-skill'].every((name) => scanByName[name] === undefined),
  `不合法的文件被列出来了：${JSON.stringify(scanData.skills.map((r) => r.name))}`,
)
check('B81', scanByName['notes.txt'] === undefined, '非 .md 的文件不该被当成 skill')
// 排序：官方按名字码点排序，合并后必须重排，顺序不能取决于哪个来源先到。
check(
  'B82',
  JSON.stringify(scanData.skills.map((row) => row.name)) === JSON.stringify([...scanData.skills.map((row) => row.name)].sort()),
  `合并后没有按名字排序：${JSON.stringify(scanData.skills.map((r) => r.name))}`,
)
check(
  'B83',
  scanData.skills.every((row, index) => row.index === index),
  `index 没有重排：${JSON.stringify(scanData.skills.map((r) => r.index))}`,
)

// **注册表优先**：同名时必须以官方那一行为准，直读只补它没有的名字。
const dedupeHost = makeHost({
  existingPaths: [`${PROJECT_ROOT}/.git`],
  skills: [skill('git-commit', 'user-dsh')],
  dirs: { [PROJECT_AGENTS_ROOT]: [{ name: 'git-commit', type: 'directory' }] },
  files: { [`${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`]: md('git-commit', '文件里的描述') },
})
hostModule.apply(dedupeHost.ctx)
const dedupeData = (await getJson(dedupeHost, `?sessionId=session-live&cwd=${encodeURIComponent(PROJECT_ROOT)}`)).body.data
const dedupeRows = dedupeData.skills.filter((row) => row.name === 'git-commit')
check('B84', dedupeRows.length === 1, `同名条目应当只有 1 行，实际 ${dedupeRows.length} 行`)
check('B85', dedupeRows[0]?.source === 'user-dsh', `同名时应保留注册表那一行，实际 source = ${JSON.stringify(dedupeRows[0]?.source)}`)
check('B86', dedupeRows[0]?.description === 'git-commit 的描述', `同名时应保留注册表的描述，实际 = ${JSON.stringify(dedupeRows[0]?.description)}`)

// **一个根读不了，不该拖垮别的根** —— 这正是上游缺的那层隔离。
const isolatedHost = makeHost({
  existingPaths: [`${PROJECT_ROOT}/.git`],
  skills: [],
  unresolvable: [PROJECT_DSH_ROOT],
  dirs: { [PROJECT_AGENTS_ROOT]: [{ name: 'git-commit', type: 'directory' }] },
  files: { [`${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`]: md('git-commit', '提交代码') },
})
hostModule.apply(isolatedHost.ctx)
const isolatedResult = await getJson(isolatedHost, `?sessionId=session-live&cwd=${encodeURIComponent(PROJECT_ROOT)}`)
check(
  'B87',
  isolatedResult.status === 200 && isolatedResult.body.data.skills.some((row) => row.name === 'git-commit'),
  `一个根 resolve 失败时，另一个根必须照常出结果，实际 = ${JSON.stringify(isolatedResult.body.data.skills.map((r) => r.name))}`,
)

// 单个文件读不了（或不是普通文件）只丢那一条。
const partialFileHost = makeHost({
  existingPaths: [`${PROJECT_ROOT}/.git`],
  skills: [],
  dirs: {
    [PROJECT_AGENTS_ROOT]: [
      { name: 'readable', type: 'directory' },
      { name: 'unreadable', type: 'directory' },
      { name: 'a-directory-named-x', type: 'directory' },
    ],
  },
  files: { [`${PROJECT_AGENTS_ROOT}/readable/SKILL.md`]: md('readable', '读得到') },
})
hostModule.apply(partialFileHost.ctx)
const partialFileData = (await getJson(partialFileHost, `?sessionId=session-live&cwd=${encodeURIComponent(PROJECT_ROOT)}`)).body.data
check(
  'B88',
  JSON.stringify(partialFileData.skills.map((row) => row.name)) === JSON.stringify(['readable']),
  `读不到的文件应被安静跳过，实际 = ${JSON.stringify(partialFileData.skills.map((r) => r.name))}`,
)

// 没有 fs 服务时直读整体静默降级：注册表照常返回，不抛错、不编造。
const noFsScanHost = makeHost({ noFs: true })
hostModule.apply(noFsScanHost.ctx)
const noFsScanResult = await getJson(noFsScanHost, '?sessionId=session-live')
check('B89', noFsScanResult.status === 200 && noFsScanResult.body.data.skills.length === SKILLSET.length, `缺 fs 时应退回纯注册表读取，实际 ${noFsScanResult.status} / ${noFsScanResult.body.data.skills?.length}`)

// ── 正文读取也必须认直读出来的那些 skill ──────────────────────────────────
// 「列表里有、点开说没有」是最难看的失败形态：直读补进来的行**不在注册表里**，
// `registry.get()` 必然返回 undefined。所以读取路径也要按同一套根目录规则回退。
const readScanHost = makeHost({
  existingPaths: [`${PROJECT_ROOT}/.git`],
  skills: [],
  dirs: { [PROJECT_AGENTS_ROOT]: [{ name: 'git-commit', type: 'directory' }, { name: 'gone', type: 'directory' }] },
  files: { [`${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`]: md('git-commit', '提交代码') },
})
hostModule.apply(readScanHost.ctx)
const readScanPost = await withEnv({ DSH_AGENTS_HOME: 'C:/agents' }, async () => {
  const response = await readScanHost.routes[0].fetch(
    POST({ op: 'read', name: 'git-commit', sessionId: 'session-live', cwd: PROJECT_ROOT }),
  )
  return { status: response.status, body: await response.json() }
})
check('B92', readScanPost.status === 200 && readScanPost.body.ok === true, `直读出来的 skill 读不到正文：${JSON.stringify(readScanPost.body).slice(0, 200)}`)
check(
  'B93',
  typeof readScanPost.body.data?.content === 'string' &&
    readScanPost.body.data.content.includes('提交代码') &&
    readScanPost.body.data.content.includes('正文'),
  `正文内容不对：${JSON.stringify(readScanPost.body.data?.content)}`,
)
check('B94', readScanPost.body.data?.path === `${PROJECT_AGENTS_ROOT}/git-commit/SKILL.md`, `正文的 path = ${JSON.stringify(readScanPost.body.data?.path)}`)
// 注册表与直读**都没有**的名字仍然要如实 409 —— 回退不是"什么都给你读出来"。
const readMissingPost = await withEnv({ DSH_AGENTS_HOME: 'C:/agents' }, async () => {
  const response = await readScanHost.routes[0].fetch(
    POST({ op: 'read', name: 'no-such-skill', sessionId: 'session-live', cwd: PROJECT_ROOT }),
  )
  return { status: response.status, body: await response.json() }
})
check('B95', readMissingPost.status === 409 && readMissingPost.body.ok === false, `找不到的 skill 应 409，实际 ${readMissingPost.status}`)
// 文件读不到（`gone` 目录没有 SKILL.md）同样要 409，而不是编一段空正文。
const readGonePost = await withEnv({ DSH_AGENTS_HOME: 'C:/agents' }, async () => {
  const response = await readScanHost.routes[0].fetch(
    POST({ op: 'read', name: 'gone', sessionId: 'session-live', cwd: PROJECT_ROOT }),
  )
  return { status: response.status, body: await response.json() }
})
check('B96', readGonePost.status === 409, `文件不在的 skill 应 409，实际 ${readGonePost.status}`)

// 诊断字段**整体下线**：`providerFailures` 与 logger exporter 都不该再出现
// （那是开发者看的内部原文，用户明确要求从界面上去掉；连带把这一路也删了）。
const cleanResult = await getJson(baseHost)
check('B90', cleanResult.body.data.providerFailures === undefined, `providerFailures 应已下线，实际 = ${JSON.stringify(cleanResult.body.data.providerFailures)}`)
// 直读用的根目录必须与 `roots` 探测出来的**同一个** projectRoot —— 两边漂了，
// 就会出现「标签页说目录存在、直读却去扫了别的地方」。
const scanRootBySource = Object.fromEntries((scanData.roots ?? []).map((root) => [root.source, root]))
check(
  'B91',
  scanRootBySource['project-agents']?.path === PROJECT_AGENTS_ROOT && scanRootBySource['project-dsh']?.path === PROJECT_DSH_ROOT,
  `roots 里的项目根与直读用的根不一致：${JSON.stringify(scanRootBySource['project-agents']?.path)} / ${JSON.stringify(scanRootBySource['project-dsh']?.path)}`,
)

// ─────────────────────────────────────────────────────────────────────────────
// C 区：客户端半边协议
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 用假 window 真跑一遍客户端 bundle，拿到 factory 的导出。
 *
 * `reactImpl` 是**注入给 bundle 的 react 实现**——这一步很关键：bundle 在 factory 执行时
 * 就把 `require("react")` 的结果闭包进了组件里。所以 D 区必须用一个「活的」react
 * （真跑 hooks 的那个）重新加载一遍 bundle，否则组件里拿到的是 C 区那个替身，
 * hook 会永远返回 undefined。
 */
function loadClientModule(reactImpl) {
  const loads = []
  const fakeWindow = { __ModuleLoader__: { load: (spec) => loads.push(spec) } }
  const requireCalls = []
  // eslint-disable-next-line no-new-func
  new Function('window', clientSrc)(fakeWindow)
  const spec = loads[0]
  const exportsObj = spec.factory((name) => {
    requireCalls.push(name)
    if (name === 'react') return reactImpl
    throw new Error(`unexpected require: ${name}`)
  })
  return { loads, exportsObj, requireCalls }
}

/** C 区用的替身 react：只够验证协议面，不跑 hooks。 */
const STUB_REACT = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const clientModule = loadClientModule(STUB_REACT)
check('C1', clientModule.loads.length === 1, `__ModuleLoader__.load 被调用 ${clientModule.loads.length} 次，期望 1`)
check('C2', clientModule.loads[0]?.id === pkg.name, `load id = ${JSON.stringify(clientModule.loads[0]?.id)}`)
check('C3', typeof clientModule.exportsObj?.apply === 'function', 'bundle 没有导出 apply')
check('C4', clientModule.requireCalls.every((name) => name === 'react'), `require 被调用时用了 ${JSON.stringify(clientModule.requireCalls)}`)

/** 用假 ctx 跑客户端 apply，捕获座位注册。 */
function applyClient(exportsObj) {
  const registrations = []
  const injected = []
  const scope = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  const ctx = { inject: (names, cb) => cb(scope) }
  // ensureStyles 在 node 下没有 document，应当安静跳过而不是抛错。
  const previousDocument = globalThis.document
  delete globalThis.document
  try {
    exportsObj.apply(ctx)
  } finally {
    if (previousDocument !== undefined) globalThis.document = previousDocument
  }
  return { registrations, injected }
}

const clientApplied = applyClient(clientModule.exportsObj)
check('C5', clientApplied.injected[0] === 'settings.section', `slots.inject 的 key = ${JSON.stringify(clientApplied.injected[0])}`)
check('C6', clientApplied.registrations.length === 1, `注册了 ${clientApplied.registrations.length} 个座位条目，期望 1`)
const registration = clientApplied.registrations[0]
check('C7', registration?.options?.name === 'settings.section', `注册项 name = ${JSON.stringify(registration?.options?.name)}`)
check('C8', registration?.options?.id === 'skills', `注册项 id = ${JSON.stringify(registration?.options?.id)}`)
check('C9', registration?.options?.order === 910, `注册项 order = ${JSON.stringify(registration?.options?.order)}`)
check('C10', typeof registration?.options?.label === 'function', '注册项 label 应是 thunk（官方按 locale 重新求值）')
check('C11', registration?.options?.label?.() === 'Skills', `label() = ${JSON.stringify(registration?.options?.label?.())}`)
check('C12', typeof registration?.component === 'function', '第二个参数应是组件（函数）')
// 注册项字段白名单里没有 icon，声明了也会被静默丢弃 → 不该声明。
check('C13', registration?.options?.icon === undefined, '注册项声明了 icon —— slot 白名单会静默丢弃它，别写')

// ─────────────────────────────────────────────────────────────────────────────
// D 区：真实渲染（迷你渲染器 + 假 fetch）
// ─────────────────────────────────────────────────────────────────────────────

/** 迷你 React：只实现本组件用到的 hook，但**按调用顺序计位**（能抓条件式 hook）。 */
function createRuntime() {
  const instances = new Map()
  const state = { current: null, dirty: false }
  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return false
    if (a.length !== b.length) return false
    return a.every((item, index) => Object.is(item, b[index]))
  }
  const react = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) }
      if (children.length === 1) merged.children = children[0]
      else if (children.length > 1) merged.children = children
      return { type, props: merged }
    },
    useState(initial) {
      const inst = state.current
      const slot = inst.index++
      if (!(slot in inst.hooks)) inst.hooks[slot] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const currentValue = inst.hooks[slot]
        const value = typeof next === 'function' ? next(currentValue) : next
        if (!Object.is(value, currentValue)) {
          inst.hooks[slot] = value
          state.dirty = true
        }
      }
      return [inst.hooks[slot], set]
    },
    useEffect(fn, deps) {
      const inst = state.current
      const slot = inst.index++
      const previous = inst.effects[slot]
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        inst.effects[slot] = { fn, deps, pending: true, cleanup: previous?.cleanup }
      }
    },
    useCallback(fn, deps) {
      const inst = state.current
      const slot = inst.index++
      const previous = inst.callbacks[slot]
      if (previous === undefined || !sameDeps(previous.deps, deps)) inst.callbacks[slot] = { fn, deps }
      return inst.callbacks[slot].fn
    },
  }
  return { react, state, instances }
}

/** 把元素树展开成 host 节点树（函数组件就地展开，并记录每次渲染的 hook 位数）。 */
function renderTree(runtime, element) {
  const walk = (node, keyPath) => {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) }
    if (Array.isArray(node)) {
      return { kind: 'frag', children: node.map((child, index) => walk(child, `${keyPath}[${index}]`)) }
    }
    const { type, props } = node
    if (typeof type === 'function') {
      const instanceKey = `${keyPath}#${type.name === '' ? 'anon' : type.name}`
      let inst = runtime.instances.get(instanceKey)
      if (inst === undefined) {
        inst = { hooks: [], effects: [], callbacks: [], index: 0, history: [] }
        runtime.instances.set(instanceKey, inst)
      }
      const outer = runtime.state.current
      runtime.state.current = inst
      inst.index = 0
      let out
      try {
        out = type(props)
      } finally {
        runtime.state.current = outer
      }
      inst.history.push(inst.index)
      return walk(out, instanceKey)
    }
    return { kind: 'host', type, props, children: walk(props.children, `${keyPath}>${type}`) }
  }
  return walk(element, '$')
}

/** host 节点子树里的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (node.kind === 'text') return node.text
  if (node.kind === 'frag') return node.children.map(textOf).join('')
  return textOf(node.children)
}

/** 摊平出所有 host 节点。 */
function hostsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (node.kind === 'host') {
    out.push(node)
    hostsOf(node.children, out)
  } else if (node.kind === 'frag') {
    for (const child of node.children) hostsOf(child, out)
  }
  return out
}

/** 跑一遍待执行 effect（依赖变了的才算），await 掉里面的异步。 */
async function runEffects(runtime) {
  let ran = 0
  for (const inst of runtime.instances.values()) {
    for (const effect of inst.effects) {
      if (effect === undefined || effect.pending !== true) continue
      effect.pending = false
      if (typeof effect.cleanup === 'function') effect.cleanup()
      effect.cleanup = await effect.fn()
      ran++
    }
  }
  return ran
}

/** 反复「渲染 → 跑 effect → 等异步回落」，直到稳定。 */
async function mount(runtime, component, props, maxPasses = 8) {
  let view = null
  for (let pass = 0; pass < maxPasses; pass++) {
    runtime.state.dirty = false
    view = renderTree(runtime, runtime.react.createElement(component, props))
    const ran = await runEffects(runtime)
    // 必须让出一个**宏任务**：effect 里的 fetch 链是 `async/await` + `.then(setState)`，
    // 只 await 一个非 promise 的返回值（cleanup）只推进一个微任务，状态还没落定，
    // 于是循环会在「读取中…」那一帧提前判定为稳定。这是本文件踩过的坑。
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (ran === 0 && runtime.state.dirty === false) return { view, passes: pass + 1 }
  }
  return { view, passes: maxPasses }
}

const MAIN_SESSION_STATE = {
  byId: {
    'session-1': { id: 'session-1', retainedBy: { mainView: 1 }, cwd: 'D:/project/demo' },
    'session-2': { id: 'session-2', retainedBy: {} },
  },
}

const REAL_FETCH = globalThis.fetch

/** 装上假 fetch；`fetchCalls` 是调用方给的记账数组。 */
function patchFetch(handler, fetchCalls) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }
}

/** 默认工作区清单：一项有 title，一项只有路径（正好试 lastSegment 兜底）。 */
const MAIN_WORKSPACE_STATE = {
  items: [
    { workspaceId: 'w-1', path: 'D:/project/agent-go', title: 'agent-go', sessionIds: [], createdAt: 1 },
    { workspaceId: 'w-2', path: 'D:/project/ECC/', title: '', sessionIds: [], createdAt: 2 },
  ],
}

/**
 * 在假 fetch（与假 sessions 快照）下真渲染一次 SkillSection。
 *
 * 每次都**重新加载一遍 bundle**，把本 runtime 的 react 交给它——这样组件里的 hooks
 * 才是真的（见 loadClientModule 的注释）。
 */
async function renderSection(fetchHandler, sessionState = MAIN_SESSION_STATE, workspaceState = MAIN_WORKSPACE_STATE) {
  const runtime = createRuntime()
  const mod = loadClientModule(runtime.react)
  const component = applyClient(mod.exportsObj).registrations[0].component
  const fetchCalls = []
  patchFetch(fetchHandler, fetchCalls)
  try {
    // useSessions / useWorkspaces 都各占一个 hook 位，这样 hook 计数与真实运行时同形。
    const useSessions = (selector) => {
      runtime.state.current.index++
      return selector(sessionState)
    }
    const useWorkspaces = (selector) => {
      runtime.state.current.index++
      return selector(workspaceState)
    }
    const props = { useSessions, useWorkspaces }
    const mounted = await mount(runtime, component, props)
    return {
      runtime,
      component,
      props,
      fetchCalls,
      fetchHandler,
      view: mounted.view,
      text: textOf(mounted.view),
      hosts: hostsOf(mounted.view),
    }
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}

const catalogResponse = (payload) => ({ status: 200, json: async () => ({ ok: true, data: payload }) })

const CATALOG = {
  skills: [
    { name: 'alpha', description: 'alpha 的描述', source: 'project-dsh', group: 'project', provider: 'filesystem', modelInvocable: true, path: 'C:/skills/alpha/SKILL.md' },
    { name: 'gamma', description: 'gamma 的描述', source: 'user-dsh', group: 'global', provider: 'filesystem', modelInvocable: true, path: 'C:/skills/gamma/SKILL.md' },
  ],
  counts: { project: 1, global: 1, custom: 0, bundled: 0, other: 0 },
  providers: { filesystem: 2 },
  roots: [
    { group: 'project', source: 'project-dsh', path: 'D:/project/.dsh/skills', exists: false },
    { group: 'project', source: 'project-agents', path: 'D:/project/.agents/skills', exists: false },
    { group: 'global', source: 'user-dsh', path: 'C:/dsh/skills', exists: true },
    { group: 'global', source: 'user-agents', path: 'C:/agents/skills', exists: false },
    { group: 'custom', source: 'custom', note: '由 Config.customSkillDirs 决定' },
    { group: 'bundled', source: 'bundled', note: '随包分发 / 运行时注册' },
  ],
  projectRoot: 'D:/project',
  complete: true,
  resolvedBy: 'session-agent',
  presetId: 'preset-cordis',
  cwd: 'D:/project/demo',
  capabilities: ['snapshot', 'read'],
}

const readyRender = await renderSection(async () => catalogResponse(CATALOG))
check('D1', readyRender.fetchCalls.length === 1, `首屏 fetch 了 ${readyRender.fetchCalls.length} 次，期望 1`)
check('D2', readyRender.fetchCalls[0]?.url.includes('sessionId=session-1'), `fetch url = ${JSON.stringify(readyRender.fetchCalls[0]?.url)}，应带上「主视图 session」的 id`)
check('D3', readyRender.text.includes('项目'), '没有渲染「项目」分组标题')
check('D4', readyRender.text.includes('全局'), '没有渲染「全局」分组标题')
check('D5', readyRender.text.includes('alpha'), '没有渲染 skill 名 alpha')
// 只展开选中分组 → 这里断言的是**当前可见那条**的描述（gamma 属于未选中的「全局」）。
check('D6', readyRender.text.includes('alpha 的描述'), '没有渲染选中分组里 skill 的描述')
check('D7', readyRender.text.includes('共 2 个 skill'), `没有渲染计数，文本片段 = ${JSON.stringify(readyRender.text.slice(0, 200))}`)
// **诊断面板整体下线**（用户明确要求）：作用域 / 预设 / cwd / 项目根 / 提供方 / 完整性
// 这一整行都不该再出现在页面上。它原本是给开发者排查用的，不是给使用者看的内容。
check(
  'D8',
  ['作用域', '预设', '项目根', '提供方', '完整性'].every((label) => !readyRender.text.includes(label)),
  `诊断面板还在渲染，文本片段 = ${JSON.stringify(readyRender.text.slice(0, 200))}`,
)
check('D9', !readyRender.text.includes('读取中…'), '就绪后仍停在「读取中…」')
// 卡片与「查看」按钮必须一一对应——不绑定"一次渲染几组"，只绑定"每条 skill 都有入口"。
const renderedCards = readyRender.hosts.filter((node) => node.props?.className === 'dskm-card')
const renderedViewButtons = readyRender.hosts.filter((node) => node.type === 'button' && textOf(node).includes('查看'))
check(
  'D10',
  renderedCards.length > 0 && renderedViewButtons.length === renderedCards.length,
  `卡片 ${renderedCards.length} 个、「查看」按钮 ${renderedViewButtons.length} 个，应一一对应`,
)

// hook 调用序必须每次渲染都一致（条件式 hook 是 React 里最致命的一类 bug）。
const sectionInstance = [...readyRender.runtime.instances.entries()].find(([key]) => key.includes('#SkillSection'))?.[1]
check('D11', sectionInstance !== undefined, '没找到 SkillSection 的渲染实例')
check(
  'D12',
  sectionInstance !== undefined && sectionInstance.history.length >= 2 && sectionInstance.history.every((count) => count === sectionInstance.history[0]),
  `hook 位数在不同渲染间不一致：${JSON.stringify(sectionInstance?.history)} —— 存在条件式 hook`,
)
check('D13', sectionInstance?.history[0] === 9, `SkillSection 的 hook 位 = ${sectionInstance?.history[0]}，期望 9（useSessions + useWorkspaces + 4×useState + useEffect + useCallback）`)

// —— 展开正文 ——
const expandFetch = async (url, init) => {
  if (init?.method === 'POST') {
    return {
      status: 200,
      json: async () => ({ ok: true, data: { name: 'alpha', path: 'C:/skills/alpha/SKILL.md', content: '# alpha 正文', truncated: false, contentLength: 8 } }),
    }
  }
  return catalogResponse(CATALOG)
}
const expandRender = await renderSection(expandFetch)
const viewButton = expandRender.hosts.find((n) => n.type === 'button' && textOf(n).includes('查看'))
check('D14', viewButton !== undefined, '没找到「查看」按钮')
// 点击必须发生在**假 fetch 装着的窗口内**：客户端的 ROUTE 是同源相对路径
// （浏览器里正确，但 Node 的原生 fetch 解析不了相对 URL），所以不能让它漏到真 fetch。
patchFetch(expandRender.fetchHandler, expandRender.fetchCalls)
try {
  await viewButton?.props?.onClick?.()
} finally {
  globalThis.fetch = REAL_FETCH
}
const expandedMounted = await (async () => {
  patchFetch(expandRender.fetchHandler, expandRender.fetchCalls)
  try {
    return await mount(expandRender.runtime, expandRender.component, expandRender.props)
  } finally {
    globalThis.fetch = REAL_FETCH
  }
})()
const expandedText = textOf(expandedMounted.view)
check('D15', expandedText.includes('alpha 正文'), `点击「查看」后没有渲染正文，文本片段 = ${JSON.stringify(expandedText.slice(0, 240))}`)
check('D16', expandedText.includes('收起'), '展开后按钮没有变成「收起」')
check('D17', expandRender.fetchCalls.some((call) => call.init?.method === 'POST'), '展开正文没有发 POST（正文应按需拉取，不跟列表一起下来）')

// —— 空表 ——
// 顶部那条「当前视图里没有发现任何 skill」已按用户要求删掉：它和标签页上的 `0`
// 说的是同一件事。空状态的解释现在**只**出现在选中那一格里，一句话，不含路径。
const emptyRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [], counts: {} }))
check('D18', emptyRender.text.includes('没有发现 skill'), `空表没有渲染空态文案，文本片段 = ${JSON.stringify(emptyRender.text.slice(-160))}`)
check('D19', emptyRender.text.includes('共 0 个 skill'), '空表计数不对')

// —— 目录读取失败：同一条错误只允许一个渲染点 ——
const ERROR_TEXT = '宿主返回 HTTP 500'
const failRender = await renderSection(async () => ({ status: 500, json: async () => ({ ok: false, error: ERROR_TEXT }) }))
const errorOccurrences = failRender.text.split(ERROR_TEXT).length - 1
check('D20', errorOccurrences === 1, `错误文案渲染了 ${errorOccurrences} 次，期望 1（同一错误只允许一个渲染点）`)
check('D21', failRender.text.includes('刷新'), '失败态仍应有「刷新」按钮可以重试')

// —— 「完整性 未完成」与提供方原文：**整体下线** ——
// 用户原话：「把冗余提示都去掉，这是作为使用者不用看到的内容」。
// 所以这里反过来钉：即使宿主仍然回传 complete:false + providerFailures（旧宿主/未来宿主），
// 页面上也不许出现「本次发现未完成」「候选被整体丢弃」这类开发者文案。
const partialRender = await renderSection(async () =>
  catalogResponse({
    ...CATALOG,
    complete: false,
    providerFailures: {
      filesystem: { message: "FsError: cannot list 'D:/…/app.asar/…': Cannot mix BigInt and other types", level: 'warn', at: 1 },
    },
  }),
)
check(
  'D62',
  ['本次发现未完成', '候选被整体丢弃', 'FsError', 'Cannot mix BigInt', '未完成'].every((needle) => !partialRender.text.includes(needle)),
  `未完成/提供方原文不该再渲染，文本片段 = ${JSON.stringify(partialRender.text.slice(0, 240))}`,
)
// 诊断下线了，但**列表本身照常渲染**——删掉的只是提示，不是数据。
check('D63', partialRender.text.includes('alpha'), '去掉提示之后，列表本身必须照常渲染')

// —— 降级到全局层：也不再提示 ——
// 这条提示原本让用户「先打开一个会话再刷新」；直读上线后「只读全局层」不再等于空表，
// 也就不再需要一句开发者视角的解释。
const degradedRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [], resolvedBy: 'global-layer', presetId: undefined, cwd: undefined }))
check(
  'D23',
  ['仅全局层', '没有解析到 Agent 预设作用域'].every((needle) => !degradedRender.text.includes(needle)),
  `降级提示不该再渲染，文本片段 = ${JSON.stringify(degradedRender.text.slice(0, 200))}`,
)
check('D24', degradedRender.text.includes('没有发现 skill'), '降级时空状态仍要有一句解释')

// —— 没有主视图 session：不得编造 sessionId ——
const noSessionRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [] }), { byId: {} })
check('D25', noSessionRender.fetchCalls.length >= 1, '没有 session 时也应发一次请求（走宿主降级路径）')
check(
  'D26',
  noSessionRender.fetchCalls.every((call) => !call.url.includes('sessionId=')),
  `没有主视图 session 时不应编造 sessionId：${JSON.stringify(noSessionRender.fetchCalls.map((c) => c.url))}`,
)

// —— 空目录也必须能看到「项目 / 全局」两组 ——
// 这是第一次真实实测暴露的直接问题：只渲染非空分组时，用户看到一片空白，
// 分不清"本机没有 skill"和"这个分组根本没实现"。
const emptyGroupsRender = await renderSection(async () =>
  catalogResponse({ ...CATALOG, skills: [], counts: {}, providers: {} }),
)
for (const [id, label] of [['D27', '项目'], ['D28', '全局'], ['D29', '自定义'], ['D30', '随包内置']]) {
  check(id, emptyGroupsRender.text.includes(label), `skills 为空时没有渲染「${label}」分组标题`)
}
// **根目录路径与「存在/不存在」小字整体下线**：那一块是排查面板，不是使用者要看的内容。
// 「空」仍然分得开三种原因，但只用一句话说，不再甩绝对路径。
const ANY_ROOT_PATH = ['D:/project/.dsh/skills', 'D:/project/.agents/skills', 'C:/dsh/skills', 'C:/agents/skills']
check(
  'D31',
  ANY_ROOT_PATH.every((path) => !emptyGroupsRender.text.includes(path)),
  `页面上不该再出现根目录路径，文本片段 = ${JSON.stringify(emptyGroupsRender.text)}`,
)
check(
  'D32',
  !emptyGroupsRender.text.includes('未判定') && !emptyGroupsRender.text.includes('不存在'),
  `不该再渲染「存在/不存在/未判定」标签，文本片段 = ${JSON.stringify(emptyGroupsRender.text)}`,
)
// 「项目 + 全局」已合并成一格：这一格里有 user-dsh（夹具里 exists:true），
// 所以空状态该说"目录存在但里面没有合法的 skill"，而不是"都不存在"。
check('D33', emptyGroupsRender.text.includes('目录存在，但里面没有合法的 skill'), `空状态解释不对，文本片段 = ${JSON.stringify(emptyGroupsRender.text.slice(-200))}`)
check('D34', !emptyGroupsRender.text.includes('D:/project'), '项目根路径不该再渲染')

// 全部根目录都不存在时，才该说"都不存在"——三种原因必须真的分得开。
const allMissingRender = await renderSection(async () =>
  catalogResponse({
    ...CATALOG,
    skills: [],
    counts: {},
    providers: {},
    roots: CATALOG.roots.map((root) => (root.path === undefined ? root : { ...root, exists: false })),
  }),
)
check('D50', allMissingRender.text.includes('这些目录都还不存在'), `全部缺失时的解释不对，文本片段 = ${JSON.stringify(allMissingRender.text.slice(-200))}`)
// D31 只覆盖了「目录存在」那一支的空状态；「都不存在」是**另一支**，路径同样不许泄漏。
// 反向验证时发现的覆盖缺口：把路径拼进这一支，D31 看不见（两个分支不同时渲染）。
check(
  'D65',
  ANY_ROOT_PATH.every((path) => !allMissingRender.text.includes(path)),
  `「都不存在」那一支也不该出现根目录路径，文本片段 = ${JSON.stringify(allMissingRender.text.slice(-200))}`,
)

// —— 分组只以「标签页 + 个数」呈现，一次展开一个 ——
// 规范标签页永远都列出来（含 0），所以「空」仍然一眼可见，但内容不堆叠。
const tabButtons = (render) =>
  render.hosts.filter((node) => {
    const className = node.props?.className
    return typeof className === 'string' && className.split(' ').includes('dskm-tab')
  })
const readyTabs = tabButtons(readyRender)
// 项目 + 全局**合并成一格**（用户要求）：3 格而不是 4 格。
check('D39', readyTabs.length === 3, `标签页数 = ${readyTabs.length}，期望 3（项目+全局 / 自定义 / 随包内置）`)
check(
  'D40',
  ['项目 + 全局2', '自定义0', '随包内置0'].every((label) => readyTabs.some((node) => textOf(node) === label)),
  `标签页文案 = ${JSON.stringify(readyTabs.map(textOf))}，每格都要带个数（含 0），且项目+全局必须合并且计数相加`,
)
// 默认落在第一个非空标签页：一进来就有内容可看，不会停在空标签页上。
check('D41', readyRender.text.includes('alpha'), '默认标签页应显示第一个非空标签页（项目 + 全局）的内容')
check('D42', readyRender.text.includes('gamma'), '合并后「项目 + 全局」里 project 与 global 的 skill 应同时可见')

// 未选中标签页的内容不得同时渲染——这才是要消掉的堆叠。
const mixedRender = await renderSection(async () =>
  catalogResponse({
    ...CATALOG,
    skills: [
      ...CATALOG.skills,
      { name: 'office-docx', description: 'docx', source: 'bundled', group: 'bundled', provider: 'dsh-office', modelInvocable: true },
    ],
    counts: { project: 1, global: 1, custom: 0, bundled: 1, other: 0 },
  }),
)
check(
  'D51',
  mixedRender.text.includes('alpha') && !mixedRender.text.includes('office-docx'),
  `只应展开选中的那一格，别的格的内容不该同时渲染，文本片段 = ${JSON.stringify(mixedRender.text.slice(-260))}`,
)

// 点空标签页：必须给出「为什么空」的解释，且不再渲染别的格的 skill。
const customTab = emptyGroupsRender.hosts.find(
  (node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dskm-tab') && textOf(node).startsWith('自定义'),
)
check('D43', customTab !== undefined, '没找到「自定义」标签页')
await customTab?.props?.onClick?.()
const customMounted = await mount(emptyGroupsRender.runtime, emptyGroupsRender.component, emptyGroupsRender.props)
const customText = textOf(customMounted.view)
// 「自定义」根没有 `path`、也没有 `exists`（位置由配置决定）→ 三种空状态里的最后一种。
check('D44', customText.includes('暂时读不到这些目录'), `点开「自定义」后没有给出空状态解释，文本片段 = ${JSON.stringify(customText.slice(-260))}`)
// 切到「自定义」后，别的格（项目 + 全局）的根目录路径**任何形态**都不该还在。
check(
  'D45',
  ANY_ROOT_PATH.every((path) => !customText.includes(path)) && customText.includes('自定义'),
  `只应展开选中的那一格，别的格的痕迹不该还在，文本片段 = ${JSON.stringify(customText.slice(-260))}`,
)

// 默认标签页必须挑「非空」的：只有随包内置有内容时，就不该停在空的那一格上。
const bundledOnly = await renderSection(async () =>
  catalogResponse({
    ...CATALOG,
    skills: [{ name: 'office-docx', description: 'docx', source: 'bundled', group: 'bundled', provider: 'dsh-office', modelInvocable: true }],
    counts: { project: 0, global: 0, custom: 0, bundled: 1, other: 0 },
  }),
)
check('D46', bundledOnly.text.includes('office-docx'), '只有 bundled 有内容时，默认应落在「随包内置」标签页上')

// ── 范围选择：看当前会话，还是看某个工作区的 skill ──────────────────────────
// 这是"跨项目看 skill"的入口。宿主侧 `options.cwd` 本来就优先于 session 的权威 cwd，
// 所以客户端只要把选中的工作区路径带上即可。
check(
  'D53',
  ['当前会话', 'agent-go（agent-go）', 'ECC（ECC）'].every((label) => readyRender.text.includes(label)),
  `没有渲染范围选择器或工作区选项，文本片段 = ${JSON.stringify(readyRender.text.slice(0, 260))}`,
)
// 没有 title 的工作区必须兜底成路径最后一段（夹具里 ECC 的 title 是空串、path 带尾斜杠）。
check('D54', readyRender.text.includes('ECC（ECC）'), '无 title 的工作区没有兜底成路径最后一段')

// 选中一个工作区 → 请求必须带上 `cwd=<工作区路径>`，否则换项目就是摆设。
const switchedRender = await renderSection(async (url) => catalogResponse(CATALOG))
const workspaceOption = switchedRender.hosts.find(
  (node) => node.type === 'select' || (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dskm-select')),
)
check('D55', workspaceOption !== undefined, '没找到范围下拉框')
// 后续所有触发/挂载都必须在**假 fetch 装着**的窗口内做：客户端的 ROUTE 是同源相对路径，
// 漏到 Node 的原生 fetch 会直接抛错（踩过：表现为"切换之后什么也没发生"）。
const withFakeFetch = async (run) => {
  patchFetch(switchedRender.fetchHandler, switchedRender.fetchCalls)
  try {
    return await run()
  } finally {
    globalThis.fetch = REAL_FETCH
  }
}
// onChange 的值是工作区路径；空串表示"当前会话"。
await withFakeFetch(async () => {
  await workspaceOption?.props?.onChange?.({ target: { value: 'D:/project/ECC' } })
  await mount(switchedRender.runtime, switchedRender.component, switchedRender.props)
})
check(
  'D56',
  switchedRender.fetchCalls.some((call) => call.url.includes('cwd=D%3A%2Fproject%2FECC')),
  `切换工作区后请求没带 cwd，实际 = ${JSON.stringify(switchedRender.fetchCalls.map((c) => c.url))}`,
)
// 首屏（还没切）必须**不带** cwd：当前会话的 cwd 由宿主权威解析，客户端不掺和。
check('D57', switchedRender.fetchCalls[0]?.url.includes('cwd=') === false, `首屏不应带 cwd，实际 = ${JSON.stringify(switchedRender.fetchCalls[0]?.url)}`)
// 而且历史上也不该出现过 `cwd=null` 这种字符串（把 null 当路径发出去是真 bug）。
check(
  'D61',
  switchedRender.fetchCalls.every((call) => !call.url.includes('cwd=null')),
  `不应把 null 当 cwd 发出去：${JSON.stringify(switchedRender.fetchCalls.map((c) => c.url))}`,
)

// 切回「当前会话」→ cwd 又消失。
await withFakeFetch(async () => {
  await workspaceOption?.props?.onChange?.({ target: { value: '' } })
  await mount(switchedRender.runtime, switchedRender.component, switchedRender.props)
})
check(
  'D58',
  switchedRender.fetchCalls[switchedRender.fetchCalls.length - 1]?.url.includes('cwd=') === false,
  '切回「当前会话」后不应再带 cwd',
)

// 展开正文也必须带同一个 cwd，否则会出现「列表里有、点开说没有」。
const readWithCwd = await renderSection(async (url, init) => {
  if (init?.method === 'POST') {
    return { status: 200, json: async () => ({ ok: true, data: { name: 'alpha', path: 'p', content: '正文', truncated: false, contentLength: 2 } }) }
  }
  return catalogResponse(CATALOG)
})
check('D59', readWithCwd.hosts.some((n) => n.type === 'button' && textOf(n).includes('查看')), '没找到「查看」按钮（cwd 用例的前置）')
patchFetch(readWithCwd.fetchHandler, readWithCwd.fetchCalls)
try {
  // 先选一个工作区，再点「查看」：POST 必须带上同一个 cwd。
  await readWithCwd.hosts
    .find((node) => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('dskm-select'))
    ?.props?.onChange?.({ target: { value: 'D:/project/agent-go' } })
  await mount(readWithCwd.runtime, readWithCwd.component, readWithCwd.props)
  // ⚠️ 必须在 mount 之后**重新找**按钮：事件闭包捕获的是当次渲染的 pickedCwd，
  // 拿着切换前抓到的旧节点去点，等于用旧闭包点——测的是过去而不是现在。
  const freshButton = hostsOf(renderTree(readWithCwd.runtime, readWithCwd.runtime.react.createElement(readWithCwd.component, readWithCwd.props))).find(
    (n) => n.type === 'button' && textOf(n).includes('查看'),
  )
  await freshButton?.props?.onClick?.()
} finally {
  globalThis.fetch = REAL_FETCH
}
await mount(readWithCwd.runtime, readWithCwd.component, readWithCwd.props)
const readPost = readWithCwd.fetchCalls.find((call) => call.init?.method === 'POST')
// ⚠️ 别用 JSON.stringify(…).includes(…)：JSON 会把 `/` 转义成 `\/`，永远匹配不上。
const readPostBody = readPost === undefined ? {} : JSON.parse(String(readPost.init?.body ?? '{}'))
check('D60', readPostBody?.cwd === 'D:/project/agent-go', `展开正文的 POST 没带选中的 cwd，实际 = ${JSON.stringify(readPostBody)}`)


// —— 提供方原文 / 提供方汇总：**整块下线**（用户要求「冗余提示都去掉」）——
// 反面钉一次：旧宿主若仍然塞 `providerFailures`，页面上也不许出现任何内部原文。
// 注意断言的是「这些字符串一个都不出现」，而不是"某一行不存在"——
// 后者会随着排版变化而平凡通过。
const FAIL_TEXT = "ENOENT: no such file or directory, scandir 'D:/.../app.asar/.../skills'"
const providerFailRender = await renderSection(async () =>
  catalogResponse({
    ...CATALOG,
    skills: [{ ...CATALOG.skills[0] }],
    counts: {},
    providers: { filesystem: 1 },
    providerFailures: { filesystem: { message: FAIL_TEXT, level: 'warn', at: 1 } },
    complete: false,
  }),
)
check(
  'D47',
  [FAIL_TEXT, 'FsError', '候选被整体丢弃', '本次发现未完成', '提供方', '完整性', 'filesystemx1'].every(
    (needle) => !providerFailRender.text.includes(needle),
  ),
  `提供方失败相关文案都不该渲染，文本片段 = ${JSON.stringify(providerFailRender.text.slice(0, 320))}`,
)
check('D48', providerFailRender.text.includes('alpha'), '去掉诊断之后，列表本身必须照常渲染')
check('D49', providerFailRender.text.includes('共 1 个 skill'), `计数必须照常渲染，文本片段 = ${JSON.stringify(providerFailRender.text.slice(0, 200))}`)
// 就绪态里也不该有任何诊断痕迹。
check(
  'D52',
  ['作用域', '完整性', '提供方', '候选被整体丢弃', '未完成'].every((needle) => !readyRender.text.includes(needle)),
  `就绪态不该有诊断文案，文本片段 = ${JSON.stringify(readyRender.text.slice(0, 320))}`,
)

// —— 徽标显示**提供方**，不重复分组名 ——
// 第一次实测里 `bundled` 徽标 + `随包内置` 分组并排出现，让人以为分类错了。
// 徽标是**每一行**的归属提示，不是诊断面板，保留。
const badgeTexts = readyRender.hosts.filter((node) => node.props?.className === 'dskm-badge').map(textOf)
check('D37', badgeTexts.includes('filesystem'), `徽标文案 = ${JSON.stringify(badgeTexts)}，应显示提供方`)
check('D38', !badgeTexts.some((text) => text === 'bundled' || text === 'project-dsh' || text === 'user-dsh'), `徽标不该重复分组名/source 名：${JSON.stringify(badgeTexts)}`)

// ─────────────────────────────────────────────────────────────────────────────

const total = passed + failures.length
if (failures.length > 0) {
  console.error(`FAIL ${passed}/${total}\n`)
  for (const failure of failures) console.error(`  x ${failure}`)
  console.error('')
  process.exit(1)
}

console.log(`PASS ${passed}/${total}`)
process.exit(0)
