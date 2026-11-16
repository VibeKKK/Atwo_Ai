/**
 * 会话回收 —— 派活会在客户端里留下一条会话，这里负责把它们清掉。
 *
 * 背景（2026-11-15 用户提出的需求）：
 *   每派一次活，Trae / 豆包 / WorkBuddy 的「最近」列表里就多一条，
 *   一天下来几十条噪声，真正想找的那条就淹了。
 *
 * 三条通道的能力不一样，必须分开实现，不能假装统一：
 *   · WorkBuddy：条目 hover → ⋯ → 菜单里**有「删除任务」**（danger 样式），可单条删。
 *   · Trae CN 1.107：条目 ⋯ 里有「归档任务 / 删除任务」（danger 样式），**是真删除**，
 *     但带二次确认框「确认删除 / 删除后…无法恢复」。点开菜单有两个坑，见下面 Trae 段的注释。
 *   · 豆包：见 deleteDoubaoSession（同 WorkBuddy 的形态）。
 *
 * 安全边界：只删「本次派活新建、且不在派活前基线里」的会话，绝不按标题模糊删。
 */
import { attach, attachUrl } from './cdp.mjs';

const WB_PORT = Number(process.env.WB_PORT || 9224);
const DB_PORT = Number(process.env.DB_PORT || 9225);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 列 WorkBuddy 的会话（最近的在前，DOM 顺序） */
export async function listWbSessions(cdp) {
  const c = cdp || (await attach(WB_PORT, 'WorkBuddy'));
  const own = !cdp;
  try {
    const raw = await c.js(`(() => JSON.stringify([...document.querySelectorAll('.conversation-item')].map((el) => ({
      id: el.getAttribute('data-conversation-id'),
      title: (el.innerText || '').split('\\n')[0].trim(),
      selected: !!el.querySelector('[data-selected="true"]'),
    }))))()`);
    return JSON.parse(raw || '[]');
  } finally { if (own) c.close(); }
}

/** 删除一条 WorkBuddy 会话。返回 {ok, reason?} */
export async function deleteWbSession(id, opts = {}) {
  const c = opts.cdp || (await attach(WB_PORT, 'WorkBuddy'));
  const own = !opts.cdp;
  try {
    const box = JSON.parse(await c.js(`(() => {
      const el = document.querySelector('.conversation-item[data-conversation-id="${id}"]');
      if (!el) return JSON.stringify({ ok: false, reason: '列表里找不到这条会话（可能已被删/被滚动出视口）' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`));
    if (!box.ok) return box;

    // 菜单按钮 hover 才渲染，必须先发一次真实的 mouseMoved
    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(350);

    const opened = await c.js(`(() => {
      const el = document.querySelector('.conversation-item[data-conversation-id="${id}"]');
      const b = el && el.querySelector('.agent-card-more-button');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()`);
    if (opened !== 'ok') return { ok: false, reason: '找不到会话条目的 ⋯ 按钮' };
    await sleep(500);

    // 菜单项文案是「删除任务」，class 带 danger
    const hit = await c.js(`(() => {
      const items = [...document.querySelectorAll('[class*="menu-item"],[class*="_item_"],[role="menuitem"]')]
        .filter((e) => /删除/.test((e.innerText || '').trim()));
      const t = items[items.length - 1];
      if (!t) return 'no-item';
      t.click();
      return 'clicked';
    })()`);
    if (hit !== 'clicked') {
      await c.js("document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); 'x'");
      return { ok: false, reason: '菜单里没有「删除」项（界面结构可能变了）' };
    }
    await sleep(700);

    // 二次确认是 wb-popconfirm（不是普通 modal）：
    //   <div class="wb-popover wb-popconfirm" role="dialog">
    //     <div class="wb-popconfirm__inner">
    //       <div class="wb-popconfirm__message">删除该任务？/ 删除后…无法恢复。</div>
    //       <div class="wb-popconfirm__buttons">
    //         <button class="wb-button wb-button--secondary">取消</button>
    //         <button class="wb-button wb-button--danger">删除</button>
    // 踩过的坑：如果按 innerText 长度排「最内层」来认 dialog，会选中 .wb-popconfirm__title，
    // 它内部没有按钮 → 永远 no-delete-btn。这里必须锁 .wb-popconfirm 容器。
    const confirmed = await c.js(`(() => {
      const pops = [...document.querySelectorAll('.wb-popconfirm')]
        .filter((e) => /删除该任务/.test(e.textContent || ''));
      if (!pops.length) return 'no-dialog';
      const root = pops[pops.length - 1];
      const btn = [...root.querySelectorAll('button')]
        .filter((e) => (e.textContent || '').trim() === '删除');
      if (!btn.length) return 'no-delete-btn';
      btn[btn.length - 1].click();
      return 'confirmed';
    })()`);
    await sleep(1200);

    let still = JSON.parse(await c.js(`(() => JSON.stringify(!!document.querySelector('.conversation-item[data-conversation-id="${id}"]')))()`));
    if (still) { await sleep(1500); still = JSON.parse(await c.js(`(() => JSON.stringify(!!document.querySelector('.conversation-item[data-conversation-id="${id}"]')))()`)); }
    if (still) await c.js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'x'");
    return { ok: !still, reason: still ? '点完删除后条目还在（确认框没关掉，或删除请求失败）' : '', confirmed };
  } finally { if (own) c.close(); }
}

/** 派活后回收：删掉「新出现、且不在 baseline 里」的会话。baseline = 派活前 listWbSessions 的 id 集合 */
export async function gcWb(baselineIds, opts = {}) {
  const c = opts.cdp || (await attach(WB_PORT, 'WorkBuddy'));
  const own = !opts.cdp;
  try {
    const now = await listWbSessions(c);
    const fresh = now.filter((s) => s.id && !baselineIds.has(s.id));
    const done = [];
    for (const s of fresh) {
      const r = await deleteWbSession(s.id, { cdp: c });
      done.push({ id: s.id, title: s.title, ok: r.ok, reason: r.reason || '' });
      await sleep(300);
    }
    return { total: now.length, fresh: fresh.length, done };
  } finally { if (own) c.close(); }
}

/* ───────────────────────── Trae ─────────────────────────
 * Trae CN 1.107（9223，CDP target 名 "Agent"）。
 *   条目：   .task-list-row-wrapper[data-session-id]
 *   ⋯ 图标： .trae-icon-More（是 <svg>，不是 button）
 *   菜单项： .task-list-menu-item
 *            ├─ 普通：重命名 / 置顶任务 / 分享 / 复制会话 / 在资源管理器打开 / 文件管理
 *            ├─ -disabled：转至云端执行
 *            ├─ .task-list-archive-menu-action：归档任务
 *            └─ -danger：删除任务
 *   确认框： role=dialog，文案「确认删除 / 删除后…无法恢复」，按钮「取消」「删除」
 *
 * 三个坑（都实测过，改之前先读）：
 *   1) 菜单开关的 click 监听在 **svg** 上。`button.click()` 没反应，
 *      CDP 真实鼠标 Input.dispatchMouseEvent 也没反应（连 hover 都试过），
 *      只有 `svg.dispatchEvent(new MouseEvent('click',{bubbles:true}))` 能开。
 *   2) 菜单存活极短：点开后 200ms 还在，等到 800ms 已经消失。
 *      所以必须短轮询抓，不能 sleep 死等再一次性查。
 *   3) 同一个会话连点两次 ⋯ 会把菜单 toggle 掉；多条菜单可能同时挂在 DOM 里，
 *      点菜单项一律取「最后一个匹配」，不要取第一个。
 */
const TRAE_PORT = Number(process.env.TRAE_PORT || 9223);
const TRAE_MENU_STEP = 120;
const TRAE_MENU_TRIES = 12;

async function traeAttach(cdp) {
  if (cdp) return { c: cdp, own: false };
  return { c: await attach(TRAE_PORT, 'Agent'), own: true };
}

/** 列 Trae 会话条目（DOM 顺序，侧栏最近的在前）。hasMore=false 说明是选中态，⋮ 不渲染 */
export async function listTraeSessions(cdp) {
  const { c, own } = await traeAttach(cdp);
  try {
    const raw = await c.js(`(() => JSON.stringify([...document.querySelectorAll('[data-session-id]')].map((el) => {
      const s = el.querySelector('.trae-icon-More');
      const b = s && (s.closest('button') || s.parentElement);
      const r = b ? b.getBoundingClientRect() : null;
      return {
        id: el.getAttribute('data-session-id'),
        title: (el.innerText || '').split(String.fromCharCode(10))[0].trim().slice(0, 60),
        hasMore: !!(r && r.width > 0),
      };
    })))()`);
    return JSON.parse(raw || '[]');
  } finally { if (own) c.close(); }
}

/** 打开某条会话的 ⋯ 菜单，返回菜单项文案数组 */
export async function openTraeMenu(id, opts = {}) {
  const { c, own } = await traeAttach(opts.cdp);
  try {
    const opened = await c.js(`(() => {
      const row = document.querySelector('[data-session-id="${id}"]');
      if (!row) return 'no-row';
      const svg = row.querySelector('.trae-icon-More');
      if (!svg) return 'no-more';
      svg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    if (opened !== 'ok') {
      return { ok: false, reason: opened === 'no-row' ? '列表里找不到这条会话' : '条目上没有 ⋯ 图标（选中态的条目不渲染它）' };
    }
    // 菜单存活极短，必须短轮询
    for (let i = 0; i < TRAE_MENU_TRIES; i++) {
      await sleep(TRAE_MENU_STEP);
      const items = JSON.parse(await c.js(`(() => JSON.stringify([...document.querySelectorAll('.task-list-menu-item')]
        .filter((e) => e.getClientRects().length).map((e) => (e.innerText || '').trim())))()`));
      if (items.length) return { ok: true, items: [...new Set(items)] };
    }
    return { ok: false, reason: '点了 ⋯ 但菜单没出现（' + (TRAE_MENU_TRIES * TRAE_MENU_STEP) + 'ms 内）' };
  } finally { if (own) c.close(); }
}

/** 点菜单项（取最后一个匹配，见坑 3） */
async function clickTraeMenuItem(c, text) {
  return await c.js(`(() => {
    const hit = [...document.querySelectorAll('.task-list-menu-item')]
      .filter((e) => e.getClientRects().length && (e.innerText || '').trim() === '${text}');
    const t = hit[hit.length - 1];
    if (!t) return 'no-item';
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 关掉可能残留在 DOM 里的菜单/确认框 */
async function dismissTraeOverlays(c) {
  await c.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1");
  await sleep(150);
}

/**
 * 删除一条 Trae 会话（真删除，不可恢复）。
 * 返回 {ok, reason?, menu?, confirmed?}
 */
export async function deleteTraeSession(id, opts = {}) {
  const { c, own } = await traeAttach(opts.cdp);
  try {
    const menu = await openTraeMenu(id, { cdp: c });
    if (!menu.ok) return menu;
    const delText = menu.items.find((t) => /删除/.test(t));
    if (!delText) {
      await dismissTraeOverlays(c);
      return { ok: false, reason: '菜单里没有删除项，实际项：' + menu.items.join(' / '), menu: menu.items };
    }
    const clicked = await clickTraeMenuItem(c, delText);
    if (clicked !== 'ok') { await dismissTraeOverlays(c); return { ok: false, reason: '点「' + delText + '」失败', menu: menu.items }; }
    await sleep(600);

    // 二次确认（必须点「删除」，点「取消」= 白干）
    const confirmed = await c.js(`(() => {
      const roots = [...document.querySelectorAll('[role="dialog"],[class*="dialog"]')]
        .filter((e) => e.getClientRects().length && /确认删除|无法恢复/.test(e.textContent || ''));
      if (!roots.length) return 'no-dialog';
      const root = roots[roots.length - 1];
      const btns = [...root.querySelectorAll('button')].filter((b) => (b.textContent || '').trim() === '删除');
      if (!btns.length) return 'no-delete-btn';
      btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'ok';
    })()`);
    await sleep(1200);

    let still = JSON.parse(await c.js(`(() => JSON.stringify(!!document.querySelector('[data-session-id="${id}"]')))()`));
    if (still) {
      await sleep(2000);
      still = JSON.parse(await c.js(`(() => JSON.stringify(!!document.querySelector('[data-session-id="${id}"]')))()`));
    }
    if (still) await dismissTraeOverlays(c);
    return {
      ok: !still,
      confirmed,
      menu: menu.items,
      reason: still ? '点了删除但条目还在（确认框 ' + confirmed + '）' : '',
    };
  } finally { if (own) c.close(); }
}

/** 归档一条 Trae 会话（可撤销，比删除安全；菜单里是 .task-list-archive-menu-action） */
export async function archiveTraeSession(id, opts = {}) {
  const { c, own } = await traeAttach(opts.cdp);
  try {
    const menu = await openTraeMenu(id, { cdp: c });
    if (!menu.ok) return menu;
    const archText = menu.items.find((t) => /归档/.test(t));
    if (!archText) { await dismissTraeOverlays(c); return { ok: false, reason: '菜单里没有归档项，实际项：' + menu.items.join(' / ') }; }
    const clicked = await clickTraeMenuItem(c, archText);
    await sleep(900);
    const still = JSON.parse(await c.js(`(() => JSON.stringify(!!document.querySelector('[data-session-id="${id}"]')))()`));
    if (still) await dismissTraeOverlays(c);
    return { ok: clicked === 'ok' && !still, reason: still ? '点了归档但条目还在' : '' };
  } finally { if (own) c.close(); }
}

/**
 * 派活后回收 Trae：只删「这次新出现、且不在 baseline 里」的条目。
 * mode='archive' 时改归档（可撤销）。
 */
export async function gcTrae(baselineIds, opts = {}) {
  const { c, own } = await traeAttach(opts.cdp);
  const mode = opts.mode === 'archive' ? 'archive' : 'delete';
  try {
    const now = await listTraeSessions(c);
    const fresh = now.filter((s) => s.id && !baselineIds.has(s.id));
    const done = [];
    for (const s of fresh) {
      const r = mode === 'archive'
        ? await archiveTraeSession(s.id, { cdp: c })
        : await deleteTraeSession(s.id, { cdp: c });
      done.push({ id: s.id, title: s.title, ok: r.ok, reason: r.reason || '' });
      await sleep(400);
    }
    return { total: now.length, fresh: fresh.length, mode, done };
  } finally { if (own) c.close(); }
}
/* ───────────────────────── 豆包 ─────────────────────────
 * 豆包（9225，doubao://doubao-chat/chat/<id>）的会话条目是
 *   <a class="group/conversation-item ...">…</a>
 * hover 后出现两个按钮：button[aria-label="归档对话"] 与 button[aria-label="更多"]。
 *
 * 「更多」点开的是 **Electron 原生菜单**，DOM 里查不到「删除」项，CDP 点不到；
 * 而「归档对话」是网页内的，实测有效：点一下条目立刻从「最近」列表移走，
 * 并弹 toast「已归档对话，你可以撤销」。
 * 所以豆包侧用「归档」替代「删除」—— 对用户要的效果（列表别堆垃圾）等价，且可撤销。
 */

/** 列豆包的会话条目：{i, title, active} */
export async function listDoubao(cdp) {
  const c = cdp || (await attachUrl(DB_PORT, 'doubao-chat/chat/'));
  const own = !cdp;
  try {
    const raw = await c.js(`(() => JSON.stringify([...document.querySelectorAll('a[class*="conversation-item"]')].map((e, i) => ({
      i,
      title: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      active: /e2e-test-active/.test(String(e.className)),
    }))))()`);
    return JSON.parse(raw || '[]');
  } finally { if (own) c.close(); }
}

/** 归档第 index 条豆包会话（index 来自 listDoubao 的 i，按「最近」列表顺序） */
export async function archiveDoubaoAt(index, opts = {}) {
  const c = opts.cdp || (await attachUrl(DB_PORT, 'doubao-chat/chat/'));
  const own = !opts.cdp;
  try {
    const before = await listDoubao(c);
    const t = before[index];
    if (!t) return { ok: false, reason: '索引越界（列表可能刚变过）' };
    if (t.active) return { ok: false, reason: '当前正在使用的会话，不动它' };

    const box = JSON.parse(await c.js(`(() => {
      const el = document.querySelectorAll('a[class*="conversation-item"]')[${index}];
      if (!el) return JSON.stringify({ ok: false });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`));
    if (!box.ok) return { ok: false, reason: '列表项消失' };

    await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await sleep(500);
    const clicked = await c.js(`(() => {
      const el = document.querySelectorAll('a[class*="conversation-item"]')[${index}];
      const b = el && el.querySelector('button[aria-label="归档对话"]');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()`);
    if (clicked !== 'ok') return { ok: false, reason: 'hover 后没出现「归档对话」按钮' };
    await sleep(900);

    const after = await listDoubao(c);
    return { ok: after.length < before.length, title: t.title, reason: after.length < before.length ? '' : '点了归档但列表没变' };
  } finally { if (own) c.close(); }
}

/** 派活后回收豆包：把「基线里没有的标题」从列表尾部（最旧）开始归档 */
export async function gcDoubao(baselineTitles, opts = {}) {
  const c = opts.cdp || (await attachUrl(DB_PORT, 'doubao-chat/chat/'));
  const own = !opts.cdp;
  try {
    const count = (arr) => arr.reduce((m, t) => m.set(t, (m.get(t) || 0) + 1), new Map());
    const now = await listDoubao(c);
    const base = count([...baselineTitles]);
    const over = count(now.filter((s) => !s.active).map((s) => s.title));
    // 只保留「比基线多出来的份数」，从列表尾部往头部扫
    const done = [];
    for (let i = now.length - 1; i >= 0; i--) {
      const s = now[i];
      if (s.active) continue;
      const left = (over.get(s.title) || 0) - (base.get(s.title) || 0);
      if (left <= 0) continue;
      const r = await archiveDoubaoAt(i, { cdp: c });
      done.push({ title: s.title, ok: r.ok, reason: r.reason || '' });
      over.set(s.title, (over.get(s.title) || 0) - 1);
      await sleep(400);
    }
    return { total: now.length, archived: done.length, done };
  } finally { if (own) c.close(); }
}

/** 三条通道一起收尾。wb 与 Trae 用真删除，豆包用归档（它的「更多」是原生菜单，点不到删除）。 */
export async function gcAll(baseline, opts = {}) {
  const out = { workbuddy: null, doubao: null, trae: null, errors: [] };
  if (baseline && baseline.wb) {
    try { out.workbuddy = await gcWb(baseline.wb, opts); } catch (e) { out.errors.push('workbuddy: ' + e.message); }
  }
  if (baseline && baseline.doubao) {
    try { out.doubao = await gcDoubao(baseline.doubao, opts); } catch (e) { out.errors.push('doubao: ' + e.message); }
  }
  if (baseline && baseline.trae) {
    try { out.trae = await gcTrae(baseline.trae, opts); } catch (e) { out.errors.push('trae: ' + e.message); }
  }
  return out;
}

/** 派活前采集基线（给 gcAll 用）。某条通道没开就留空集合，gc 时自然什么也不做。 */
export async function snapshotBaseline() {
  const base = { wb: new Set(), doubao: [], trae: new Set() };
  try { base.wb = new Set((await listWbSessions()).map((s) => s.id).filter(Boolean)); } catch {}
  try { base.doubao = (await listDoubao()).filter((s) => !s.active).map((s) => s.title); } catch {}
  try { base.trae = new Set((await listTraeSessions()).map((s) => s.id).filter(Boolean)); } catch {}
  return base;
}
