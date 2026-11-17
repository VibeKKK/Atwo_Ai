import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { graphDbPath, loadGraph, linked } from '../lib/graph-clusters.mjs';
import { buildClusters } from '../lib/split.mjs';

function makeGraphDb(root, rows) {
  const dir = path.join(root, '.graft');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'graft.db'));
  db.exec('CREATE TABLE files(path TEXT); CREATE TABLE edges(src TEXT, dst TEXT, external INTEGER);');
  for (const [src, dst, ext] of rows) db.prepare('INSERT INTO edges VALUES(?,?,?)').run(src, dst, ext ?? 0);
  db.prepare('INSERT INTO files VALUES(?)').run('lib/a.mjs');
  db.close();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atwo-graph-'));

test('没有库时返回 null，不抛', () => {
  assert.equal(loadGraph(root), null);
  assert.equal(graphDbPath(root).endsWith(path.join('.graft', 'graft.db')), true);
});

test('有库时只收仓库内的边（external=0）', () => {
  makeGraphDb(root, [['lib/a.mjs', 'lib/b.mjs', 0], ['lib/a.mjs', 'node:fs', 1]]);
  const g = loadGraph(root);
  assert.ok(g && g.edges.size === 1, '包外那条不该进来');
  assert.equal(linked(g, 'lib/a.mjs', 'lib/b.mjs'), true);
  assert.equal(linked(g, 'lib/b.mjs', 'lib/a.mjs'), true, '任一方向都算');
  assert.equal(linked(g, 'lib/a.mjs', 'lib/zzz.mjs'), false);
});

test('ATWO_GRAPH=0 时强制不用图', () => {
  const old = process.env.ATWO_GRAPH;
  process.env.ATWO_GRAPH = '0';
  try { assert.equal(loadGraph(root), null); } finally {
    if (old === undefined) delete process.env.ATWO_GRAPH; else process.env.ATWO_GRAPH = old;
  }
});

test('切分器真的用图：源码读不到也能并簇', () => {
  // abs 指向不存在的文件 → 正则那条路一无所获；能并簇就只能是图的证据。
  const units = [
    { unit: 'lib/a.mjs', abs: path.join(root, '__nope1__.mjs'), bytes: 1 },
    { unit: 'lib/b.mjs', abs: path.join(root, '__nope2__.mjs'), bytes: 1 },
  ];
  const withGraph = buildClusters(units, { cwd: root });
  const noGraph = buildClusters(units, { cwd: root, graph: null });
  assert.equal(withGraph.length, 1, '图说有依赖，应该并成一簇');
  assert.equal(noGraph.length, 2, '没有图时读不到源码，只能分开');
});

test('清尾', () => { fs.rmSync(root, { recursive: true, force: true }); });
