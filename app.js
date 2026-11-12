const $ = s => document.querySelector(s);
const KEEP_DAYS = 7;
const BASE = { g: 1, oz: 28.3495, ml: 1, cup: 236.588, tbsp: 14.7868 };
const COOK_RE = /\b(cooked|roasted|boiled|baked|grilled|fried|steamed|broiled|braised|stewed|toasted|microwaved|poached|scrambled|canned|drained)\b/i;
const RAW_RE = /\b(raw|uncooked|dry)\b/i;
const VOL_RE = /^(cup|tbsp|tsp|tablespoon|teaspoon|fl)/i;
const cfg = () => ({ owner: '', repo: 'calorie-data', token: '', usda: '', kcalG: 2000, proG: 120, fibG: 30,
  ...JSON.parse(localStorage.cfg || '{}') });
const dkey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const lastDays = () => Array.from({ length: KEEP_DAYS }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return dkey(d); });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n * 10) / 10;

let days = JSON.parse(localStorage.days || '{}');
let manual = false, allMatches = [], matches = [], sel = null, portions = [], overrides = {};
let stateMode = localStorage.stateMode || 'any', editId = null, today = dkey(), queue = Promise.resolve();

/* ---------- GitHub storage ---------- */
const api = p => `https://api.github.com/repos/${cfg().owner}/${cfg().repo}/contents/${p}`;
const hdr = () => ({ Authorization: `Bearer ${cfg().token}`, Accept: 'application/vnd.github+json' });
const enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const dec = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));

async function checkRepo() {
  const r = await fetch(`https://api.github.com/repos/${cfg().owner}/${cfg().repo}`, { headers: hdr() });
  if (r.status === 401) throw new Error('Token invalid or expired (401)');
  if (r.status === 404) throw new Error('Repo not found, or token has no access to it (404). Check username, repo name, and token repo selection.');
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  if (j.permissions && j.permissions.push === false) throw new Error('Token is read-only. Set Contents to Read and write.');
}

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
  if ((r.status === 409 || r.status === 422) && retry) { const fresh = await pull(day); d.sha = fresh.sha; return push(day, false); }
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  d.sha = (await r.json()).content.sha;
  localStorage.days = JSON.stringify(days);
}

const setStatus = t => $('#st').textContent = t;
const persist = day => {
  localStorage.days = JSON.stringify(days);
  setStatus('saving…');
  queue = queue.then(() => push(day)).then(() => setStatus('synced'), e => setStatus('error – ' + e.message));
};

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

/* ---------- USDA ---------- */
const classify = d => COOK_RE.test(d) ? 'cooked' : RAW_RE.test(d) ? 'raw' : 'other';

async function search(q) {
  const key = cfg().usda;
  if (!key) throw new Error('Add USDA API key in Settings');
  const u = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  u.search = new URLSearchParams({ query: q, dataType: 'Foundation,SR Legacy', pageSize: 50, api_key: key });
  const r = await fetch(u);
  if (!r.ok) throw new Error(`USDA error ${r.status}`);
  const { foods } = await r.json();
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = foods.map(f => {
    const v = (...ids) => { for (const id of ids) { const n = f.foodNutrients.find(x => x.nutrientId === id); if (n && n.value != null) return n.value; } return null; };
    const k = v(1008, 2047, 2048);
    if (k == null) return null;
    const d = f.description;
    return { id: f.fdcId, desc: d, k, p: v(1003) ?? 0, f: v(1079) ?? 0, state: classify(d),
      score: toks.filter(t => d.toLowerCase().includes(t)).length };
  }).filter(Boolean);
  if (!out.length) throw new Error('No matches. Try simpler words or enter calories manually.');
  return out.sort((a, b) => b.score - a.score || a.desc.length - b.desc.length);
}

const pcache = {};
async function getPortions(id) {
  if (pcache[id]) return pcache[id];
  try {
    const r = await fetch(`https://api.nal.usda.gov/fdc/v1/food/${id}?api_key=${encodeURIComponent(cfg().usda)}`);
    if (!r.ok) return [];
    const j = await r.json(), out = [];
    for (const p of (j.foodPortions || [])) {
      if (!p.gramWeight) continue;
      const un = p.measureUnit && p.measureUnit.name && p.measureUnit.name !== 'undetermined' ? p.measureUnit.name : '';
      const mod = p.modifier && !/^\d+$/.test(p.modifier) ? p.modifier : '';
      let label = [un, mod].filter(Boolean).join(', ');
      if (!label && p.portionDescription && !/not specified/i.test(p.portionDescription)) label = p.portionDescription;
      if (!label) continue;
      const grams = p.gramWeight / (p.amount || 1);
      if (!out.some(o => o.label === label)) out.push({ label, grams });
    }
    return pcache[id] = out;
  } catch { return []; }
}

/* ---------- units ---------- */
const gpu = u => u.startsWith('p:') ? (portions[+u.slice(2)] || { grams: 1 }).grams : (overrides[u] ?? BASE[u]);
const ulabel = u => u.startsWith('p:') ? (portions[+u.slice(2)] || { label: u }).label : u;

function buildUnits(auto = false, force = null) {
  const cur = force || $('#unit').value;
  let h = Object.keys(BASE).map(u => `<option value="${u}">${u}${overrides[u] ? ' (' + Math.round(overrides[u]) + ' g, this food)' : ''}</option>`).join('');
  if (portions.length) h += '<optgroup label="Count / portions">' +
    portions.map((p, i) => `<option value="p:${i}">${esc(p.label)} (${Math.round(p.grams)} g)</option>`).join('') + '</optgroup>';
  $('#unit').innerHTML = h;
  $('#unit').value = [...$('#unit').options].some(o => o.value === cur) ? cur : 'g';
  if (auto && $('#unit').value === 'g') {
    const i = portions.findIndex(p => !VOL_RE.test(p.label));
    if (i >= 0) $('#unit').value = 'p:' + i;
  }
  showPreview();
}

async function pick(m) {
  sel = m; portions = []; overrides = {};
  renderMatches(); buildUnits();
  const ps = await getPortions(m.id);
  if (sel !== m) return;
  portions = []; overrides = {};
  for (const p of ps) {
    const l = p.label.toLowerCase();
    if (l === 'cup') overrides.cup = p.grams;
    else if (l === 'tbsp' || l === 'tablespoon') overrides.tbsp = p.grams;
    else portions.push(p);
  }
  buildUnits(true);
}

function applyFilter() {
  let list = allMatches, note = '';
  if (stateMode === 'raw') list = allMatches.filter(m => m.state !== 'cooked');
  if (stateMode === 'cooked') list = allMatches.filter(m => m.state !== 'raw');
  if (!list.length) { list = allMatches; note = `No ${stateMode} version found; showing all.`; }
  if (stateMode !== 'any') list = [...list].sort((a, b) => (b.state === stateMode) - (a.state === stateMode));
  matches = list;
  $('#err').textContent = note;
  if (list.length) pick(list[0]); else renderMatches();
}

const scale = (m, amt, u) => { const f = amt * gpu(u) / 100; return { kcal: m.k * f, pro: m.p * f, fib: m.f * f, grams: amt * gpu(u) }; };

function showPreview() {
  const a = parseFloat($('#amt').value);
  if (!sel) return $('#preview').textContent = '';
  let t = `Matched: ${sel.desc} (${sel.state === 'other' ? 'state not specified' : sel.state}). `;
  if (a) {
    const u = $('#unit').value, s = scale(sel, a, u);
    t += `${a} ${ulabel(u)} ≈ ${Math.round(s.grams)} g → ${Math.round(s.kcal)} kcal · ${fmt(s.pro)} g protein · ${fmt(s.fib)} g fiber`;
    if (['ml', 'cup', 'tbsp'].includes(u) && !overrides[u]) t += ' (no portion data for this food; assumes water-like density)';
  }
  $('#preview').textContent = t;
}

function renderMatches() {
  $('#matches').innerHTML = matches.map((m, i) =>
    `<div class="m ${sel === m ? 'sel' : ''}" data-i="${i}">${esc(m.desc)}<span class="tag">${m.state}</span><div class="sm">${Math.round(m.k)} kcal / 100 g</div></div>`).join('');
  document.querySelectorAll('.m').forEach(el => el.onclick = () => pick(matches[+el.dataset.i]));
}

/* ---------- render ---------- */
const totals = es => es.reduce((t, e) => ({ k: t.k + e.kcal, p: t.p + e.pro, f: t.f + e.fib }), { k: 0, p: 0, f: 0 });
const sub = e => e.manual ? (e.amount > 1 ? `${e.amount} × ${Math.round(e.m ? e.m.k : e.kcal / e.amount)} kcal` : 'manual')
  : `${e.amount} ${esc(e.unit)}${e.grams ? ' ≈ ' + Math.round(e.grams) + ' g' : ''}${e.per100 && e.per100.state && e.per100.state !== 'other' ? ' · ' + e.per100.state : ''}`;
const row = (e, btn) => `<div class="item" ${btn ? `data-id="${e.id}"` : ''}><div>${esc(e.name)}<div class="sm">${sub(e)}</div></div>
<div style="text-align:right"><b>${Math.round(e.kcal)} kcal</b><div class="sm">P ${fmt(e.pro)} · F ${fmt(e.fib)}</div>${btn ? '<button class="d" data-del="' + e.id + '" style="width:auto;padding:2px 8px;margin-top:4px">Delete</button>' : ''}</div></div>`;

function bar(id, v, g) { const b = $('#b' + id); b.style.width = Math.min(100, v / g * 100) + '%'; b.style.background = v > g ? 'var(--r)' : ({ cal: 'var(--o)', pro: 'var(--b)', fib: 'var(--g)' })[id]; }

function render() {
  today = dkey();
  const c = cfg(), es = (days[today] && days[today].entries) || [], t = totals(es);
  $('#cal').textContent = Math.round(t.k); $('#pro').textContent = fmt(t.p); $('#fib').textContent = fmt(t.f);
  $('#gcal').textContent = c.kcalG; $('#gpro').textContent = c.proG; $('#gfib').textContent = c.fibG;
  bar('cal', t.k, c.kcalG); bar('pro', t.p, c.proG); bar('fib', t.f, c.fibG);
  $('#list').innerHTML = es.length ? es.slice().reverse().map(e => row(e, true)).join('') : '<div class="sm">Nothing logged yet.</div>';
  $('#list').querySelectorAll('[data-del]').forEach(b => b.onclick = ev => { ev.stopPropagation(); del(b.dataset.del); });
  $('#list').querySelectorAll('.item').forEach(i => i.onclick = () => startEdit(i.dataset.id));
  $('#hist').innerHTML = lastDays().slice(1).map(k => {
    const e = (days[k] && days[k].entries) || [], h = totals(e);
    return `<details class="card"><summary>${k} — ${Math.round(h.k)} kcal · P ${fmt(h.p)} · F ${fmt(h.f)}</summary>${e.map(x => row(x, false)).join('') || '<div class="sm">No entries</div>'}</details>`;
  }).join('');
}

function del(id) { const d = days[today]; d.entries = d.entries.filter(e => e.id !== id); persist(today); render(); }

function startEdit(id) {
  const e = days[today].entries.find(x => x.id === id); if (!e) return;
  editId = id; $('#cancel').hidden = false; $('#save').textContent = 'Save changes';
  setMode(e.manual);
  if (e.manual) {
    const m = e.m || { k: e.kcal, p: e.pro, f: e.fib };
    $('#mname').value = e.name; $('#mcal').value = m.k; $('#mpro').value = m.p; $('#mfib').value = m.f; $('#mcount').value = e.amount > 1 ? e.amount : '';
  } else {
    $('#name').value = e.name; $('#amt').value = e.amount;
    sel = e.per100; portions = e.portions || []; overrides = e.overrides || {}; matches = []; allMatches = [];
    renderMatches(); buildUnits(false, e.unitVal || e.unit); showPreview();
  }
  scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  editId = null; sel = null; matches = []; allMatches = []; portions = []; overrides = {}; renderMatches(); buildUnits();
  ['#name', '#amt', '#mname', '#mcal', '#mpro', '#mfib', '#mcount'].forEach(s => $(s).value = '');
  $('#preview').textContent = ''; $('#err').textContent = ''; $('#cancel').hidden = true; $('#save').textContent = 'Add';
}

function setMode(m) { manual = m; $('#look').hidden = m; $('#man').hidden = !m; $('#mLook').className = m ? '' : 'on'; $('#mMan').className = m ? 'on' : ''; }
function setState(s) {
  stateMode = s; localStorage.stateMode = s;
  $('#sAny').className = s === 'any' ? 'on' : ''; $('#sRaw').className = s === 'raw' ? 'on' : ''; $('#sCook').className = s === 'cooked' ? 'on' : '';
  if (allMatches.length) applyFilter();
}

$('#mLook').onclick = () => setMode(false);
$('#mMan').onclick = () => setMode(true);
$('#sAny').onclick = () => setState('any');
$('#sRaw').onclick = () => setState('raw');
$('#sCook').onclick = () => setState('cooked');
$('#cancel').onclick = resetForm;
$('#amt').oninput = $('#unit').onchange = showPreview;

$('#find').onclick = async () => {
  $('#err').textContent = '';
  const q = $('#name').value.trim(); if (!q) return;
  $('#find').textContent = 'Searching…';
  try { allMatches = await search(q); applyFilter(); }
  catch (e) { $('#err').textContent = e.message; }
  $('#find').textContent = 'Find nutrition';
};

$('#save').onclick = () => {
  let e;
  if (manual) {
    const name = $('#mname').value.trim(), k = parseFloat($('#mcal').value), n = parseFloat($('#mcount').value) || 1;
    if (!name || isNaN(k)) return $('#err').textContent = 'Enter a name and calories.';
    const p = parseFloat($('#mpro').value) || 0, f = parseFloat($('#mfib').value) || 0;
    e = { name, amount: n, unit: '×', kcal: k * n, pro: p * n, fib: f * n, manual: true, m: { k, p, f } };
  } else {
    const name = $('#name').value.trim(), a = parseFloat($('#amt').value), u = $('#unit').value;
    if (!name || !a) return $('#err').textContent = 'Enter ingredient and amount.';
    if (!sel) return $('#err').textContent = 'Tap "Find nutrition" and pick a match.';
    const s = scale(sel, a, u);
    e = { name, amount: a, unit: ulabel(u), unitVal: u, grams: s.grams, kcal: s.kcal, pro: s.pro, fib: s.fib, manual: false,
      per100: { desc: sel.desc, k: sel.k, p: sel.p, f: sel.f, state: sel.state }, portions, overrides };
  }
  days[today] = days[today] || { entries: [], sha: null };
  if (editId) { const i = days[today].entries.findIndex(x => x.id === editId); days[today].entries[i] = { ...e, id: editId, ts: Date.now() }; }
  else days[today].entries.push({ ...e, id: crypto.randomUUID(), ts: Date.now() });
  persist(today); resetForm(); render();
};

/* ---------- settings ---------- */
function loadCfg() { const c = cfg(); for (const k of ['owner', 'repo', 'token', 'usda', 'kcalG', 'proG', 'fibG']) $('#' + k).value = c[k]; }
$('#saveCfg').onclick = () => {
  const c = {}; for (const k of ['owner', 'repo', 'token', 'usda']) c[k] = $('#' + k).value.trim();
  for (const k of ['kcalG', 'proG', 'fibG']) c[k] = parseFloat($('#' + k).value) || cfg()[k];
  localStorage.cfg = JSON.stringify(c); sync(true);
};

document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (dkey() !== today) sync(); else render(); } });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadCfg(); buildUnits(); setState(stateMode); render(); sync();
