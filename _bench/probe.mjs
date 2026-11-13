import { attach } from '../lib/cdp.mjs';
const c = await attach(9223, 'Agent');
const r = await c.js(`(() => {
  const pres = [...document.querySelectorAll('pre')];
  const codes = [...document.querySelectorAll('code')];
  const divs = [...document.querySelectorAll('div')].filter(d => d.children.length === 0 && (d.textContent||'').includes('def top_lnk'));
  const out = { preCount: pres.length, codeCount: codes.length, divCount: divs.length };
  const pick = codes[codes.length-1] || pres[pres.length-1] || divs[0];
  if (pick) {
    out.pickTag = pick.tagName;
    out.pickClass = pick.className;
    out.textLen = (pick.textContent||'').length;
    out.textHead = JSON.stringify((pick.textContent||'').slice(0, 160));
    out.innerHead = JSON.stringify((pick.innerText||'').slice(0, 160));
    out.hasNBSP = /\u00a0/.test(pick.textContent || '');
    out.ws = pick.ownerDocument.defaultView.getComputedStyle(pick).whiteSpace;
    out.htmlHead = pick.outerHTML.slice(0, 300);
    // 往上找最近的有 'code' 字样的容器
    let p = pick.parentElement, depth = 0, found = null;
    while (p && depth < 6) {
      if (/code|pre|markdown/i.test(p.className || '')) { found = { tag: p.tagName, cls: String(p.className).slice(0,80), ws: getComputedStyle(p).whiteSpace }; break; }
      p = p.parentElement; depth++;
    }
    out.wrapper = found;
  }
  return out;
})()`);
console.log(JSON.stringify(r, null, 2));
c.close();
