// shellrun app: make, save and run scripts of Terminal and Prolog commands.
import { api, notify } from '/shared/api.js';
import { MARKER, newScript, parseCommands, splitArgs, stepLabel, toShellScript, validateScript } from './lib/script.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
};

const APP_NAME = location.pathname.split('/')[2] || 'shellrunscriptmaker';
const DEFAULT_FOLDER = 'LucianOS/shellrun';
let info;
let script = newScript();
let scriptPath = null; // relative to the suite folder
let dirty = false;
let job = null;
let stopStream = null;
let pendingLine = '';

// ---------- state ----------
async function remember(extra = {}) {
  const prev = (await api.state.get('shellrun').catch(() => null)) ?? {};
  await api.state.set('shellrun', { ...prev, folder: $('folder').value.trim(), openPath: scriptPath, ...extra });
}

function setDirty(value) {
  dirty = value;
  $('dirty').textContent = dirty ? 'Unsaved' : '';
}

const slug = (name) => name.trim().replace(/[^A-Za-z0-9 _-]+/g, '').replace(/\s+/g, '-') || 'script';

// ---------- scripts list ----------
async function showScripts() {
  const folder = $('folder').value.trim();
  const list = $('scripts');
  list.replaceChildren();
  try {
    const { entries } = await api.files.list(folder);
    const scripts = entries.filter((e) => e.type === 'file' && e.name.endsWith('.shellrun.json'));
    for (const e of scripts) {
      const li = el('li', { title: e.path },
        el('span', { className: 'icon', textContent: '▶' }),
        el('span', { className: 'name', textContent: e.name.replace(/\.shellrun\.json$/, '') }));
      if (e.path === scriptPath) li.classList.add('selected');
      li.addEventListener('click', () => openScript(e.path));
      list.append(li);
    }
    if (!scripts.length) list.append(el('li', { className: 'quiet', textContent: 'No scripts here yet' }));
  } catch (err) {
    list.append(el('li', { className: 'quiet', textContent: err.status === 404 ? 'Folder does not exist yet. It is made when you save.' : err.message }));
  }
}

async function openScript(path) {
  if (dirty && !confirm('Discard unsaved changes to this script?')) return;
  try {
    const f = await api.files.read(path);
    const parsed = JSON.parse(f.content);
    script = { ...newScript(), ...parsed };
    scriptPath = f.path;
    setDirty(false);
    render();
    showScripts();
    remember();
  } catch (err) {
    alert(`Could not open ${path}: ${err.message}`);
  }
}

// ---------- step editor ----------
function field(label, input) {
  return [el('label', { textContent: label }), input];
}

function textInput(value, onInput, { list, ...props } = {}) {
  const input = el('input', { type: 'text', value: value ?? '', ...props });
  if (list) input.setAttribute('list', list);
  input.addEventListener('input', () => {
    onInput(input.value);
    setDirty(true);
    renderProblems();
  });
  return input;
}

function stepItem(step, i) {
  const li = el('li', {});
  li.dataset.type = step.type;
  li.dataset.index = i;
  const move = (d) => {
    const j = i + d;
    if (j < 0 || j >= script.steps.length) return;
    [script.steps[i], script.steps[j]] = [script.steps[j], script.steps[i]];
    setDirty(true);
    render();
  };
  li.append(el('div', { className: 'stephead' },
    el('span', { className: 'num', textContent: `Step ${i + 1}` }),
    el('span', { className: 'kind', textContent: { cmd: 'Terminal', prolog: 'Prolog', pause: 'Pause' }[step.type] }),
    el('span', { className: 'spacer' }),
    el('button', { textContent: '↑', title: 'Move up', onclick: () => move(-1) }),
    el('button', { textContent: '↓', title: 'Move down', onclick: () => move(1) }),
    el('button', { textContent: '✕', title: 'Delete step', onclick: () => { script.steps.splice(i, 1); setDirty(true); render(); } })));

  const fields = el('div', { className: 'fields' });
  if (step.type !== 'pause') {
    fields.append(...field('Folder', textInput(step.cwd, (v) => (step.cwd = v.trim()), { className: 'mono', placeholder: '(suite folder)' })));
  }
  if (step.type === 'cmd') {
    fields.append(...field('Command', textInput(step.cmd, (v) => (step.cmd = v.trim()), { className: 'mono', list: 'allowed' })));
    fields.append(...field('Arguments', textInput((step.args ?? []).map(quoteArg).join(' '), (v) => (step.args = splitArgs(v)), { className: 'mono' })));
  }
  if (step.type === 'prolog') {
    const goals = el('textarea', { spellcheck: false, value: (step.goals ?? []).map((g) => `${g}.`).join('\n') });
    goals.addEventListener('input', () => {
      step.goals = goals.value.split('\n').map((l) => l.trim().replace(/\.$/, '').trim()).filter(Boolean);
      setDirty(true);
      renderProblems();
    });
    fields.append(...field('Queries (one per line)', goals));
    fields.append(...field('Stack limit', textInput(step.stackLimit, (v) => (step.stackLimit = v.trim()), { className: 'mono', placeholder: info?.swiplStackLimit ?? '54G' })));
    fields.append(...field('Save output to', textInput(step.stdoutTo, (v) => (step.stdoutTo = v.trim()), { className: 'mono', placeholder: '(show it here)' })));
    const inter = el('input', { type: 'checkbox', checked: !!step.interactive });
    inter.addEventListener('change', () => { step.interactive = inter.checked; setDirty(true); });
    fields.append(el('label', { textContent: 'Interactive' }), el('span', { className: 'quiet' }, inter, ' Lets you type answers to the program (e.g. auto off)'));
  }
  if (step.type === 'pause') {
    fields.append(...field('Message', textInput(step.message, (v) => (step.message = v), {})));
  }
  li.append(fields);
  return li;
}

function quoteArg(a) {
  return a === '' || /[\s'"\\]/.test(a) ? `'${a.replace(/'/g, `'"'"'`)}'` : a;
}

function render() {
  $('name').value = script.name ?? '';
  $('stopOnFail').checked = script.stopOnFail !== false;
  $('tempDir').checked = !!script.tempDir;
  const list = $('steps');
  list.replaceChildren(...script.steps.map(stepItem));
  if (!script.steps.length) list.append(el('li', { className: 'quiet', textContent: 'No steps yet. Add one, or paste your commands.' }));
  renderProblems();
}

function renderProblems() {
  const problems = validateScript(script);
  $('problems').textContent = problems.join(' · ');
  return problems;
}

function addStep(step) {
  script.steps.push(step);
  setDirty(true);
  render();
}

// ---------- save / export ----------
async function save({ as = false } = {}) {
  script.name = $('name').value.trim() || 'Untitled';
  let path = scriptPath;
  if (as || !path) {
    const name = prompt('Save script as', script.name);
    if (!name) return false;
    script.name = name;
    const folder = $('folder').value.trim();
    path = `${folder ? `${folder}/` : ''}${slug(name)}.shellrun.json`;
  }
  try {
    await api.files.write(path, JSON.stringify(script, null, 2) + '\n', { mkdirs: true });
  } catch (err) {
    alert(`Could not save: ${err.message}`);
    return false;
  }
  scriptPath = path;
  setDirty(false);
  render();
  showScripts();
  remember();
  return true;
}

async function exportSh() {
  if (!scriptPath && !(await save())) return;
  const shPath = scriptPath.replace(/\.shellrun\.json$/, '.sh');
  await api.files.write(shPath, toShellScript(script, info.swiplStackLimit));
  status(`Exported ${shPath}. Run it in Terminal with: bash ${shPath.split('/').pop()}`);
}

// ---------- running ----------
function status(text, kind = 'quiet') {
  $('runStatus').textContent = text;
  $('runStatus').className = kind;
}

function setStepStatus(index, value) {
  const li = $('steps').querySelector(`li[data-index="${index}"]`);
  if (li) li.dataset.status = value;
}

function clearStepStatus() {
  $('steps').querySelectorAll('li[data-status]').forEach((li) => delete li.dataset.status);
}

function handleMarker(m) {
  if (m.event === 'step') {
    setStepStatus(m.index, m.status);
    if (m.status === 'waiting') {
      const step = script.steps[m.index];
      $('pauseText').textContent = step?.message || 'Paused';
      $('pauseBar').classList.remove('hidden');
    } else {
      $('pauseBar').classList.add('hidden');
    }
    if (m.status === 'running') status(`Running step ${m.index + 1} of ${script.steps.length}`);
  }
}

function showOutput(stream, text) {
  const out = $('output');
  if (stream !== 'stdout') {
    out.append(el('span', { className: stream, textContent: text }));
  } else {
    pendingLine += text;
    const lines = pendingLine.split('\n');
    pendingLine = lines.pop();
    let visible = '';
    for (const line of lines) {
      if (line.startsWith(MARKER)) {
        if (visible) { out.append(el('span', { className: 'stdout', textContent: visible })); visible = ''; }
        try { handleMarker(JSON.parse(line.slice(MARKER.length))); } catch {}
      } else {
        visible += line + '\n';
      }
    }
    // show a partial line now unless it might be a marker
    if (pendingLine && !MARKER.startsWith(pendingLine.slice(0, MARKER.length)) ) {
      visible += pendingLine;
      pendingLine = '';
    }
    if (visible) out.append(el('span', { className: 'stdout', textContent: visible }));
  }
  out.scrollTop = out.scrollHeight;
}

function attach(summary) {
  job = summary;
  pendingLine = '';
  $('output').replaceChildren();
  clearStepStatus();
  $('run').disabled = true;
  $('interrupt').disabled = false;
  $('inputRow').classList.remove('hidden');
  status('Running');
  stopStream?.();
  stopStream = api.jobs.stream(summary.id, {
    output: ({ stream, text }) => showOutput(stream, text),
    end: (s) => finished(s)
  });
}

function finished(s) {
  const text = { done: 'Finished', cancelled: 'Interrupted' }[s.status] ?? (s.exitCode === 130 ? 'Stopped at a pause' : `Failed (exit ${s.exitCode ?? s.signal})`);
  status(text, s.status === 'done' ? 'ok' : 'error');
  $('run').disabled = false;
  $('interrupt').disabled = true;
  $('inputRow').classList.add('hidden');
  $('pauseBar').classList.add('hidden');
  job = null;
  remember({ lastJobId: null });
  notify('shellrun', `${script.name}: ${text}`);
}

async function run() {
  if (renderProblems().length) return alert('Fix the problems under the steps first.');
  if (!script.steps.length) return alert('Add a step first.');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  if (dirty || !scriptPath) {
    if (!(await save())) return;
  }
  const folder = scriptPath.split('/').slice(0, -1).join('/');
  try {
    const summary = await api.jobs.start({
      cmd: 'node',
      args: [`${info.appsDir}/${APP_NAME}/runner.mjs`, scriptPath],
      cwd: folder,
      stdin: true,
      tempDir: !!script.tempDir,
      label: `shellrun: ${script.name}`
    });
    attach(summary);
    remember({ lastJobId: summary.id });
  } catch (err) {
    status(err.message, 'error');
  }
}

async function send(text) {
  if (!job) return;
  try {
    await api.jobs.input(job.id, text);
  } catch (err) {
    status(err.message, 'error');
  }
}

// ---------- paste ----------
function openPaste() {
  $('pasteWarnings').textContent = '';
  $('pasteDialog').showModal();
}

$('pasteDialog').addEventListener('close', () => {
  const mode = $('pasteDialog').returnValue;
  if (mode !== 'append' && mode !== 'replace') return;
  const { steps, warnings } = parseCommands($('pasteText').value, { cwd: $('pasteCwd').value.trim() });
  script.steps = mode === 'replace' ? steps : [...script.steps, ...steps];
  setDirty(true);
  render();
  if (warnings.length) alert(`Added ${steps.length} steps, with notes:\n\n${warnings.join('\n')}`);
});

// ---------- wiring ----------
$('name').addEventListener('input', () => { script.name = $('name').value; setDirty(true); });
$('stopOnFail').addEventListener('change', () => { script.stopOnFail = $('stopOnFail').checked; setDirty(true); });
$('tempDir').addEventListener('change', () => { script.tempDir = $('tempDir').checked; setDirty(true); });
$('new').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes to this script?')) return;
  script = newScript();
  scriptPath = null;
  setDirty(false);
  render();
  showScripts();
});
$('save').addEventListener('click', () => save());
$('saveAs').addEventListener('click', () => save({ as: true }));
$('export').addEventListener('click', () => exportSh().catch((e) => status(e.message, 'error')));
$('run').addEventListener('click', run);
$('interrupt').addEventListener('click', () => job && api.jobs.cancel(job.id));
$('continue').addEventListener('click', () => send('\n'));
$('stopAtPause').addEventListener('click', () => send('stop\n'));
$('send').addEventListener('click', () => { send($('input').value + '\n'); $('input').value = ''; });
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { send($('input').value + '\n'); $('input').value = ''; } });
$('addCmd').addEventListener('click', () => addStep({ type: 'cmd', cwd: lastCwd(), cmd: '', args: [] }));
$('addProlog').addEventListener('click', () => addStep({ type: 'prolog', cwd: lastCwd(), goals: [], stackLimit: '', interactive: false, stdoutTo: '' }));
$('addPause').addEventListener('click', () => addStep({ type: 'pause', message: 'Check the output, then continue' }));
$('paste').addEventListener('click', openPaste);
$('folderGo').addEventListener('click', () => { showScripts(); remember(); });
$('folder').addEventListener('keydown', (e) => { if (e.key === 'Enter') { showScripts(); remember(); } });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

function lastCwd() {
  for (let i = script.steps.length - 1; i >= 0; i--) if (script.steps[i].cwd !== undefined) return script.steps[i].cwd;
  return '';
}

async function init() {
  info = await api.info();
  $('steps').before(el('datalist', { id: 'allowed' }, ...info.allowedCommands.map((c) => el('option', { value: c }))));
  if (!info.allowedCommands.includes('node')) {
    status('Add "node" to allowedCommands in the suite config.json so shellrun can run scripts.', 'error');
  }
  const saved = (await api.state.get('shellrun').catch(() => null)) ?? {};
  $('folder').value = saved.folder ?? DEFAULT_FOLDER;
  const fromUrl = new URLSearchParams(location.search).get('open');
  render();
  await showScripts();
  const toOpen = fromUrl ?? saved.openPath;
  if (toOpen) await openScript(toOpen);
  if (saved.lastJobId) {
    try {
      const j = await api.jobs.get(saved.lastJobId);
      if (!j.endedAt) attach(j);
    } catch {}
  }
}

init().catch((err) => status(err.message, 'error'));
