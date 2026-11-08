/**
 * 最小 STscript 子集：用于 Automation ID 和 /tavern/chats/:id/script。
 *
 * 支持：/pass /echo /setvar /addvar /incvar /decvar /getvar /flushvar /inject
 * 支持管道 {{pipe}}、局部变量 {{getvar::key}}。
 * 不支持的指令（/if /while /gen /send /cut 等）会记入 log.unsupported，不执行。
 */
import { substituteVariables } from './variables.js';

function splitCommands(script) {
  return String(script)
    .split('|')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('#'));
}

function splitArgs(value) {
  const out = [];
  const pattern = /(?:[^\s"]+|"[^"]*")+/g;
  let match;
  while ((match = pattern.exec(value)) !== null) out.push(match[0].replace(/^"|"$/g, ''));
  return out;
}

function parseCommand(line) {
  const match = line.match(/^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
  if (match === null) return null;
  const name = match[1].toLowerCase();
  const rest = match[2].trim();
  const args = splitArgs(rest);
  const named = {};
  const positional = [];
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq > 0) named[arg.slice(0, eq)] = arg.slice(eq + 1);
    else positional.push(arg);
  }
  return { name, rest, args, named, positional };
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {string} script
 * @param {{variables?: object, injections?: object[]}} state
 * @returns {{variables: object, injections: object[], log: object[], output: string, changed: boolean}}
 */
export function runScript(script, state = {}) {
  const variables = { ...(state.variables ?? {}) };
  const injections = Array.isArray(state.injections) ? state.injections.slice() : [];
  const log = [];
  let pipe = '';
  let changed = false;
  for (const line of splitCommands(script)) {
    const command = parseCommand(line);
    if (command === null) {
      log.push({ type: 'unsupported', line, reason: 'not-a-slash-command' });
      continue;
    }
    const { name, rest, named, positional } = command;
    const key = typeof named.key === 'string' && named.key.length > 0 ? named.key : (positional[0] ?? '');
    try {
      switch (name) {
        case 'pass':
          pipe = substituteVariables(rest || positional.join(' '), variables);
          log.push({ type: 'pass', output: pipe });
          break;
        case 'echo':
          log.push({ type: 'echo', text: substituteVariables(rest, variables).replaceAll('{{pipe}}', pipe) });
          break;
        case 'getvar':
          pipe = variables[key] === undefined ? '' : String(variables[key]);
          log.push({ type: 'getvar', key, value: pipe });
          break;
        case 'setvar': {
          if (key.length === 0) break;
          const value = named.value !== undefined ? named.value : rest.replace(/^\S+\s*/, '');
          variables[key] = substituteVariables(value, variables);
          changed = true;
          log.push({ type: 'setvar', key, value: variables[key] });
          break;
        }
        case 'addvar':
        case 'incvar':
        case 'decvar': {
          if (key.length === 0) break;
          const current = variables[key];
          const increment = name === 'addvar'
            ? (named.value !== undefined ? named.value : (rest.replace(/^\S+\s*/, '') || '0'))
            : (name === 'incvar' ? '1' : '-1');
          const left = numeric(current);
          const right = numeric(increment);
          variables[key] = left !== null && right !== null
            ? left + right
            : `${current ?? ''}${increment}`;
          changed = true;
          log.push({ type: name, key, value: variables[key] });
          break;
        }
        case 'flushvar':
          if (key.length > 0) {
            delete variables[key];
            changed = true;
            log.push({ type: 'flushvar', key });
          }
          break;
        case 'inject': {
          const id = typeof named.id === 'string' && named.id.length > 0 ? named.id : `auto_${injections.length + 1}`;
          const text = rest.replace(/(?:^|\s)id=\S+/, '').replace(/(?:^|\s)depth=\S+/, '').trim();
          if (text.length > 0) {
            injections.push({
              id,
              text: substituteVariables(text, variables),
              depth: Number.isFinite(Number(named.depth)) ? Math.max(0, Math.floor(Number(named.depth))) : 4,
              role: Number.isFinite(Number(named.role)) ? Math.max(0, Math.min(2, Math.floor(Number(named.role)))) : 0
            });
            changed = true;
            log.push({ type: 'inject', id, text });
          }
          break;
        }
        default:
          log.push({ type: 'unsupported', line, reason: `unknown-command:${name}` });
      }
    } catch (error) {
      log.push({ type: 'error', line, message: error?.message ?? String(error) });
    }
  }
  return { variables, injections, log, output: pipe, changed };
}
