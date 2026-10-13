/**
 * 传输包（C06–C08）。当前已实现 C06 队列与调度（T15），C07/C08 见 T16/T17。
 *
 * 本包零运行时依赖，模块顶层无副作用（不注册监听、不访问 window），可在 SSR 与
 * Vitest 环境中直接导入。所有外部能力（提交批次、离线存储、生效配置、网络信息、
 * 页面离开信号）都通过注入接口获取，接口约定见 `packages/transport/README.md`。
 */

/** 包名，用于自监控事件的维度。 */
export const PACKAGE_NAME = '@web-report-sdk/transport';

export * from './batch/index';
export * from './queue/index';
export * from './offline/index';
export * from './sender/index';
export * from './leader/index';
