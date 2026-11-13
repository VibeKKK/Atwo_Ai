import { attach } from '../lib/cdp.mjs';
const c = await attach(9223, 'Agent');
const r = await c.js(`(() => {
  const all = [...document.querySelectorAll('*')];
  const target = all.find(e => e.children.length === 0 && (e.textContent||'').trim().startsWith('def top_lnk'));
  if (!target) return { err: 'not found' };
  const line = target;
  const parent = line.parentElement;
  const gp = parent && parent.parentElement;
  const info = (e) => e ? {
    tag: e.tagName, cls: String(e.className||'').slice(0,120),
    ws: getComputedStyle(e).whiteSpace,
    pl: getComputedStyle(e).paddingLeft, ml: getComputedStyle(e).marginLeft,
    html: e.outerHTML.slice(0, 240),
    text: JSON.stringify((e.textContent||'').slice(0,80))
  } : null;
  // 找同一容器里「缩进最明显」的一行（如 return [] 应该有缩进）
  let indented = null;
  if (gp) {
    indented = [...gp.children].find(e => (e.textContent||'').trim().startsWith('return []'));
  }
  return {
    line: info(line),
    parent: info(parent),
    grandparent: info(gp),
    childCount: gp ? gp.children.length : -1,
    indented: info(indented),
    indentedHTMLcodes: indented ? [...(indented.textContent||'')].map(ch=>ch.charCodeAt(0)).slice(0,10) : null
  };
})()`);
console.log(JSON.stringify(r, null, 2));
c.close();
