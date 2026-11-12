const $ = s => document.querySelector(s);
const KEEP_DAYS = 7;
const G = { g: 1, oz: 28.3495, ml: 1, cup: 236.588, tbsp: 14.7868 };
const cfg = () => ({ owner: '', repo: 'calorie-data', token: '', usda: '', kcalG: 2000, proG: 120, fibG: 30,
  ...JSON.parse(localStorage.cfg || '{}') });
const dkey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const lastDays = () => Array.from({ length: KEEP_DAYS }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return dkey(d); });

let days = JSON.parse(localStorage.days || '{}');
let manual = false, matches = [], sel = null, editId = null, today = dkey(), queue = Promise.resolve();

const api = p => `https://api.github.com/repos/${cfg().owner}/${cfg().repo}/contents/${p}`;
const hdr = () => ({ Authorization: `Bearer ${cfg().token}`, Accept: 'application/vnd.github+json' });
const enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const dec = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function pull(day) {
  const r = await fetch(api(`days/${day}.json`) + `?t=${Date.now()}`, { headers: hdr() });
  if (r.status === 404) return { entries: [], sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  return { entries: JSON.parse(dec(j.content)).entries, sha: j.sha };
}

async function push(day, retry = true) {
  const d = days[day];
  const body = { message: `Update ${day}`, content: enc(JSON.stringify({ entries: d.entries }, null, 1)) };
  if (d.sha) body.sha = d.sha;
  const r = await fetch(api(`days/${day}.json`), { method: 'PUT', headers: hdr(), body: JSON.stringify(body) });
  if (r.status === 409 || r.status === 422) {
    if (retry) { const fresh = await pull(day); d.sha = fresh.sha; return push(day, false); }
  }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  d.sha = (await r.json()).content.sha;
  localStorage.days = JSON.stringify(days);
}

const persist = day => {
  localStorage.days = JSON.stringify(days);
  setStatus('saving…');
  queue = queue.then(() => push(day)).then(() => setStatus('synced'), e => setStatus('offline – ' + e.message));
};
const setStatus = t => $('#st').textContent = t;

async function checkRepo() {
  const r = await fetch(`https://api.github.com/repos/${cfg().owner}/${cfg().repo}`, { headers: hdr() });
  if (r.status === 401) throw new Error('Token invalid or expired (401)');
  if (r.status === 404) throw new Error('Repo not found, or token has no access to it (404). Check username, repo name, and token repo selection.');
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  if (j.permissions && j.permissions.push === false) throw new Error('Token is read-only. Set Contents to Read and write.');
}

async function sync(showAlert = false) {
  if (!cfg().token || !cfg().owner) {
    setStatus('set up settings');
    if (showAlert) alert('Fill in GitHub username, repo name, and token first.');
    return;
  }
  setStatus('syncing…');
  try {
    await checkRepo();
    const keep = lastDays();
    const res = await Promise.all(keep.map(pull));
    keep.forEach((k, i) => days[k] = res[i]);
    Object.keys(days).forEach(k => { if (!keep.includes(k)) delete days[k]; });
    localStorage.days = JSON.stringify(days);
    setStatus('synced');
    if (showAlert) alert('Connected to ' + cfg().owner + '/' + cfg().repo + '. Sync works.');
  } catch (e) {
    setStatus('error – ' + e.message);
    if (showAlert) alert('Sync failed: ' + e.message);
  }
  render();
}

async function search(q) {
  const key = cfg().usda;
  if (!key) throw new Error('Add USDA API key in Settings');
  const u = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  u.search = new URLSearchParams({ query: q, dataType: 'Foundation,SR Legacy', pageSize: 15, api_key: key });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`USDA error ${r.status}`);
  const { foods } = await r.json();
  const out = foods.map(f => {
    const v = (...ids) => { for (const id of ids) { const n = f.foodNutrients.find(x => x.nutrientId === id); if (n && n.value != null) return n.value; } return null; };
    const k = v(1008, 2047, 2048);
    return k == null ? null : { desc: f.description, k, p: v(1003) ?? 0, f: v(1079) ?? 0 };
  }).filter(Boolean);
  if (!out.length) throw new Error('No matches. Try simpler words or enter calories manually.');
  return out;
}

const scale = (m, amt, unit) => { const f = amt * G[unit] / 100; return { kcal: m.k * f, pro: m.p * f, fib: m.f * f }; };
const fmt = n => Math.round(n * 10) / 10;

function showPreview() {
  const a = parseFloat($('#amt').value);
  if (!sel || !a) return $('#preview').textContent = '';
  const s = scale(sel, a, $('#unit').value);
  let t = `${Math.round(s.kcal)} kcal · ${fmt(s.pro)} g protein · ${fmt(s.fib)} g fiber`;
  if (['ml', 'cup', 'tbsp'].includes($('#unit').value)) t += ' (volume assumes water-like density; use grams for accuracy)';
  $('#preview').textContent = t;
}

function renderMatches() {
  $('#matches').innerHTML = matches.map((m, i) =>
    `<div class="m ${sel === m ? 'sel' : ''}" data-i="${i}">${m.desc}<div class="sm">${Math.round(m.k)} kcal / 100 g</div></div>`).join('');
  document.querySelectorAll('.m').forEach(el => el.onclick = () => { sel = matches[+el.dataset.i]; renderMatches(); showPreview(); });
}

const totals = es => es.reduce((t, e) => ({ k: t.k + e.kcal, p: t.p + e.pro, f: t.f + e.fib }), { k: 0, p: 0, f: 0 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const row = (e, btn) => `<div class="item" ${btn ? `data-id="${e.id}"` : ''}><div>${esc(e.name)}<div class="sm">${e.manual ? 'manual' : e.amount + ' ' + e.unit}</div></div>
<div style="text-align:right"><b>${Math.round(e.kcal)} kcal</b><div class="sm">P ${fmt(e.pro)} · F ${fmt(e.fib)}</div>${btn ? '<button class="d" data-del="' + e.id + '" style="width:auto;padding:2px 8px;margin-top:4px">Delete</button>' : ''}</div></div>`;

function bar(id, v, g) { const b = $('#b' + id); b.style.width = Math.min(100, v / g * 100) + '%'; b.style.background = v > g ? 'var(--r)' : ({ cal: 'var(--o)', pro: 'var(--b)', fib: 'var(--g)' })[id]; }

function render() {
  today = dkey();
  const c = cfg(), es = (days[today]?.entries) || [], t = totals(es);
  $('#cal').textContent = Math.round(t.k); $('#pro').textContent = fmt(t.p); $('#fib').textContent = fmt(t.f);
  $('#gcal').textContent = c.kcalG; $('#gpro').textContent = c.proG; $('#gfib').textContent = c.fibG;
  bar('cal', t.k, c.kcalG); bar('pro', t.p, c.proG); bar('fib', t.f, c.fibG);
  $('#list').innerHTML = es.length ? es.slice().reverse().map(e => row(e, true)).join('') : '<div class="sm">Nothing logged yet.</div>';
  $('#list').querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); del(b.dataset.del); });
  $('#list').querySelectorAll('.item').forEach(i => i.onclick = () => startEdit(i.dataset.id));
  $('#hist').innerHTML = lastDays().slice(1).map(k => {
    const e = days[k]?.entries || [], h = totals(e);
    return `<details class="card"><summary>${k} — ${Math.round(h.k)} kcal · P ${fmt(h.p)} · F ${fmt(h.f)}</summary>${e.map(x => row(x, false)).join('') || '<div class="sm">No entries</div>'}</details>`;
  }).join('');
}

function del(id) { const d = days[today]; d.entries = d.entries.filter(e => e.id !== id); persist(today); render(); }

function startEdit(id) {
  const e = days[today].entries.find(x => x.id === id); if (!e) return;
  editId = id; $('#cancel').hidden = false; $('#save').textContent = 'Save changes';
  setMode(e.manual);
  if (e.manual) { $('#mname').value = e.name; $('#mcal').value = e.kcal; $('#mpro').value = e.pro; $('#mfib').value = e.fib; }
  else { $('#name').value = e.name; $('#amt').value = e.amount; $('#unit').value = e.unit; sel = e.per100; matches = []; renderMatches(); showPreview(); }
  scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editId = null; sel = null; matches = []; renderMatches();
  ['#name', '#amt', '#mname', '#mcal', '#mpro', '#mfib'].forEach(s => $(s).value = '');
  $('#preview').textContent = ''; $('#err').textContent = ''; $('#cancel').hidden = true; $('#save').textContent = 'Add';
}

function setMode(m) { manual = m; $('#look').hidden = m; $('#man').hidden = !m; $('#mLook').className = m ? '' : 'on'; $('#mMan').className = m ? 'on' : ''; }

$('#mLook').onclick = () => setMode(false);
$('#mMan').onclick = () => setMode(true);
$('#cancel').onclick = resetForm;
$('#amt').oninput = $('#unit').onchange = showPreview;

$('#find').onclick = async () => {
  $('#err').textContent = '';
  const q = $('#name').value.trim(); if (!q) return;
  $('#find').textContent = 'Searching…';
  try { matches = await search(q); sel = matches[0]; renderMatches(); showPreview(); }
  catch (e) { $('#err').textContent = e.message; }
  $('#find').textContent = 'Find nutrition';
};

$('#save').onclick = () => {
  let e;
  if (manual) {
    const name = $('#mname').value.trim(), k = parseFloat($('#mcal').value);
    if (!name || isNaN(k)) return $('#err').textContent = 'Enter a name and calories.';
    e = { name, amount: 1, unit: 'serving', kcal: k, pro: parseFloat($('#mpro').value) || 0, fib: parseFloat($('#mfib').value) || 0, manual: true };
  } else {
    const name = $('#name').value.trim(), a = parseFloat($('#amt').value);
    if (!name || !a) return $('#err').textContent = 'Enter ingredient and amount.';
    if (!sel) return $('#err').textContent = 'Tap "Find nutrition" and pick a match.';
    const s = scale(sel, a, $('#unit').value);
    e = { name, amount: a, unit: $('#unit').value, ...s, manual: false, per100: { desc: sel.desc, k: sel.k, p: sel.p, f: sel.f } };
  }
  days[today] ||= { entries: [], sha: null };
  if (editId) { const i = days[today].entries.findIndex(x => x.id === editId); days[today].entries[i] = { ...e, id: editId, ts: Date.now() }; }
  else days[today].entries.push({ ...e, id: crypto.randomUUID(), ts: Date.now() });
  persist(today); resetForm(); render();
};

function loadCfg() { const c = cfg(); for (const k of ['owner', 'repo', 'token', 'usda', 'kcalG', 'proG', 'fibG']) $('#' + k).value = c[k]; }
$('#saveCfg').onclick = () => {
  const c = {}; for (const k of ['owner', 'repo', 'token', 'usda']) c[k] = $('#' + k).value.trim();
  for (const k of ['kcalG', 'proG', 'fibG']) c[k] = parseFloat($('#' + k).value) || cfg()[k];
  localStorage.cfg = JSON.stringify(c); sync(true);
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (dkey() !== today) sync(); else render(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadCfg(); render(); sync();
