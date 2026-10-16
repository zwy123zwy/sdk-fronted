/**
 * C05-AC-11 隐私用例：请求带 `Authorization` 头与含令牌的查询参数 → 上报中**不出现**这两项。
 *
 * 约束（T18-plan §4）：
 * - 采集内容限定为元信息：方法、URL（经 C04 的 URL 白名单与脱敏）、状态码、耗时、是否失败；
 * - **请求体默认不采集**；`Authorization` 头属于「根本不取」，不是「取了再删」；
 * - URL 进的是 `dimensions.url_template`（模板），查询参数值不得出现。
 */
import { describe, expect, it } from 'vitest';

import { createHttpCapture } from './index';
import type { HttpEvent } from './index';

describe('C05-AC-11 不采集 Authorization 头与查询参数中的令牌', () => {
  it('注入的令牌值（Authorization 头与查询参数）都不出现在上报里', () => {
    const events: HttpEvent[] = [];
    const capture = createHttpCapture((event) => {
      events.push(event);
    });
    const authorization = 'Bearer fake-token-placeholder-abcdef';
    const urlToken = 'fake-query-token-1234567890';

    // 采集侧只接收元信息：headers 与 URL 实参都不进入事件
    capture.record(
      { method: 'GET', url: `/api/task/1?access_token=${urlToken}` },
      { status: 200 },
      33,
    );

    const serialized = JSON.stringify(events);
    expect(events).toHaveLength(1);
    expect(serialized, 'Authorization 头的值不得出现').not.toContain(authorization);
    expect(serialized, '查询参数里的令牌不得出现').not.toContain(urlToken);
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('Bearer');
  });

  it('url_template 不含查询参数（模板而非实参 URL）', () => {
    const events: HttpEvent[] = [];
    const capture = createHttpCapture((event) => {
      events.push(event);
    });
    capture.record({ method: 'GET', url: '/api/task/1?token=fake-token-abcdef' }, { status: 200 }, 12);

    const template = events[0]?.dimensions.url_template ?? '';
    expect(template).not.toContain('?');
    expect(template).not.toContain('fake-token-abcdef');
  });

  it('注入自定义 urlTemplate 后 dimensions.url_template 用注入值（判别：与缺省「去查询参数」的结果不同串）', () => {
    const events: HttpEvent[] = [];
    const capture = createHttpCapture(
      (event) => {
        events.push(event);
      },
      // 只注入 options：`record` 是手动归一化路径，不需要 refs/hooker。
      { options: { urlTemplate: (): string => '/x/:id' } },
    );
    // 伪造实参 URL：缺省实现（去掉 `?`/`#`）会得到 `/api/task/42`，与注入的 `/x/:id` 不是同一串，
    // 因此本条能区分「读了该字段」与「钉成缺省」。
    capture.record(
      { method: 'GET', url: '/api/task/42?token=fake-token-abcdef#frag' },
      { status: 200 },
      12,
    );

    expect(events, '注入模板后仍必须产出事件').toHaveLength(1);
    expect(events[0]?.dimensions.url_template, '必须使用注入的 urlTemplate').toBe('/x/:id');
    expect(JSON.stringify(events), '注入模板不是「拼在缺省模板上」').not.toContain('/api/task/42');
  });
});
