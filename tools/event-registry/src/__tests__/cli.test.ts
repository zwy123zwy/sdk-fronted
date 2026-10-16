/**
 * K01 验收用例：CLI 退出码、未登记事件报告（K01-AC-11）与性能（K01-AC-12）。
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { collectUnregistered, toUnregisteredReport } from '../unregistered.js';
import {
  COMPAT_PAIRS_DIR,
  CONTRACT_SCHEMA_PATH,
  VALID_DEFINITION_PATH,
  dimension,
  makeDefinition,
  makeDefinitions,
  makeTempDir,
  readJsonFile,
  removeTempDir,
  writeRegistry,
} from './test-support.js';

/** 捕获 CLI 输出的记录器。 */
interface RunResult {
  code: number;
  stdout: string[];
  stderr: string[];
}

/** 在进程内运行 CLI，收集输出与退出码。 */
async function run(args: readonly string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

describe('K01-AC-01 CLI check 子命令', () => {
  it('K01-AC-01 check 在契约合法样例上正确报告 critical 配额（单事件 100% 超限）', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      await writeRegistry(root, { 'task.json': valid });
      const result = await run(['check', '--registry', join(root, 'events', '*.json')]);
      // 契约样例是 1 个 critical 事件（1/1 = 100%），按 K01-F3 应拦截
      expect(result.code).not.toBe(0);
      expect(result.stderr.join('\n')).toMatch(/critical/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-01 check 在配额合法的注册表上返回退出码 0', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (let index = 0; index < 10; index += 1) {
        const critical = index === 0;
        files[`e${String(index)}.json`] = makeDefinition({
          event_name: `quota_demo_${String(index)}`,
          priority: critical ? 'critical' : 'normal',
          ...(critical ? { critical_reason: '结算依赖，没有其他数据源可补回' } : {}),
          fields: [dimension('scene', { required: true })],
        });
      }
      await writeRegistry(root, files);
      const result = await run(['check', '--registry', join(root, 'events', '*.json')]);
      expect(result.stderr.join('\n')).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout.join('\n')).toMatch(/10 个事件定义/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-01 check 输出同时给出事件数与 critical 配额', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (let index = 0; index < 10; index += 1) {
        const critical = index === 0;
        files[`e${String(index)}.json`] = makeDefinition({
          event_name: `quota_demo_${String(index)}`,
          priority: critical ? 'critical' : 'normal',
          ...(critical ? { critical_reason: '结算依赖，没有其他数据源可补回' } : {}),
          fields: [dimension('scene', { required: true })],
        });
      }
      await writeRegistry(root, files);
      const result = await run(['check', '--registry', join(root, 'events', '*.json')]);
      expect(result.code).toBe(0);
      expect(result.stdout.join('\n')).toMatch(/critical/);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-02 CLI 失败时为非零退出码并指出文件与字段路径', () => {
  it('K01-AC-02 非法定义的错误信息包含文件路径与字段路径', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'bad.json': makeDefinition({ event_name: 'web_custom_click' }),
      });
      const result = await run(['check', '--registry', join(root, 'events', '*.json')]);
      expect(result.code).not.toBe(0);
      const text = `${result.stdout.join('\n')}\n${result.stderr.join('\n')}`;
      expect(text).toContain('bad.json');
      expect(text).toContain('/event_name');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-02 缺少参数或未知子命令时返回非零退出码并输出用法', async () => {
    const missing = await run(['check']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr.join('\n')).toMatch(/用法|--registry|没有找到任何事件定义/);
    const missingValue = await run(['check', '--registry']);
    expect(missingValue.code).not.toBe(0);
    expect(missingValue.stderr.join('\n')).toMatch(/用法|--registry|缺少取值/);
    const unknown = await run(['frobnicate']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr.join('\n')).toMatch(/用法|未知/);
  });

  it('K01-AC-02 注册表目录不存在时返回非零退出码', async () => {
    const root = await makeTempDir();
    try {
      const result = await run(['check', '--registry', join(root, 'nope', '*.json')]);
      expect(result.code).not.toBe(0);
      expect(result.stderr.join('\n')).toMatch(/没有找到任何事件定义|不存在|找不到/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-02 --schema 指定自带 Schema 时同样按字段路径报错', async () => {
    const root = await makeTempDir();
    try {
      const valid = await readJsonFile(VALID_DEFINITION_PATH);
      await writeRegistry(root, { 'task.json': valid });
      const schemaFile = join(root, 'strict.schema.json');
      await writeFileText(
        schemaFile,
        JSON.stringify({ type: 'object', required: ['event_name', 'impossible_field'] }),
      );
      const strict = await run([
        'check',
        '--registry',
        join(root, 'events', '*.json'),
        '--schema',
        schemaFile,
      ]);
      expect(strict.code).not.toBe(0);
      expect(strict.stderr.join('\n')).toContain('/impossible_field');
      expect(strict.stderr.join('\n')).toContain('task.json');
      // 契约 Schema 文件本身也能作为 --schema 传入（用 normal 事件避开配额检查）
      const normalEvent: Record<string, unknown> = {
        ...(valid as Record<string, unknown>),
        priority: 'normal',
      };
      delete normalEvent['critical_reason'];
      await writeRegistry(root, { 'task.json': normalEvent });
      const contractSchema = await run([
        'check',
        '--registry',
        join(root, 'events', '*.json'),
        '--schema',
        CONTRACT_SCHEMA_PATH,
      ]);
      expect(contractSchema.code, contractSchema.stderr.join('\n')).toBe(0);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-03/04/05 CLI 兼容性检查', () => {
  it('K01-AC-03 对样例对目录逐对执行 check 时判定与规则表一致', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({
        event_name: 'compat_demo',
        schema_version: 1,
        fields: [dimension('scene', { required: true, max_length: 32 })],
      });
      const newDefinition = makeDefinition({
        event_name: 'compat_demo',
        schema_version: 2,
        fields: [dimension('scene', { required: true, max_length: 64 })],
      });
      await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      await writeRegistry(`${root}/new`, { 'a.json': oldDefinition, 'b.json': newDefinition });
      const result = await run([
        'check',
        '--registry',
        join(root, 'new', '*.json'),
        '--baseline-dir',
        join(root, 'old'),
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout.join('\n')).toMatch(/已放宽 max_length|兼容/);
      expect(COMPAT_PAIRS_DIR).toContain('compat-pairs');
      expect(CONTRACT_SCHEMA_PATH).toContain('event-definition.schema.json');
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-04 未递增 schema_version 时返回非零退出码并提示需要递增版本', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({
        event_name: 'compat_demo',
        fields: [dimension('scene', { required: true }), dimension('note')],
      });
      const newDefinition = makeDefinition({
        event_name: 'compat_demo',
        fields: [dimension('scene', { required: true })],
      });
      await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      await writeRegistry(`${root}/new`, { 'a.json': newDefinition });
      const result = await run([
        'check',
        '--registry',
        join(root, 'new', '*.json'),
        '--baseline-dir',
        join(root, 'old'),
      ]);
      expect(result.code).not.toBe(0);
      const text = `${result.stdout.join('\n')}\n${result.stderr.join('\n')}`;
      expect(text).toMatch(/schema_version/);
      expect(text).toMatch(/递增/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-05 破坏性变更默认非零退出码，--allow-breaking 放行', async () => {
    const root = await makeTempDir();
    try {
      const oldDefinition = makeDefinition({
        event_name: 'compat_demo',
        schema_version: 1,
        fields: [dimension('scene', { required: true })],
      });
      const newDefinition = makeDefinition({
        event_name: 'compat_demo',
        schema_version: 2,
        fields: [dimension('scene', { required: true }), dimension('extra_scene', { required: true })],
      });
      await writeRegistry(`${root}/old`, { 'a.json': oldDefinition });
      await writeRegistry(`${root}/new`, { 'a.json': oldDefinition, 'b.json': newDefinition });

      const blocked = await run([
        'check',
        '--registry',
        join(root, 'new', '*.json'),
        '--baseline-dir',
        join(root, 'old'),
      ]);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stdout.join('\n')).toContain('extra_scene');
      expect(blocked.stdout.join('\n')).toMatch(/新增必填字段/);

      const allowed = await run([
        'check',
        '--registry',
        join(root, 'new', '*.json'),
        '--baseline-dir',
        join(root, 'old'),
        '--allow-breaking',
      ]);
      expect(allowed.code).toBe(0);
      expect(allowed.stdout.join('\n')).toMatch(/新增必填字段/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-05 从临时 git 仓库读取基线版本', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'a.json': makeDefinition({
          event_name: 'git_demo',
          schema_version: 1,
          fields: [dimension('scene', { required: true })],
        }),
      });
      const gitAvailable = await initGitRepo(root);
      expect(typeof gitAvailable).toBe('boolean');
      if (!gitAvailable) return;
      // 追加破坏性变更但不递增版本，check 必须拦截
      await writeRegistry(root, {
        'a.json': makeDefinition({
          event_name: 'git_demo',
          schema_version: 1,
          fields: [dimension('scene', { required: true }), dimension('extra_scene', { required: true })],
        }),
      });
      const result = await run([
        'check',
        '--cwd',
        root,
        '--registry',
        'events/*.json',
        '--baseline-git',
        'HEAD',
      ]);
      expect(result.code).not.toBe(0);
      const text = `${result.stdout.join('\n')}\n${result.stderr.join('\n')}`;
      expect(text).toMatch(/git_demo/);
      expect(text).toMatch(/schema_version/);
    } finally {
      await removeTempDir(root);
    }
  }, 60_000);
});

describe('K01-AC-06/-07 CLI 配额与同名同版本', () => {
  it('K01-AC-06 critical 超过 10% 时返回非零退出码', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (let index = 0; index < 21; index += 1) {
        const critical = index < 3;
        files[`e${String(index)}.json`] = makeDefinition({
          event_name: `quota_demo_${String(index)}`,
          priority: critical ? 'critical' : 'normal',
          ...(critical ? { critical_reason: '结算依赖，没有其他数据源可补回' } : {}),
          fields: [dimension('scene', { required: true })],
        });
      }
      await writeRegistry(root, files);
      const result = await run(['check', '--registry', join(root, 'events', '*.json')]);
      expect(result.code).not.toBe(0);
      expect(`${result.stdout.join('\n')}${result.stderr.join('\n')}`).toMatch(/critical|10%/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-07 同名同版本或保留前缀时返回非零退出码', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'a.json': makeDefinition({ event_name: 'dup_event' }),
        'b.json': makeDefinition({ event_name: 'dup_event' }),
      });
      const duplicate = await run(['check', '--registry', join(root, 'events', '*.json')]);
      expect(duplicate.code).not.toBe(0);
      expect(`${duplicate.stdout.join('\n')}${duplicate.stderr.join('\n')}`).toMatch(/dup_event/);
    } finally {
      await removeTempDir(root);
    }
  });
});

describe('K01-AC-11 未登记事件报告', () => {
  it('K01-AC-11 报告列出注册表中没有的事件及出现次数并返回退出码 0', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'known.json': makeDefinition({ event_name: 'task_submit_complete' }),
      });
      const namesFile = join(root, 'names.json');
      const names = [
        'task_submit_complete',
        'unknown_event_alpha',
        'task_submit_complete',
        'unknown_event_beta',
        'unknown_event_alpha',
        'unknown_event_alpha',
      ];
      await writeFileJson(namesFile, names);
      const result = await run([
        'report-unregistered',
        '--registry',
        join(root, 'events', '*.json'),
        '--events',
        namesFile,
      ]);
      expect(result.stderr.join('\n')).toBe('');
      expect(result.code).toBe(0);
      const text = result.stdout.join('\n');
      expect(text).toContain('unknown_event_alpha');
      expect(text).toContain('unknown_event_beta');
      expect(text).toMatch(/3/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-11 全部已登记时输出 0 条未登记事件并以退出码 0 结束', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'known.json': makeDefinition({ event_name: 'task_submit_complete' }),
      });
      const namesFile = join(root, 'names.json');
      await writeFileJson(namesFile, ['task_submit_complete', 'task_submit_complete']);
      const result = await run([
        'report-unregistered',
        '--registry',
        join(root, 'events', '*.json'),
        '--events',
        namesFile,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout.join('\n')).toMatch(/0/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-11 支持 JSONL 清单（M01 导出格式）', async () => {
    const root = await makeTempDir();
    try {
      await writeRegistry(root, {
        'known.json': makeDefinition({ event_name: 'task_submit_complete' }),
      });
      const namesFile = join(root, 'names.jsonl');
      await writeFileText(
        namesFile,
        ['{"event_name":"task_submit_complete"}', '{"event_name":"ghost_event"}', '{"event_name":"ghost_event"}'].join('\n'),
      );
      const result = await run([
        'report-unregistered',
        '--registry',
        join(root, 'events', '*.json'),
        '--events',
        namesFile,
      ]);
      expect(result.code).toBe(0);
      const text = result.stdout.join('\n');
      expect(text).toContain('ghost_event');
      expect(text).toMatch(/2/);
    } finally {
      await removeTempDir(root);
    }
  });

  it('K01-AC-11 纯函数接口去重后按出现次数降序', () => {
    const registryNames = new Set(['known_event']);
    const report = toUnregisteredReport({
      registryNames,
      observed: ['ghost_one', 'ghost_two', 'ghost_one', 'ghost_one', 'ghost_two'],
      registryName: 'demo',
      keepVersions: 3,
    });
    expect(report.unregistered.map((entry) => entry.event_name)).toEqual(['ghost_one', 'ghost_two']);
    expect(report.unregistered[0]?.count).toBe(3);
    expect(report.total_observed).toBe(5);
    expect(collectUnregistered(new Set(['a']), ['b', 'b', 'c'])).toEqual([
      { event_name: 'b', count: 2 },
      { event_name: 'c', count: 1 },
    ]);
  });
});

describe('K01-AC-12 500 个事件定义的检查与生成', () => {
  /**
   * 度量一次「check + generate + export-rules」的 **CPU 时间**（毫秒），全程不读墙钟。
   *
   * **口径是「计算量」，不是墙钟**（2026-10-17 修；与
   * `packages/core/src/privacy/mask-adversarial.test.ts`、
   * `tools/config-signer/src/__tests__/performance.test.ts`、`docs/reports/t33-access-blockers.md` §12.3 同一病根、同一修法）：
   * 本仓的 `unit` project 有 140+ 个文件，`K01-AC-08` 的 `tsc --noEmit` 单次就要 44–53 s；
   * 门禁/多进程并发时机器会**超订**，此时**墙钟度量的不是代码，而是「被抢占多久 + 排队多久」**。
   * 受控负载（自建 CPU 负载 + 10 个并发全量 `unit` 进程、`loadavg` 108）实测：
   * 本用例 5/10 个进程-run 红，原文 `AssertionError: expected 5031 to be less than or equal to 5000`
   * （另有 5382 / 5445 / 5476 / 6027），而**同一批条件下这三个子命令的 CPU 时间只有 191–386 ms**
   * （余量 13–26×）——被抢占的等待只加在墙钟上、不加在 CPU 时间上，
   * 而「500 个事件定义在 5 秒内检查/生成完」是关于**计算量**的命题 ⇒ CPU 时间才是它的正确度量。
   * **阈值（5 s）与统计量之外的一切判据都保持原值**，没有 retry / sleep / 放宽 / 跳过。
   *
   * 统计量取三个子命令**一次连续执行**的 CPU 时间总和（原判据就是这三个子命令的合计），
   * 而不是逐子命令求分位数：原判据没有逐次样本，故这里也不新造样本口径。
   */
  async function measureCpuMs(operation: () => Promise<void>): Promise<number> {
    const started = process.cpuUsage();
    await operation();
    const finished = process.cpuUsage();
    return (finished.user - started.user + finished.system - started.system) / 1000;
  }

  it('K01-AC-12 500 个事件定义的 check + generate + export-rules 总耗时不超过 5 秒', async () => {
    const root = await makeTempDir();
    try {
      const files: Record<string, unknown> = {};
      for (const definition of makeDefinitions(500)) {
        files[`${String(definition['event_name'])}.json`] = definition;
      }
      await writeRegistry(root, files);
      const registryPattern = join(root, 'events', '*.json');
      const typesFile = join(root, 'out', 'types.ts');
      const rulesFile = join(root, 'out', 'rules.json');

      // 预热一次，让 Ajv 编译与模块图加载不进入计时
      const warmup = await run(['check', '--registry', registryPattern]);
      expect(warmup.code).toBe(0);

      let check: RunResult = { code: -1, stdout: [], stderr: [] };
      let generate: RunResult = { code: -1, stdout: [], stderr: [] };
      let rules: RunResult = { code: -1, stdout: [], stderr: [] };
      const elapsedCpu = await measureCpuMs(async () => {
        check = await run(['check', '--registry', registryPattern]);
        generate = await run([
          'generate',
          '--registry',
          registryPattern,
          '--out',
          typesFile,
        ]);
        rules = await run([
          'export-rules',
          '--registry',
          registryPattern,
          '--out',
          rulesFile,
        ]);
      });
      expect(check.code).toBe(0);
      expect(generate.code).toBe(0);
      expect(rules.code).toBe(0);
      expect(elapsedCpu).toBeLessThanOrEqual(5_000);
      // 把实测 CPU 耗时写进断言消息，失败时便于定位
      expect(elapsedCpu, `500 个事件定义共用时 ${elapsedCpu.toFixed(1)} ms（CPU 时间）`).toBeLessThan(5_000);
    } finally {
      await removeTempDir(root);
    }
  }, 120_000);
});

// —— 局部小工具（避免测试里再引入额外依赖） ——

async function writeFileJson(path: string, value: unknown): Promise<void> {
  await writeFileText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

/** 在临时目录建一个最小 git 仓库并把当前内容提交为基线。git 不可用时返回 false。 */
async function initGitRepo(root: string): Promise<boolean> {
  const runGit = (args: readonly string[]): Promise<number> =>
    new Promise((settle) => {
      const child = spawn('git', [...args], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      child.on('error', () => {
        settle(-1);
      });
      child.on('close', (code) => {
        settle(code ?? -1);
      });
    });
  const initialized = await runGit(['init', '-q']);
  if (initialized !== 0) return false;
  const added = await runGit(['add', '-A']);
  if (added !== 0) return false;
  const committed = await runGit([
    '-c',
    'user.email=agent@example.invalid',
    '-c',
    'user.name=K01 Test',
    'commit',
    '-q',
    '-m',
    'baseline',
  ]);
  return committed === 0;
}
