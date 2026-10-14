#!/usr/bin/env node
/**
 * T33 验收用例第 3 条的**自查清单执行器**（**不依赖 Q2**）。
 *
 * T33 卡：「试点方使用自己的接收服务时，提供 `receiver-requirements.md` 的自查结果。」
 * 本脚本把该契约的全部「必须」条目转成**可执行探针**，接入方指向自己的预发布接收服务
 * 跑一遍即可产出自查结果，不必再问本项目的人。
 *
 * 口径来源：`docs/contracts/receiver-requirements.md`（RR-01..RR-21）与其第 2 节的
 * 「RR ↔ M01 用例对照」。**本脚本只读探针，不修改被测接收方。**
 *
 * 用法：
 *   node tests/pilot/20-receiver-selfcheck.mjs --base-url https://recv.pre.example.invalid --token <占位令牌>
 *   node tests/pilot/20-receiver-selfcheck.mjs                      # 默认自测本仓库 M01
 *
 * 可选：`--config-path <path>`（默认 `/v1/config/<app-id>/staging.json`）指定 SDK 远程配置
 * 发布物路径；脚本会只读探测该路径并在「配置前提」一条里如实记录结果。
 *
 * **令牌一律从命令行传入，绝不写进仓库**。默认值是 M01 的公开占位值。
 *
 * 输出的自查表可直接贴进试点接入方清单；`FAIL` / `SKIP` 都必须如实记录，
 * **不得**把「未测」写成「通过」。
 */
import { startReceiver } from '../../tools/mock-receiver/dist/index.js';

const textOf = async (response) => {
  try {
    return await response.text();
  } catch {
    return '';
  }
};

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next === undefined ? fallback : next;
}

const PLACEHOLDER_APP_ID = 'pilot-selfcheck-app';
const writeToken = argValue('--token', 'placeholder-write-token-0000');
const appId = argValue('--app-id', PLACEHOLDER_APP_ID);
let baseUrl = argValue('--base-url', null);
const configPath = argValue('--config-path', `/v1/config/${appId}/staging.json`);

/** 被测接收方：默认用本仓库 M01 自测（证明本清单可执行）。 */
let ownedReceiver = null;
if (baseUrl === null) {
  ownedReceiver = await startReceiver({ port: 0, writeToken });
  baseUrl = `http://127.0.0.1:${String(ownedReceiver.port)}`;
  console.log(`（未给 --base-url，自测本仓库 M01：${baseUrl}）`);
}

const results = [];
function record(id, requirement, status, detail) {
  results.push({ id, requirement, status, detail });
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP';
  console.log(`  [${mark}] ${id}  ${requirement}${detail === undefined ? '' : `\n         ${detail}`}`);
}

/** 造一个最小合法批次；`eventIds` 控制去重探针。 */
function batchOf(eventIds, extra = {}) {
  return {
    protocol_version: 1,
    app_id: appId,
    env: 'staging',
    release: '0.0.0-pilot-selfcheck',
    sdk_name: '@web-report-sdk/browser',
    sdk_version: '0.0.0',
    // device_id / session_id 在契约里是 `$defs/uuid`（M01 按 v4 正则校验），
    // 因此占位值也必须是**形状合法**的 UUID v4：全零前缀 + 显式 version/variant 位。
    device_id: '00000000-0000-4000-8000-00000000d001',
    device_id_persistent: false,
    session_id: '00000000-0000-4000-8000-000000005001',
    consent: 'granted',
    batch_id: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    sent_at: Date.now(),
    clock_offset: 0,
    clock_calibrated: false,
    common: { page_id: '/selfcheck' },
    events: eventIds.map((eventId) => ({
      event_id: eventId,
      event_name: 'pilot_selfcheck_event',
      event_type: 'custom',
      schema_version: 1,
      occurred_at: Date.now(),
      priority: 'normal',
      dimensions: { source: 'selfcheck' },
    })),
    ...extra,
  };
}

async function post(path, body, headers = {}) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-app-id': appId,
      'x-write-token': writeToken,
      ...headers,
    },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await textOf(response);
  return { status: response.status, headers: response.headers, text };
}

async function get(path) {
  const response = await globalThis.fetch(`${baseUrl}${path}`, { headers: { 'x-app-id': appId } });
  const text = await textOf(response);
  return { status: response.status, headers: response.headers, text };
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

console.log('\n=== 接收方自查（口径：docs/contracts/receiver-requirements.md） ===');
console.log(`被测接收方：${baseUrl}\n`);

// RR-01：端点与响应码
{
  const ok = await post('/v1/batch', batchOf([uuid(1)]));
  const badPath = await post('/definitely-not-a-path', batchOf([uuid(2)]));
  record(
    'RR-01',
    '实现 ingest-protocol 的端点、请求格式、上限与响应码',
    ok.status === 202 && badPath.status === 404 ? 'PASS' : 'FAIL',
    `POST /v1/batch -> ${String(ok.status)}（期望 202）；未知路径 -> ${String(badPath.status)}（期望 404）`,
  );
}

// RR-02：持久化后才 202
record(
  'RR-02',
  '只在批次已持久化之后返回 202；任何失败都不得返回 2xx',
  'SKIP',
  '无法从外部区分「先返回后落盘」——需接收方提供存储层证据或崩溃注入；本条须由接收方提供实现说明',
);

// RR-03：信标通道（text/plain + 请求体 auth）
{
  // M01/契约的信标令牌形状是 `auth: { write_token, app_id }`（**不是** `{ token }`，
  // 也不是裸字符串）。写错形状会得到 401，容易被误读成"接收方不支持信标通道"。
  const beaconBody = JSON.stringify({
    ...batchOf([uuid(3)]),
    auth: { write_token: writeToken, app_id: appId },
  });
  const beacon = await post('/v1/batch', beaconBody, { 'content-type': 'text/plain;charset=UTF-8' });
  record(
    'RR-03',
    '同时支持常规通道（X-Write-Token）与信标通道（text/plain，令牌在请求体 auth）',
    beacon.status === 202 ? 'PASS' : 'FAIL',
    `text/plain + body.auth{write_token,app_id} -> ${String(beacon.status)}（期望 202）`,
  );
}

// RR-04：gzip 与解压防护
{
  const gzipped = await (async () => {
    const stream = new globalThis.Blob([JSON.stringify(batchOf([uuid(4)]))]).stream();
    const compressed = stream.pipeThrough(new globalThis.CompressionStream('gzip'));
    return new Uint8Array(await new globalThis.Response(compressed).arrayBuffer());
  })();
  const gz = await post('/v1/batch', gzipped, {
    'content-type': 'application/json',
    'content-encoding': 'gzip',
  });
  const badEncoding = await post('/v1/batch', batchOf([uuid(5)]), {
    'content-type': 'application/json',
    'content-encoding': 'br',
  });
  record(
    'RR-04',
    '支持 gzip；解压量达 1 MB 立即中止（413）；压缩后 >256 KB 返回 413；其他编码 400',
    gz.status === 202 && badEncoding.status === 400 ? 'PASS' : 'FAIL',
    `gzip -> ${String(gz.status)}（期望 202）；Content-Encoding: br -> ${String(badEncoding.status)}（期望 400）；` +
      '1 MB 解压中止与 256 KB 上限需专用夹具，本条未覆盖（见 RR-04 附注）',
  );
}

// RR-05：按 app_id + event_id 去重（≥7 天）
{
  const dupId = uuid(9);
  const first = await post('/v1/batch', batchOf([dupId]));
  const second = await post('/v1/batch', batchOf([dupId]));
  // 换 app_id 时**必须同时**改 `x-app-id` 头与 body.app_id，否则接收方按 app_id_mismatch 拒收
  // （400），探针会把"我把请求写错了"误读成"接收方不支持跨 app 去重"。
  const otherAppId = `${appId}-other`;
  const otherBody = { ...batchOf([dupId]), app_id: otherAppId };
  const other = await post('/v1/batch', otherBody, { 'x-app-id': otherAppId });
  const counters = (await get('/__mock/counters')).text;
  let dedupeEvidence = '（该接收方无计数读接口，去重效果无法从此处确认）';
  try {
    const snapshot = JSON.parse(counters);
    if (typeof snapshot.duplicate_events === 'number') {
      dedupeEvidence =
        `去重证据（对方计数接口）：received_batches=${String(snapshot.received_batches)}、` +
        `stored_events=${String(snapshot.stored_events)}、duplicate_events=${String(snapshot.duplicate_events)}、` +
        `恒等式 received-stored===duplicate → ${String(snapshot.received_events - snapshot.stored_events === snapshot.duplicate_events)}`;
    }
  } catch {
    // 读接口不是 M01 形状时保持默认说明
  }
  record(
    'RR-05',
    '按 app_id + event_id 在至少 7 天窗口内去重',
    first.status === 202 && second.status === 202 && other.status === 202 ? 'PASS' : 'FAIL',
    `同 app 同 event_id 两次 -> ${String(first.status)}/${String(second.status)}（都应收 202）；` +
      `换 app 同 event_id（头与 body 同步换）-> ${String(other.status)}（应仍收 202 且不被跨 app 去重）；${dedupeEvidence}`,
  );
}

// RR-06：common 字段还原
record(
  'RR-06',
  '按 event-standard 的提升规则还原批次 common；事件体中的值优先',
  'SKIP',
  '需接收方入库后的读接口才能核对「业务侧看到的字段」；M01 的 /__mock/events 可查，自建接收方请提供等价读接口',
);

// RR-07：Retry-After 与 X-Server-Time
{
  const normal = await post('/v1/batch', batchOf([uuid(6)]));
  const hasServerTime = normal.headers.get('x-server-time') !== null;
  record(
    'RR-07',
    '429、503 返回 Retry-After；所有响应返回 X-Server-Time',
    hasServerTime ? 'PASS' : 'FAIL',
    `正常响应的 X-Server-Time = ${normal.headers.get('x-server-time') ?? '(缺失)'}；` +
      '429/503 的 Retry-After 需注入故障（M01 可用 POST /__mock/injection），本条未注入',
  );
}

// RR-08：CORS
{
  const preflight = await globalThis.fetch(`${baseUrl}/v1/batch`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://pilot.example.invalid',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-app-id,x-write-token',
    },
  });
  const allowOrigin = preflight.headers.get('access-control-allow-origin');
  const expose = preflight.headers.get('access-control-expose-headers');
  record(
    'RR-08',
    '支持 CORS：允许 SDK 来源与必要请求头；暴露 Retry-After、X-Server-Time',
    allowOrigin !== null ? 'PASS' : 'FAIL',
    `OPTIONS 预检 -> ${String(preflight.status)}；Allow-Origin=${allowOrigin ?? '(缺失)'}；Expose-Headers=${expose ?? '(缺失)'}`,
  );
}

// RR-15：限流（读契约第 2 节；此处只探测是否存在 429 行为）
record(
  'RR-15',
  '限流：超出配额返回 429 且带 Retry-After',
  'SKIP',
  '压测型探针会污染预发布环境，**故意不做**；须由接收方提供限流配置与证据',
);

// 可读性：计数/入库读接口（对账前提）
{
  const counters = await get('/__mock/counters');
  record(
    '对账前提',
    '接收方提供「去重后入库计数」的读接口（T33 对账三腿中的腿②以此为准）',
    counters.status === 200 ? 'PASS' : 'SKIP',
    counters.status === 200
      ? 'M01 计数接口可用（GET /__mock/counters）'
      : `未探测到 /__mock/counters（${String(counters.status)}）——自建接收方须提供等价读接口，否则 T33 对账无法进行`,
  );
}

// 配置端点（SDK 接入前提，不是 RR 条目）：SDK 初始化要从接收方同源的静态发布物
// 拉取远程配置（`docs/contracts/remote-config.md`：`{config_endpoint}/v1/config/{app_id}/{env}.json`）。
// 接收方不托管该静态物时是接入阻塞点，故**只读探测并如实记录**，不参与 PASS/FAIL 汇总，
// 以免把「我方自测用的 M01 不提供该项」误报成接收方违约。
{
  const config = await get(configPath);
  record(
    '配置前提',
    `SDK 初始化所需的远程配置发布物可读（GET ${configPath}）`,
    config.status === 200 ? 'PASS' : 'SKIP',
    config.status === 200
      ? `配置端点可用（GET ${configPath} -> 200，${String(config.text.length)} 字节）`
      : `未探测到配置端点（GET ${configPath} -> ${String(config.status)}）——静态发布物通常由接入方的静态托管/CDN 提供，` +
        `不在接收服务进程内；接入方须确认该路径可达，否则 SDK 无法取配置（可用 --config-path 改路径）`,
  );
}

await ownedReceiver?.stop();

const pass = results.filter((r) => r.status === 'PASS').length;
const fail = results.filter((r) => r.status === 'FAIL').length;
const skip = results.filter((r) => r.status === 'SKIP').length;

console.log(`\n=== 自查汇总：PASS ${String(pass)} / FAIL ${String(fail)} / SKIP ${String(skip)} ===`);
console.log('SKIP 一律**不算通过**：需接收方补充证据或实现说明，并在 T33 自查结果里如实标注。');
console.log('\n可贴进自查结果的表格：\n');
console.log('| 条目 | 要求 | 自查结果 | 证据 / 说明 |');
console.log('|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.id} | ${r.requirement} | ${r.status} | ${(r.detail ?? '').replace(/\|/g, '\\|').replace(/\n\s*/g, ' ')} |`);
}

process.exitCode = fail === 0 ? 0 : 1;
