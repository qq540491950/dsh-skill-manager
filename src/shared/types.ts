/**
 * 两个半边共用的**数据面契约**（只有类型，没有运行时值）。
 *
 * 为什么单独一份：宿主半边算出来的 payload 形状就是客户端半边要渲染的形状，
 * 两边各写一遍必然漂——而「列表里有、点开说没有」这类事故正是从漂开始的。
 * 因为这里全是 `import type`，esbuild 打包时整份文件会被擦掉，
 * **不会破坏宿主半边「产物零 import」的硬约束**（AGENTS 2.1）。
 */

/** 界面上的分组键。顺序即界面顺序（见宿主 `GROUP_ORDER`）。 */
export type GroupKey = 'project' | 'global' | 'custom' | 'bundled' | 'other'

/**
 * 官方 `SkillSource` 的取值 + 未知兜底。
 *
 * 与根目录的对应关系来自 `@deepseek-ai/dsh-skill-filesystem` 的 rank 表（README 第 4 节）。
 * `string` 兜底放在最后：注册表可能给出我们没见过的来源，那种行必须照实标成 `other`，
 * 而不是伪装成某一组。
 */
export type SkillSource =
  | 'project-dsh'
  | 'project-agents'
  | 'user-dsh'
  | 'user-agents'
  | 'custom'
  | 'bundled'
  | 'runtime'
  | 'unknown'

/**
 * 列表里的一行。
 *
 * 可选字段一律写成 `?: T | undefined`（不是 `?: T`）：`exactOptionalPropertyTypes` 下
 * 「显式赋 undefined」与「没有这个属性」是两件事，而宿主半边是**显式赋 undefined** 的，
 * 这样写才能如实表达它在线上 JSON 里会消失这件事。
 */
export interface SkillRow {
  index: number
  name: string
  description: string
  whenToUse?: string | undefined
  path?: string | undefined
  /** 原样透传官方 `source`（可能是我们没见过的值）。 */
  source: string
  group: GroupKey
  provider?: string | undefined
  modelInvocable: boolean
  userInvocable: boolean
  /**
   * 这一行的开关**能不能点**。
   *
   * 只有「项目 / 全局」四个规范根里的 skill 可写（宿主算得出路径、也写得进去）。
   * `custom`（位置由 Config 决定）、`bundled` / `runtime`（随包或运行时注册）都不可写——
   * 开关必须置灰，**点了没反应比没有开关更糟**。
   */
  writable: boolean
  resourceKind?: string | undefined
}

/**
 * 规范根目录的一行（探测结果）。
 *
 * `exists`：`true` 存在 / `false` 不存在 / `undefined` 无法判定。
 * **「未判定」不等于「不存在」**——把沙箱或能力问题说成"你没装"是误报（AGENTS 3.8）。
 * `note` 用于由配置决定的根（`custom` / `bundled`）：宿主读不到展开后的路径，就只说来源。
 */
export interface RootRow {
  group: GroupKey
  source: string
  path?: string | undefined
  exists?: boolean | undefined
  note?: string | undefined
}

/** GET 的 `data`（客户端渲染的全部依据）。 */
export interface CatalogPayload {
  skills: SkillRow[]
  /** 每个分组的条数（四个规范分组恒在，`other` 按需）。 */
  counts: Record<string, number>
  /** 按提供方汇总。留给后续诊断消费者；本页 UI 不渲染（AGENTS 3.9）。 */
  providers: Record<string, number>
  roots: RootRow[]
  projectRoot?: string | undefined
  /** 本次发现是否完整（上游 provider 健康度信号）。UI 不渲染。 */
  complete: boolean
  /** 作用域是怎么解析出来的：`session-agent` / `preset-lease` / `global-layer`。 */
  resolvedBy: string
  presetId?: string | undefined
  /** 实际生效的 cwd（客户端用它给「当前会话」加个短名）。 */
  cwd?: string | undefined
}

/** 一次 `snapshot()` 之后随响应下发的附加事实。 */
export interface CatalogEnvelope extends CatalogPayload {
  route: string
  capabilities: readonly string[]
}

/** POST `op: "read"` 的 `data`。 */
export interface SkillBody {
  name: string
  path?: string | undefined
  content: string
  truncated: boolean
  contentLength: number
}

/**
 * POST `op: "set-enabled"` 的 `data`。
 *
 * `changed: false` 表示"它本来就是那个状态"——宿主**没有写文件**。
 * 客户端据此不要做任何本地变更（也不会多一次 provider 重扫）。
 */
export interface SetEnabledResult {
  name: string
  path?: string | undefined
  enabled: boolean
  changed: boolean
}

/** 路由响应包络：成功带 `data`，失败**没有** `data`（自检 5.5 钉这条）。 */
export type ApiResponse<TData> = { ok: true; data: TData } | { ok: false; error: string }
