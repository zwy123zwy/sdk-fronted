/**
 * 签名私钥来源（K02-F6）。
 *
 * 两条路径：
 * - `local-file`：从本地 PEM 文件读私钥，**仅用于测试**（契约第 4 节明确如此限定）；
 * - `external-command`：把 payload 经 **stdin** 交给接入方的 KMS 替身命令，
 *   只从 stdout 收 64 字节裸签名的 base64url。**K02 进程完全不接触私钥。**
 *
 * 安全约定：
 * - 不支持从命令行、stdin 或环境变量直接读私钥（会留在 shell 历史与进程环境里）；
 * - 外部命令用 `spawn` 且 `shell: false`，避免命令注入；
 * - payload 不走命令行参数，避免出现在进程列表；
 * - 外部命令的 stderr 只截断后回显，并过滤 PEM 头，防止 KMS 把私钥打回来。
 */
import { spawn } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isProblem, usageProblem, type Problem } from './errors.js';

/** 签名函数：输入 payload 的 UTF-8 字节，输出 64 字节裸签名的 base64url。 */
export type Signer = (payload: Buffer) => Promise<string>;

/** 外部签名命令。 */
export interface SignCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** 私钥来源配置。 */
export type SignerSource =
  | { readonly kind: 'local-file'; readonly privateKeyPath: string }
  | { readonly kind: 'external-command'; readonly signCommand: SignCommand };

/** 裸签名格式：base64url 且解码后正好 64 字节（IEEE P1363，r‖s）。 */
export const SIGNATURE_LENGTH = 64;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const EXTERNAL_COMMAND_TIMEOUT_MS = 30_000;

/** 字符串是否是合法的 64 字节裸签名（base64url，无填充）。 */
export function isRawSignature(value: string): boolean {
  if (!SIGNATURE_PATTERN.test(value)) return false;
  return Buffer.from(value, 'base64url').length === SIGNATURE_LENGTH;
}

/** 从本地 PEM 文件建签名器。返回签名器或用法错误。 */
export async function createSignerFromFile(path: string): Promise<Signer | Problem> {
  let pem: string;
  try {
    pem = await readFile(path, { encoding: 'utf8' });
  } catch (error) {
    const reason = error instanceof Error ? error.name : '读取失败';
    return usageProblem('usage_error', `无法读取私钥文件 ${path}（${reason}）；文件内容不会回显`);
  }
  try {
    const privateKey = createPrivateKey({ key: pem, format: 'pem' });
    if (privateKey.asymmetricKeyType !== 'ec') {
      return usageProblem('usage_error', `私钥文件 ${path} 不是 EC 密钥；K02 只支持 P-256`);
    }
    return (payload: Buffer): Promise<string> =>
      Promise.resolve(
        sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
      );
  } catch {
    // 不回显解析错误信息：某些解析错误会带上输入片段
    return usageProblem('usage_error', `私钥文件 ${path} 无法解析为 PEM 私钥；文件内容不会回显`);
  }
}

/** 外部命令 stderr 的安全化：截断、去控制字符、过滤 PEM 头所在行。 */
export function sanitizeExternalOutput(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !line.includes('-----BEGIN'))
    .join(' | ')
    .slice(0, 200);
}

/** 从外部签名命令建签名器。返回签名器或用法错误。 */
export function createSignerFromCommand(signCommand: SignCommand): Signer {
  return (payload: Buffer): Promise<string> =>
    new Promise<string>((resolvePromise, reject) => {
      const child = spawn(signCommand.command, [...signCommand.args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('外部签名命令超时（30 秒）'));
      }, EXTERNAL_COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`无法启动外部签名命令 ${signCommand.command}：${error.name}`));
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = sanitizeExternalOutput(Buffer.concat(stderr).toString('utf8'));
          reject(new Error(`外部签名命令退出码 ${String(code)}${detail === '' ? '' : `：${detail}`}`));
          return;
        }
        const signature = Buffer.concat(stdout).toString('utf8').trim();
        if (!isRawSignature(signature)) {
          reject(new Error('外部签名命令没有返回 64 字节裸签名（期望 base64url，86 字符）'));
          return;
        }
        resolvePromise(signature);
      });
      child.stdin.on('error', () => {
        // 子进程提前退出时的 EPIPE：由 close 分支统一处理
      });
      child.stdin.end(payload);
    });
}

/** 按来源创建签名器。 */
export async function createSigner(
  source: SignerSource,
): Promise<{ readonly signer: Signer } | Problem> {
  if (source.kind === 'external-command') {
    return { signer: createSignerFromCommand(source.signCommand) };
  }
  const signer = await createSignerFromFile(source.privateKeyPath);
  if (isProblem(signer)) return signer;
  return { signer };
}
