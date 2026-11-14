// 路径与端口的唯一来源。
//
// 为什么需要它：Trae 的 exe 路径、codebuddy 的 CLI 路径、CDP 端口以前散落在
// agents/*.mjs 的默认值里，换一台机器要翻三个文件改。现在集中在这里，
// 优先级：环境变量 > config.local.json > 内置默认值。
//
// config.local.json 不进 git（每台机器可以不一样），格式：
//   { "traeExe": "...", "codebuddyCli": "...", "traePort": 9223 }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（lib/ 的上一级） */
export const ROOT = path.join(HERE, '..');

const LOCAL_FILE = path.join(ROOT, 'config.local.json');

function readLocal() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
  } catch (e) {
    // 配置写坏了不应该让整个程序起不来，但必须让人看见
    console.error('[config] config.local.json 解析失败，已忽略：' + e.message);
    return {};
  }
}

const local = readLocal();

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '') ?? '';

// 用户主目录（Windows 上优先 USERPROFILE，其它平台退回 HOME）——
// 以前这些路径被写死在 agents/*.mjs 里，换台机器就得改四五个文件。
const HOME = pick(process.env.USERPROFILE, process.env.HOME, '');
const joinHome = (...parts) => (HOME ? path.join(HOME, ...parts) : '');

export const config = {
  root: ROOT,
  localFile: LOCAL_FILE,
  hasLocal: fs.existsSync(LOCAL_FILE),
  traeExe: pick(process.env.TRAE_EXE, local.traeExe, 'D:\\code app\\ai code\\Trae CN\\Trae CN.exe'),
  traePort: Number(pick(process.env.TRAE_CDP_PORT, local.traePort, 9223)),
  codebuddyCli: pick(process.env.CODEBUDDY_CLI, local.codebuddyCli, joinHome('Tools', 'codebuddy-cli', 'package')),
  workbuddyExe: pick(process.env.WB_EXE, local.workbuddyExe, 'D:\\code app\\ai code\\WorkBuddy\\WorkBuddy.exe'),
  workbuddyPort: Number(pick(process.env.WB_PORT, local.workbuddyPort, 9224)),
  timeoutMs: Number(pick(process.env.ORCH_TIMEOUT_MS, local.timeoutMs, 240000)),
  // DSH 自身：插件 node_modules、skill 目录、内置 python（都能被环境变量覆盖）
  dshRoot: pick(process.env.DSH_HOME, local.dshRoot, joinHome('.dsh')),
  skillsDir: pick(process.env.ORCH_SKILLS_DIR, local.skillsDir, joinHome('.dsh', 'skills')),
  // python 候选：从上到下第一个能跑的就是它（lib/syntax.mjs、eval/judge.mjs 共用）
  pythonCandidates: (() => {
    const env = process.env.ORCH_PYTHON;
    const own = [env, local.python].filter(Boolean);
    return own.length ? own : [
      joinHome('.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
      joinHome('AppData', 'Local', 'Programs', 'Python', 'Python315', 'python.exe'),
      'python3',
      'python',
    ].filter(Boolean);
  })(),
};

/** 每一项的来源，doctor 用来说"这个值是哪来的" */
export function configSources() {
  const src = (envVal, localVal, dflt) => (envVal ? 'env' : (localVal ? 'config.local.json' : '默认值'));
  return {
    traeExe: src(process.env.TRAE_EXE, local.traeExe),
    traePort: src(process.env.TRAE_CDP_PORT, local.traePort),
    codebuddyCli: src(process.env.CODEBUDDY_CLI, local.codebuddyCli),
    workbuddyExe: src(process.env.WB_EXE, local.workbuddyExe),
    workbuddyPort: src(process.env.WB_PORT, local.workbuddyPort),
    timeoutMs: src(process.env.ORCH_TIMEOUT_MS, local.timeoutMs),
    dshRoot: src(process.env.DSH_HOME, local.dshRoot),
    skillsDir: src(process.env.ORCH_SKILLS_DIR, local.skillsDir),
    pythonCandidates: src(process.env.ORCH_PYTHON, local.python),
  };
}

/** 写一份模板 config.local.json（不覆盖已有文件） */
export function writeLocalTemplate(force = false) {
  if (fs.existsSync(LOCAL_FILE) && !force) return { ok: false, reason: '已存在，未覆盖' };
  const tpl = {
    _comment: '本机路径配置。不进 git。优先级：环境变量 > 本文件 > 内置默认值。',
    traeExe: config.traeExe,
    traePort: config.traePort,
    codebuddyCli: config.codebuddyCli,
    workbuddyExe: config.workbuddyExe,
    workbuddyPort: config.workbuddyPort,
    timeoutMs: config.timeoutMs,
  };
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
  return { ok: true, file: LOCAL_FILE };
}
