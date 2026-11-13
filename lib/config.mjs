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

export const config = {
  root: ROOT,
  localFile: LOCAL_FILE,
  hasLocal: fs.existsSync(LOCAL_FILE),
  traeExe: pick(process.env.TRAE_EXE, local.traeExe, 'D:\\code app\\ai code\\Trae CN\\Trae CN.exe'),
  traePort: Number(pick(process.env.TRAE_CDP_PORT, local.traePort, 9223)),
  codebuddyCli: pick(process.env.CODEBUDDY_CLI, local.codebuddyCli, 'C:\\Users\\kkk\\Tools\\codebuddy-cli\\package'),
  timeoutMs: Number(pick(process.env.ORCH_TIMEOUT_MS, local.timeoutMs, 240000)),
};

/** 每一项的来源，doctor 用来说"这个值是哪来的" */
export function configSources() {
  const src = (envVal, localVal, dflt) => (envVal ? 'env' : (localVal ? 'config.local.json' : '默认值'));
  return {
    traeExe: src(process.env.TRAE_EXE, local.traeExe),
    traePort: src(process.env.TRAE_CDP_PORT, local.traePort),
    codebuddyCli: src(process.env.CODEBUDDY_CLI, local.codebuddyCli),
    timeoutMs: src(process.env.ORCH_TIMEOUT_MS, local.timeoutMs),
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
    timeoutMs: config.timeoutMs,
  };
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(tpl, null, 2) + '\n', 'utf8');
  return { ok: true, file: LOCAL_FILE };
}
