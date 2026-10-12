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

/** 搭一套宿主替身；每个成员都记录自己的调用，断言才有「实际发生了什么」可看。 */
function makeHost(options = {}) {
  const calls = { snapshot: [], scopedSnapshot: [], get: [], scopedGet: [], acquireScope: [], observeSession: [], serviceFor: [] }
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
  const scope = {
    skills,
    get(name) {
      return { agentPresets: presets, agents, sessionQuery, workspaceRegistry: undefined }[name]
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
  return { ctx, routes, calls, lease, observation, liveAgent, scopedRegistry, skills }
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

/** 跑一次 GET，返回 `{ status, body }`。 */
async function getJson(host, query = '') {
  const response = await host.routes[0].fetch(GET(query))
  return { status: response.status, body: await response.json() }
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

/**
 * 在假 fetch（与假 sessions 快照）下真渲染一次 SkillSection。
 *
 * 每次都**重新加载一遍 bundle**，把本 runtime 的 react 交给它——这样组件里的 hooks
 * 才是真的（见 loadClientModule 的注释）。
 */
async function renderSection(fetchHandler, sessionState = MAIN_SESSION_STATE) {
  const runtime = createRuntime()
  const mod = loadClientModule(runtime.react)
  const component = applyClient(mod.exportsObj).registrations[0].component
  const fetchCalls = []
  patchFetch(fetchHandler, fetchCalls)
  try {
    // useSessions 也占一个 hook 位，这样 hook 计数与真实运行时同形。
    const useSessions = (selector) => {
      runtime.state.current.index++
      return selector(sessionState)
    }
    const props = { useSessions }
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
    { name: 'alpha', description: 'alpha 的描述', source: 'project-dsh', group: 'project', modelInvocable: true, path: 'C:/skills/alpha/SKILL.md' },
    { name: 'gamma', description: 'gamma 的描述', source: 'user-dsh', group: 'global', modelInvocable: true, path: 'C:/skills/gamma/SKILL.md' },
  ],
  counts: { project: 1, global: 1, custom: 0, bundled: 0, other: 0 },
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
check('D6', readyRender.text.includes('gamma 的描述'), '没有渲染 skill 描述')
check('D7', readyRender.text.includes('共 2 个 skill'), `没有渲染计数，文本片段 = ${JSON.stringify(readyRender.text.slice(0, 200))}`)
check('D8', readyRender.text.includes('当前会话（活 Agent）'), '没有把 resolvedBy 翻译成可读文案')
check('D9', !readyRender.text.includes('读取中…'), '就绪后仍停在「读取中…」')
check('D10', readyRender.hosts.filter((n) => n.type === 'button' && textOf(n).includes('查看')).length === 2, '每条 skill 应各有一个「查看」按钮')

// hook 调用序必须每次渲染都一致（条件式 hook 是 React 里最致命的一类 bug）。
const sectionInstance = [...readyRender.runtime.instances.entries()].find(([key]) => key.includes('#SkillSection'))?.[1]
check('D11', sectionInstance !== undefined, '没找到 SkillSection 的渲染实例')
check(
  'D12',
  sectionInstance !== undefined && sectionInstance.history.length >= 2 && sectionInstance.history.every((count) => count === sectionInstance.history[0]),
  `hook 位数在不同渲染间不一致：${JSON.stringify(sectionInstance?.history)} —— 存在条件式 hook`,
)
check('D13', sectionInstance?.history[0] === 6, `SkillSection 的 hook 位 = ${sectionInstance?.history[0]}，期望 6（useSessions + 3×useState + useEffect + useCallback）`)

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
const emptyRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [], counts: {} }))
check('D18', emptyRender.text.includes('当前视图里没有发现任何 skill'), '空表没有渲染空态文案')
check('D19', emptyRender.text.includes('共 0 个 skill'), '空表计数不对')

// —— 目录读取失败：同一条错误只允许一个渲染点 ——
const ERROR_TEXT = '宿主返回 HTTP 500'
const failRender = await renderSection(async () => ({ status: 500, json: async () => ({ ok: false, error: ERROR_TEXT }) }))
const errorOccurrences = failRender.text.split(ERROR_TEXT).length - 1
check('D20', errorOccurrences === 1, `错误文案渲染了 ${errorOccurrences} 次，期望 1（同一错误只允许一个渲染点）`)
check('D21', failRender.text.includes('刷新'), '失败态仍应有「刷新」按钮可以重试')

// —— 发现未完成 ——
const partialRender = await renderSection(async () => catalogResponse({ ...CATALOG, complete: false }))
check('D22', partialRender.text.includes('本次发现未完成'), 'complete:false 没有渲染「发现未完成」提示')

// —— 降级到全局层：必须解释「为什么可能是空的」——
const degradedRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [], resolvedBy: 'global-layer', presetId: undefined, cwd: undefined }))
check('D23', degradedRender.text.includes('仅全局层'), '降级时没有把 resolvedBy 说清楚')
check('D24', degradedRender.text.includes('请先打开一个会话'), '降级时没有给出可操作的建议')

// —— 没有主视图 session：不得编造 sessionId ——
const noSessionRender = await renderSection(async () => catalogResponse({ ...CATALOG, skills: [] }), { byId: {} })
check('D25', noSessionRender.fetchCalls.length >= 1, '没有 session 时也应发一次请求（走宿主降级路径）')
check(
  'D26',
  noSessionRender.fetchCalls.every((call) => !call.url.includes('sessionId=')),
  `没有主视图 session 时不应编造 sessionId：${JSON.stringify(noSessionRender.fetchCalls.map((c) => c.url))}`,
)

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
