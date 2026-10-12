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
 * ## 零 import
 *
 * 本文件由 Loader 以 `file:///...` 绝对路径加载，裸模块说明符（`@deepseek-ai/cordis`、
 * `node:path` 等）都藏在 app.asar 里，从磁盘路径解析不到。因此只用注入进来的 Service
 * 与全局 `URL` / `Response`。这与 `dsh-mcp-manager` 同一纪律。
 *
 * ## 只读
 *
 * 第一阶段**不含任何写入路径**：没有 `ctx.configEditor.edit()`、没有 `ctx.loader.*`、
 * 不碰 `~/.dsh/profiles/**`。GET 是纯读；POST 只有 `op: "read"`（读一份 skill 正文）。
 */

/** 本插件注册的浏览器路由。必须以 `/api/` 开头（`connection.fetch` 的校验）。 */
const ROUTE = '/api/skill-manager'

/** 单次 skill 正文读取的上限，避免把超大文件整段塞进响应。 */
const CONTENT_LIMIT = 200_000

/** 提供方失败原文的最大长度：够看清"哪个根目录/哪个路径"，又不会把整段栈塞进快照。 */
const FAILURE_MESSAGE_LIMIT = 600

/** 一次目录解析的预算：watcher 失效后重新扫描根目录是异步的，给足但要有界。 */
const RESOLVE_TIMEOUT_MS = 8000

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
const GROUPS = {
  'project-dsh': 'project',
  'project-agents': 'project',
  'user-dsh': 'global',
  'user-agents': 'global',
  custom: 'custom',
  bundled: 'bundled',
  runtime: 'bundled',
}

/** 分组顺序 = 界面上的分节顺序。 */
const GROUP_ORDER = ['project', 'global', 'custom', 'bundled', 'other']

export const name = 'dsh-skill-manager'
/** 依赖在 apply 内用 ctx.inject 声明，便于缺失服务时优雅降级而不是抛错。 */
export const inject = []

/**
 * 宿主插件体。
 * @param ctx - 宿主根上下文。
 */
export function apply(ctx) {
  // `connection` 提供浏览器路由；`skills` 是注册表本体。两者缺一，本插件无事可做，
  // 所以放在 ctx.inject 里——缺失时插件保持 inactive，而不是激活后抛错。
  ctx.inject(['connection', 'skills'], (scope) => {
    /**
     * 最近一次读取里**被跳过的提供方**及其原文。
     *
     * 为什么必须自己收：`@deepseek-ai/dsh-skill` 在某个提供方的 `list()` 抛错时会打
     *
     *     ctx.logger.warn(`skill provider "${name}" skipped: ${errorMessage(error)}`)
     *     // dsh-skill/lib/index.js:354
     *
     * 然后把这个提供方的候选**全部丢掉**、并把这次观测标记为 incomplete。
     * 而宿主内置的日志缓冲只留 error 级（warn 进不去），stdout 在桌面版又被 pipe 到一个
     * 没有控制台的父进程——不主动收就等于原因不可见。这与 `dsh-mcp-manager` 收
     * `mcp-client(...)` 失败原文是同一套做法。
     *
     * 实测价值：`@deepseek-ai/dsh-skill-filesystem` 的 `list()` 是
     *
     *     for (const root of roots) for (const skill of await discoverRoot(root, ...)) ...
     *
     * ——**整个循环没有 per-root 的 try/catch**，所以任何一个根目录抛错都会把
     * 已经收到的候选一起丢掉。页面上表现为「项目/全局/自定义全是 0，但 `完整性 未完成`，
     * 而提供方列表里根本没有 filesystem」。没有这行原文，就只能猜是哪个根目录。
     */
    const providerFailures = new Map()
    /** `skill provider "<name>" skipped: <detail>` */
    const PROVIDER_SKIPPED = /^skill provider "([^"]+)" skipped:\s*([\s\S]*)$/

    const captureLog = (message) => {
      const line = message?.args?.[0]
      if (typeof line !== 'string') return
      const matched = PROVIDER_SKIPPED.exec(line)
      if (matched === null) return
      providerFailures.set(matched[1], {
        message: matched[2].trim().slice(0, FAILURE_MESSAGE_LIMIT),
        level: message.type,
        at: typeof message.ts === 'number' ? message.ts : Date.now(),
      })
    }

    // `logger` 是 cordis 内置服务，不需要写进 inject；探测一次，让缺 logger 的替身优雅降级。
    // `levels.default = 3` 是显式把阈值拉到全收——内置 exporter 正因为没声明它而丢掉 warn。
    if (typeof scope.logger?.exporter === 'function') {
      scope.logger.exporter({ levels: { default: 3 }, export: captureLog })
    }

    /**
     * 读当前**默认** preset 的 id。
     *
     * 为什么要它：冷读（没有活 Agent）时必须有一个 preset 才能 `acquireScope()`，
     * 而「默认 preset」是 `resolve()` 不带参数时官方定义的语义。
     * 两条路都失败就返回 undefined，交给 `acquireScope(undefined)` 自己兜底。
     * @returns preset id，或 undefined。
     */
    const defaultPresetId = async () => {
      const presets = scope.get('agentPresets')
      if (presets === undefined) return undefined
      try {
        const preset = await presets.resolve()
        if (typeof preset?.id === 'string' && preset.id !== '') return preset.id
      } catch {
        // 落到 roster 这条路。
      }
      try {
        const roster = await presets.remoteExportList()
        const rows = Array.isArray(roster?.presets) ? roster.presets : []
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
    const fallbackCwd = () => {
      try {
        const workspaces = scope.get('workspaceRegistry')?.list?.()
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
    const observeSession = async (sessionId, signal) => {
      const sessionQuery = scope.get('sessionQuery')
      if (typeof sessionQuery?.observeSession !== 'function') return undefined
      try {
        return await sessionQuery.observeSession(sessionId, { signal })
      } catch {
        // session 不存在 / 读不出来：退化成「没有 session 信息」，而不是整页失败。
        return undefined
      }
    }

    /** 把 `AsyncDisposable` 租约释放掉；不同运行时能力不一，全部包在 try 里。 */
    const releaseLease = async (lease) => {
      if (lease === null || lease === undefined) return
      const asyncDispose = typeof Symbol === 'function' ? Symbol.asyncDispose : undefined
      const dispose = typeof Symbol === 'function' ? Symbol.dispose : undefined
      try {
        if (asyncDispose !== undefined && typeof lease[asyncDispose] === 'function') {
          await lease[asyncDispose]()
        } else if (dispose !== undefined && typeof lease[dispose] === 'function') {
          lease[dispose]()
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
    const joinPath = (base, ...parts) => {
      const sep = base.includes('\\') ? '\\' : '/'
      return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
    }

    /** 上一级目录；到根就返回自己。 */
    const parentPath = (value) => {
      const normalized = value.replace(/[\\/]+$/, '')
      const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
      if (cut < 0) return normalized
      if (cut === 0) return normalized.slice(0, 1)
      // 盘符根（`C:\`）后面已经没有了：返回盘符本身，别退化成 `C:`。
      if (/^[A-Za-z]:$/.test(normalized.slice(0, cut))) return `${normalized.slice(0, cut)}\\`
      return normalized.slice(0, cut)
    }

    /** home 目录：只用环境变量，不 import `node:os`（宿主半边零 import）。 */
    const homeDir = () => process.env.USERPROFILE ?? process.env.HOME ?? undefined

    /** @returns true=存在 / false=不存在 / undefined=无法判定（fs 缺失或沙箱拒绝）。 */
    const pathExists = async (path) => {
      if (typeof path !== 'string' || path === '') return undefined
      const fsService = scope.get('fs')
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
    const resolveProjectRoot = async (cwd) => {
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

    /** 规范根目录清单（项目 / 全局 / 自定义 / 随包内置），带存在性。 */
    const probeRoots = async (cwd) => {
      const projectRoot = await resolveProjectRoot(cwd)
      const home = homeDir()
      const dshHome = process.env.DSH_HOME ?? (home === undefined ? undefined : joinPath(home, '.dsh'))
      const agentsHome = process.env.DSH_AGENTS_HOME ?? (home === undefined ? undefined : joinPath(home, '.agents'))
      const specs = [
        ['project', 'project-dsh', projectRoot === undefined ? undefined : joinPath(projectRoot, '.dsh', 'skills')],
        ['project', 'project-agents', projectRoot === undefined ? undefined : joinPath(projectRoot, '.agents', 'skills')],
        ['global', 'user-dsh', dshHome === undefined ? undefined : joinPath(dshHome, 'skills')],
        ['global', 'user-agents', agentsHome === undefined ? undefined : joinPath(agentsHome, 'skills')],
      ]
      const rows = []
      for (const [group, source, path] of specs) {
        rows.push({ group, source, path, exists: await pathExists(path) })
      }
      rows.push({ group: 'custom', source: 'custom', note: '由 Config.customSkillDirs 决定' })
      rows.push({ group: 'bundled', source: 'bundled', note: '随包分发 / 运行时注册' })
      return { projectRoot, rows }
    }

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
    const resolveView = async (options, signal) => {
      const agents = scope.get('agents')
      const presets = scope.get('agentPresets')
      const sessionId =
        typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined
      // 先问 session 要**权威**的 cwd / 它记录下来的 preset。
      // 这是唯一可靠的 cwd 来源：宿主没有「当前工作区」概念（见 fallbackCwd 注释）。
      const observation = sessionId === undefined ? undefined : await observeSession(sessionId, signal)
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
    const withView = async (options, signal, operation) => {
      const view = await resolveView(options, signal)
      try {
        return await operation(view)
      } finally {
        await releaseLease(view.observation)
        await releaseLease(view.lease)
      }
    }

    /** 把 `SkillSummary` 压成客户端要渲染的形状（含分组，见 `GROUPS`）。 */
    const toRow = (skill, index) => {
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
        resourceKind: typeof skill?.resourceBase?.kind === 'string' ? skill.resourceBase.kind : undefined,
      }
    }

    /**
     * 取一份目录快照。
     *
     * 用 `snapshot()` 而不是 `list()`：只有 `snapshot()` 会额外告诉我们
     * **这次发现是否完整**（`complete`）。`complete === false` 意味着某个根目录
     * 扫描失败或还没扫完——此时列表**不能**当成「就是这样了」展示，UI 必须明说。
     * @param options - 查询参数。
     * @param signal - 取消信号。
     */
    const readCatalog = (options, signal) =>
      withView(options, signal, async (view) => {
        // 清空上一轮的失败记录：我们要报的是"**这次**读取里谁被跳过了"。
        // incomplete 的观测永远不会被缓存（上游保证），所以每次 incomplete 都会真的重跑
        // list()、也就一定会重新打出那行 warn——这个清空不会把原因抹掉。
        providerFailures.clear()
        const snapshot = await view.registry.snapshot({ cwd: view.cwd, scope: view.scope, signal })
        const skills = Array.isArray(snapshot?.skills) ? snapshot.skills : []
        const rows = skills.map(toRow)
        const counts = {}
        for (const group of GROUP_ORDER) counts[group] = 0
        for (const row of rows) counts[row.group] = (counts[row.group] ?? 0) + 1
        // 按提供方汇总：`complete === false` 时，这行是唯一能指向"是谁没交作业"的线索。
        const providers = {}
        for (const row of rows) {
          const key = row.provider ?? '(未知提供方)'
          providers[key] = (providers[key] ?? 0) + 1
        }
        // 根目录探测只是尽力而为：它失败绝不能把整次目录读取带下去。
        // 注意这层 catch 是**兜底**（`pathExists` 自己已经吞掉 fs 异常），
        // 由 B68 守住「探测出问题时 roots 仍有 6 条、存在性降级为未判定」。
        let roots = { projectRoot: undefined, rows: [] }
        try {
          roots = await probeRoots(view.cwd)
        } catch {
          // 保持空清单，前端会显示「未判定」。
        }
        return {
          skills: rows,
          counts,
          providers,
          // 谁被跳过了 + 原文。这是 `完整性 未完成` 唯一能落到具体原因上的出口。
          providerFailures: Object.fromEntries(providerFailures),
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
     * @param options - 查询参数 + `name`。
     * @param signal - 取消信号。
     */
    const readSkill = (options, signal) =>
      withView(options, signal, async (view) => {
        const found = await view.registry.get(String(options.name ?? ''), {
          cwd: view.cwd,
          scope: view.scope,
          signal,
        })
        if (found === undefined) {
          throw new Error(
            `当前视图里找不到 skill "${String(options.name ?? '')}"；它可能刚被改名或删除，请刷新后重试`,
          )
        }
        const content = String(found.content ?? '')
        return {
          name: String(found.name ?? ''),
          path: typeof found.path === 'string' ? found.path : undefined,
          content: content.slice(0, CONTENT_LIMIT),
          truncated: content.length > CONTENT_LIMIT,
          contentLength: content.length,
        }
      })

    const respond = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })

    const handler = async (request) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
      try {
        const url = new URL(request.url)
        const options = {
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          preset: url.searchParams.get('preset') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
        }

        if (request.method === 'GET') {
          const data = await readCatalog(options, controller.signal)
          return respond(200, {
            ok: true,
            data: { ...data, route: ROUTE, capabilities: ['snapshot', 'read'] },
          })
        }

        const payload = await request.json()
        switch (payload?.op) {
          case 'read': {
            const data = await readSkill(
              { ...options, name: payload.name, sessionId: payload.sessionId ?? options.sessionId, cwd: payload.cwd ?? options.cwd },
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
function safePresetOf(presets, agent) {
  try {
    const id = presets?.composedPreset?.(agent?.ctx)
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}
