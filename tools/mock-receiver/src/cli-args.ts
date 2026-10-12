/**
 * CLI 参数解析（M01-F6、M01-AC-15）。
 *
 * 只允许 `127.0.0.1`；非法参数抛出可读错误，由 `cli.ts` 转成非零退出码。
 */
import { DEFAULT_PORT, LISTEN_HOST, assertListenHost } from './server.js';

export interface CliArgs {
  host: string;
  port: number;
  configFile: string | null;
  storageFail: boolean;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`--port 必须是整数：${raw}`);
  const value = Number.parseInt(raw, 10);
  if (value < 0 || value > 65_535) throw new Error(`--port 必须在 0–65535 之间：${raw}`);
  return value;
}

/** 解析命令行参数。`--help` 与未知参数都抛出错误（由调用方打印用法）。 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { host: LISTEN_HOST, port: DEFAULT_PORT, configFile: null, storageFail: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--host': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--host 缺少取值');
        assertListenHost(value);
        args.host = value;
        index += 1;
        break;
      }
      case '--port': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--port 缺少取值');
        args.port = parsePort(value);
        index += 1;
        break;
      }
      case '--config-file': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('--config-file 缺少取值');
        args.configFile = value;
        index += 1;
        break;
      }
      case '--storage-fail': {
        args.storageFail = true;
        break;
      }
      case '--help':
      case '-h': {
        throw new Error('--help 是用法查询：见 README 的“启动命令”一节');
      }
      default: {
        throw new Error(`未知参数：${String(flag)}`);
      }
    }
  }
  return args;
}

/** 用法文本。 */
export const USAGE = `用法：web-report-mock-receiver [选项]

选项：
  --port <端口>        监听端口，0 表示自动分配（默认 ${String(DEFAULT_PORT)}）
  --host <地址>        只允许 ${LISTEN_HOST}（默认 ${LISTEN_HOST}）
  --config-file <文件> 启动时托管的 I-02 配置发布物（默认读契约样例）
  --storage-fail       启动即注入“存储失败”（M01-AC-05）
  --help               显示本说明

M01 只用于本地测试，不得用于生产。`;
