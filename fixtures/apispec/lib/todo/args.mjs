/**
 * Parse command-line arguments for the todo CLI (ESM, zero dependencies).
 *
 * Forms: `add <文本>`, `list`, `done <序号>`, `rm <序号>`,
 * plus the modifiers `--file <路径>`, `--json`, `--help`.
 * Flags may appear before or after the command. Every result carries the
 * same six keys; unused fields are `null` and booleans default to `false`.
 * Unrecognised commands or flags yield `{ cmd: 'unknown', raw }`.
 *
 * @param {string[]} argv - Argument list, e.g. `process.argv.slice(2)`.
 * @returns {{cmd: string|null, text: string|null, index: number|null,
 *            file: string|null, json: boolean, help: boolean,
 *            raw?: string[]}} The parsed arguments.
 */
export function parseArgs(argv = []) {
  const raw = Array.isArray(argv) ? argv.slice() : [];
  const result = {
    cmd: null,
    text: null,
    index: null,
    file: null,
    json: false,
    help: false,
  };

  const positionals = [];
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    if (token === '--json') {
      result.json = true;
    } else if (token === '--help') {
      result.help = true;
    } else if (token === '--file') {
      const value = raw[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { cmd: 'unknown', raw };
      }
      result.file = value;
      i += 1;
    } else if (token.startsWith('-')) {
      return { cmd: 'unknown', raw };
    } else {
      positionals.push(token);
    }
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    if (result.help) {
      result.cmd = 'help';
      return result;
    }
    return { cmd: 'unknown', raw };
  }

  switch (command) {
    case 'add':
      if (rest.length === 0) {
        return { cmd: 'unknown', raw };
      }
      result.cmd = 'add';
      result.text = rest.join(' ');
      break;
    case 'list':
      result.cmd = 'list';
      break;
    case 'done':
    case 'rm': {
      const index = Number(rest[0]);
      if (rest.length === 0 || !Number.isInteger(index)) {
        return { cmd: 'unknown', raw };
      }
      result.cmd = command;
      result.index = index;
      break;
    }
    default:
      return { cmd: 'unknown', raw };
  }

  return result;
}
