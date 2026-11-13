#!/usr/bin/env node
// collab.mjs —— 两个 DSH 工作区之间的待命通道 / 共通记忆闸门
//
// 设计前提：两边共享同一个文件夹，所以"联系"就是落文件，不需要网络。
//
//   node collab.mjs status              看通道状态（默认 DORMANT）
//   node collab.mjs arm                 上膛（用户下令后才允许）
//   node collab.mjs disarm              解除
//   node collab.mjs post "内容" [-t 主题]   留一条消息给对方（需已上膛）
//   node collab.mjs read                看对方留的、我没读过的
//   node collab.mjs ack                 把我读过的标记已读
//   node collab.mjs shared              看/初始化共通记忆库（需已上膛）
//
// 关键约束：SHARED.md 在 DORMANT 状态下不写不改。这是用户明确要求的。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'collab');
const MAIL = path.join(DIR, 'mailbox');
const ARMED_FILE = path.join(DIR, '.armed');
const PEERS_FILE = path.join(DIR, 'peers.json');
const SHARED_FILE = path.join(DIR, 'SHARED.md');
const READ_FILE = path.join(DIR, '.read.json');
const LOAD_FILE = path.join(DIR, 'load.json');

// 谁在跑这个脚本：默认 dsh-lead；对端用 COLLAB_ME=dsh-work-replace 覆盖
const ME = process.env.COLLAB_ME || 'dsh-lead';

function ensure() {
  for (const d of [DIR, MAIL]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(PEERS_FILE)) {
    fs.writeFileSync(PEERS_FILE, JSON.stringify({
      me: ME,
      note: '本机主 DSH 工作区（D:\\code app\\ai code\\Dssh\\dsh\\dsh workplace）',
      peers: [{
        id: 'dsh-orchestra',
        label: 'Orchestra 作者工作区',
        location: '未知（本机 session 库里没有它的会话；可能在另一台机器）',
        channel: 'collab/mailbox 文件投递',
        status: 'unreachable-until-user-orders'
      }]
    }, null, 2) + '\n', 'utf8');
  }
  if (!fs.existsSync(READ_FILE)) fs.writeFileSync(READ_FILE, '{}\n', 'utf8');
}

const armed = () => fs.existsSync(ARMED_FILE);
function needArm(what) {
  if (armed()) return true;
  console.log(`\n  通道处于 DORMANT（未上膛），${what} 需要用户先下令。`);
  console.log('  下令后执行：node collab.mjs arm\n');
  return false;
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cmdStatus() {
  ensure();
  const peers = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf8'));
  const msgs = fs.readdirSync(MAIL).filter(f => f.endsWith('.md'));
  const read = JSON.parse(fs.readFileSync(READ_FILE, 'utf8'));
  const unread = msgs.filter(f => !read[f] && !f.includes(`-from-${ME}-`));

  console.log('');
  console.log('  ══ DSH ↔ DSH 通道 ══');
  console.log(`  状态      ${armed() ? 'ARMED（已上膛，可协同）' : 'DORMANT（待命，不协同）'}`);
  console.log(`  位置      ${DIR}`);
  // 2026-11-13 修（rank2）：peers.json 的 me 由首个初始化者写死（dsh-lead），文件两区共享 →
  // 对端跑 status 会看到「我 dsh-lead / 对方 dsh-work-replace」，视角完全反转。
  // 以当前进程的 ME 为准，并从对方列表里剔除自己；不写回文件，避免两边反复改同一字段。
  const others = (peers.peers || []).filter(p => p.id !== ME);
  const drift = peers.me && peers.me !== ME ? `（peers.json 记为 ${peers.me}，本进程按 COLLAB_ME=${ME}）` : '';
  console.log(`  我        ${ME}${drift}`);
  if (!others.length) console.log('  对方      （peers.json 未登记其他工作区）');
  for (const p of others) console.log(`  对方      ${p.id}  ${p.label}   ${p.status}`);
  console.log(`  信箱      ${msgs.length} 条，未读 ${unread.length} 条`);
  { const ld = readLoad(); const a = ld.agents || {};
    const parts = Object.keys(a).map(k => `${k}:${a[k].state === 'busy' ? '忙' : a[k].state === 'standby' ? '待命' : '空闲'}`);
    if (parts.length) console.log(`  负载      ${parts.join('   ')}`); }
  console.log(`  共通记忆  ${fs.existsSync(SHARED_FILE) ? 'SHARED.md 已存在' : '未建（上膛后 shared 初始化）'}`);
  console.log('');
  if (unread.length) {
    console.log('  未读：');
    for (const f of unread) console.log('    · ' + f);
    console.log('');
  }
}

function cmdArm() {
  ensure();
  fs.writeFileSync(ARMED_FILE, `armed-at ${new Date().toISOString()}\n`, 'utf8');
  console.log('\n  ✓ 已上膛：现在可以 post 留消息、shared 写共通记忆。\n');
}

function cmdDisarm() {
  ensure();
  if (fs.existsSync(ARMED_FILE)) fs.unlinkSync(ARMED_FILE);
  console.log('\n  ✓ 已解除：通道回到 DORMANT，SHARED.md 不再写入。\n');
}

function cmdPost(text, topic) {
  ensure();
  if (!needArm('留消息')) return;
  if (!text) { console.log('  用法: node collab.mjs post "内容" [-t 主题]'); return; }
  const t = topic || 'note';
  const file = path.join(MAIL, `${stamp()}-from-${ME}-${t}.md`);
  fs.writeFileSync(file, `# ${t}\n\n- from: ${ME}\n- at: ${new Date().toISOString()}\n\n${text}\n`, 'utf8');
  console.log(`\n  ✓ 已投递: ${path.basename(file)}\n`);
}

function cmdRead() {
  ensure();
  const msgs = fs.readdirSync(MAIL).filter(f => f.endsWith('.md'));
  const read = JSON.parse(fs.readFileSync(READ_FILE, 'utf8'));
  const unread = msgs.filter(f => !read[f] && !f.includes(`-from-${ME}-`));
  if (!unread.length) { console.log('\n  没有新消息。\n'); return; }
  for (const f of unread) {
    console.log('\n  ── ' + f + ' ' + '─'.repeat(Math.max(0, 40 - f.length)));
    console.log(fs.readFileSync(path.join(MAIL, f), 'utf8').trim());
  }
  console.log('');
}

function cmdAck() {
  ensure();
  const read = JSON.parse(fs.readFileSync(READ_FILE, 'utf8'));
  let n = 0;
  for (const f of fs.readdirSync(MAIL).filter(x => x.endsWith('.md'))) {
    if (!read[f] && !f.includes(`-from-${ME}-`)) { read[f] = new Date().toISOString(); n++; }
  }
  fs.writeFileSync(READ_FILE, JSON.stringify(read, null, 2) + '\n', 'utf8');
  console.log(`\n  ✓ 已标记 ${n} 条为已读。\n`);
}

function readLoad() {
  try { return JSON.parse(fs.readFileSync(LOAD_FILE, 'utf8')); }
  catch { return { updated: null, agents: {} }; }
}

// 负载看板：随时可用，但要按工作量分摊 —— 派活前先看这张表
function cmdLoad(state, note) {
  ensure();
  const j = readLoad();
  j.agents = j.agents || {};
  if (!state) {
    console.log('\n  ══ 负载看板 ══');
    const ids = Object.keys(j.agents);
    if (!ids.length) console.log('  还没有人登记。用：node collab.mjs load busy "在做什么"');
    for (const id of ids) {
      const a = j.agents[id];
      const tag = a.state === 'busy' ? '忙' : a.state === 'standby' ? '待命' : '空闲';
      console.log(`  ${id.padEnd(20)} ${tag.padEnd(4)} ${a.current || ''}   (${a.since || ''})`);
    }
    console.log(`  更新于 ${j.updated || '—'}\n`);
    return;
  }
  if (!['idle', 'busy', 'standby'].includes(state)) {
    console.log('  用法: node collab.mjs load [idle|busy|standby] "当前在做什么"');
    return;
  }
  j.agents[ME] = { state, current: note || '', since: new Date().toISOString() };
  j.updated = new Date().toISOString();
  fs.writeFileSync(LOAD_FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
  const tag = state === 'busy' ? '忙' : state === 'standby' ? '待命' : '空闲';
  console.log(`\n  ✓ ${ME} → ${tag}${note ? '  ' + note : ''}\n`);
}

function cmdShared() {
  ensure();
  if (!needArm('初始化共通记忆')) return;
  if (fs.existsSync(SHARED_FILE)) {
    console.log('\n  ── SHARED.md ──');
    console.log(fs.readFileSync(SHARED_FILE, 'utf8').trim());
    console.log('');
    return;
  }
  fs.writeFileSync(SHARED_FILE, `# 共通记忆库（DSH ↔ DSH）

本文件是**两个 DSH 工作区共同维护**的合作记录。规则：

1. 只写**合作事实**，不写各自项目的内部细节（那些在各自项目的 STATE.md）
2. 每条带日期 + 署名（${ME} / dsh-orchestra）
3. 有分歧就两条都留，不要覆盖对方的
4. 每次协同结束追加一节，不重写全文

---

## 0 建立

- 2026-11-13 由 ${ME} 初始化，等待对端确认
`, 'utf8');
  console.log(`\n  ✓ 已创建 ${SHARED_FILE}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const ti = rest.indexOf('-t');
const topic = ti >= 0 ? rest[ti + 1] : '';
const text = rest.filter((_, i) => ti < 0 || (i !== ti && i !== ti + 1)).join(' ');

switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'arm': cmdArm(); break;
  case 'disarm': cmdDisarm(); break;
  case 'post': cmdPost(text, topic); break;
  case 'read': cmdRead(); break;
  case 'ack': cmdAck(); break;
  case 'shared': cmdShared(); break;
  case 'load': cmdLoad(rest[0], rest.slice(1).join(' ')); break;
  default:
    console.log(`用法:
  node collab.mjs status
  node collab.mjs arm | disarm
  node collab.mjs post "内容" [-t 主题]
  node collab.mjs read | ack
  node collab.mjs shared
  node collab.mjs load                看负载看板
  node collab.mjs load busy|idle|standby "在做什么"`);
}
