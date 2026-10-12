#!/usr/bin/env node
/**
 * M01 CLI：一条命令启动本地 mock 接收服务（M01-F6）。
 *
 * 失败（端口占用、非法地址、配置不可读）时返回非零退出码并输出可读错误。
 */
import { USAGE, parseCliArgs, type CliArgs } from './cli-args.js';
import { startReceiver, type ReceiverOptions } from './server.js';

export interface MainIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface RunCliOptions {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** 测试用：只启动并立即返回（不等待 SIGINT）。 */
  startOnly?: boolean;
}

/** 由命令行参数构造 `startReceiver` 的选项。 */
export function argsToOptions(args: CliArgs): ReceiverOptions {
  return {
    host: args.host,
    port: args.port,
    ...(args.configFile === null ? {} : { configFile: args.configFile }),
    storageFail: args.storageFail,
  };
}

/** 命令主流程，返回退出码。 */
export async function main(argv: readonly string[], io: MainIo, startOnly = false): Promise<number> {
  let options: ReceiverOptions;
  try {
    options = argsToOptions(parseCliArgs(argv));
  } catch (error) {
    io.stderr(`M01 启动失败：${(error as Error).message}`);
    io.stderr(USAGE);
    return 1;
  }

  try {
    const receiver = await startReceiver(options);
    io.stdout(`M01 mock 接收服务已启动：http://127.0.0.1:${String(receiver.port)}`);
    io.stdout('  上报端点：POST /v1/batch');
    io.stdout('  配置端点：GET /v1/config/demo-app/staging.json');
    io.stdout('  计数接口：GET /__mock/counters');
    io.stdout('  只用于本地测试，不得用于生产。按 Ctrl+C 停止。');

    if (startOnly) return 0;

    await new Promise<void>((resolve) => {
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        void receiver.stop().then(() => {
          io.stdout('M01 已停止。');
          resolve();
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`M01 启动失败：${message}`);
    return 1;
  }
}

/** 供测试使用的入口。 */
export function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  return main(
    argv,
    {
      stdout: options.stdout ?? ((): void => undefined),
      stderr: options.stderr ?? ((): void => undefined),
    },
    options.startOnly ?? false,
  );
}

/**
 * 直接执行 `cli.js`（或源码 `cli.ts`）时启动服务。
 *
 * 不能依赖 `import.meta.url`：tsup 会把本模块打进共享 chunk，此时 `import.meta.url`
 * 指向 chunk 而不是 bin 入口。改为按入口文件名判断。
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const name = entry.slice(entry.lastIndexOf('/') + 1);
  return name === 'cli.js' || name === 'cli.ts';
}

if (isMainModule()) {
  runCli(process.argv.slice(2), {
    stdout: (line: string) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string) => {
      process.stderr.write(`${line}\n`);
    },
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`M01 未捕获错误：${String(error)}\n`);
      process.exitCode = 1;
    });
}
