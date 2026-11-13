// pair.mjs —— 和副总管（dsh work replace）并肩工作的同屏看板
// 零依赖，只读写 collab/ 里已有文件，不引入新状态格式。
//
// 用法：
//   node pair.mjs                          看板（双方状态 + 未读信 + 共享文档最新几条）
//   node pair.mjs me "正在做X"              更新自己"当前在干什么"（对方一看就知道）
//   node pair.mjs post "内容" [--topic 主题] 给对方投一封信
//   node pair.mjs watch [秒]                每 N 秒刷新一次（默认 5 秒，Ctrl+C 退出）
//   node pair.mjs read                      把未读全部标记为已读

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './lib/store.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COLLAB = path.join(ROOT, 'collab');
const MAIL = path.join(COLLAB, 'mailbox');
const LOAD = path.join(COLLAB, 'load.json');
const SHARED = path.join(COLLAB, 'SHARED.md');
const READ = path.join(COLLAB, '.read.json');

// 2026-11-14 改（rank2）：原来硬编码 'dsh-lead'，两个工作区共用同一份 pair.mjs，
// 在 rank2 侧跑 post 会把信签成 dsh-lead（实测文件名 ...-from-dsh-lead-...），
// me 也会写进 dsh-lead 的负载条目污染对方状态。改成和 collab.mjs 一致，读 COLLAB_ME。
const ME = process.env.COLLAB_ME || 'dsh-lead';
const PEER = ME === 'dsh-lead'
  ? { id: 'dsh-work-replace', label: '副总管 · dsh work replace' }
  : { id: 'dsh-lead', label: '总管 · dsh workplace' };

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
// 值摘要：对象取几个关键字段，长文本截断
const brief = (v, n = 46) => {
  let s;
  if (v === null || v === undefined) s = '—';
  else if (typeof v === 'object') {
    const keys = Object.keys(v).slice(0, 3);
    s = keys.map((k) => k + ':' + String(v[k])).join(' · ');
  } else s = String(v);
  s = s.replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const pad = (s, n) => { s = String(s); return s + ' '.repeat(Math.max(0, n - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0))); };
const fresh = (iso) => {
  if (!iso) return '从未';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '未知';
  if (ms < 90e3) return Math.round(ms / 1000) + ' 秒前';
  if (ms < 90 * 60e3) return Math.round(ms / 60e3) + ' 分钟前';
  if (ms < 36 * 3600e3) return Math.round(ms / 3600e3) + ' 小时前';
  return Math.round(ms / 86400e3) + ' 天前';
};

function mails() {
  if (!fs.existsSync(MAIL)) return [];
  return fs.readdirSync(MAIL).filter((f) => f.endsWith('.md')).map((f) => {
    const st = fs.statSync(path.join(MAIL, f));
    // 发件人 ID 自带连字符（dsh-lead / dsh-work-replace），[^-]+ 会把它截断成 dsh。
    // 先按已知 ID 精确匹配，匹配不到才退回「第一个连字符」的旧规则。
    const KNOWN = ['dsh-work-replace', 'dsh-lead'];
    const stampM = f.match(/^(\d{8})-(\d{6})-from-(.+)\.md$/);
    let who = '?'; let topic = f;
    if (stampM) {
      const tail = stampM[3];
      const hit = KNOWN.find((k) => tail.startsWith(k + '-'));
      if (hit) { who = hit; topic = tail.slice(hit.length + 1); }
      else { const i = tail.indexOf('-'); who = i > 0 ? tail.slice(0, i) : tail; topic = i > 0 ? tail.slice(i + 1) : ''; }
    }
    return { f, mtime: st.mtime.toISOString(), who, topic, ts: stampM ? stampM[1] + '-' + stampM[2] : '' };
  }).sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

function board() {
  const load = readJson(LOAD, { agents: {} }).agents || {};
  const read = readJson(READ, {});
  const all = mails();
  const unread = all.filter((m) => !read[m.f]);
  const me = load[ME] || { state: '—', current: '（没登记）', since: null };
  const peer = load[PEER.id] || { state: '—', current: '（没登记）', since: null };

  const lines = [];
  lines.push('════════ 并肩工作台 · ' + new Date().toLocaleString('zh-CN') + ' ════════');
  lines.push(pad('我（' + ME + '）', 26) + '状态 ' + pad(me.state, 10) + '更新于 ' + fresh(me.since));
  lines.push(pad('', 26) + '在做：' + me.current);
  lines.push(pad(PEER.label, 26) + '状态 ' + pad(peer.state, 10) + '更新于 ' + fresh(peer.since));
  lines.push(pad('', 26) + '在做：' + peer.current);
  lines.push('─'.repeat(64));

  lines.push('未读信 ' + unread.length + ' 封' + (all.length ? '（共 ' + all.length + ' 封）' : ''));
  for (const m of unread.slice(0, 5)) lines.push('  ● [' + m.who + '] ' + m.topic + '  · ' + fresh(m.mtime));
  if (!unread.length && all.length) {
    const last = all[0];
    lines.push('  最近一封：[' + last.who + '] ' + last.topic + '  · ' + fresh(last.mtime));
  }
  lines.push('─'.repeat(64));

  // 2026-11-14：接上共享数据库（项目库 = 会过期的状态，记忆库 = 不过期的方法）
  try {
    const pj = open('project');
    const mm = open('memory');
    const prows = pj.list().sort((a, b) => (a.table === b.table ? (a.key < b.key ? -1 : 1) : (a.table < b.table ? -1 : 1)));
    lines.push('【项目库】' + (prows.length ? prows.length + ' 行' : '（空）'));
    for (const r of prows.slice(0, 8)) {
      lines.push('  ' + pad((r.table || '') + '/' + r.key, 22) + brief(r.val, 46) + '  [' + r.by + ' ' + fresh(r.ts) + ']');
    }
    if (prows.length > 8) lines.push('  …还有 ' + (prows.length - 8) + ' 行（node store.mjs list）');

    const mrows = mm.list().sort((a, b) => (a.ts < b.ts ? 1 : -1));
    lines.push('【记忆库】' + (mrows.length ? mrows.length + ' 条' : '（空）'));
    for (const r of mrows.slice(0, 6)) {
      lines.push('  ' + pad((r.table || '') + '/' + r.key, 22) + brief(r.val, 46) + '  [' + r.by + ']');
    }
    if (mrows.length > 6) lines.push('  …还有 ' + (mrows.length - 6) + ' 条（node store.mjs list --db memory）');
  } catch (e) {
    lines.push('【数据库】读取失败：' + e.message);
  }
  lines.push('─'.repeat(64));

  if (fs.existsSync(SHARED)) {
    const heads = fs.readFileSync(SHARED, 'utf8').split(/\r?\n/).filter((l) => /^#{2,3}\s+/.test(l));
    lines.push('SHARED.md 最近 ' + Math.min(4, heads.length) + ' 条（共 ' + heads.length + ' 节）：');
    for (const h of heads.slice(-4)) lines.push('  ' + h.replace(/^#+\s*/, ''));
  }
  lines.push('════════════════════════════════════════════════════════════');
  lines.push('发信：node pair.mjs post "内容"      改我在干什么：node pair.mjs me "…"');
  return lines.join('\n');
}

const argv = process.argv.slice(2);
const cmd = argv[0] || 'board';

if (cmd === 'board') {
  console.log(board());
} else if (cmd === 'watch') {
  const sec = Math.max(1, Number(argv[1]) || 5);
  const tick = () => { process.stdout.write('\x1b[2J\x1b[H'); console.log(board()); };
  tick();
  setInterval(tick, sec * 1000);
} else if (cmd === 'me') {
  const text = argv.slice(1).join(' ').trim();
  if (!text) { console.error('用法：node pair.mjs me "我现在在干什么"'); process.exit(2); }
  const load = readJson(LOAD, { agents: {} });
  load.updated = new Date().toISOString();
  load.agents = load.agents || {};
  load.agents[ME] = { state: 'busy', current: text, since: new Date().toISOString() };
  writeJson(LOAD, load);
  console.log('已登记：' + text);
} else if (cmd === 'post') {
  const topicIdx = argv.indexOf('--topic');
  const topic = topicIdx > 0 ? argv[topicIdx + 1] : '协同';
  const body = argv.slice(1, topicIdx > 0 ? topicIdx : undefined).join(' ').trim();
  if (!body) { console.error('用法：node pair.mjs post "内容" [--topic 主题]'); process.exit(2); }
  fs.mkdirSync(MAIL, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const slug = topic.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30);
  const file = path.join(MAIL, `${stamp}-from-${ME}-${slug}.md`);
  const text = `# ${topic}\n\n- 发件：${ME}\n- 时间：${new Date().toLocaleString('zh-CN')}\n\n${body}\n\n---\n回信：node pair.mjs post "内容" --topic 回信\n`;
  fs.writeFileSync(file, text, 'utf8');
  console.log('已投递：' + path.basename(file));
} else if (cmd === 'read') {
  const read = readJson(READ, {});
  const now = new Date().toISOString();
  let n = 0;
  for (const m of mails()) if (!read[m.f]) { read[m.f] = now; n++; }
  writeJson(READ, read);
  console.log('已标记 ' + n + ' 封为已读');
} else {
  console.error('未知命令：' + cmd + '\n可用：board（默认）/ watch / me / post / read');
  process.exit(2);
}
