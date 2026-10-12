import { examples } from './examples.js';

const $ = (id) => document.getElementById(id);
const code = $('code');
const output = $('output');
const runButton = $('run');
const unsafe = $('unsafe');
let selected = examples[0];
let worker = null;
let executionTimer = null;
let revision = 0;
let runRevision = 0;
let runUnsafe = false;

const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function highlight(source) {
  const tokens = /(\/\/|\/\*|")|\b(fn|let|mut|struct|match|if|else|while|loop|for|in|return|break|continue|true|false|Some|None|Ok|Err|String|i32|i64|f64|bool|unsafe)\b|\b(\d+(?:\.\d+)?)\b|\b(println!|print!|panic!)/g;
  let result = '', previous = 0;
  let token;
  while ((token = tokens.exec(source))) {
    result += escape(source.slice(previous, token.index));
    let end = tokens.lastIndex;
    const kind = token[1] === '"' ? 'string' : token[1] ? 'comment' : token[2] ? 'keyword' : token[3] ? 'number' : 'macro';
    if (token[1] === '//') { const newline = source.indexOf('\n',end); end = newline === -1 ? source.length : newline; }
    else if (token[1] === '/*') { const close = source.indexOf('*/',end); end = close === -1 ? source.length : close + 2; }
    else if (token[1] === '"') {
      while (end < source.length) { const char = source[end++]; if (char === '\\') end = Math.min(end + 1,source.length); else if (char === '"') break; }
    }
    result += `<span class="token-${kind}">${escape(source.slice(token.index,end))}</span>`;
    previous = end;
    tokens.lastIndex = end;
  }
  return result + escape(source.slice(previous)) + '\n';
}
function updateEditor() {
  $('highlight').innerHTML = highlight(code.value);
  $('line-numbers').textContent = Array.from({ length:code.value.split('\n').length }, (_, index) => index + 1).join('\n');
  syncScroll(); updateCursor();
}
function syncScroll() { $('highlight').scrollTop = code.scrollTop; $('highlight').scrollLeft = code.scrollLeft; $('line-numbers').scrollTop = code.scrollTop; }
function updateCursor() {
  const preceding = code.value.slice(0, code.selectionStart).split('\n');
  $('cursor-position').textContent = `Ln ${preceding.length}, Col ${preceding.at(-1).length + 1}`;
}
function setStatus(text, state = '') { $('run-status').textContent = text; $('run-status').dataset.state = state; }
function save() { try { localStorage.setItem('rust-js-draft', JSON.stringify({ id:selected.id, code:code.value })); } catch {} }
function choose(example) {
  selected = example;
  code.value = example.code;
  code.scrollTop = code.scrollLeft = 0;
  $('example-description').textContent = example.description;
  for (const button of $('examples').children) button.setAttribute('aria-current', String(button.dataset.id === selected.id));
  revision++;
  updateEditor(); save();
  setStatus('Example loaded');
}
for (const example of examples) {
  const button = document.createElement('button');
  button.className = 'example-button'; button.dataset.id = example.id;
  button.setAttribute('aria-current', String(example.id === selected.id));
  const symbol = document.createElement('span'); symbol.className = 'example-symbol'; symbol.textContent = example.symbol; symbol.setAttribute('aria-hidden','true');
  const label = document.createElement('span'); label.textContent = example.title;
  button.append(symbol,label); button.addEventListener('click', () => choose(example)); $('examples').append(button);
}
function append(text, className) { const p = document.createElement('p'); p.className = className; p.textContent = text; output.append(p); }
function finish(result) {
  const sourceChanged = revision !== runRevision;
  stopWorker(); output.replaceChildren();
  for (const line of result.stdout ?? []) append(line, 'stdout');
  $('steps').textContent = (result.steps ?? 0).toLocaleString();
  $('checker-state').textContent = runUnsafe ? 'Taking the day off' : 'Checked at runtime';
  if (result.ok) {
    setStatus(sourceChanged ? 'Finished · source changed' : 'Finished successfully', 'success');
    if (!result.stdout?.length) append('Program finished without output.', 'empty-output');
  } else {
    setStatus(sourceChanged ? 'Stopped · source changed' : 'Stopped at runtime', 'error');
    const error = result.error ?? { code:'E_RUNTIME',message:'Something went wrong.',line:1,column:1 };
    append(`${error.code}: ${error.message}`, 'error-title');
    append(`main.rs:${error.line ?? 1}:${error.column ?? 1}`, 'error-context');
    if (error.hint) append(`help: ${error.hint}`, 'error-hint');
  }
  for (const warning of result.warnings ?? []) append(warning, 'runtime-warning');
  $('runtime-note').textContent = runUnsafe ? 'Ownership checks bypassed. JavaScript remains unconcerned.' : 'A real interpreter. A very small subset of Rust.';
}
function stopWorker() {
  if (worker) { worker.terminate(); worker = null; }
  clearTimeout(executionTimer); runButton.disabled = false; runButton.querySelector('span').textContent = 'Run code';
}
function run() {
  stopWorker();
  runRevision = revision;
  runUnsafe = unsafe.checked;
  output.replaceChildren(); setStatus('Running…');
  runButton.disabled = true; runButton.querySelector('span').textContent = 'Running…';
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type:'module' });
    worker.onmessage = ({ data }) => finish(data);
    worker.onerror = () => finish({ok:false,error:{code:'E_WORKER',message:'The interpreter could not start.',hint:'Reload the page. If running locally, use npm start rather than opening index.html directly.'}});
    worker.postMessage({ source:code.value, unsafe:runUnsafe });
    executionTimer = setTimeout(() => finish({ok:false,error:{code:'E_TIMEOUT',message:'Execution took too long.',hint:'Reduce the loop or recursion. Even questionable decisions need limits.'}}), 2500);
  } catch { finish({ok:false,error:{code:'E_WORKER',message:'Your browser could not start the interpreter.',hint:'Use a current browser with module worker support.'}}); }
}
runButton.addEventListener('click',run);
code.addEventListener('input', () => {
  const oversized = code.value.length > 40000;
  if (oversized) code.value = code.value.slice(0,40000);
  revision++; updateEditor(); save(); setStatus(oversized ? 'Source limited to 40,000 characters' : 'Edited · ready to run');
});
code.addEventListener('scroll',syncScroll);
code.addEventListener('click',updateCursor);
code.addEventListener('keyup',updateCursor);
code.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = code.selectionStart, end = code.selectionEnd;
    code.setRangeText('    ', start, end, 'end');
    code.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('guide').open) { event.preventDefault(); run(); } });
$('reset').addEventListener('click', () => { choose(selected); setStatus('Example restored'); });
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(code.value); $('copy').textContent = 'Copied'; }
  catch { code.focus(); code.select(); $('copy').textContent = 'Select + copy'; }
  setTimeout(() => { $('copy').textContent = 'Copy code'; },1500);
});
$('clear').addEventListener('click', () => { stopWorker(); output.replaceChildren(); append('Output cleared. Your decisions remain.', 'empty-output'); $('steps').textContent = '—'; setStatus('Ready when you are'); });
unsafe.addEventListener('change', () => {
  $('unsafe-banner').hidden = !unsafe.checked;
  $('checker-state').textContent = unsafe.checked ? 'Taking the day off' : 'Fashionably late';
  revision++;
  setStatus('Mode changed · run again');
});
function guide() { $('guide').showModal(); }
$('guide-button').addEventListener('click',guide);
$('limits-button').addEventListener('click',guide);
$('close-guide').addEventListener('click', () => $('guide').close());
$('guide').addEventListener('click', (event) => { if (event.target === $('guide')) { const rect = $('guide').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('guide').close(); } });
code.value = selected.code;
try {
  const saved = JSON.parse(localStorage.getItem('rust-js-draft'));
  if (saved && typeof saved.code === 'string' && saved.code.length <= 40000) {
    selected = examples.find(e => e.id === saved.id) || examples[0];
    code.value = saved.code;
    $('example-description').textContent = selected.description;
    for (const button of $('examples').children) button.setAttribute('aria-current',String(button.dataset.id === selected.id));
  }
} catch {}
updateEditor();
window.addEventListener('pagehide',stopWorker);
