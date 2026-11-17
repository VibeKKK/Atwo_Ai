/**
 * 纯 JSON 任务存储层（ESM）：磁盘上是一个 JSON 数组，本模块不解释任务对象的字段。
 * 写入采用「先写 filePath + '.tmp'，再 rename 覆盖」的原子替换，读者不会看到半截 JSON。
 * 仅依赖 node:fs 与 node:path，无第三方依赖。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

const ENCODING = 'utf8';
const TMP_SUFFIX = '.tmp';
const INDENT = 2;

/**
 * 读取任务列表。文件不存在返回 []；文件为空或仅空白也返回 []；
 * 非法 JSON 抛 SyntaxError，顶层不是数组抛 TypeError。
 *
 * @param {string} filePath - JSON 文件路径（相对或绝对）
 * @returns {Array<object>} 任务数组，文件缺失时为空数组
 * @throws {SyntaxError} 内容不是合法 JSON
 * @throws {TypeError} 顶层不是数组
 */
export function loadTasks(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = readFileSync(filePath, ENCODING).trim();
  if (raw === '') {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SyntaxError(`任务文件不是合法 JSON：${filePath}（${error.message}）`);
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`任务文件顶层必须是数组：${filePath}`);
  }
  return parsed;
}

/**
 * 原子写入任务列表：序列化 -> 写 .tmp -> rename 覆盖目标。
 * 临时文件与目标同目录，rename 为同文件系统内的原子替换；目标不存在时也能创建。
 * 写入失败会清理 .tmp，且不破坏已有的目标文件。
 *
 * @param {string} filePath - 目标 JSON 文件路径（相对或绝对）
 * @param {Array<object>} list - 需要持久化的任务数组
 * @returns {void}
 * @throws {TypeError} list 不是数组
 * @throws {Error} 目标目录不存在或文件系统写入失败
 */
export function saveTasks(filePath, list) {
  if (!Array.isArray(list)) {
    throw new TypeError('saveTasks 的第二个参数必须是数组');
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    throw new Error(`目标目录不存在：${dir}`);
  }
  const tmpPath = `${filePath}${TMP_SUFFIX}`;
  const payload = `${JSON.stringify(list, null, INDENT)}\n`;

  try {
    writeFileSync(tmpPath, payload, { encoding: ENCODING, flag: 'w' });
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // 清理失败不掩盖原始错误
    }
    throw error;
  }
}
