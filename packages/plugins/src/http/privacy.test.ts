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
});
