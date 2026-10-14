/**
 * C05-F1..F4 的契约自证（T18-plan §7）：用**真实** Schema 做正向与负向对照。
 *
 * 负向样本逐条对应一个"实现若写错就会被拒"的违约点（§7 的 1–12 条），
 * 另加**非空转对照**：故意构造的合法样本必须被接受。
 */
import { describe, expect, it } from 'vitest';

import {
  compileHttp,
  compileJsError,
  compileLongTask,
  compileVitals,
  validHttp,
  validJsError,
  validLongTask,
  validVitals,
} from './schemas';

describe('C05 契约自证：真实 builtin-events Schema 的正向校验（非空转对照）', () => {
  it('四类事件的最小合法样本都通过各自的 Schema', () => {
    const jsError = compileJsError();
    expect(jsError(validJsError()), JSON.stringify(jsError.errors)).toBe(true);

    const vitals = compileVitals();
    expect(vitals(validVitals()), JSON.stringify(vitals.errors)).toBe(true);

    const longTask = compileLongTask();
    expect(longTask(validLongTask()), JSON.stringify(longTask.errors)).toBe(true);

    const http = compileHttp();
    expect(http(validHttp()), JSON.stringify(http.errors)).toBe(true);
  });
});

describe('C05 契约自证：负向对照（证明校验器有判别力）', () => {
  it('web_js_error：缺 dimensions.source / 缺 fingerprint 都判 false', () => {
    const validate = compileJsError();
    const missingSource = validJsError();
    missingSource['dimensions'] = { error_type: 'TypeError', message: 'm', fingerprint: 'fp' };
    expect(validate(missingSource), JSON.stringify(validate.errors)).toBe(false);

    const missingFingerprint = validJsError();
    missingFingerprint['dimensions'] = { error_type: 'TypeError', message: 'm', source: 'window_error' };
    expect(validate(missingFingerprint), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_js_error：metrics.count = 0 或 1.5 都判 false', () => {
    const validate = compileJsError();
    const zero = validJsError();
    zero['metrics'] = { count: 0 };
    expect(validate(zero), JSON.stringify(validate.errors)).toBe(false);

    const fractional = validJsError();
    fractional['metrics'] = { count: 1.5 };
    expect(validate(fractional), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_vitals：metric_name = FID / 缺 rating / rating = ok 都判 false', () => {
    const validate = compileVitals();
    const fid = validVitals();
    fid['dimensions'] = { metric_name: 'FID', rating: 'good' };
    expect(validate(fid), JSON.stringify(validate.errors)).toBe(false);

    const noRating = validVitals();
    noRating['dimensions'] = { metric_name: 'LCP' };
    expect(validate(noRating), JSON.stringify(validate.errors)).toBe(false);

    const okRating = validVitals();
    okRating['dimensions'] = { metric_name: 'LCP', rating: 'ok' };
    expect(validate(okRating), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_vitals：缺 metrics.delta 判 false', () => {
    const validate = compileVitals();
    const noDelta = validVitals();
    noDelta['metrics'] = { value: 1200 };
    expect(validate(noDelta), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_long_task：缺 metrics.duration_ms 判 false', () => {
    const validate = compileLongTask();
    const noDuration = validLongTask();
    noDuration['metrics'] = { start_time_ms: 340 };
    expect(validate(noDuration), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_long_task：往 dimensions 里塞字段判 false（该 Schema 的 dimensions 是空对象 schema）', () => {
    const validate = compileLongTask();
    const withDimensions = validLongTask();
    withDimensions['dimensions'] = { note: 'x' };
    expect(validate(withDimensions), JSON.stringify(validate.errors)).toBe(false);
  });

  it('web_http：status_class = "200" / metrics.status = 99 / 缺 url_template 都判 false', () => {
    const validate = compileHttp();

    const wrongClass = validHttp();
    wrongClass['dimensions'] = { method: 'GET', url_template: '/api/task/:id', status_class: '200' };
    expect(validate(wrongClass), JSON.stringify(validate.errors)).toBe(false);

    const lowStatus = validHttp();
    lowStatus['metrics'] = { status: 99, duration_ms: 42 };
    expect(validate(lowStatus), JSON.stringify(validate.errors)).toBe(false);

    const noTemplate = validHttp();
    noTemplate['dimensions'] = { method: 'GET', status_class: '2xx' };
    expect(validate(noTemplate), JSON.stringify(validate.errors)).toBe(false);
  });

  it('非空转对照：多一个未声明字段必须判 false，同一校验器对合法样本判 true', () => {
    const validate = compileJsError();
    const extra = validJsError();
    extra['not_a_field'] = 'x';
    expect(validate(extra), JSON.stringify(validate.errors)).toBe(false);
    expect(validate(validJsError())).toBe(true);
  });
});
