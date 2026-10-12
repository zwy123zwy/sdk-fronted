/**
 * C01-F3 加载桩（T12）：放在页面头部的极小内联脚本。
 *
 * 性质：
 * - **与主包完全独立**：不 import 任何模块；先把调用缓存到队列，主包加载后调用 `drain()`
 *   把队列交给主包实例回放（`client.acceptCommand`）；
 * - 主包 404 时：不抛错、不影响页面、队列不超过 200 条（C01-AC-07）；
 * - 队列上限 200 条，保留最早的调用；超出时丢弃新调用并 warn（本文件是内联脚本源码，
 *   不属于 `packages/core/src`，不受那里针对 `console` 的 lint 约束）；
 * - 只缓存 C01 定义的公共方法，不做业务逻辑；位置快照只取 `location.href`，
 *   `page_id` 由主包在回放时补全；
 * - 本文件整体是「普通脚本」而不是 ESM 模块（没有 `import` / `export`），
 *   构建时压缩输出，测试里用 `vm` 直接执行（见 `packages/core/src/api/loading-stub.test.ts`）。
 *
 * 用法（构建脚本把本文件内容内联进页面头部的 `<script>`）：
 * ```html
 * <script>// 这里是 loading-stub.ts 压缩后的内容</script>
 * <script async src="https://cdn.example.com/web-report-sdk.iife.js"></script>
 * ```
 */

/** 加载桩缓存的一条命令（与 `@web-report-sdk/core` 的 `StubCommand` 形状一致）。 */
interface LoadingStubCommand {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly args?: readonly unknown[] | undefined;
  /** 调用当时生成的 UUID v4（去重依据；主包必须原样沿用）。 */
  readonly eventId: string;
  readonly occurredAt: number;
  readonly pageId?: string | undefined;
  readonly url?: string | undefined;
}

/** 加载桩安装到 `window` 上的全局对象形状。 */
interface LoadingStubGlobal {
  init(options?: unknown): void;
  track(name: string, input?: unknown): void;
  log(level: string, message: string, input?: unknown): void;
  captureError(error: unknown, input?: unknown): void;
  setUser(id: string, options?: unknown): void;
  clearUser(): void;
  setContext(key: string, value: string): void;
  removeContext(key: string): void;
  setPage(pageId: string): void;
  setConsent(state: string): void;
  flush(): void;
  destroy(): void;
  /** 队列当前长度（调试与自检用）。 */
  getQueueLength(): number;
  /** 取出并清空全部缓存命令，交给主包实例回放（主包加载完成后调用一次）。 */
  drain(): readonly LoadingStubCommand[];
  /** 队列上限，固定 200。 */
  readonly queueLimit: number;
  /** 主包接管后由主包置为 true，供接入方排查。 */
  ready: boolean;
}

interface LoadingStubState {
  sdk: LoadingStubGlobal;
  readonly queue: LoadingStubCommand[];
}

// 内联脚本入口：整体包在 IIFE 里，所有声明都是函数作用域私有，
// 重复内联/重复执行不会因为顶层 `const` 重名而报错；单例键保证队列不被重置。
(() => {
  const KEY = '__webReportSdkLoadingStub__';
  const GLOBAL_KEY = 'WebReportSDK';
  const MAX = 200;

  /** UUID v4：事件去重的唯一依据，必须在**调用当时**生成。 */
  function createEventId(): string {
    let result = '';
    for (const character of 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx') {
      result +=
        character === 'x'
          ? ((Math.random() * 16) | 0).toString(16)
          : character === 'y'
            ? (((Math.random() * 4) | 0) + 8).toString(16)
            : character;
    }
    return result;
  }

  function currentUrl(): string | undefined {
    const location = (globalThis as { location?: { href?: unknown } }).location;
    const href = location?.href;
    return typeof href === 'string' ? href : undefined;
  }

  const root = globalThis as unknown as Record<string, unknown>;
  const existing = root[KEY] as LoadingStubState | undefined;
  if (existing !== undefined) return;

  const queue: LoadingStubCommand[] = [];
  const state: LoadingStubState = { sdk: undefined as unknown as LoadingStubGlobal, queue };
  let errorHandler: ((event: unknown) => void) | undefined;

  function push(kind: string, name: string | undefined, args: readonly unknown[]): void {
    if (queue.length >= MAX) {
      // 本文件在 eslint.config.js 里有一条**显式的** no-console 豁免（与
      // packages/core/src/api/console-sink.ts 并列）。此处直接使用 console，
      // 不再用 root['console'] 之类的间接写法规避规则——那是 lint 躲避、不可审计。
      // 用 try/catch 而不是 typeof 判断，是为了在缺少 console 的宿主（例如测试里的
      // vm 沙箱）中同样不抛错（C01-AC-07：加载桩任何情况下都不得影响页面）。
      try {
        console.warn(`web-report-sdk: queue overflow (${kind})`);
      } catch {
        // 宿主没有 console：静默跳过告警，队列行为不变。
      }
      return;
    }
    const command: LoadingStubCommand = { kind, eventId: createEventId(), occurredAt: Date.now(), args };
    if (name !== undefined) (command as { name?: string }).name = name;
    const url = currentUrl();
    if (url !== undefined) (command as { url?: string }).url = url;
    queue.push(command);
  }

  const sdk: LoadingStubGlobal = {
    init(options?: unknown): void {
      push('init', undefined, [options]);
    },
    track(name: string, input?: unknown): void {
      push('track', name, [input]);
    },
    log(level: string, message: string, input?: unknown): void {
      push('log', undefined, [level, message, input]);
    },
    captureError(error: unknown, input?: unknown): void {
      push('captureError', undefined, [error, input]);
    },
    setUser(id: string, options?: unknown): void {
      push('setUser', undefined, [id, options]);
    },
    clearUser(): void {
      push('clearUser', undefined, []);
    },
    setContext(key: string, value: string): void {
      push('setContext', undefined, [key, value]);
    },
    removeContext(key: string): void {
      push('removeContext', undefined, [key]);
    },
    setPage(pageId: string): void {
      push('setPage', undefined, [pageId]);
    },
    setConsent(state: string): void {
      push('setConsent', undefined, [state]);
    },
    flush(): void {
      push('flush', undefined, []);
    },
    destroy(): void {
      push('destroy', undefined, []);
    },
    getQueueLength(): number {
      return queue.length;
    },
    drain(): readonly LoadingStubCommand[] {
      // 主包接管后移除加载桩的错误监听，避免与主包插件重复上报。
      const target = root as {
        removeEventListener?: (type: string, handler: (event: unknown) => void, capture?: boolean) => void;
      };
      const handler = errorHandler;
      errorHandler = undefined;
      if (handler !== undefined && typeof target.removeEventListener === 'function') {
        try {
          target.removeEventListener('error', handler, true);
        } catch {
          // 环境不支持时忽略：不影响回放结果
        }
      }
      return queue.splice(0, queue.length);
    },
    queueLimit: MAX,
    ready: false,
  };

  state.sdk = sdk;
  root[KEY] = state;
  root[GLOBAL_KEY] = sdk;

  // 尽早捕获首屏未捕获错误（UC-11）：加载桩阶段把错误缓存成 captureError 命令，
  // 主包加载后随队列一起回放。只读事件信息，不改动页面行为（不 preventDefault）。
  const target = root as {
    addEventListener?: (type: string, handler: (event: unknown) => void, capture?: boolean) => void;
  };
  if (typeof target.addEventListener === 'function') {
    try {
      errorHandler = (event: unknown) => {
        const detail = event as { error?: unknown; message?: unknown };
        push('captureError', undefined, [detail.error ?? detail.message ?? detail]);
      };
      target.addEventListener('error', errorHandler, true);
    } catch {
      // 环境不支持时静默降级：不影响页面，也不影响其它缓存命令
    }
  }
})();
