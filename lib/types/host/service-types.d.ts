/**
 * 宿主侧**注入服务**的结构类型。
 *
 * 为什么不直接 `import type { Context } from '@deepseek-ai/cordis'`：
 * 本仓库的 `node_modules` 里没有 cordis（它是 `peerDependencies`，由 DSH 提供），
 * 而 `@deepseek-ai/dsh-*` 的服务类型又都在 app.asar 里。所以这里按"我们真正用到的那几个
 * 成员"声明结构类型——**正好也把契约写死在类型里**：多调一个未声明的成员就编译失败。
 *
 * 参数一律写得比真实签名宽（`unknown` / 可选），因为我们只保证自己怎么用它，
 * 不替官方拍板它的实现细节。
 */
/** 服务根上下文的读取面。`get` 返回 `unknown`，由调用方按名字收窄（见 `service()`）。 */
export interface ScopeLike {
    get(name: string): unknown;
}
/** 插件体拿到的根上下文：只需要 `inject`（依赖在 apply 内声明，缺失时优雅降级）。 */
export interface HostContext {
    inject(names: readonly string[], callback: (scope: HostScope) => void): void;
}
/** `inject` 之后的 scope：本插件用到的两个服务在这里变成必填。 */
export interface HostScope extends ScopeLike {
    readonly skills: SkillRegistry;
    readonly connection: ConnectionService;
}
/** 注册一条浏览器路由（挂在 webServer 的 `/api` 前缀之下）。 */
export interface ConnectionService {
    readonly fetch: {
        register(options: {
            path: string;
            methods: readonly string[];
            requestBody: 'buffered';
            fetch: (request: Request) => Promise<Response>;
        }): unknown;
    };
}
/** `ctx.skills` 快照里的一行（官方 `SkillSummary`，字段全部**不可信**，逐条收窄）。 */
export interface SkillSummary {
    name?: unknown;
    description?: unknown;
    whenToUse?: unknown;
    path?: unknown;
    source?: unknown;
    provider?: unknown;
    invocation?: {
        modelInvocable?: unknown;
        userInvocable?: unknown;
    } | undefined;
    resourceBase?: {
        kind?: unknown;
    } | undefined;
}
/** `ctx.skills.snapshot()` 的返回：`complete` 是「本次发现是否完整」的唯一权威信号。 */
export interface SkillSnapshot {
    skills?: readonly SkillSummary[] | undefined;
    complete?: unknown;
}
/** `ctx.skills.get()` 的返回（含正文）。 */
export interface SkillDetail {
    name?: unknown;
    path?: unknown;
    content?: unknown;
}
/** 注册表读取的两个入口。**必须带 `scope`**，否则只会合并全局 layer（AGENTS 2.2）。 */
export interface SkillRegistry {
    snapshot(options: {
        cwd?: string | undefined;
        scope?: unknown;
        signal?: AbortSignal;
    }): Promise<SkillSnapshot | undefined>;
    get(name: string, options: {
        cwd?: string | undefined;
        scope?: unknown;
        signal?: AbortSignal;
    }): Promise<SkillDetail | undefined>;
}
/**
 * `ctx.fs`：只用 resolve / listDir / readText / stat / lstat / writeText 六个成员。
 *
 * `writeText` 是本插件**唯一**的写入出口（只用来改 `SKILL.md` 的 frontmatter）；
 * `stat` 的 `version` 是写入护栏（`replaceIfVersion`）的凭证，拿不到版本就不写。
 */
export interface FsEntry {
    name?: unknown;
    type?: unknown;
    target?: {
        displayPath?: unknown;
    } | undefined;
}
/** 写入意图：本插件只用 `replaceIfVersion`（无护栏的覆盖一律不做）。 */
export interface FsWriteIntent {
    kind: 'replaceIfVersion';
    version: string;
}
export interface FsService {
    resolve(path: string, options?: {
        signal?: AbortSignal;
    }): Promise<string>;
    listDir(target: string, signal?: AbortSignal): Promise<readonly FsEntry[] | undefined>;
    readText(target: string, signal?: AbortSignal): Promise<unknown>;
    stat?(target: string, signal?: AbortSignal): Promise<{
        type?: unknown;
        version?: unknown;
    } | undefined>;
    lstat?(path: string): Promise<unknown>;
    writeText?(target: string, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<unknown>;
}
/** `ctx.sessionQuery`：`observeSession()` 返回 **caller-owned** 租约，读完必须释放。 */
export interface SessionObservation {
    header?: {
        cwd?: unknown;
        agentPreset?: unknown;
    } | undefined;
    projections?: {
        values?: {
            agentPreset?: unknown;
        };
    } | undefined;
}
export interface SessionQueryService {
    observeSession(sessionId: string, options?: {
        signal?: AbortSignal;
    }): Promise<SessionObservation | undefined>;
}
/** `ctx.agentPresets`：`acquireScope()` 返回 **revision 租约**，读完必须释放。 */
export interface PresetRow {
    id?: unknown;
    isDefault?: unknown;
}
export interface PresetLease {
    key?: unknown;
}
export interface AgentPresetsService {
    resolve(presetId?: string): Promise<{
        id?: unknown;
    } | undefined>;
    remoteExportList(): Promise<{
        presets?: readonly PresetRow[];
    } | undefined>;
    acquireScope(presetId?: string): Promise<PresetLease | undefined>;
    serviceFor(agent: unknown, name: string): SkillRegistry | undefined;
    composedPreset?(ctx: unknown): unknown;
}
/** `ctx.agents`：只用来判断某个 session 是否有**活 Agent**（最高保真的 scope 来源）。 */
export interface AgentsService {
    get?(sessionId: string): unknown;
}
/** `ctx.workspaceRegistry`：cwd 的**兜底**来源，不是正路（AGENTS 2.4）。 */
export interface WorkspaceRegistryService {
    list?(): readonly {
        path?: unknown;
    }[] | undefined;
}
/** 可被 `Symbol.dispose` / `Symbol.asyncDispose` 释放的租约（两种都可能）。 */
export type SymbolKeyed = {
    [key: symbol]: unknown;
};
