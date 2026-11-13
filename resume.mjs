#!/usr/bin/env node
// resume —— 项目记忆接续 CLI
//
//   node resume.mjs init <路径> [--name 名字] [--goal 目标]
//   node resume.mjs list                         所有项目一张表（按最后活动排序）
//   node resume.mjs <项目>                       接续简报（下一步/卡住/进行中/流水）
//   node resume.mjs <项目> --slim                压成一行，给别人塞 prompt 用
//   node resume.mjs add   <项目> "待办内容"       加一条 - [ ] 待办
//   node resume.mjs done  <项目> "关键词"         把匹配的待办勾成完成
//   node resume.mjs block <项目> "关键词" ["原因"] 标成卡住
//   node resume.mjs next  <项目> "下一步做什么"    替换「下一步」整段
//   node resume.mjs note  <项目> "发生了什么"      追加一条流水
//
// 项目参数支持：注册名 / 绝对路径 / 路径尾段目录名
import {
  register, listProjects, readProject, brief, renderBrief, renderList,
  addItem, markDone, markBlocked, setNext, note, touch,
} from './lib/project-memory.mjs';

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const flag = (name) => {
  const i = rest.indexOf('--' + name);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
  return v === undefined || v.startsWith('--') ? true : v;
};

function usage() {
  console.log(`resume —— 项目记忆接续

  init  <路径> [--name N] [--goal G]   建立项目记忆（在项目根目录生成 STATE.md）
  list                                所有项目 + 最后活动 + 下一步
  <项目>                              接续简报
  <项目> --slim                       一行版，塞进 prompt 用

  add   <项目> "内容"                  加待办
  done  <项目> "关键词"                勾完成
  block <项目> "关键词" ["原因"]       标卡住
  next  <项目> "内容"                  改下一步
  note  <项目> "内容"                  记流水

项目名可以是注册名、绝对路径、或目录名。`);
}

if (!cmd || cmd === 'help' || cmd === '--help') { usage(); process.exit(0); }

if (cmd === 'init') {
  const target = rest[0];
  if (!target) { console.error('要指定项目路径'); process.exit(2); }
  const name = flag('name');
  const goal = flag('goal');
  const e = register(target, { name: typeof name === 'string' ? name : undefined, goal: typeof goal === 'string' ? goal : undefined });
  console.log(`已建立项目记忆：${e.name}`);
  console.log(`  root   ${e.root}`);
  console.log(`  STATE  ${e.root}\\STATE.md`);
  console.log('\n下一步：把「目标」和「下一步」两段填掉，之后每次开工读这一份就行。');
  process.exit(0);
}

if (cmd === 'list') { console.log(renderList()); process.exit(0); }

const ACTIONS = new Set(['add', 'done', 'block', 'next', 'note']);
if (ACTIONS.has(cmd)) {
  const who = rest.shift();
  const plain = rest.filter(x => !x.startsWith('--'));
  // block 的第一个参数是「关键词」，剩下的是「原因」；其他命令整段都是内容
  const text = (cmd === 'block' ? (plain[0] || '') : plain.join(' ')).trim();
  const reason = cmd === 'block' ? plain.slice(1).join(' ').trim() : '';
  if (!who || !text) { console.error(`用法: resume.mjs ${cmd} <项目> "内容"`); process.exit(2); }
  try {
    if (cmd === 'add') { addItem(who, text); console.log('已加待办：' + text); }
    if (cmd === 'done') {
      const r = markDone(who, text);
      console.log(r.changed ? `已勾完成 ${r.hit} 项（含「${text}」）` : `没找到含「${text}」的未完成项`);
    }
    if (cmd === 'block') {
      const r = markBlocked(who, text, reason);
      console.log(r.changed ? `已标卡住 ${r.hit} 项` : `没找到含「${text}」的未完成项`);
    }
    if (cmd === 'next') { setNext(who, text); console.log('已更新下一步：' + text); }
    if (cmd === 'note') { note(who, text); console.log('已记流水：' + text); }
    process.exit(0);
  } catch (e) {
    console.error('ERR ' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  }
}

// 默认：当项目名处理
const slim = argv.includes('--slim');
const who = cmd;
const p = readProject(who);
if (!p) {
  console.error(`没有这个项目：${who}`);
  const ps = listProjects();
  if (ps.length) console.error('试试：' + ps.map(x => x.name).join(' / '));
  process.exit(2);
}
touch(p.name);
if (slim) {
  const b = brief(who, { slim: true });
  console.log(b.missing ? `[${b.name}] 无 STATE.md` : `${b.name} ｜ ${b.slim}`);
} else {
  console.log(renderBrief(brief(who)));
}
