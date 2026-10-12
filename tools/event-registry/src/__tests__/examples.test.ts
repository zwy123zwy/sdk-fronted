/**
 * K01 回归用例：`examples/event-registry/` 示例注册表必须通过 check 与 generate。
 *
 * 这是交接产物（给 T12、T34）的守护用例：示例注册表一旦漂移，本用例先失败。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { loadRegistry } from '../registry.js';
import { RUNTIME_RULES_SCHEMA_ID } from '../rules.js';
import { REPO_ROOT, makeTempDir, readJsonFile, removeTempDir } from './test-support.js';

/** 示例注册表目录。 */
const EXAMPLES_REGISTRY = join(REPO_ROOT, 'examples/event-registry/events');

async function run(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('K01 示例注册表（交接产物）', () => {
  it('K01-AC-01 示例注册表通过校验，critical 配额为 10%', async () => {
    const registry = await loadRegistry({ eventsDir: EXAMPLES_REGISTRY, repoRoot: REPO_ROOT });
    expect(registry.errors).toEqual([]);
    expect(registry.criticalQuota.totalCount).toBe(10);
    expect(registry.criticalQuota.criticalCount).toBe(1);
    expect(registry.criticalQuota.ok).toBe(true);
    // 至少一个事件有多版本，支撑 K01-F5 的"最近 3 版"
    const versions = registry.events.filter((event) => event.eventName === 'checkout_order_complete');
    expect(versions.map((event) => event.schemaVersion)).toEqual([1, 2, 3]);
  });

  it('K01-AC-01/K01-AC-08 示例注册表 check 与 generate 都返回退出码 0', async () => {
    const root = await makeTempDir();
    try {
      const check = await run(['check', '--registry', EXAMPLES_REGISTRY]);
      expect(check.stderr, check.stderr).toBe('');
      expect(check.code).toBe(0);

      const typesFile = join(root, 'events.d.ts');
      const generate = await run(['generate', '--registry', EXAMPLES_REGISTRY, '--out', typesFile]);
      expect(generate.code).toBe(0);
      const typesText = await readFile(typesFile, 'utf8');
      expect(typesText).toContain('export interface EventRegistry {');
      expect(typesText).toContain('export type EventDefinitions = EventRegistry;');
      expect(typesText).toContain('readonly schema_version: 3;');
      expect(typesText).not.toContain('editor_draft_saved');
    } finally {
      await removeTempDir(root);
    }
  }, 60_000);

  it('K01-AC-10 示例注册表 export-rules 输出符合规则 Schema', async () => {
    const root = await makeTempDir();
    try {
      const rulesFile = join(root, 'rules.json');
      const result = await run([
        'export-rules',
        '--registry',
        EXAMPLES_REGISTRY,
        '--out',
        rulesFile,
        '--registry-name',
        'demo-app',
      ]);
      expect(result.code).toBe(0);
      const rules = (await readJsonFile(rulesFile)) as { schema_id: string; keep_versions: number; events: { event_name: string; versions: { schema_version: number }[] }[] };
      expect(rules.schema_id).toBe(RUNTIME_RULES_SCHEMA_ID);
      expect(rules.keep_versions).toBe(3);
      const versioned = rules.events.find((entry) => entry.event_name === 'checkout_order_complete');
      expect(versioned?.versions.map((item) => item.schema_version)).toEqual([3, 2, 1]);
    } finally {
      await removeTempDir(root);
    }
  }, 60_000);

  it('K01-AC-11 示例清单报告 2 个未登记事件并以退出码 0 结束', async () => {
    const result = await run([
      'report-unregistered',
      '--registry',
      EXAMPLES_REGISTRY,
      '--events',
      join(REPO_ROOT, 'examples/event-registry/observed-events.sample.jsonl'),
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('legacy_cart_checkout');
    expect(result.stdout).toContain('legacy_video_buffer');
    expect(result.stdout).toMatch(/出现 3 次/);
    expect(result.stdout).toMatch(/出现 1 次/);
  });
});
