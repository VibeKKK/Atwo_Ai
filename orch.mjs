#!/usr/bin/env node
// orch.mjs —— 统一入口。把原先六个独立命令收成一个主命令 + 子命令组。
//
//   orch ask trae|codebuddy|workbuddy|auto "任务…"   派活（同 orchestra.mjs）
//   orch list | stats | budget | health | peek …     查询（均支持 --json）
//   orch db  put|get|list|del|log|tables|stat|compact|dbs  共享数据库（同 store.mjs）
//   orch peer board|me|post|read|watch               并肩看板（同 pair.mjs）
//   orch pr   list|show|approve|reject|undo|review|pending   提案（同 pr.mjs）
//   orch mail list|send|read                         邮箱（同 collab.mjs）
//   orch resume [项目]                                接续（同 resume.mjs）
//
// 设计：只做参数路由，不复制任何业务逻辑 —— 每个子命令都 spawn 原脚本，
// stdio 全继承，所以退出码、颜色、--json 输出都保持原样。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const sub = argv[0] || '';

// 不需要「组名」的直接命令 → 原样透传给 orchestra.mjs
const DIRECTORIES = new Set(['db', 'peer', 'pr', 'mail', 'resume']);
const ORCH_CMDS = new Set([
  'ask', 'auto', 'pick', 'batch', 'review', 'duo', 'stats', 'budget', 'health',
  'peek', 'list', 'memory', 'ctx', 'eph', 'doctor', 'probe', 'swarm', 'top',
]);

const TARGET = {
  db: 'store.mjs',
  peer: 'pair.mjs',
  pr: 'pr.mjs',
  mail: 'collab.mjs',
  resume: 'resume.mjs',
};

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exit(r.status === null ? 1 : r.status);
}

function usage() {
  console.log(`orch —— 本机 AI 协作台

派活
  orch ask <trae|codebuddy|workbuddy|auto> "<任务>" [--json] [--json-strict] [--skill 名字]
  orch auto "<任务>"            按任务性质自动选 agent
  orch pick "<任务>"            只显示会选谁，零成本
  orch batch "a" "b" "c"        多条小任务压一次调用
  orch swarm …                  多任务并发编排
  orch duo "<任务>"             两家同答，用来交叉验证

查询（都支持 --json）
  orch list | stats | budget | health | peek | top

共享数据库（两套库：project 会过期 / memory 不过期）
  orch db put project orchestra '{"状态":"开发中"}' [--db memory] [--note 说明]
  orch db get | list | del | log | tables | stat | compact | dbs  [--json]

并肩看板
  orch peer                  同屏看双方状态 + 两套库
  orch peer me "我在干什么"   更新我的状态
  orch peer post "内容"      给对方发信
  orch peer read | watch     读信 / 盯一会儿

提案（PR 式改动 + 审阅门）
  orch pr list | show <id> | approve <id> | reject <id> | undo <id> | pending
  orch pr review <id> --by rank1|rank2 [--note "意见"] [--reject]

其它
  orch mail …    邮箱
  orch resume    接续上次的项目记忆

惯例：所有查询命令加 --json 输出机器可读结果，错误也是 {\"ok\":false,code,message}。`);
}

if (!sub || sub === '-h' || sub === '--help' || sub === 'help') { usage(); process.exit(sub ? 0 : 2); }

if (DIRECTORIES.has(sub)) {
  const rest = argv.slice(1);
  // 没有子命令时给个最小提示，避免把「空参数」当成错误派活
  if (!rest.length) {
    const hint = { db: 'dbs', peer: 'board', pr: 'list', mail: 'list', resume: '' }[sub];
    run(TARGET[sub], hint ? [hint] : []);
  }
  run(TARGET[sub], rest);
}

if (ORCH_CMDS.has(sub)) run('orchestra.mjs', argv);

// 兜底：把第一个词当成 orchestra 的子命令再说，比如 orch 未知命令
console.error(`未知命令：${sub}\n可用：ask auto pick batch review duo swarm + list stats budget health peek top + db peer pr mail resume\n用 orch -h 看完整用法`);
process.exit(2);
