/** 确定性 event_id 生成：形状是合法 UUID v4（契约 batch.schema.json 的 uuid 模式）。 */
let counter = 0;

export function resetIds() {
  counter = 0;
}

export function newEventId() {
  counter += 1;
  return '00000000-0000-4000-8000-' + counter.toString(16).padStart(12, '0');
}

export function newEventIds(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(newEventId());
  return out;
}
