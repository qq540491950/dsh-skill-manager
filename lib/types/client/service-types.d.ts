/**
 * 客户端侧**注入服务**的结构类型（与宿主那份 `service-types.ts` 互为镜像）。
 *
 * 为什么自己写：本仓库没有 cordis / 官方 client 包的类型（它们由 DSH 运行时提供），
 * 所以只声明"我们真正用到的成员"。多调一个未声明的成员 = 编译失败，
 * 这正是想要的护栏。
 */
/** 插件体拿到的客户端根上下文：只需要 `inject`。 */
export interface ClientContext {
    inject(names: readonly string[], callback: (scope: ClientScope) => void): void;
}
export interface ClientScope {
    readonly slots: SlotsService;
}
/** `ctx.slots`：只能通过 `inject(座位名, …)` 注册（未声明的座位直接 register 会抛）。 */
export interface SlotsService {
    inject(slotName: string, callback: () => unknown): unknown;
    /**
     * list 座位的注册字段。**没有 `icon`** —— 官方白名单里没有这个键，
     * 写了会被静默丢弃（AGENTS 3.4），所以类型里也不给。
     */
    register(options: {
        name: string;
        id: string;
        order: number;
        label: () => string;
    }, component: unknown): unknown;
}
