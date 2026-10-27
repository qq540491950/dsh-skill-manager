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
 * ## 只读
 *
 * 第一阶段**不含任何写入路径**：没有 `ctx.configEditor.edit()`、没有 `ctx.loader.*`、
 * 不碰 `~/.dsh/profiles/**`、不注册任何 skill / 提供方。GET 是纯读；
 * POST 只有 `op: "read"`（读一份 skill 正文）。
 */
import type { HostContext } from './service-types.ts';
export declare const name = "dsh-skill-manager";
/** 依赖在 apply 内用 ctx.inject 声明，便于缺失服务时优雅降级而不是抛错。 */
export declare const inject: readonly string[];
/**
 * 宿主插件体。
 * @param ctx - 宿主根上下文。
 */
export declare function apply(ctx: HostContext): void;
