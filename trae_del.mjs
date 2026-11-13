// Trae 会话删除（软件层，纯 DOM/IPC，不碰系统鼠标）
// 原理：右键会话行 → 页面里会渲染出 data-testid="session-delete-action" 的菜单项 →
//       点它 → 弹确认框 → 点「删除」。全程在渲染进程里，不弹原生菜单、不抢鼠标。
import { attach } from './lib/cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);
const MAX = Number(argv.find((a) => /^\d+$/.test(a)) || 100);
const KEEP_RE = (() => {
  const i = argv.indexOf('--keep');
  return i >= 0 ? argv[i + 1] : '';
})();
const DRY = argv.includes('--dry');

function log(...a) { console.log(...a); }

const c = await attach(9223, 'Agent');

async function rows() {
  return c.js(`[...document.querySelectorAll('div.task-list-row-wrapper')].map((e, i) => {
    const r = e.getBoundingClientRect();
    return { i, t: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40),
             x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })`);
}

async function rightClick(x, y) {
  await c.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(120);
  await c.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
  await c.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  await sleep(500);
}

async function clickDeleteMenuItem() {
  return c.js(`(() => {
    const el = document.querySelector('[data-testid="session-delete-action"]');
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
}

// 确认框：找可见的、文本以「删除」开头且不是菜单项的按钮
async function clickConfirm() {
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    const r = await c.js(`(() => {
      const cands = [...document.querySelectorAll('button, [role="button"], .semi-button, [class*="btn"]')];
      const hit = cands.filter((b) => {
        const t = (b.textContent || '').trim();
        const rc = b.getBoundingClientRect();
        return rc.width > 20 && rc.height > 16 && (t === '删除' || t === '确认' || t === '确认删除' || t === 'Delete' || t === 'Confirm');
      });
      const el = hit[hit.length - 1];
      if (!el) return 'no-confirm';
      el.click();
      return 'clicked:' + (el.textContent || '').trim();
    })()`);
    if (r !== 'no-confirm') return r;
  }
  return 'timeout';
}

try {
  const before = (await rows()).length;
  log(`起始会话数 = ${before}`);
  let done = 0;
  for (let n = 0; n < MAX; n++) {
    const list = await rows();
    if (!list.length) { log('没有会话了'); break; }
    const target = list.find((r) => !(KEEP_RE && new RegExp(KEEP_RE).test(r.t)));
    if (!target) { log('剩下的都命中保留规则，停'); break; }
    if (DRY) { log(`  [dry] 将删 [${target.i}] 「${target.t}」`); done++; continue; }

    const b = list.length;
    await rightClick(target.x, target.y);
    const r1 = await clickDeleteMenuItem();
    if (r1 !== 'clicked') { log(`  ✗ 菜单项没出现（${r1}），停`); break; }
    await sleep(500);
    const r2 = await clickConfirm();
    if (!r2.startsWith('clicked')) { log(`  ✗ 确认框没点到（${r2}），停`); break; }
    await sleep(1100);
    const after = (await rows()).length;
    if (after < b) { done++; log(`  ✓ 「${target.t}」 ${b} → ${after}`); }
    else { log(`  ✗ 「${target.t}」数量没变(${b})，停`); break; }
  }
  log(`共删 ${done} 条，剩 ${(await rows()).length} 条`);
} finally { c.close(); }
