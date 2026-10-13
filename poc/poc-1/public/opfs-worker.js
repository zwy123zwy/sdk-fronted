/**
 * POC-1 追加轮：OPFS 读写 worker。
 *
 * 用 `createSyncAccessHandle()`（只在 worker 里可用，Chromium / Firefox / WebKit 都支持），
 * 「落盘点」= flush() + close() 都返回之后。
 * 对照模式（deferCloseMs > 0）会写入数据但把 close() 推迟，用来模拟「未完成写入就被强杀」。
 */
function enc(text) {
  return new TextEncoder().encode(text);
}

function dec(buf) {
  return new TextDecoder().decode(buf);
}

async function root() {
  return await navigator.storage.getDirectory();
}

async function listFiles(prefix) {
  const dir = await root();
  const names = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.indexOf(prefix) === 0) names.push(name);
  }
  return names;
}

async function readFile(name) {
  const dir = await root();
  let handle;
  try {
    handle = await dir.getFileHandle(name, { create: false });
  } catch (e) {
    return ''; // 文件还不存在 → 空内容
  }
  const file = await handle.getFile();
  return await file.text();
}

async function writeFile(name, text, opts) {
  const { deferWriteMs = 0, deferCloseMs = 0, skipFlush = false } = opts || {};
  if (deferWriteMs > 0) {
    // 对照：整个写入被推迟，强杀时「写」还没有发生
    await new Promise((resolve) => setTimeout(resolve, deferWriteMs));
  }
  const dir = await root();
  const handle = await dir.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  access.truncate(0);
  access.write(enc(text), { at: 0 });
  if (!skipFlush) access.flush();
  if (deferCloseMs > 0) {
    // 对照：数据已写并 flush，但不 close
    await new Promise((resolve) => setTimeout(resolve, deferCloseMs));
  }
  access.close();
  return true;
}

async function deleteFile(name) {
  const dir = await root();
  await dir.removeEntry(name);
  return true;
}

async function clearFiles(prefix) {
  const names = await listFiles(prefix);
  const dir = await root();
  for (const name of names) {
    try {
      await dir.removeEntry(name);
    } catch (e) {
      /* ignore */
    }
  }
  return names.length;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const reqId = msg.reqId;
  try {
    let result = null;
    if (msg.op === 'probe') {
      result = { ok: true, hasSyncAccessHandle: typeof FileSystemFileHandle !== 'undefined' };
    } else if (msg.op === 'put') {
      result = await writeFile(msg.file, msg.text, msg.opts || {});
    } else if (msg.op === 'get') {
      result = await readFile(msg.file);
    } else if (msg.op === 'list') {
      result = await listFiles(msg.prefix || 'pending');
    } else if (msg.op === 'delete') {
      result = await deleteFile(msg.file);
    } else if (msg.op === 'clear') {
      result = await clearFiles(msg.prefix || 'pending');
    } else {
      throw new Error('unknown op: ' + msg.op);
    }
    self.postMessage({ reqId, ok: true, result });
  } catch (err) {
    self.postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};
