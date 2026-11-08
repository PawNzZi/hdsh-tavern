/**
 * Automation ID 的最小执行层。
 *
 * 世界书条目激活时，如果带了 automationId，就查 `status_schema.automations[id]`
 * 并执行声明的动作。没有 STscript / Quick Replies 的完整运行时，但覆盖常见效果：
 *
 *   "automations": {
 *     "enter_tavern": [
 *       { "action": "addvar", "key": "affection", "value": 2 },
 *       { "action": "inject", "id": "tavern_mood", "text": "酒馆里很吵。", "depth": 4, "role": 0 }
 *     ],
 *     "night_event": { "action": "script", "script": "/addvar key=affection 1 | /inject id=night 夜深了。" }
 *   }
 */
import { runScript } from './script.js';

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function applyAction(action, state) {
  const type = action.action;
  const variables = state.variables;
  const log = [];
  switch (type) {
    case 'setvar': {
      const key = String(action.key ?? '').trim();
      if (key.length === 0) return log;
      variables[key] = action.value;
      log.push({ type: 'setvar', key, value: action.value });
      state.changed = true;
      return log;
    }
    case 'addvar':
    case 'incvar':
    case 'decvar': {
      const key = String(action.key ?? '').trim();
      if (key.length === 0) return log;
      const current = numeric(variables[key], 0);
      const delta = type === 'addvar'
        ? numeric(action.value, 0)
        : (type === 'incvar' ? 1 : -1);
      variables[key] = current + delta;
      state.changed = true;
      log.push({ type, key, value: variables[key] });
      return log;
    }
    case 'inject': {
      const text = String(action.text ?? '').trim();
      if (text.length === 0) return log;
      state.injections.push({
        id: String(action.id ?? `auto_${state.injections.length + 1}`),
        text,
        depth: Math.max(0, Math.min(100, Math.trunc(numeric(action.depth, 4)))),
        role: Math.max(0, Math.min(2, Math.trunc(numeric(action.role, 0))))
      });
      state.changed = true;
      log.push({ type: 'inject', text });
      return log;
    }
    case 'script': {
      const result = runScript(String(action.script ?? ''), {
        variables,
        injections: state.injections
      });
      state.variables = result.variables;
      state.injections = result.injections;
      if (result.changed) state.changed = true;
      return result.log;
    }
    default:
      return [{ type: 'unsupported', action: type }];
  }
}

/**
 * @param {string[]} automationIds 本轮激活条目上的 automationId
 * @param {object | null} schema statusSchemaFor(...)
 * @param {{variables: object, injections: object[]}} state
 * @returns {{log: object[], ran: string[], changed: boolean}}
 */
export function runAutomations(automationIds, schema, state) {
  const automations = schema?.automations ?? {};
  const runtime = {
    variables: { ...(state.variables ?? {}) },
    injections: Array.isArray(state.injections) ? state.injections.slice() : [],
    changed: false
  };
  const ran = [];
  const log = [];
  const seen = new Set();
  for (const id of automationIds || []) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const actions = Array.isArray(automations[id])
      ? automations[id]
      : (automations[id] === undefined ? [] : [automations[id]]);
    if (actions.length === 0) continue;
    ran.push(id);
    for (const action of actions) {
      if (typeof action === 'string') {
        const result = runScript(action, { variables: runtime.variables, injections: runtime.injections });
        runtime.variables = result.variables;
        runtime.injections = result.injections;
        runtime.changed = runtime.changed || result.changed;
        log.push(...result.log);
        continue;
      }
      if (action === null || typeof action !== 'object') continue;
      log.push(...applyAction(action, runtime));
    }
  }
  return { ...runtime, log, ran };
}
