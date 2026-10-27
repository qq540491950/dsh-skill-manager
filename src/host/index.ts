/**
 * 宿主半边（Host half）——skill 管理器的只读数据面。
 *
 * ## 为什么需要宿主半边
 *
 * `ctx.skills`（`@deepseek-ai/dsh-skill` 的注册表）**没有任何 `@Remote` 方法**，
 * 所以浏览器半边拿不到它。官方唯一的客户端入口是 `@deepseek-ai/dsh-api-session-controller`
 * 的 `ctx.remote.skills.list({ sessionId })`，但那条通道**故意裁掉了 `source` / `provider` /
 * `rank`**（见 `skill-catalog.js` 里逐字段挑拣的那段），只留 `name/path/description/
 * whenToUse/modelInvocable`。而我们这一页要做的恰恰是「全局 vs 项目」的分组，
 * 分组的唯一权威依据就是 `source`——所以必须自己开一条通道，把完整摘要取回来。
 *
 * ## 关键约束：**读 skill 必须带 scope，否则基本是空表**
 *
 * `@deepseek-ai/dsh-skill-filesystem` 在本机 profile 里**不是**挂在宿主根上，而是挂在
 * **agent preset 的 standing composition** 里（`cordis.yml` 的 preset 段落，
 * `customSkillDirs` 指向 `@deepseek-ai/dsh-agent-preset/skills`）。
 * 按 `ctx.skills` 的层语义：preset 里注册的提供方进的是**那个 preset 的 layer**，
 * 而一次读取只会「全局 layer + 当前作用域链」合并。于是：
 *
 * - 不带 `scope` → 只看得到全局 layer → 一个提供方都没有 → **空**；
 * - 带对了 `scope` → 才看得见 project / user / custom / bundled 四类根。
 *
 * 所以本文件的解析流程是**逐字对齐官方 `SessionSkillCatalog.list()`**（那是这条链上
 * 唯一被官方验证过的实现），只做了两处扩展：允许调用方显式指定 `preset`/`cwd`，
 * 以及在没有活 Agent 时用 `acquireScope()` 拿一份**冷读租约**。
 *
 * ## 两个来源：注册表 + 规范根目录直读
 *
 * 只用注册表是不够的。`dsh-skill-filesystem` 的 `list()` **没有 per-root try/catch**，
 * 一个根目录抛错就把该提供方的全部候选丢掉——项目与用户目录里存在的 skill 一起消失。
 * 本机实测就是如此（`customSkillDirs` 指向 app.asar 内的路径，`ctx.fs.listDir` 抛
 * `FsError: cannot list …: Cannot mix BigInt and other types`）。
 *
 * 所以 `readCatalog` 会同时**只读直读**那四个规范根目录（`scanRoots`），按
 * 「注册表优先」合并：同名一律以注册表为准，直读只补它没有的名字。提供方健康时
 * 直读是纯空操作。读到的行**不走 `ctx.skills.register()`**，只进这一次 HTTP 响应。
 *
 * ## 零 import
 *
 * 本文件由 Loader 以 `file:///...` 绝对路径加载，裸模块说明符（`@deepseek-ai/cordis`、
 * `node:path` 等）都藏在 app.asar 里，从磁盘路径解析不到。因此只用注入进来的 Service
 * 与全局 `URL` / `Response`。这与 `dsh-mcp-manager` 同一纪律。
 * 源码里的相对 `import` **只有类型**（`shared/types.ts`、`./service-types.ts`），
 * 类型擦除后产物里一行 import 都不剩（自检 A8–A10 + E2 钉这条）。
 *
 * ## 写入面：只有一个（启用/关闭开关）
 *
 * 本插件**只有一处写入**，就是 `op: "set-enabled"` 改一个 `SKILL.md` 的 frontmatter：
 *
 *   - 关 = 写入 `disable-model-invocation: true` + `user-invocable: false`
 *     （官方语义：前者让模型目录与 `skill` 工具看不到它，后者让 `/名字` 看不到它）
 *   - 开 = **删掉这两个键**（官方默认就是两者皆允许，删掉比写 `false` 更干净）
 *
 * 三条纪律：
 *   1. 只改这两行，**其余字节原样保留**（`rewriteInvocation` 逐字节重建头部，正文不动）
 *   2. 写入一律带版本护栏（`{ kind: 'replaceIfVersion', version }`），并把 gate
 *      放在 `ctx.fs.writeText` 上——**不用 `editText`**（它是文本匹配式编辑，
 *      同一个 `description` 可能出现在多处）
 *   3. **不接受客户端传来的路径**：目标文件由宿主自己按规范根目录算出来（`scanRoot`）
 *
 * 没有 `ctx.loader.*`、没有 `ctx.configEditor.edit()`、不碰 `~/.dsh/profiles/**`、
 * 不注册任何 skill / 提供方。**也没有删除**：`ctx.fs` 的契约里根本没有 unlink/rmdir，
 * 真删只能起 shell 进程（会绕过沙箱围栏），所以这件事本插件**不做**（见 AGENTS 8）。
 * GET 仍是纯读；POST 只有 `op: "read"` 与 `op: "set-enabled"`。
 */

import type { CatalogPayload, GroupKey, RootRow, SetEnabledResult, SkillBody, SkillRow } from '../shared/types.ts'
import type {
  AgentPresetsService,
  AgentsService,
  FsEntry,
  FsService,
  HostContext,
  PresetRow,
  SandboxExecutionPolicy,
  SandboxPolicyService,
  SessionObservation,
  SessionQueryService,
  SkillDetail,
  SkillRegistry,
  SkillSnapshot,
  SkillSummary,
  SymbolKeyed,
  WorkspaceRegistryService,
} from './service-types.ts'

/** 本插件注册的浏览器路由。必须以 `/api/` 开头（`connection.fetch` 的校验）。 */
const ROUTE = '/api/skill-manager'

/** 单次 skill 正文读取的上限，避免把超大文件整段塞进响应。 */
const CONTENT_LIMIT = 200_000

/** 一次目录解析的预算：watcher 失效后重新扫描根目录是异步的，给足但要有界。 */
const RESOLVE_TIMEOUT_MS = 8000

/**
 * 直读根目录时，每个根最多看多少个条目。
 *
 * 官方 provider 会把整个根读一遍（它服务的是 skill 目录本身，不是一张设置页）；
 * 本插件必须自己给自己设界：条目数异常膨胀时宁可少列，也不要把请求拖到超时。
 */
const SCAN_ENTRY_LIMIT = 200

/** 一张 `SKILL.md` 只在前 64 KiB 里找 frontmatter —— 正文不参与解析。 */
const SCAN_READ_LIMIT = 65_536

/** skill 名约束，逐字来自官方 `dsh-skill/lib/index.js` 的 `SKILL_NAME`。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * `SkillSource` → 面向用户的分组。
 *
 * `SkillSource` 的取值与根目录的对应关系来自 `@deepseek-ai/dsh-skill-filesystem` 的
 * rank 表（README.zh.md「根目录与优先级」）：
 *
 * | Rank | source           | 根目录                                  |
 * |------|------------------|-----------------------------------------|
 * | 100  | `project-dsh`    | `<projectRoot>/.dsh/skills`             |
 * | 200  | `project-agents` | `<projectRoot>/.agents/skills`          |
 * | 300  | `custom`         | `Config.customSkillDirs`                |
 * | 400  | `user-dsh`       | `<dshHome>/skills`                      |
 * | 500  | `user-agents`    | `<agentsHome>/skills`                   |
 * | 600  | `bundled`        | `<bundledSkillDir>` / `$DSH_BUNDLED_SKILL_DIR` |
 *
 * 「项目」与「全局」是用户要的两组；`custom`/`bundled`/`runtime` 既不属于项目目录、
 * 也不属于用户目录，**不硬塞进这两组**，各自单列，免得把 `<agent-preset>/skills`
 * 里的随包 skill 谎报成「项目 skill」。本机 profile 里 `customSkillDirs` 恰好指向
 * `@deepseek-ai/dsh-agent-preset/skills`，所以那一组里装的是随 preset 分发的官方 skill。
 */
const GROUPS: Record<string, GroupKey> = {
  'project-dsh': 'project',
  'project-agents': 'project',
  'user-dsh': 'global',
  'user-agents': 'global',
  custom: 'custom',
  bundled: 'bundled',
  runtime: 'bundled',
}

/** 分组顺序 = 界面上的分节顺序。 */
const GROUP_ORDER: readonly GroupKey[] = ['project', 'global', 'custom', 'bundled', 'other']

/**
 * 哪些来源的 skill **有本插件自己定位得到、也写得进去的文件**。
 *
 * 只有这四个规范根满足条件——它们的路径由 `standardRoots` 自己算出来（来自 env 与
 * projectRoot），既可信又可写。另外三个来源都不行：
 *   - `custom`：位置由 `Config.customSkillDirs` 决定，宿主半边读不到展开值（可能在
 *     app.asar 里），算不出路径 → 不给写，界面上开关置灰
 *   - `bundled` / `runtime`：随包分发 / 运行时注册，没有可编辑的 `SKILL.md`
 *
 * 开关只在能真正生效的时候才可点。**点了没反应比没有开关更糟。**
 */
const WRITABLE_SOURCES: readonly string[] = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']

/**
 * frontmatter 里的调用策略键（出现即视为"这一行由本插件管理"）。
 *
 * 只认**顶格**的键：缩进行属于上一个键的块标量，不能碰。
 */
const INVOCATION_KEY_LINE = /^(?:disable-model-invocation|user-invocable)\s*:/

export const name = 'dsh-skill-manager'
/** 依赖在 apply 内用 ctx.inject 声明，便于缺失服务时优雅降级而不是抛错。 */
export const inject: readonly string[] = []

/** 一次读取的查询参数（全部可选：缺了就按"当前会话"的语义解析）。 */
interface QueryOptions {
  sessionId?: string | undefined
  preset?: string | undefined
  cwd?: string | undefined
}

/** `op: "read"` 的入参。`name` 原样收，收窄交给 `readSkill`。 */
interface ReadOptions extends QueryOptions {
  name?: unknown
}

/** `op: "set-enabled"` 的入参。同上，收窄在 `setSkillEnabled` 里做。 */
interface SetEnabledOptions extends QueryOptions {
  name?: unknown
}

/** 一份可写文件：目标句柄 + 当前正文 + 版本（版本是并发的写入护栏）。 */
interface WritableFile {
  target: string
  text: string
  version: string
}

/** 一个规范根目录（`source` 决定它的分组；`skipSystem` 与官方一致）。 */
interface RootSpec {
  group: GroupKey
  source: string
  path?: string | undefined
  skipSystem?: boolean
}

/** 四个规范根 + 它们的 projectRoot。 */
interface StandardRoots {
  projectRoot: string | undefined
  specs: RootSpec[]
}

/** 直读出来的一个候选（形状与官方 `SkillSummary` 对齐，`toRow` 才不用分叉）。 */
interface ScannedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: string
  provider: string
  resourceBase: { kind: 'directory'; path: string }
  path: string
}

/** 一个 `SKILL.md` 的位置：文件路径 + 它所属的目录（正文里的相对引用以目录为基准）。 */
interface Locator {
  path: string
  directory: string
}

/** 作用域解析的结果。`lease` / `observation` 都是**调用方负责释放**的租约。 */
interface ResolvedView {
  registry: SkillRegistry
  scope: unknown
  cwd: string | undefined
  presetId: string | undefined
  resolvedBy: string
  lease: unknown
  observation: unknown
}

/**
 * 宿主插件体。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx: HostContext): void {
  // `connection` 提供浏览器路由；`skills` 是注册表本体。两者缺一，本插件无事可做，
  // 所以放在 ctx.inject 里——缺失时插件保持 inactive，而不是激活后抛错。
  ctx.inject(['connection', 'skills'], (scope) => {
    // 这里原本挂着一个 `logger.exporter`，按 `skill provider "<name>" skipped:` 前缀收
    // 提供方失败原文并随 payload 下发。**已按用户要求整体删除**：那是一条只有开发者
    // 看得懂的内部诊断（实测原文长这样——`FsError: cannot list "…app.asar…": Cannot mix
    // BigInt and other types`），却被渲染成页面上最醒目的一块红字。用户明确表示
    // 「这是作为使用者不用看到的内容」。
    //
    // 它想解决的问题仍然存在（`dsh-skill-filesystem` 的 `list()` 没有 per-root
    // try/catch，一个坏根目录就把整个提供方的候选丢光）。本文件的处置不是继续报错，
    // 而是**自己把规范根目录只读直读一遍**（见 `scanRoots`）——根因不修，但页面能用。

    /** 按名字取一个注入服务，并收窄成它的结构类型（`get()` 本身返回 `unknown`）。 */
    const service = <T>(serviceName: string): T | undefined => scope.get(serviceName) as T | undefined

    /**
     * 读当前**默认** preset 的 id。
     *
     * 为什么要它：冷读（没有活 Agent）时必须有一个 preset 才能 `acquireScope()`，
     * 而「默认 preset」是 `resolve()` 不带参数时官方定义的语义。
     * 两条路都失败就返回 undefined，交给 `acquireScope(undefined)` 自己兜底。
     * @returns preset id，或 undefined。
     */
    const defaultPresetId = async (): Promise<string | undefined> => {
      const presets = service<AgentPresetsService>('agentPresets')
      if (presets === undefined) return undefined
      try {
        const preset = await presets.resolve()
        if (typeof preset?.id === 'string' && preset.id !== '') return preset.id
      } catch {
        // 落到 roster 这条路。
      }
      try {
        const roster = await presets.remoteExportList()
        const rows: readonly PresetRow[] = Array.isArray(roster?.presets) ? roster.presets : []
        const picked = rows.find((row) => row?.isDefault === true) ?? rows[0]
        return typeof picked?.id === 'string' && picked.id !== '' ? picked.id : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 冷读时的 cwd 兜底：问工作区注册表要第一个工作区路径。
     *
     * **这只是兜底，不是正路。** 宿主侧根本没有「当前工作区」这个概念——选择留在客户端的
     * `uiWorkspace.selection` 里——所以能问出来的只有「全部工作区里的第一个」，
     * 未必是用户正在看的那个。正路是让客户端把 `sessionId` 发上来（见 `observeSession`）。
     */
    const fallbackCwd = (): string | undefined => {
      try {
        const workspaces = service<WorkspaceRegistryService>('workspaceRegistry')?.list?.()
        const first = Array.isArray(workspaces) ? workspaces[0] : undefined
        return typeof first?.path === 'string' && first.path !== '' ? first.path : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 权威解析一个 session 的 `cwd` 与 `agentPreset`。
     *
     * 这是官方 `SessionSkillCatalog.list()` 的同款做法，也是**唯一可靠**的 cwd 来源。
     * `SessionHeader` 直接带 `cwd` 与 `agentPreset`，所以不必像官方那段再往
     * `projections.values.agentPreset` 里掏一层（projection 默认可能不带，
     * 官方为此还专门断言了 `observation.projections === undefined` 就抛错）。
     * 这里改成：**先用 header，header 没有再看 projections**，少一个失败点。
     *
     * @returns observation（**caller-owned 租约，用完必须 dispose**；见 `withView`），
     *   或 `undefined`（没有 sessionQuery 服务，或这个 session 查不到）。
     */
    const observeSession = async (sessionId: string, signal: AbortSignal): Promise<unknown> => {
      const sessionQuery = service<SessionQueryService>('sessionQuery')
      if (typeof sessionQuery?.observeSession !== 'function') return undefined
      try {
        return await sessionQuery.observeSession(sessionId, { signal })
      } catch {
        // session 不存在 / 读不出来：退化成「没有 session 信息」，而不是整页失败。
        return undefined
      }
    }

    /** 把 `AsyncDisposable` 租约释放掉；不同运行时能力不一，全部包在 try 里。 */
    const releaseLease = async (lease: unknown): Promise<void> => {
      if (lease === null || lease === undefined) return
      // `Symbol.dispose` / `Symbol.asyncDispose` 属于 `esnext.disposable`，而宿主半边的 lib
      // 只有 ES2022（见 tsconfig.host.json）——类型侧取不到，运行时却可能有。所以按需探测。
      const symbols = Symbol as unknown as { asyncDispose?: symbol; dispose?: symbol }
      const asyncDispose = symbols.asyncDispose
      const dispose = symbols.dispose
      const keyed = lease as SymbolKeyed
      try {
        const asyncRelease = asyncDispose === undefined ? undefined : keyed[asyncDispose]
        const syncRelease = dispose === undefined ? undefined : keyed[dispose]
        if (typeof asyncRelease === 'function') {
          await (asyncRelease as () => unknown).call(lease)
        } else if (typeof syncRelease === 'function') {
          ;(syncRelease as () => unknown).call(lease)
        }
      } catch {
        // 释放失败不影响本次只读结果。
      }
    }

    // ── 规范根目录探测 ──────────────────────────────────────────────────────
    //
    // 为什么需要它：只报「找到了什么」时，**一个空分组和"这个分组根本没实现"
    // 在界面上长得一模一样**。用户看到一片空白，无法判断是自己没装 skill、
    // 还是根目录不存在、还是提供方挂了。
    //
    // 所以这里把规范根目录连同「存在 / 不存在 / 无法判定」一起报出去。
    // 根目录与 rank、source 的对应关系见 README.md 第 4 节。
    // `custom` / `bundled` 两个根的位置由配置（`CustomSkillDirs` / `bundledSkillDir`）
    // 决定，宿主半边读不到展开后的值，所以只报「由配置决定」——不假装知道路径。
    //
    // 注意「无法判定」必须与「不存在」分开：`fs` 服务缺失或沙箱拒绝时是前者，
    // 把权限问题说成"你没有 skill"是误报。

    /** 没有 `node:path`：按基准路径里的分隔符选拼法（Windows 是反斜杠）。 */
    const joinPath = (base: string, ...parts: string[]): string =>
      [base.replace(/[\\/]+$/, ''), ...parts].join(base.includes('\\') ? '\\' : '/')

    /** 上一级目录；到根就返回自己。 */
    const parentPath = (value: string): string => {
      const normalized = value.replace(/[\\/]+$/, '')
      const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
      if (cut < 0) return normalized
      if (cut === 0) return normalized.slice(0, 1)
      // 盘符根（`C:\`）后面已经没有了：返回盘符本身，别退化成 `C:`。
      if (/^[A-Za-z]:$/.test(normalized.slice(0, cut))) return `${normalized.slice(0, cut)}\\`
      return normalized.slice(0, cut)
    }

    /** home 目录：只用环境变量，不 import `node:os`（宿主半边零 import）。 */
    const homeDir = (): string | undefined => process.env.USERPROFILE ?? process.env.HOME ?? undefined

    /** @returns true=存在 / false=不存在 / undefined=无法判定（fs 缺失或沙箱拒绝）。 */
    const pathExists = async (path: unknown): Promise<boolean | undefined> => {
      if (typeof path !== 'string' || path === '') return undefined
      const fsService = service<FsService>('fs')
      if (typeof fsService?.lstat !== 'function') return undefined
      try {
        const info = await fsService.lstat(path)
        return info !== undefined && info !== null
      } catch {
        return undefined
      }
    }

    /**
     * 项目根 = 最近的含 `.git` 的祖先目录；没有就退回 cwd。
     * 与上游 `dsh-skill-filesystem` 的判定一致（README.zh.md「根目录与优先级」）。
     */
    const resolveProjectRoot = async (cwd: unknown): Promise<string | undefined> => {
      if (typeof cwd !== 'string' || cwd === '') return undefined
      let current = cwd.replace(/[\\/]+$/, '')
      for (let depth = 0; depth < 12; depth++) {
        if ((await pathExists(joinPath(current, '.git'))) === true) return current
        const parent = parentPath(current)
        if (parent === current) break
        current = parent
      }
      return current
    }

    /**
     * 四个**规范根目录**（项目 ×2 + 用户 ×2），以及它们的 projectRoot。
     *
     * 路径与 `source` 的对应关系逐条来自官方 rank 表（README 第 4 节），两边必须一致：
     * 直读出来的行与被注册表读出来的行要能落进同一个分组。
     * `skipSystem` 也与官方一致——`<dshHome>/skills/.system` 是 harness 自己的保留目录。
     * @param cwd - session 的权威 cwd（没有就整段为 undefined，不编路径）。
     */
    const standardRoots = async (cwd: unknown): Promise<StandardRoots> => {
      const projectRoot = await resolveProjectRoot(cwd)
      const home = homeDir()
      const dshHome = process.env.DSH_HOME ?? (home === undefined ? undefined : joinPath(home, '.dsh'))
      const agentsHome =
        process.env.DSH_AGENTS_HOME ?? (home === undefined ? undefined : joinPath(home, '.agents'))
      return {
        projectRoot,
        specs: [
          {
            group: 'project',
            source: 'project-dsh',
            path: projectRoot === undefined ? undefined : joinPath(projectRoot, '.dsh', 'skills'),
          },
          {
            group: 'project',
            source: 'project-agents',
            path: projectRoot === undefined ? undefined : joinPath(projectRoot, '.agents', 'skills'),
          },
          {
            group: 'global',
            source: 'user-dsh',
            path: dshHome === undefined ? undefined : joinPath(dshHome, 'skills'),
            skipSystem: true,
          },
          {
            group: 'global',
            source: 'user-agents',
            path: agentsHome === undefined ? undefined : joinPath(agentsHome, 'skills'),
          },
        ],
      }
    }

    /** 规范根目录清单（项目 / 全局 / 自定义 / 随包内置），带存在性。 */
    const probeRoots = async (
      standard: StandardRoots,
    ): Promise<{ projectRoot: string | undefined; rows: RootRow[] }> => {
      const rows: RootRow[] = []
      for (const spec of standard.specs) {
        rows.push({ group: spec.group, source: spec.source, path: spec.path, exists: await pathExists(spec.path) })
      }
      rows.push({ group: 'custom', source: 'custom', note: '由 Config.customSkillDirs 决定' })
      rows.push({ group: 'bundled', source: 'bundled', note: '随包分发 / 运行时注册' })
      return { projectRoot: standard.projectRoot, rows }
    }

    // ── 规范根目录**直读**（对上游 provider 的补充） ─────────────────────────
    //
    // 为什么需要这一路：`@deepseek-ai/dsh-skill-filesystem` 的 `list()` 是
    //
    //     for (const root of roots) for (const skill of await discoverRoot(root, ...)) ...
    //
    // ——**整个循环没有 per-root 的 try/catch**。于是任何一个根目录抛错，这个提供方的
    // **全部**候选一起被 `dsh-skill` 丢掉（它只打一行 warn 并把观测标记为 incomplete）。
    // 本机就是这种情况：profile 里 `customSkillDirs` 指向 `app.asar` 内的
    // `<agent-preset>/skills`，`ctx.fs.listDir` 在 asar 路径上抛
    // `FsError: cannot list …: Cannot mix BigInt and other types`，于是项目与用户目录里
    // **明明存在**的 skill 也一起消失——实测表现为「选了项目还是 0 个，只有随包内置」。
    //
    // 上游那一行修不修不归本插件管，但页面不该因此变成瞎的。所以这里补一条只读直读：
    // 用官方同一套根目录规则自己走一遍 `ctx.fs`，**每个根、每个文件各自兜底**
    // （上游缺的正是这层隔离），把结果并进目录快照。
    //
    // 并法是「**注册表优先**」：同名条目一律以 `ctx.skills` 的为准。提供方健康时这一路
    // 是**纯空操作**——所有名字都已存在，一行都不会多出来。

    /**
     * `ctx.fs.resolve()` + `listDir()`。失败一律返回 undefined。
     *
     * 一个根读不了（沙箱拒绝、路径在 asar 里、根不存在……）不该拖垮整页，
     * 这是与上游 `discoverRoot` 最关键的差别。
     */
    const listDirViaFs = async (path: unknown, signal: AbortSignal): Promise<readonly FsEntry[] | undefined> => {
      const fsService = service<FsService>('fs')
      if (typeof path !== 'string' || path === '') return undefined
      if (typeof fsService?.resolve !== 'function' || typeof fsService?.listDir !== 'function') return undefined
      try {
        const target = await fsService.resolve(path, { signal })
        const entries = await fsService.listDir(target, signal)
        return Array.isArray(entries) ? entries : undefined
      } catch {
        return undefined
      }
    }

    /** `ctx.fs` 读一份 UTF-8 文本；不是普通文件、或读不到，都返回 undefined。 */
    const readTextViaFs = async (path: unknown, signal: AbortSignal): Promise<string | undefined> => {
      const fsService = service<FsService>('fs')
      if (typeof path !== 'string' || path === '') return undefined
      if (typeof fsService?.resolve !== 'function' || typeof fsService?.readText !== 'function') return undefined
      try {
        const target = await fsService.resolve(path, { signal })
        if (typeof fsService.stat === 'function') {
          const info = await fsService.stat(target, signal)
          if (info !== undefined && info?.type !== 'file') return undefined
        }
        const text = await fsService.readText(target, signal)
        return typeof text === 'string' ? text : undefined
      } catch {
        return undefined
      }
    }

    /** 去掉未加引号的 YAML 标量尾部的注释（`#` 前必须有空白，`a#b` 不是注释）。 */
    const stripYamlComment = (value: string): string => {
      const matched = /(^|\s)#/.exec(value)
      if (matched === null || matched.index === undefined) return value
      return value.slice(0, matched.index).trimEnd()
    }

    /** YAML 标量 → JS 字符串：认单引号、双引号，其余按裸标量（去注释、trim）。 */
    const yamlScalar = (value: string): string => {
      const trimmed = value.trim()
      if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed
          .slice(1, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
      }
      if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/''/g, "'")
      }
      return stripYamlComment(trimmed)
    }

    /**
     * 极简 frontmatter 解析：只认 `key: value`、缩进块标量（`|` / `>`）与引号标量。
     *
     * 官方用的是 `yaml` 包，而宿主半边**零 import**（裸模块说明符都在 app.asar 里，
     * 从磁盘路径解析不到）——所以这里只实现本页真正要用的那个子集。
     * **宁可漏也不要编**：闭合的 `---` 找不到就返回 undefined，调用方据此跳过该文件，
     * 与官方「frontmatter 不合法就忽略这个文件」的语义一致。
     * @returns 键值映射，或 undefined（不是 frontmatter / 没有闭合标记）。
     */
    const parseFrontmatter = (raw: string): Record<string, unknown> | undefined => {
      const firstLineEnd = raw.indexOf('\n')
      if (firstLineEnd < 0) return undefined
      if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
      const lines: string[] = []
      let lineStart = firstLineEnd + 1
      let closed = false
      while (lineStart <= raw.length) {
        const nextNewline = raw.indexOf('\n', lineStart)
        const lineEnd = nextNewline < 0 ? raw.length : nextNewline
        const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
        if (line === '---') {
          closed = true
          break
        }
        lines.push(line)
        if (nextNewline < 0) break
        lineStart = nextNewline + 1
      }
      if (!closed) return undefined

      const data: Record<string, unknown> = {}
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        if (line === undefined) continue
        // 顶层键必须顶格；缩进行属于上一个键（或块标量），注释与空行直接跳过。
        if (line === '' || /^\s/.test(line) || line.trimStart().startsWith('#')) continue
        const colon = line.indexOf(':')
        if (colon <= 0) continue
        const key = line.slice(0, colon).trim()
        if (key === '') continue
        const rawValue = line.slice(colon + 1).trim()
        if (/^[|>][-+]?\d*$/.test(rawValue)) {
          // 块标量：吃掉后续所有缩进行（含空行），按第一行的缩进量整体去缩。
          const block: string[] = []
          let cursor = index + 1
          while (cursor < lines.length) {
            const candidate = lines[cursor]
            if (candidate === undefined) break
            if (candidate.trim() !== '' && !/^\s/.test(candidate)) break
            block.push(candidate)
            cursor += 1
          }
          while (block.length > 0 && (block.at(-1) ?? '').trim() === '') block.pop()
          let indent: number | undefined
          for (const item of block) {
            if (item.trim() === '') continue
            const width = item.length - item.trimStart().length
            if (indent === undefined || width < indent) indent = width
          }
          const body = block.map((item) => (indent === undefined ? item : item.slice(indent)))
          data[key] = rawValue.startsWith('>') ? body.join(' ').trim() : body.join('\n').trim()
          index = cursor - 1
          continue
        }
        data[key] = yamlScalar(rawValue)
      }
      return data
    }

    /**
     * 官方 `frontmatterBoolean` 的等价物：布尔、`0`/`1`、`true/false/yes/no/on/off`。
     * 其它取值一律判为**不合法**（官方会抛错并忽略整个文件，这里同样不列这一行）。
     * @returns `{ ok, value }`——官方语义下 `ok:false` 等于「这个 skill 不合法」。
     */
    const frontmatterBoolean = (
      data: Record<string, unknown>,
      key: string,
    ): { ok: boolean; value: boolean | undefined } => {
      if (!Object.hasOwn(data, key)) return { ok: true, value: undefined }
      const value = data[key]
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === '1') return { ok: true, value: true }
      if (value === '0') return { ok: true, value: false }
      if (typeof value === 'string') {
        const lowered = value.toLowerCase()
        if (lowered === 'true' || lowered === 'yes' || lowered === 'on') return { ok: true, value: true }
        if (lowered === 'false' || lowered === 'no' || lowered === 'off') return { ok: true, value: false }
      }
      return { ok: false, value: undefined }
    }

    /**
     * 把一份 `SKILL.md` 的原文解析成一行候选。
     *
     * 硬性要求逐条对齐官方 `parseSkillFile`：frontmatter 存在、`name` 是 kebab-case、
     * `description` 非空、旧的调用策略键名一律拒绝、调用策略取值合法。
     * **少列一个只是少列，多列一个才是错**——所以任何一条不满足都返回 undefined。
     * @param raw - 文件原文。
     * @param locator - `{ path, directory }`。
     * @param root - 所属根目录（提供 `source`）。
     */
    const parseSkillFile = (raw: string, locator: Locator, root: RootSpec): ScannedSkill | undefined => {
      const data = parseFrontmatter(raw)
      if (data === undefined) return undefined
      const name = typeof data.name === 'string' ? data.name.trim() : ''
      if (name === '' || !SKILL_NAME.test(name)) return undefined
      const description = typeof data.description === 'string' ? data.description.trim() : ''
      if (description === '') return undefined
      // 官方 `rejectLegacyInvocationKey`：旧键名直接判该文件不合法。
      if (Object.hasOwn(data, 'disableModelInvocation') || Object.hasOwn(data, 'modelInvocable')) return undefined
      if (Object.hasOwn(data, 'userInvocable')) return undefined
      const disableModel = frontmatterBoolean(data, 'disable-model-invocation')
      const userInvocable = frontmatterBoolean(data, 'user-invocable')
      if (!disableModel.ok || !userInvocable.ok) return undefined
      const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : ''
      return {
        name,
        description,
        ...(whenToUse === '' ? {} : { whenToUse }),
        invocation: { modelInvocable: disableModel.value !== true, userInvocable: userInvocable.value !== false },
        source: root.source,
        provider: 'filesystem',
        resourceBase: { kind: 'directory', path: locator.directory },
        path: locator.path,
      }
    }

    /** 一个根目录里的全部候选；条目级失败只丢那一条。 */
    const scanRoot = async (spec: RootSpec, signal: AbortSignal): Promise<ScannedSkill[]> => {
      const entries = await listDirViaFs(spec.path, signal)
      if (entries === undefined) return []
      const found: ScannedSkill[] = []
      for (const entry of entries.slice(0, SCAN_ENTRY_LIMIT)) {
        const entryName = typeof entry?.name === 'string' ? entry.name : ''
        if (entryName === '') continue
        if (spec.skipSystem === true && entryName === '.system') continue
        const base = spec.path ?? ''
        const display = typeof entry?.target?.displayPath === 'string' ? entry.target.displayPath : joinPath(base, entryName)
        const locator: Locator | undefined =
          entry.type === 'directory'
            ? { path: joinPath(display, 'SKILL.md'), directory: display }
            : entry.type === 'file' && entryName.endsWith('.md')
              ? { path: display, directory: base }
              : undefined
        if (locator === undefined) continue
        const raw = await readTextViaFs(locator.path, signal)
        if (raw === undefined) continue
        const parsed = parseSkillFile(raw.slice(0, SCAN_READ_LIMIT), locator, spec)
        if (parsed !== undefined) found.push(parsed)
      }
      found.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return found
    }

    /** 直读四个规范根目录，拼成候选数组（根的顺序 × 根内名字序）。 */
    const scanRoots = async (standard: StandardRoots, signal: AbortSignal): Promise<ScannedSkill[]> => {
      const out: ScannedSkill[] = []
      for (const spec of standard.specs) {
        for (const skill of await scanRoot(spec, signal)) out.push(skill)
      }
      return out
    }

    // ── 写入面：启用 / 关闭一个 skill ─────────────────────────────────────────
    //
    // 这个开关的语义**完全是官方的**：`dsh-skill-filesystem` 的 frontmatter 支持
    // `disable-model-invocation` 与 `user-invocable` 两个键（README「Skill format」），
    // 前者把 skill 从模型目录与加载器里拿走，后者把人手输入 `/名字` 的入口拿走。
    // 所以本插件不需要发明状态：读它们的当前值当开关状态，写它们当开关动作。
    //
    // 生效不需要重启：provider 自己 watch 每个根，`SKILL.md` 一改就 invalidate，
    // 模型下一步拿到的是替换后的目录。

    /**
     * 只改调用策略两行的重写器。
     *
     * 逐字节重建头部、正文原样拼回：**绝不整文件重排**（用户的 frontmatter 可能用了
     * 块标量、引号、注释，重排一次就把它们写没了）。
     * @param raw - 当前文件全文。
     * @param enabled - true = 删掉两个键（官方默认两者皆允许）；false = 写入停用取值。
     * @returns 新全文。内容没变时与 `raw` **逐字节相同**（调用方据此判"无变化"）。
     */
    const rewriteInvocation = (raw: string, enabled: boolean): string => {
      const eol = raw.includes('\r\n') ? '\r\n' : '\n'
      const firstLineEnd = raw.indexOf('\n')
      if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
        throw new Error('这个 skill 文件没有 frontmatter，改不了停用开关')
      }
      let cursor = firstLineEnd + 1
      let blockEnd = -1
      while (cursor <= raw.length) {
        const nextNewline = raw.indexOf('\n', cursor)
        const lineEnd = nextNewline < 0 ? raw.length : nextNewline
        if (raw.slice(cursor, lineEnd).replace(/\r$/, '') === '---') {
          blockEnd = cursor
          break
        }
        if (nextNewline < 0) break
        cursor = nextNewline + 1
      }
      if (blockEnd < 0) throw new Error('这个 skill 文件的 frontmatter 没有闭合的 --- 行，改不了停用开关')

      const lines = raw.slice(firstLineEnd + 1, blockEnd).split(eol)
      // 片段总是以换行结尾，split 会多出一个空串——去掉它才是真正的行列表。
      if (lines.at(-1) === '') lines.pop()
      const kept = lines.filter((line) => !INVOCATION_KEY_LINE.test(line))
      if (!enabled) {
        kept.push('disable-model-invocation: true')
        kept.push('user-invocable: false')
      }
      const head = raw.slice(0, firstLineEnd + 1)
      const body = kept.length === 0 ? '' : `${kept.join(eol)}${eol}`
      return `${head}${body}${raw.slice(blockEnd)}`
    }

    /**
     * 打开一份文件准备写：`resolve` + `stat`（拿版本）+ `readText`。
     *
     * 版本是必须的：写入要用 `replaceIfVersion` 护栏，拿不到版本就说明这个后端不提供
     * 版本号，那就**不写**（宁可报错，也不做无护栏的覆盖）。
     * @returns 三件套，或 undefined（服务缺失 / 不是普通文件 / 没有版本 / 读不到）。
     */
    const openForWrite = async (path: string, signal: AbortSignal): Promise<WritableFile | undefined> => {
      const fsService = service<FsService>('fs')
      if (typeof fsService?.resolve !== 'function') return undefined
      if (typeof fsService.stat !== 'function' || typeof fsService.readText !== 'function') return undefined
      if (typeof fsService.writeText !== 'function') return undefined
      try {
        const target = await fsService.resolve(path, { signal })
        const info = await fsService.stat(target, signal)
        if (info === undefined || info.type !== 'file') return undefined
        const version = typeof info.version === 'string' ? info.version : undefined
        if (version === undefined) return undefined
        const text = await fsService.readText(target, signal)
        if (typeof text !== 'string') return undefined
        return { target, text, version }
      } catch {
        return undefined
      }
    }

    /**
     * 写入用的 per-call 沙箱策略。
     *
     * **为什么必须显式给**：`writeText` 的第 5 个参数省略时，`fs-sandbox` 走
     * agentless 兜底 → 部署默认模式（本机 `workspace-write`）→ 工作区之外的
     * `~/.dsh/skills`、`<project>/.agents/skills` 一律被拒。实测原文：
     *
     *     cannot write "C:\Users\admin\.dsh\skills\to-tickets\SKILL.md":
     *     file access denied under workspace-write mode
     *
     * 也就是：**不显式给，这个开关对绝大多数 skill 根本用不了**。
     *
     * **为什么不抄会话当前的 mode**：这个开关是**设置动作**（用户在设置页点的），
     * 不是模型在会话里改文件——同一页上换模型、开关插件也都不受会话文件沙箱约束。
     * 所以这里显式声明 `danger-full-access`，把"这是宿主代表用户执行的设置写入"
     * 写进调用本身，而不是让后端按模型的沙箱去猜。
     *
     * 暴露面很小：目标路径永远由宿主自己按四个规范根算出来（A36/B114 钉住），
     * 客户端连路径都给不了；写的内容也只有那两行 frontmatter。
     * @returns 策略，或 undefined（没有 sandboxPolicy 服务时就交给后端默认——那是裸后端，
     *   不做任何围栏，写就是了）。
     */
    const writePolicy = (): SandboxExecutionPolicy | undefined => {
      const policy = service<SandboxPolicyService>('sandboxPolicy')
      if (typeof policy?.resolve !== 'function') return undefined
      try {
        const base = policy.resolve()
        if (base === undefined || typeof base.workspaceRoot !== 'string') return undefined
        return { mode: 'danger-full-access', workspaceRoot: base.workspaceRoot }
      } catch {
        return undefined
      }
    }

    /** 带版本护栏地写回一份文件。失败一律带着原因抛出去，绝不静默。 */
    const writeFileGuarded = async (file: WritableFile, next: string, signal: AbortSignal): Promise<void> => {
      const fsService = service<FsService>('fs')
      if (typeof fsService?.writeText !== 'function') throw new Error('宿主没有提供可写的文件系统服务')
      await fsService.writeText(
        file.target,
        next,
        { kind: 'replaceIfVersion', version: file.version },
        signal,
        writePolicy(),
      )
    }

    /**
     * 开关一个 skill（写它的 `SKILL.md`）。
     *
     * 定位只用**宿主自己算出来的**规范根（`scanRoot`）——客户端只能给 `name`，
     * 给不了路径。找不到时用注册表快照说明**为什么**不可写（随包 / 配置目录 / 刚被删），
     * 而不是甩一句"失败"。
     * @param options - 查询参数 + `name`。
     * @param enabled - true = 启用（删两个键）；false = 停用（写两个键）。
     * @param signal - 取消信号。
     */
    const setSkillEnabled = (options: SetEnabledOptions, enabled: boolean, signal: AbortSignal): Promise<SetEnabledResult> =>
      withView(options, signal, async (view) => {
        const name = String(options.name ?? '')
        if (name === '') throw new Error('缺少 skill 名字')
        const standard = await standardRoots(view.cwd)
        let match: ScannedSkill | undefined
        for (const spec of standard.specs) {
          if (!WRITABLE_SOURCES.includes(spec.source)) continue
          match = (await scanRoot(spec, signal)).find((row) => row.name === name)
          if (match !== undefined) break
        }
        if (match === undefined) {
          // 不可写的原因要分开说：随包/运行时没有文件；配置目录定位不到；其余是真的没了。
          const snapshot = await view.registry.snapshot({ cwd: view.cwd, scope: view.scope, signal })
          const known = (Array.isArray(snapshot?.skills) ? snapshot.skills : []).find((row) => String(row?.name ?? '') === name)
          if (known === undefined) {
            throw new Error(`当前视图里找不到 skill "${name}"；它可能刚被改名或删除，请刷新后重试`)
          }
          const source = typeof known.source === 'string' ? known.source : 'unknown'
          if (source === 'custom') {
            throw new Error(`「${name}」在 Config.customSkillDirs 指定的目录里，本页定位不到它的文件，改不了开关`)
          }
          throw new Error(`「${name}」是随包内置（或运行时注册）的 skill，没有可改写的文件`)
        }

        const file = await openForWrite(match.path, signal)
        if (file === undefined) {
          throw new Error(`读不到「${name}」的 skill 文件：它可能被移动了，或当前文件系统不让改写`)
        }
        const next = rewriteInvocation(file.text, enabled)
        // 逐字节比对：开关本来就是这个状态时**不写**（写一次就多一次 mtime 变动，
        // 也会白白触发 provider 的失效重扫）。
        if (next === file.text) return { name, path: match.path, enabled, changed: false }
        try {
          await writeFileGuarded(file, next, signal)
        } catch (error) {
          throw new Error(`写入「${name}」失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return { name, path: match.path, enabled, changed: true }
      })

    /**
     * 解析「一次读取」所需的 `{ registry, scope, cwd, resolvedBy, presetId }`。
     *
     * 三条路径，按保真度从高到低：
     *
     *  1. `sessionId` 命中**活 Agent**（最高保真）：`scope` 直接就是那个 Agent
     *     （官方 `SessionSkillCatalog` 也是这么传的），注册表取该 preset 组内的
     *     `serviceFor(agent, 'skills')`。
     *  2. 指定 / session 记录的 / 默认 preset 的**冷读租约**：`acquireScope(presetId)`
     *     → 用它的 `key`，读完必须释放。这条路覆盖「session 不活」的情况。
     *  3. 都不行：退化成**全局 layer 读取**（`scope: undefined`）。这条路径在本机
     *     会得到空表，但它是诚实的降级，`resolvedBy` 会如实说明，UI 据此提示用户。
     *
     * 无论走哪条路，`cwd` 都优先取 session header 的权威值（见 `observeSession`）。
     * 返回值里的 `lease` 与 `observation` 都由调用方负责释放（见 `withView`）。
     * @param options - `{ sessionId, preset, cwd }`，全部可选。
     * @param signal - 取消信号。
     */
    const resolveView = async (options: QueryOptions, signal: AbortSignal): Promise<ResolvedView> => {
      const agents = service<AgentsService>('agents')
      const presets = service<AgentPresetsService>('agentPresets')
      const sessionId =
        typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
      // 先问 session 要**权威**的 cwd / 它记录下来的 preset。
      // 这是唯一可靠的 cwd 来源：宿主没有「当前工作区」概念（见 fallbackCwd 注释）。
      const observation =
        sessionId === undefined ? undefined : ((await observeSession(sessionId, signal)) as SessionObservation | undefined)
      const header = observation?.header
      const recordedPreset =
        typeof header?.agentPreset === 'string' && header.agentPreset !== ''
          ? header.agentPreset
          : typeof observation?.projections?.values?.agentPreset === 'string'
            ? observation.projections.values.agentPreset
            : undefined
      // 优先级：调用方显式指定 > session header > 工作区兜底。
      const cwd =
        options.cwd ??
        (typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined) ??
        fallbackCwd()
      const preset = options.preset ?? recordedPreset

      const live = sessionId === undefined ? undefined : agents?.get?.(sessionId)

      if (live !== undefined) {
        const scoped = presets?.serviceFor?.(live, 'skills')
        return {
          registry: scoped ?? scope.skills,
          scope: live,
          cwd,
          presetId: safePresetOf(presets, live) ?? preset,
          resolvedBy: 'session-agent',
          lease: undefined,
          observation,
        }
      }

      if (presets !== undefined) {
        const presetId = preset ?? (await defaultPresetId())
        try {
          const lease = await presets.acquireScope(presetId)
          if (lease !== undefined && lease?.key !== undefined) {
            return {
              registry: scope.skills,
              scope: lease.key,
              cwd,
              presetId,
              resolvedBy: 'preset-lease',
              lease,
              observation,
            }
          }
        } catch {
          // 落到全局读取。
        }
      }

      return {
        registry: scope.skills,
        scope: undefined,
        cwd,
        presetId: undefined,
        resolvedBy: 'global-layer',
        lease: undefined,
        observation,
      }
    }

    /**
     * 跑一次带租约生命周期的读取。
     *
     * 两种资源都要在读取期间保持有效、读完释放：
     *  - `acquireScope()` 的返回值是 **revision 租约**：拖着不释放会把 preset 的一个
     *    revision 一直钉住；
     *  - `observeSession()` 的返回值是 **caller-owned observation 租约**（`Disposable`），
     *    官方同样是读完即放。
     * 顺序：先放 observation 再放 scope 租约（scope 是「读的视图」，observation 是「读的输入」，
     * 释放顺序对只读语义没有影响，这里保持与获取顺序相反的栈式释放）。
     * @param options - 见 `resolveView`。
     * @param signal - 取消信号，透传给 `observeSession`。
     * @param operation - 收到解析结果，返回本次读的结果。
     */
    const withView = async <T>(
      options: QueryOptions,
      signal: AbortSignal,
      operation: (view: ResolvedView) => Promise<T>,
    ): Promise<T> => {
      const view = await resolveView(options, signal)
      try {
        return await operation(view)
      } finally {
        await releaseLease(view.observation)
        await releaseLease(view.lease)
      }
    }

    /** 把 `SkillSummary` 压成客户端要渲染的形状（含分组，见 `GROUPS`）。 */
    const toRow = (skill: SkillSummary, index: number): SkillRow => {
      const source = typeof skill?.source === 'string' ? skill.source : 'unknown'
      return {
        index,
        name: String(skill?.name ?? ''),
        description: String(skill?.description ?? ''),
        whenToUse: typeof skill?.whenToUse === 'string' ? skill.whenToUse : undefined,
        path: typeof skill?.path === 'string' ? skill.path : undefined,
        source,
        group: GROUPS[source] ?? 'other',
        provider: typeof skill?.provider === 'string' ? skill.provider : undefined,
        modelInvocable: skill?.invocation?.modelInvocable !== false,
        userInvocable: skill?.invocation?.userInvocable !== false,
        // 能不能点那个开关：只有我们自己算得出路径、也写得进去的来源才行。
        writable: WRITABLE_SOURCES.includes(source),
        resourceKind: typeof skill?.resourceBase?.kind === 'string' ? skill.resourceBase.kind : undefined,
      }
    }

    /**
     * 取一份目录快照。
     *
     * 两个来源合并：
     *  1. `ctx.skills.snapshot()` —— 注册表（含所有提供方），**权威**；
     *  2. 规范根目录直读（`scanRoots`）—— 只补注册表**没有**的名字。
     *
     * 为什么要有第 2 条：上游 provider 一个坏根目录就会把项目 skill 一起丢掉
     * （详见 `scanRoots` 上面的注释）。合并规则是「注册表优先」，所以提供方健康时
     * 直读是纯空操作——不会多出一行，也不会改变任何既有行为。
     *
     * 用 `snapshot()` 而不是 `list()`：`complete` 仍然如实透传（它是「这次发现是否完整」
     * 的唯一权威信号，留给后续消费者；本页 UI 已不再渲染诊断）。
     * @param options - 查询参数。
     * @param signal - 取消信号。
     */
    const readCatalog = (options: QueryOptions, signal: AbortSignal): Promise<CatalogPayload> =>
      withView(options, signal, async (view) => {
        // 项目根要先定下来：直读与根目录探测都要用它，只走一次 `.git` 祖先链。
        const standard = await standardRoots(view.cwd)
        // 三件事互不依赖：注册表读取、直读根目录、存在性探测。并发跑，别把 I/O 串起来。
        const [snapshot, scanned] = await Promise.all([
          view.registry.snapshot({ cwd: view.cwd, scope: view.scope, signal }) as Promise<SkillSnapshot | undefined>,
          scanRoots(standard, signal),
        ])
        const rows = (Array.isArray(snapshot?.skills) ? snapshot.skills : []).map(toRow)
        // 注册表优先：同名一律以官方那一行为准，直读只补它没有的名字。
        const seen = new Set(rows.map((row) => row.name))
        for (const skill of scanned) {
          if (seen.has(skill.name)) continue
          seen.add(skill.name)
          rows.push(toRow(skill, rows.length))
        }
        // 官方按名字码点排序；合并后重排一次，顺序才不会依赖两个来源谁先到。
        rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        for (const [index, row] of rows.entries()) row.index = index

        const counts: Record<string, number> = {}
        for (const group of GROUP_ORDER) counts[group] = 0
        for (const row of rows) counts[row.group] = (counts[row.group] ?? 0) + 1
        // 按提供方汇总：留给后续诊断消费者（本页 UI 不渲染）。
        const providers: Record<string, number> = {}
        for (const row of rows) {
          const key = row.provider ?? '(未知提供方)'
          providers[key] = (providers[key] ?? 0) + 1
        }
        // 根目录探测只是尽力而为：它失败绝不能把整次目录读取带下去。
        // 注意这层 catch 是**兜底**（`pathExists` 自己已经吞掉 fs 异常），
        // 由 B68 守住「探测出问题时 roots 仍有 6 条、存在性降级为未判定」。
        let roots: { projectRoot: string | undefined; rows: RootRow[] } = { projectRoot: standard.projectRoot, rows: [] }
        try {
          roots = await probeRoots(standard)
        } catch {
          // 保持空清单，`emptyNote` 会退回「没有发现 skill」。
        }
        return {
          skills: rows,
          counts,
          providers,
          roots: roots.rows,
          projectRoot: roots.projectRoot,
          complete: snapshot?.complete !== false,
          resolvedBy: view.resolvedBy,
          presetId: view.presetId,
          cwd: view.cwd,
        }
      })

    /**
     * 读一份 skill 的正文（`SKILL.md` 内容）。
     *
     * 仍然走同一次作用域解析——因为「改名后取到的是不是同一个 skill」这件事
     * 必须和列表用**同一个视图**判断，否则会出现「列表里有、点开说没有」。
     *
     * 注册表给不出来时（典型：上游 provider 被一个坏根目录整条拖死，列表是直读补的）
     * 就**按同一套根目录规则重新找到那个文件**再读。注意：绝不接受客户端传来的路径——
     * 唯一可信的来源是宿主自己算出来的规范根。
     * @param options - 查询参数 + `name`。
     * @param signal - 取消信号。
     */
    const readSkill = (options: ReadOptions, signal: AbortSignal): Promise<SkillBody> =>
      withView(options, signal, async (view) => {
        const name = String(options.name ?? '')
        const found: SkillDetail | undefined = await view.registry.get(name, {
          cwd: view.cwd,
          scope: view.scope,
          signal,
        })
        if (found !== undefined) {
          const content = String(found.content ?? '')
          return {
            name: String(found.name ?? ''),
            path: typeof found.path === 'string' ? found.path : undefined,
            content: content.slice(0, CONTENT_LIMIT),
            truncated: content.length > CONTENT_LIMIT,
            contentLength: content.length,
          }
        }

        // 注册表不认识这个名字：走直读。**重新按同一套根目录规则解析**，不信任调用方给的路径。
        const standard = await standardRoots(view.cwd)
        for (const spec of standard.specs) {
          const match = (await scanRoot(spec, signal)).find((skill) => skill.name === name)
          if (match === undefined) continue
          const raw = await readTextViaFs(match.path, signal)
          if (raw === undefined) continue
          return {
            name,
            path: match.path,
            content: raw.slice(0, CONTENT_LIMIT),
            truncated: raw.length > CONTENT_LIMIT,
            contentLength: raw.length,
          }
        }

        throw new Error(`当前视图里找不到 skill "${name}"；它可能刚被改名或删除，请刷新后重试`)
      })

    const respond = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })

    const handler = async (request: Request): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
      try {
        const url = new URL(request.url)
        const options: QueryOptions = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          preset: url.searchParams.get('preset') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
        }

        if (request.method === 'GET') {
          const data = await readCatalog(options, controller.signal)
          return respond(200, {
            ok: true,
            data: { ...data, route: ROUTE, capabilities: ['snapshot', 'read', 'set-enabled'] },
          })
        }

        // 请求体是客户端自己发的 JSON，但**当作不可信输入**收窄：非字符串一律退回 query 里的值。
        // 注意 `path` 一概不收——目标文件只能由宿主自己算（见 `setSkillEnabled`）。
        const payload = (await request.json()) as
          | { op?: unknown; name?: unknown; enabled?: unknown; sessionId?: unknown; cwd?: unknown }
          | null
          | undefined
        switch (payload?.op) {
          case 'read': {
            const data = await readSkill(
              {
                ...options,
                name: payload.name,
                sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : options.sessionId,
                cwd: typeof payload.cwd === 'string' ? payload.cwd : options.cwd,
              },
              controller.signal,
            )
            return respond(200, { ok: true, data })
          }
          case 'set-enabled': {
            const data = await setSkillEnabled(
              {
                ...options,
                name: payload.name,
                sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : options.sessionId,
                cwd: typeof payload.cwd === 'string' ? payload.cwd : options.cwd,
              },
              payload.enabled !== false,
              controller.signal,
            )
            return respond(200, { ok: true, data })
          }
          default:
            return respond(400, { ok: false, error: `未知操作：${String(payload?.op)}` })
        }
      } catch (error) {
        // 只读失败一律原样回原因：没有写入，所以不存在「回滚」问题。
        return respond(409, { ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        clearTimeout(timer)
      }
    }

    // `connection.fetch` 是 caller-context 求值的 getter：register() 会把 disposer 挂到
    // 我们这个 scope 的 effect 上，随插件卸载自动摘除路由（不需要自己 ctx.effect 包一层）。
    // 路由必须形如 `/api/<名字>`，它挂在 webServer 的 `/api` prefix 之下，
    // 因此自动获得 Host/Origin 围栏与浏览器鉴权，客户端同源 fetch 即可，不需要自建 token。
    scope.connection.fetch.register({
      path: ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: handler,
    })
  })
}

/**
 * 读一个活 Agent 当前绑定的 preset id（只用于展示，失败不影响读取）。
 * @param presets - `agentPresets` 服务，可能 undefined。
 * @param agent - 活 Agent。
 */
function safePresetOf(presets: AgentPresetsService | undefined, agent: unknown): string | undefined {
  try {
    const id = presets?.composedPreset?.((agent as { ctx?: unknown } | undefined)?.ctx)
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}
