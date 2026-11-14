import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE_SRC = path.join(HERE, '..', 'lib', 'store.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// store.mjs 的 ROOT/DB_ROOT 由自身文件路径推导，open() 没有目录参数；
// 复制成 <临时目录>/<case>/lib/store.mjs 再动态导入，DB_ROOT 就落在 os.tmpdir() 下，
// 每个 case 是独立模块实例，cache 与 DB 目录互不污染。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-history-'));

async function freshOpen(tag) {
  const libDir = path.join(tmpRoot, tag, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const dest = path.join(libDir, 'store.mjs');
  fs.copyFileSync(STORE_SRC, dest);
  const mod = await import(pathToFileURL(dest).href);
  return mod.open;
}

try {
  // (1) put 之后 history('t','k') 返回按时间升序的全部变更
  {
    const open = await freshOpen('case1');
    const db = open('project');
    const values = [10, 20, 30, 40];
    const bys = ['alice', 'bob', 'carol', 'dave'];
    for (let i = 0; i < values.length; i++) {
      db.put('t', 'k', { n: values[i] }, { by: bys[i], note: `change-${i}` });
      await sleep(2);
    }
    const h = db.history('t', 'k');
    assert.strictEqual(h.length, values.length, 'history 应返回全部变更');
    assert.deepStrictEqual(h.map((r) => r.val.n), values, 'history 值顺序应与写入顺序一致');
    assert.deepStrictEqual(h.map((r) => r.by), bys);
    assert.ok(h.every((r) => r.op === 'put'));
    for (let i = 1; i < h.length; i++) {
      assert.ok(h[i - 1].ts <= h[i].ts, 'history 必须按时间升序');
    }
  }

  // (2) 写 300 条后 compact(200)，allRecords() 总数仍是 300
  {
    const open = await freshOpen('case2');
    const db = open('project');
    // 300 次写入落在 100 个不同的键上：compact 后快照保留 100 个存活行、
    // journal 保留最近 200 条，allRecords() = 100 + 200 = 300，历史不丢。
    for (let i = 0; i < 300; i++) {
      db.put('bulk', `k${i % 100}`, { i }, { by: 'bulk' });
    }
    assert.strictEqual(db.allRecords().length, 300, 'compact 前应有 300 条');
    const res = db.compact(200);
    assert.strictEqual(res.keptTail, 200);
    assert.strictEqual(db.allRecords().length, 300, 'compact(200) 后总数仍应是 300');
  }

  // (3) 两个不同 by 写同一个键，get 拿到后写的值
  {
    const open = await freshOpen('case3');
    const db = open('project');
    db.put('t', 'shared', { v: 'first' }, { by: 'alice' });
    await sleep(2);
    db.put('t', 'shared', { v: 'second' }, { by: 'bob' });
    const all = db.allRecords();
    assert.strictEqual(all.length, 2);
    assert.deepStrictEqual([...new Set(all.map((r) => r.by))].sort(), ['alice', 'bob']);
    const got = db.get('t', 'shared');
    assert.ok(got, 'get 应命中');
    assert.strictEqual(got.val.v, 'second', 'get 应拿到后写的值');
    assert.strictEqual(got.by, 'bob');
  }

  console.log('store_history.mjs: 3 checks passed');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
