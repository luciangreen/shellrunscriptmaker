// shellrun script logic, shared by the browser app and the Node runner (no Node-only imports).
//
// A script is JSON, saved as <name>.shellrun.json:
// {
//   "name": "Breasoning",
//   "stopOnFail": true,
//   "tempDir": false,
//   "steps": [
//     { "type": "cmd",    "cwd": "Dropbox/GitHub-private2/Text-to-Breasonings", "cmd": "mv", "args": ["a", "b"] },
//     { "type": "prolog", "cwd": "...", "goals": ["['text_to_breasonings.pl']", "texttobr(u,\"file.txt\",u,u)"],
//       "stackLimit": "54G", "interactive": false, "stdoutTo": "" },
//     { "type": "pause",  "message": "Check the output, then continue" }
//   ]
// }
// Folders (cwd) are relative to the suite folder.

export const STEP_TYPES = ['cmd', 'prolog', 'pause'];

// Join and normalise POSIX-style relative paths. Never returns a path starting with "../".
export function joinPath(base, rel) {
  if (!rel) return base;
  const parts = (rel.startsWith('/') ? rel : `${base}/${rel}`).split('/');
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

// Split a command line like a shell would for quoting: a 'b c' "d e" -> ['a', 'b c', 'd e'].
export function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

const SHELL_FEATURES = /[|&;<>`]|\$\(/;

// Remove a trailing % comment from a Prolog line, ignoring % inside quotes.
export function stripPrologComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '%') {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

const isConsultQuery = (q) => /^\[[^\]]*\]$/.test(q.trim());

// Turn pasted Terminal and Prolog instructions into steps.
// Understands: cd, swipl sessions (queries ending in "."), halt., "% ... STOP HERE ..." lines
// (become a pause; the Prolog session then restarts with the same files loaded), # comments.
export function parseCommands(text, { cwd: startCwd = '' } = {}) {
  const steps = [];
  const warnings = [];
  let cwd = startCwd;
  let session = null;

  const flush = () => {
    if (!session) return;
    if (session.buffer.trim()) {
      warnings.push(`Prolog query not ended with ".": ${session.buffer.trim()}`);
    }
    if (session.goals.some((g) => !isConsultQuery(g))) {
      steps.push({ type: 'prolog', cwd: session.cwd, goals: session.goals, stackLimit: session.stackLimit, interactive: false, stdoutTo: '' });
    }
    session = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (session) {
      if (!line) continue;
      if (line.startsWith('%')) {
        if (/stop here/i.test(line)) {
          const consults = session.goals.filter(isConsultQuery);
          const { cwd: c, stackLimit } = session;
          flush();
          steps.push({ type: 'pause', message: line.replace(/^%+\s*\**\s*/, '').trim() || 'Paused' });
          session = { cwd: c, stackLimit, goals: [...consults], buffer: '' };
        }
        continue;
      }
      session.buffer += (session.buffer ? ' ' : '') + stripPrologComment(line);
      if (session.buffer.endsWith('.')) {
        const q = session.buffer.slice(0, -1).trim();
        session.buffer = '';
        if (/(^|,)\s*halt$/.test(q)) {
          // "halt." or "noprotocol, halt." ends the session
          const rest = q.replace(/,?\s*halt$/, '').trim();
          if (rest) session.goals.push(rest);
          flush();
        } else if (q) session.goals.push(q);
      }
      continue;
    }
    if (!line || line.startsWith('#') || line.startsWith('%')) continue;
    if (/^(logout|exit)$/.test(line)) continue;
    const args = splitArgs(line);
    if (args[0] === 'cd') {
      cwd = args[1] === undefined || args[1] === '~' ? '' : joinPath(cwd, args[1].replace(/^~\//, '/'));
      continue;
    }
    if (args[0] === 'swipl') {
      const limit = args.find((a) => a.startsWith('--stack-limit='));
      session = { cwd, stackLimit: limit ? limit.split('=')[1] : '', goals: [], buffer: '' };
      continue;
    }
    if (SHELL_FEATURES.test(line)) {
      warnings.push(`Uses shell features (pipes, redirects, ;, &&), which run only if "bash" is allowed: ${line}`);
    }
    steps.push({ type: 'cmd', cwd, cmd: args[0], args: args.slice(1) });
  }
  flush();
  return { steps, warnings };
}

// One goal for swipl -g that behaves like typing the queries at the ?- prompt:
// each query runs on its own (no shared variables), a failing query prints a warning
// and the rest still run, as at the prompt.
export function buildPrologGoal(goals) {
  const parts = goals.map((g, i) => {
    const q = g.trim().replace(/\.\s*$/, '');
    return `(\\+ \\+ catch((${q}), E, (print_message(error, E), fail)) -> true ; format(user_error, "Warning: query ~w failed~n", [${i + 1}]))`;
  });
  return parts.length ? parts.join(', ') : 'true';
}

export function prologArgs(step, defaultStackLimit = '54G') {
  const limit = step.stackLimit || defaultStackLimit;
  if (!/^\d+[KMG]?$/.test(String(limit))) throw new Error(`Stack limit looks like 54G, got "${limit}"`);
  return [`--stack-limit=${limit}`, '-g', buildPrologGoal(step.goals ?? []), '-t', 'halt'];
}

export function stepLabel(step) {
  if (step.label) return step.label;
  if (step.type === 'cmd') return [step.cmd, ...(step.args ?? [])].join(' ');
  if (step.type === 'prolog') {
    const main = (step.goals ?? []).filter((g) => !isConsultQuery(g));
    return `Prolog: ${(main[0] ?? '').slice(0, 70)}${main.length > 1 ? ` (+${main.length - 1} more)` : ''}`;
  }
  return `Pause: ${step.message ?? ''}`;
}

export function validateScript(script) {
  const errors = [];
  if (!script || typeof script !== 'object') return ['Script must be an object'];
  if (!Array.isArray(script.steps)) return ['Script needs a "steps" list'];
  script.steps.forEach((s, i) => {
    const n = `Step ${i + 1}`;
    if (!STEP_TYPES.includes(s.type)) errors.push(`${n}: unknown type "${s.type}"`);
    if (s.cwd !== undefined && typeof s.cwd !== 'string') errors.push(`${n}: folder must be text`);
    if (s.type === 'cmd') {
      if (!s.cmd || typeof s.cmd !== 'string') errors.push(`${n}: command is empty`);
      else if (/[\\/]/.test(s.cmd)) errors.push(`${n}: command must be a bare name like "swipl"`);
      if (s.args && (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string'))) errors.push(`${n}: arguments must be text`);
    }
    if (s.type === 'prolog') {
      if (!Array.isArray(s.goals) || !s.goals.length) errors.push(`${n}: add at least one query`);
      if (s.stackLimit && !/^\d+[KMG]?$/.test(s.stackLimit)) errors.push(`${n}: stack limit looks like 54G`);
      if (s.stdoutTo && (s.stdoutTo.includes('..') || s.stdoutTo.startsWith('/'))) errors.push(`${n}: output file must be a name inside the step's folder`);
    }
  });
  return errors;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A bash version of the script, to run in Terminal without the suite.
export function toShellScript(script, defaultStackLimit = '54G') {
  const lines = [
    '#!/bin/bash',
    `# ${script.name || 'shellrun script'} (made with shellrun)`,
    '# Folders are relative to ROOT, the suite folder.',
    'ROOT="${LUCIANOS_ROOT:-$HOME}"',
    script.stopOnFail === false ? '' : 'set -e',
    ''
  ];
  script.steps.forEach((s, i) => {
    lines.push(`# Step ${i + 1}: ${stepLabel(s).replace(/\n/g, ' ')}`);
    if (s.type !== 'pause') lines.push(`cd "$ROOT"/${shQuote(s.cwd || '.')}`);
    if (s.type === 'cmd') lines.push([s.cmd, ...(s.args ?? [])].map(shQuote).join(' '));
    if (s.type === 'prolog') {
      const cmd = ['swipl', ...prologArgs(s, defaultStackLimit)].map(shQuote).join(' ');
      lines.push(s.stdoutTo ? `${cmd} > ${shQuote(s.stdoutTo)}` : cmd);
    }
    if (s.type === 'pause') lines.push(`read -r -p ${shQuote(`${s.message || 'Paused'} Press Enter to continue (Ctrl-C to stop). `)} _`);
    lines.push('');
  });
  lines.push('echo "Finished."');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';
}

export function newScript(name = 'Untitled') {
  return { name, stopOnFail: true, tempDir: false, steps: [] };
}

// Lines the runner prints so the app can follow progress. Hidden from the output pane.
export const MARKER = '\u001eSHELLRUN ';
