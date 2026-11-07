import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MARKER } from '../lib/script.js';

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner.mjs');
let base, root, bin;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'shellrun-test-'));
  root = path.join(base, 'root');
  bin = path.join(base, 'bin');
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  fs.mkdirSync(bin);
  // Stand-in for swipl: prints its arguments and folder.
  fs.writeFileSync(path.join(bin, 'swipl'), `#!/usr/bin/env node\nconsole.log('FAKE-SWIPL ' + JSON.stringify(process.argv.slice(2)) + ' in ' + process.cwd());\n`, { mode: 0o755 });
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

function runScript(script, { input = [], allowed = 'echo,node,swipl,ls' } = {}) {
  const file = path.join(root, 'work', `s${Math.random().toString(16).slice(2)}.shellrun.json`);
  fs.writeFileSync(file, JSON.stringify(script));
  return new Promise((resolve) => {
    const child = spawn('node', [RUNNER, path.relative(root, file)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LUCIANOS_ROOT: root, LUCIANOS_ALLOWED_COMMANDS: allowed, LUCIANOS_STACK_LIMIT: '1G' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    const pending = [...input];
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"status":"waiting"') && pending.length) {
        const line = pending.shift();
        setTimeout(() => child.stdin.write(line + '\n'), 20);
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      const markers = out.split('\n').filter((l) => l.startsWith(MARKER)).map((l) => JSON.parse(l.slice(MARKER.length)));
      resolve({ code, out, markers });
    });
  });
}

test('runs command, Prolog and pause steps in order', async () => {
  const r = await runScript({
    name: 'demo',
    steps: [
      { type: 'cmd', cwd: 'work', cmd: 'echo', args: ['hello $(whoami)'] },
      { type: 'pause', message: 'Check it' },
      { type: 'prolog', cwd: 'work', goals: ["['t2b.pl']", 'texttobr(u,"file.txt",u,u)'], stackLimit: '54G' },
      { type: 'prolog', cwd: 'work', goals: ['true'], stdoutTo: 'captured.txt' }
    ]
  }, { input: [''] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /hello \$\(whoami\)/); // no shell
  assert.match(r.out, /FAKE-SWIPL \["--stack-limit=54G","-g",".*texttobr\(u,\\"file.txt\\",u,u\).*","-t","halt"\]/);
  assert.match(r.out, new RegExp(`in ${fs.realpathSync(root)}/work`));
  assert.match(fs.readFileSync(path.join(root, 'work', 'captured.txt'), 'utf8'), /--stack-limit=1G/);
  assert.deepEqual(r.markers.at(-1), { event: 'end', status: 'done' });
  assert.ok(r.markers.some((m) => m.status === 'waiting' && m.index === 1));
});

test('"stop" at a pause ends the run', async () => {
  const r = await runScript({ steps: [{ type: 'pause', message: 'Thesis?' }, { type: 'cmd', cmd: 'echo', args: ['should not run'] }] }, { input: ['stop'] });
  assert.equal(r.code, 130);
  assert.doesNotMatch(r.out, /should not run/);
});

test('stops at a failed step unless told to carry on', async () => {
  const failing = { type: 'cmd', cmd: 'node', args: ['-e', 'process.exit(4)'] };
  const after1 = { type: 'cmd', cmd: 'echo', args: ['after'] };
  let r = await runScript({ steps: [failing, after1] });
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.out, /\nafter\n/);
  r = await runScript({ stopOnFail: false, steps: [failing, after1] });
  assert.equal(r.code, 1);
  assert.match(r.out, /\nafter\n/);
});

test('applies the suite allowlist and folder rules', async () => {
  let r = await runScript({ steps: [{ type: 'cmd', cmd: 'ls' }] }, { allowed: 'echo' });
  assert.equal(r.code, 1);
  assert.match(r.out, /not in allowedCommands/);
  r = await runScript({ steps: [{ type: 'cmd', cwd: '../..', cmd: 'echo', args: ['x'] }] });
  assert.equal(r.code, 1);
  assert.match(r.out, /outside the suite folder/);
});

test('rejects an invalid script before running anything', async () => {
  const r = await runScript({ steps: [{ type: 'cmd', cmd: '/bin/rm', args: ['-rf', 'x'] }] });
  assert.equal(r.code, 1);
  assert.match(r.out, /bare name/);
});
