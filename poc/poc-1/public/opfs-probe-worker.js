self.onmessage = async () => {
  const steps = [];
  const step = async (name, fn) => { try { const v = await fn(); steps.push([name, 'ok', v === undefined ? '' : String(v).slice(0,60)]); return v; } catch (e) { steps.push([name, 'FAIL', String(e.name) + ': ' + String(e.message).slice(0,90)]); return null; } };
  const dir = await step('getDirectory', () => navigator.storage.getDirectory());
  if (dir) {
    const fh = await step('getFileHandle(create)', () => dir.getFileHandle('probe-worker.txt', { create: true }));
    if (fh) {
      const acc = await step('createSyncAccessHandle', () => fh.createSyncAccessHandle());
      if (acc) {
        await step('truncate', () => acc.truncate(0));
        await step('write', () => acc.write(new TextEncoder().encode('hello')));
        await step('flush', () => acc.flush());
        await step('close', () => acc.close());
      }
    }
  }
  self.postMessage({ steps });
};
