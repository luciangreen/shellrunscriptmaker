#!/usr/bin/env node
// Runs a shellrun script step by step. Started by the shellrun app as a LucianOS job:
//   node runner.mjs <script.shellrun.json relative to the suite folder>
// Applies the suite's rules (from the job's environment): commands must be in the
// allowlist, folders must be inside the suite folder, nothing runs through a shell.
// Pause steps wait for a line on stdin: Enter continues, "stop" ends the run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { MARKER, prologArgs, stepLabel, validateScript } from './lib/script.js';

const ROOT = fs.realpathSync(process.env.LUCIANOS_ROOT || process.env.HOME);
const ALLOWED = (process.env.LUCIANOS_ALLOWED_COMMANDS || '').split(',').filter(Boolean);
const STACK = process.env.LUCIANOS_STACK_LIMIT || '54G';

const mark = (data) => process.stdout.write(`${MARKER}${JSON.stringify(data)}\n`);
const say = (text) => process.stdout.write(text);
let current = null;
let stopping = false;

function insideRoot(rel) {
  const abs = path.resolve(ROOT, rel || '.');
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new Error(`Folder is outside the suite folder: ${rel}`);
  return real;
}

function run(cmd, args, { cwd, interactive, stdoutTo }) {
  if (!ALLOWED.includes(cmd)) throw new Error(`"${cmd}" is not in allowedCommands in the suite's config.json`);
  return new Promise((resolve) => {
    let out = 'inherit';
    let fd = null;
    if (stdoutTo) {
      fd = fs.openSync(path.join(cwd, stdoutTo), 'w');
      out = fd;
    }
    const child = spawn(cmd, args, { cwd, shell: false, stdio: [interactive ? 'inherit' : 'ignore', out, 'inherit'] });
    current = child;
    child.on('error', (err) => {
      say(`Could not start ${cmd}: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      current = null;
      if (fd !== null) fs.closeSync(fd);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

function waitForLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      resolve(line);
      rl.close();
    });
    // stdin closed with no answer: treat as stop
    rl.once('close', () => {
      if (!answered) resolve('stop');
    });
  });
}

async function main() {
  const scriptArg = process.argv[2];
  if (!scriptArg) throw new Error('Usage: node runner.mjs <script.shellrun.json>');
  const scriptPath = path.isAbsolute(scriptArg) ? scriptArg : path.join(ROOT, scriptArg);
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const errors = validateScript(script);
  if (errors.length) throw new Error(errors.join('\n'));

  const total = script.steps.length;
  say(`shellrun: ${script.name || path.basename(scriptPath)} (${total} steps)\n`);
  mark({ event: 'begin', total });
  let failures = 0;
  for (let i = 0; i < total; i++) {
    if (stopping) break;
    const step = script.steps[i];
    say(`\n── Step ${i + 1}/${total}: ${stepLabel(step)}\n`);
    mark({ event: 'step', index: i, status: 'running' });
    let code = 0;
    try {
      if (step.type === 'pause') {
        mark({ event: 'step', index: i, status: 'waiting' });
        say(`${step.message || 'Paused.'}\nPress Continue to go on, or Stop to end here.\n`);
        const line = await waitForLine();
        if (line.trim().toLowerCase() === 'stop') {
          say('Stopped at the pause.\n');
          mark({ event: 'step', index: i, status: 'stopped' });
          mark({ event: 'end', status: 'stopped' });
          process.exit(130);
        }
      } else {
        const cwd = insideRoot(step.cwd);
        const [cmd, args] = step.type === 'cmd' ? [step.cmd, step.args ?? []] : ['swipl', prologArgs(step, STACK)];
        code = await run(cmd, args, { cwd, interactive: !!step.interactive, stdoutTo: step.stdoutTo });
      }
    } catch (err) {
      say(`${err.message}\n`);
      code = 1;
    }
    if (stopping) break;
    mark({ event: 'step', index: i, status: code === 0 ? 'done' : 'failed', code });
    if (code !== 0) {
      failures++;
      say(`Step ${i + 1} failed (exit ${code}).\n`);
      if (script.stopOnFail !== false) {
        mark({ event: 'end', status: 'failed' });
        process.exit(code);
      }
    }
  }
  if (stopping) return;
  mark({ event: 'end', status: failures ? 'failed' : 'done' });
  say(failures ? `\nFinished with ${failures} failed step(s).\n` : '\nAll steps finished.\n');
  process.exit(failures ? 1 : 0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    stopping = true;
    say('\nInterrupted.\n');
    if (current) current.kill('SIGTERM');
    setTimeout(() => process.exit(143), current ? 3000 : 0).unref();
    if (!current) process.exit(143);
    current?.on('close', () => process.exit(143));
  });
}

main().catch((err) => {
  say(`${err.message}\n`);
  mark({ event: 'end', status: 'failed' });
  process.exit(1);
});
