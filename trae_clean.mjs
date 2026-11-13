#!/usr/bin/env node
// Trae 会话清理：把历史会话彻底删掉（不是归档）。
// 用法：
//   node trae_clean.mjs list            只列出，不动手
//   node trae_clean.mjs del --yes       真删（不加 --yes 只演练）
//   node trae_clean.mjs del --yes --keep 1   保留最近 1 条
//
// 依赖：Trae 必须以 --remote-debugging-port=9223 启动（ensureTrae 会处理）。

import { attach } from './lib/cdp.mjs';

const PORT = Number(process.env.ORCH_TRAE_PORT || 9223);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROWS_JS = `(() => {
  const wrap = document.querySelector('.task-list-wrapper');
  if (wrap) wrap.scrollTop = 0;
  const out = [];
  const rows = [].slice.call(document.querySelectorAll('div.task-list-row-wrapper'));
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri].getBoundingClientRect();
    if (r.height < 10) continue;
    out.push({
      i: out.length,
      text: (rows[ri].innerText || '').trim().split(String.fromCharCode(10)).join(' ').slice(0, 40),
      x: Math.round(r.x + r.width - 12),
      y: Math.round(r.y + r.height / 2),
      top: Math.round(r.y),
      h: Math.round(r.height),
    });
  }
  return out;
})()`;

const MENU_JS = `(() => {
  const picked = [];
  const seen = new Set();
  const all = [].slice.call(document.querySelectorAll('[role=menuitem], .monaco-menu .action-item, .monaco-menu-container [class*=action-item], [class*=context-menu] [class*=item], [class*=dropdown] [class*=item], [class*=popover] [class*=item]'));
  for (const e of all) {
    const r = e.getBoundingClientRect();
    if (r.width < 30 || r.height < 10) continue;
    const t = (e.innerText || '').trim();
    if (!t || t.length > 24) continue;
    const key = t + '@' + Math.round(r.x) + ',' + Math.round(r.y);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    if (picked.length >= 12) break;
  }
  return picked;
})()`;

async function click(c, x, y, button = 'left') {
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(120);
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
}

async function rows(c) {
  try { return await c.js(ROWS_JS) || []; } catch { return []; }
}

export async function listSessions(port = PORT) {
  const c = await attach(port, 'Agent');
  try { return await rows(c); } finally { try { c.close(); } catch {} }
}

// 删一条：悬停行 → 点行尾按钮 → 在弹出菜单里找「删除」→ 若出现确认框再点确认
export async function deleteOne(c, row) {
  // 悬停到行上，让操作按钮出现
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x - 40, y: row.y });
  await sleep(400);
  await click(c, row.x, row.y);
  await sleep(700);

  let menu = [];
  try { menu = await c.js(MENU_JS) || []; } catch { menu = []; }

  // 有些版本是「更多操作」按钮单独出现
  if (!menu.length) {
    const more = await c.js(`(() => {
      const bs = [].slice.call(document.querySelectorAll('button[aria-label="更多操作"],button[aria-label*="更多"],button[aria-label*="More"]'));
      for (const b of bs) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && Math.abs(r.y + r.height / 2 - ${row.y}) < 30) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
      return null;
    })()`).catch(() => null);
    if (more) { await click(c, more.x, more.y); await sleep(700); try { menu = await c.js(MENU_JS) || []; } catch {} }
  }

  const del = menu.find((m) => /删除|Delete|Delete chat|删除会话/.test(m.text));
  if (!del) return { ok: false, reason: '菜单里没有「删除」', menu: menu.map((m) => m.text) };

  await click(c, del.x, del.y);
  await sleep(800);

  // 可能的二次确认
  const confirm = await c.js(`(() => {
    const bs = [].slice.call(document.querySelectorAll('button,[role=button]'));
    for (const b of bs) {
      const r = b.getBoundingClientRect();
      if (r.width < 30) continue;
      const t = (b.innerText || '').trim();
      if (t === '删除' || t === '确认' || t === '确定' || /^Delete$/i.test(t)) {
        return { text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }
    }
    return null;
  })()`).catch(() => null);
  if (confirm) { await click(c, confirm.x, confirm.y); await sleep(900); }
  return { ok: true, used: del.text, confirmed: !!confirm };
}

export async function deleteSessions({ keep = 0, dryRun = true, port = PORT, max = 200 } = {}) {
  const c = await attach(port, 'Agent');
  const removed = [];
  const failed = [];
  try {
    let before = await rows(c);
    const target = Math.max(0, before.length - keep);
    if (dryRun) {
      return { dryRun: true, total: before.length, keep, willDelete: target, rows: before.map((r) => r.text) };
    }
    let guard = 0;
    while (removed.length < target && guard < max) {
      guard += 1;
      const list = await rows(c);
      if (!list.length) break;
      const row = list[0]; // 每次删最上面一条，回避索引漂移
      const r = await deleteOne(c, row);
      if (r.ok) removed.push(row.text);
      else { failed.push({ text: row.text, reason: r.reason, menu: r.menu }); break; }
      await sleep(400);
      const after = await rows(c);
      if (after.length >= list.length) { failed.push({ text: row.text, reason: '点了删除但行数没减少' }); break; }
    }
    const after = await rows(c);
    return { dryRun: false, total: before.length, removed: removed.length, remaining: after.length, kept: after.map((x) => x.text), failed };
  } finally { try { c.close(); } catch {} }
}

// ---- CLI ----
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const has = (f) => argv.includes(f);
const num = (f, d) => { const i = argv.indexOf(f); const v = i >= 0 ? Number(argv[i + 1]) : NaN; return Number.isFinite(v) ? v : d; };

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/trae_clean.mjs')) {
  if (cmd === 'list') {
    const rows = await listSessions();
    console.log('会话条目：' + rows.length + ' 条');
    rows.forEach((r) => console.log('  [' + r.i + '] ' + r.text));
  } else if (cmd === 'del') {
    const keep = num('--keep', 0);
    const dryRun = !has('--yes');
    const r = await deleteSessions({ keep, dryRun });
    if (r.dryRun) {
      console.log('演练模式（没删任何东西）：共 ' + r.total + ' 条，保留 ' + r.keep + ' 条，将删除 ' + r.willDelete + ' 条');
      console.log('真删请加 --yes');
    } else {
      console.log('已删除 ' + r.removed + ' 条，剩余 ' + r.remaining + ' 条');
      if (r.failed && r.failed.length) console.log('中断原因：' + JSON.stringify(r.failed));
    }
  } else {
    console.log('用法：node trae_clean.mjs list | del [--yes] [--keep N]');
  }
}
