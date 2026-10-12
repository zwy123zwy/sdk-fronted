/**
 * 基线快照读取（K01-F2）。
 *
 * 兼容性检查对比"git 基线版本"与当前工作区，因此需要从指定 git 引用读出 `events/` 目录。
 * 只用 Node 内置模块与只读的 git 命令：
 * `git rev-parse --show-toplevel` → `git ls-tree -r -z` → `git show <ref>:<path>`，
 * 把基线文件写到临时目录，再按与工作区完全相同的 glob 规则加载与判定。
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** git 基线读取选项。 */
export interface GitArchiveOptions {
  /** 工作目录（`--cwd`），必须位于 git 仓库内。 */
  cwd: string;
  /** git 引用：HEAD、main、某个 commit-ish。 */
  gitRef: string;
  /** 仓库内的事件定义目录（如 `events`）；为空表示仓库根。 */
  subPath: string;
}

/** 快照目录（调用方负责调用 `cleanup`）。 */
export interface SnapshotDirectory {
  /** 解出的基线事件定义目录。 */
  directory: string;
  /** 基线里的文件数。 */
  fileCount: number;
  cleanup: () => Promise<void>;
}

/** 从 git 引用导出 `<subPath>` 到临时目录；失败时抛出可读错误。 */
export async function archiveGitSnapshot(options: GitArchiveOptions): Promise<SnapshotDirectory> {
  const cwd = await realpath(resolve(options.cwd));
  const repoRoot = await realpath(await gitRoot(cwd));
  // macOS 上 /var 与 /private/var 是同一目录的两种写法，先取真实路径再算相对路径
  const subPath = relative(repoRoot, resolve(cwd, options.subPath)).split('\\').join('/');
  const trackedFiles = await listTrackedFiles(repoRoot, options.gitRef, subPath);
  if (trackedFiles.length === 0) {
    throw new Error(
      `git 引用 ${options.gitRef} 下的 ${subPath === '' ? '仓库根' : subPath} 没有已跟踪文件，无法作为兼容性基线`,
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'k01-baseline-'));
  for (const file of trackedFiles) {
    const content = await runGit(['show', `${options.gitRef}:${file}`], repoRoot);
    if (content.code !== 0) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(
        `读取基线文件失败：${options.gitRef}:${file}（${content.stderr.trim() || `git 退出码 ${String(content.code)}`}）`,
      );
    }
    const target = join(directory, ...file.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content.stdout);
  }
  return {
    directory: toNativeSubPath(directory, subPath),
    fileCount: trackedFiles.length,
    cleanup: async (): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** 仓库根目录（`git rev-parse --show-toplevel`）。 */
export async function gitRoot(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], cwd);
  if (result.code !== 0) {
    throw new Error(`不是 git 仓库：${cwd}（${result.stderr.trim() || 'git rev-parse 失败'}）`);
  }
  // macOS 上 /var 与 /private/var 是同一目录的两种写法；调用方还会用它算相对路径，
  // 因此这里统一返回真实路径
  return realpath(result.stdout.toString('utf8').trim());
}

/** 列出引用下 `<subPath>` 的已跟踪 `.json` 文件（仓库相对 POSIX 路径）。 */
export async function listTrackedFiles(
  repoRoot: string,
  gitRef: string,
  subPath: string,
): Promise<string[]> {
  const args = ['ls-tree', '-r', '-z', '--name-only', gitRef];
  if (subPath !== '') args.push('--', subPath);
  const result = await runGit(args, repoRoot);
  if (result.code !== 0) {
    throw new Error(
      `无法列出 git 引用 ${gitRef} 下的文件：${result.stderr.trim() || `git 退出码 ${String(result.code)}`}`,
    );
  }
  return result.stdout
    .toString('utf8')
    .split('\u0000')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.endsWith('.json'))
    .sort();
}

/** 把 git 里的 POSIX 子路径拼到解包目录下。 */
export function toNativeSubPath(directory: string, subPath: string): string {
  if (subPath === '') return directory;
  return join(directory, ...subPath.split('/').filter((part) => part.length > 0));
}

/** 目录是否存在且可读。 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** 写入输出文件（自动创建父目录）。 */
export async function writeOutputFile(file: string, text: string): Promise<void> {
  const absolute = resolve(file);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, 'utf8');
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** 执行 git 命令并收集输出（只读命令）。 */
async function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('git', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      resolvePromise({ code: -1, stdout: Buffer.concat(chunks), stderr: error.message });
    });
    child.on('close', (code) => {
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}
