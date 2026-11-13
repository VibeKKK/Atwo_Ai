// 共享工作记忆：所有 AI 共读同一份 STATE.md，DSH 负责写。
// 目的：别的 AI 不需要重新解释背景，DSH 也不需要每次把上下文重讲一遍。
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEM = join(ROOT, 'memory');
const STATE = join(MEM, 'STATE.md');
const LOG = join(MEM, 'log.jsonl');

mkdirSync(MEM, { recursive: true });

const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const DEFAULT_STATE = `# 团队工作记忆
> 所有 AI 共用这一份。DSH 写，其他人读。改动走 orchestra.mjs，不要手改。

## 项目
- 名称：Orchestra（AI 协作台）
- 位置：D:\\ai project\\ai team work
- 用途：DSH 拆任务写提示词 → 派给 Trae / CodeBuddy 执行 → DSH 验收 → 记账

## 当前阶段
- 时间：{{now}}
- 状态：打通 Trae 派活与互审，接入共享记忆

## 已确认的事实
- Trae CN 可用 CDP 全自动驱动：启动参数 --remote-debugging-port=9223，Agent 面板 title 为 "Agent"
- 输入框是 Lexical 编辑器（div.chat-input-v2-input-box-editable，contenteditable=true）
- 写入只能靠派发 ClipboardEvent('paste')，且必须轮询等待 DOM 更新（不能同步读 innerText）
- 清空必须用 CDP 真实键盘：Ctrl+A → Delete（JS 的 execCommand 无效）
- Lexical 把每个段落渲染成 <p>，innerText 的换行会翻倍，字符串比较要先归一化
- CodeBuddy 本机尚未安装

## 待办
- 按 Trae 评审修 askTrae 的 before/addedText/超时/开始判定
- CodeBuddy 接入

## 最近一次派活
- （空）
`;

export function readState() {
  if (!existsSync(STATE)) { writeFileSync(STATE, DEFAULT_STATE.replace('{{now}}', now()), 'utf8'); }
  return readFileSync(STATE, 'utf8');
}

export function writeState(text) {
  writeFileSync(STATE, text, 'utf8');
  return text;
}

/** 把「最近一次派活」那一节换掉 */
export function setLastJob(entry) {
  let s = readState();
  const block = `- 时间：${entry.time || now()}
- 指派给：${entry.agent}
- 任务：${entry.promptSummary}
- 耗时：${entry.elapsedMs != null ? (entry.elapsedMs / 1000).toFixed(1) + 's' : '—'}
- 结果：${entry.ok ? '成功' : '失败 — ' + (entry.error || '')}
- 产出长度：${entry.outputChars ?? '—'} 字符`;
  s = s.replace(/## 最近一次派活[\s\S]*$/, '## 最近一次派活\n' + block + '\n');
  writeState(s);
  return s;
}

export function appendLog(entry) {
  appendFileSync(LOG, JSON.stringify({ time: now(), ...entry }) + '\n', 'utf8');
}

export function readLog(n = 20) {
  if (!existsSync(LOG)) return [];
  const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

/**
 * 拼一段可以直接塞进 prompt 的上下文。
 * 默认走 slim 模式：只给「项目 / 当前阶段 / 待办 / 最近一次派活」。
 * 完整 STATE.md 动辄 2-3KB，每派一次都烧一遍 token，没必要——细节让对方来问。
 */
export function buildContext(opts = {}) {
  const { full = false, maxChars = 1200 } = opts;
  const raw = readState();
  let body;
  if (full) {
    body = raw.length > maxChars ? raw.slice(0, maxChars) + '\n…（截断）' : raw;
  } else {
    const grab = (title) => {
      const re = new RegExp('## ' + title + '\\n([\\s\\S]*?)(?=\\n## |$)');
      const mm = raw.match(re);
      return mm ? mm[1].trim() : '';
    };
    const parts = [];
    const proj = grab('项目');
    const stage = grab('当前阶段');
    const todo = grab('待办');
    const last = grab('最近一次派活');
    if (proj) parts.push('## 项目\n' + proj);
    if (stage) parts.push('## 当前阶段\n' + stage);
    if (todo) parts.push('## 待办\n' + todo);
    if (last) parts.push('## 最近一次派活\n' + last);
    body = parts.join('\n\n');
    if (body.length > maxChars) body = body.slice(0, maxChars) + '\n…（截断）';
  }
  return `\n\n[共享工作记忆 · DSH 维护，需要细节直接问]\n${body}\n[/记忆]\n`;
}