// Meeting availability — client. Events live on the server; this page talks to its JSON API
// and listens on a Server-Sent Events stream so everyone sees changes as they happen.

const $ = (sel) => document.querySelector(sel);
const NAME_KEY = 'availability.name';
const MAX_DAYS = 31;

let state = null;     // { id, t, tz, d: ['YYYY-MM-DD'], s, e, m, p: { name: Uint8Array } }
let me = '';          // current user's name
let drag = null;      // active paint gesture on the "mine" grid
let brush = 1;        // SLOT value the "mine" grid paints with
let stream = null;    // EventSource for the open event
let pending = 0;      // saves in flight
let saveChain = Promise.resolve();
let loadSeq = 0;
const cells = { mine: [], group: [] };

// ---------- encoding ----------
// Each person's availability is one 2-bit SLOT value per slot, packed and base64url encoded.

const SLOT = { none: 0, available: 1, preferred: 2, unavailable: 3 };
const SLOT_CLASS = ['', 'available', 'preferred', 'unavailable'];

function toBase64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function packSlots(slots) {
  const bytes = new Uint8Array(Math.ceil(slots.length / 4));
  slots.forEach((v, i) => { bytes[i >> 2] |= v << ((i & 3) * 2); });
  return toBase64Url(bytes);
}

function unpackSlots(str, n) {
  const bytes = fromBase64Url(str);
  const slots = new Uint8Array(n);
  for (let i = 0; i < n; i++) slots[i] = (bytes[i >> 2] >> ((i & 3) * 2)) & 3;
  return slots;
}

function canAttend(v) {
  return v === SLOT.available || v === SLOT.preferred;
}

function slotCount(ev) {
  return ev.d.length * ((ev.e - ev.s) / ev.m);
}

function decodeEvent(ev) {
  const n = slotCount(ev);
  const p = {};
  for (const [name, bits] of Object.entries(ev.p || {})) p[name] = unpackSlots(bits, n);
  return { ...ev, p };
}

// ---------- server ----------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function personUrl(id, name) {
  return `api/events/${id}/people/${encodeURIComponent(name)}`;
}

// Saves run one at a time, in order, so the server always ends up with the latest edit.
function queue(task) {
  pending++;
  setStatus();
  saveChain = saveChain
    .then(task)
    .catch((err) => {
      if (err.status === 401) return relock();
      toast(`Couldn't save: ${err.message}`);
      resync();
    })
    .finally(() => {
      pending--;
      setStatus();
    });
}

function savePerson(name) {
  const { id } = state;
  const slots = state.p[name];
  queue(() => api('PUT', personUrl(id, name), { slots: packSlots(slots) }));
}

function deletePerson(name) {
  const { id } = state;
  queue(() => api('DELETE', personUrl(id, name)));
}

async function resync() {
  if (!state) return;
  try {
    applyRemote(await api('GET', `api/events/${state.id}`));
  } catch { /* the live stream will catch us up when it reconnects */ }
}

function openStream() {
  closeStream();
  stream = new EventSource(`api/events/${state.id}/stream`);
  stream.onmessage = (e) => applyRemote(JSON.parse(e.data));
  stream.onopen = setStatus;
  stream.onerror = () => {
    // EventSource retries network drops itself, but gives up on an error response (such as a
    // 401 when access has expired). Reload the event so the right screen is shown.
    if (stream.readyState === EventSource.CLOSED) relock();
    else setStatus();
  };
}

function relock() {
  closeStream();
  state = null;
  load();
}

function closeStream() {
  stream?.close();
  stream = null;
}

function applyRemote(ev) {
  if (!state || ev.id !== state.id) return;
  const { p } = decodeEvent(ev);
  // While you're painting or a save is in flight, your local slots are newer than the server's.
  if (me && state.p[me] && (drag || pending)) p[me] = state.p[me];
  if (me && !p[me]) me = '';  // someone removed you
  state.p = p;
  refresh();
}

function setStatus() {
  const status = $('#status');
  if (!stream) return;
  const live = stream.readyState === EventSource.OPEN;
  status.className = `status ${live ? 'live' : 'offline'}`;
  status.textContent = pending ? 'Saving…' : live ? 'Live' : 'Reconnecting…';
}

// ---------- formatting ----------

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtTime(min) {
  const d = new Date(2000, 0, 1, Math.floor(min / 60), min % 60);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(str, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return parseDate(str).toLocaleDateString(undefined, opts);
}

function slotsPerDay() { return (state.e - state.s) / state.m; }
function slotStart(slot) { return state.s + slot * state.m; }

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- setup ----------

// New events get a generated password: three short words and a number, e.g. "maple-otter-crisp-42",
// so it's easy to read out or type from a message.
const WORDS = (
  'acorn amber anchor apple arrow aspen atlas autumn badge bamboo banjo basil beacon berry birch '
  + 'biscuit blossom bolt bramble breeze brick brook bubble cabin cactus camel candle canyon carbon '
  + 'cedar cherry chess cider cinder citrus clover cobalt comet coral cotton crane crater crisp '
  + 'crystal cypress daisy delta denim dingo dune eagle ember emerald falcon fern fiddle flint '
  + 'forest fossil fox frost galaxy garnet gecko ginger glacier granite gravel harbor hazel heron '
  + 'hickory honey horizon husky iris island ivory jasper jelly jungle kayak kelp kettle kiwi koala '
  + 'lagoon lantern lemon lily linen lotus lunar magnet mango maple marble meadow melon mint '
  + 'mosaic moss nectar nickel nutmeg oak oasis ocean olive onyx orbit orchid otter paddle panda '
  + 'paper pebble pepper pine pixel planet plum pocket polar pony poppy prairie prism pumpkin '
  + 'quartz quill rabbit radar raven reef ribbon river robin rocket ruby saddle saffron sage '
  + 'salmon sandal satin scarlet shadow shell sierra silver sketch sparrow spruce squid summit '
  + 'sunset swift tango thistle thunder tiger timber topaz tulip tundra turtle velvet violet '
  + 'walnut walrus willow winter wombat yarrow zebra zephyr'
).split(' ');

function randomInt(n) {
  return crypto.getRandomValues(new Uint32Array(1))[0] % n;
}

function generatePassword() {
  const words = Array.from({ length: 3 }, () => WORDS[randomInt(WORDS.length)]);
  return [...words, 10 + randomInt(90)].join('-');
}

function showSetup(error = '') {
  closeStream();
  state = null;
  $('#board').hidden = true;
  $('#unlock').hidden = true;
  $('#setup').hidden = false;
  $('#setup-error').textContent = error;
  document.title = 'Meeting Availability';
}

function initSetupForm() {
  const form = $('#setup-form');
  for (let min = 0; min <= 24 * 60; min += 30) {
    if (min < 24 * 60) form.start.add(new Option(fmtTime(min), min));
    if (min > 0) form.end.add(new Option(min === 24 * 60 ? 'Midnight' : fmtTime(min), min));
  }
  form.start.value = 9 * 60;
  form.end.value = 17 * 60;
  const today = new Date();
  form.from.value = isoDate(today);
  form.to.value = isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6));
  form.password.value = generatePassword();
  $('#new-password').addEventListener('click', () => { form.password.value = generatePassword(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#setup-error');
    const s = Number(form.start.value);
    const end = Number(form.end.value);
    const m = Number(form.step.value);
    if (end <= s) return void (err.textContent = 'The latest time must be after the earliest time.');
    if ((end - s) % m) return void (err.textContent = `The time range must divide evenly into ${m}-minute slots.`);

    const days = [];
    const last = parseDate(form.to.value);
    for (let d = parseDate(form.from.value); d <= last; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (form.weekdays.checked && (dow === 0 || dow === 6)) continue;
      days.push(isoDate(d));
    }
    if (!days.length) return void (err.textContent = 'That date range contains no days.');
    if (days.length > MAX_DAYS) return void (err.textContent = `Please choose at most ${MAX_DAYS} days.`);

    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const ev = await api('POST', 'api/events', {
        t: form.title.value.trim(),
        password: form.password.value,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        d: days, s, e: end, m,
      });
      history.pushState(null, '', '#' + ev.id);
      await load();
      form.password.value = generatePassword();
      toast(ev.protected
        ? 'Event created — share the link, and send the password separately'
        : 'Event created — copy the link to invite people');
    } catch (error) {
      err.textContent = `Couldn't create the event: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- unlock ----------

function showUnlock(title) {
  closeStream();
  state = null;
  $('#setup').hidden = true;
  $('#board').hidden = true;
  $('#unlock').hidden = false;
  $('#unlock-title').textContent = title || 'Protected event';
  $('#unlock-error').textContent = '';
  document.title = `${title || 'Protected event'} · Availability`;
  $('#unlock-form').password.focus();
}

function initUnlockForm() {
  const form = $('#unlock-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = location.hash.slice(1);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    $('#unlock-error').textContent = '';
    try {
      await api('POST', `api/events/${encodeURIComponent(id)}/unlock`, { password: form.password.value });
      form.password.value = '';
      await load();
    } catch (err) {
      $('#unlock-error').textContent = err.status === 403 ? 'Incorrect password.' : `Couldn't open the event: ${err.message}`;
      form.password.select();
    } finally {
      button.disabled = false;
    }
  });
}

// ---------- board ----------

function showBoard() {
  $('#setup').hidden = true;
  $('#unlock').hidden = true;
  $('#board').hidden = false;
  $('#title').textContent = state.t;
  $('#tz').textContent = `Times shown in ${state.tz} (the organiser's time zone)`;
  document.title = `${state.t} · Availability`;

  const saved = localStorage.getItem(NAME_KEY) || '';
  me = state.p[saved] ? saved : '';  // only auto-select a name that's already on this event
  $('#name').value = saved;

  buildGrid($('#mine'), 'mine');
  buildGrid($('#group'), 'group');
  showDetail(null);
  refresh();
}

function buildGrid(root, kind) {
  root.replaceChildren();
  cells[kind] = [];
  const spd = slotsPerDay();
  root.style.gridTemplateColumns = `auto repeat(${state.d.length}, minmax(42px, 1fr))`;

  root.append(el('div'));
  for (const day of state.d) {
    const head = el('div', 'day');
    head.append(fmtDay(day, { weekday: 'short' }), el('b', null, fmtDay(day, { day: 'numeric', month: 'short' })));
    root.append(head);
  }

  for (let slot = 0; slot < spd; slot++) {
    const onHour = slotStart(slot) % 60 === 0;
    root.append(el('div', 'time', onHour ? fmtTime(slotStart(slot)) : ''));
    for (let day = 0; day < state.d.length; day++) {
      const cell = el('div', onHour && slot > 0 ? 'cell hour' : 'cell');
      const i = day * spd + slot;
      cell.dataset.i = i;
      cells[kind][i] = cell;
      root.append(cell);
    }
  }
}

// Per slot: how many people can attend, and how many of those prefer it.
function tally() {
  const n = slotCount(state);
  const attend = new Uint16Array(n);
  const pref = new Uint16Array(n);
  for (const slots of Object.values(state.p)) {
    slots.forEach((v, i) => {
      if (canAttend(v)) attend[i]++;
      if (v === SLOT.preferred) pref[i]++;
    });
  }
  return { attend, pref };
}

function refresh() {
  const mine = me ? state.p[me] : null;
  const lock = $('#mine-lock');
  const typed = $('#name').value.trim();
  lock.hidden = !!mine;
  lock.textContent = typed
    ? `Click here to add your availability as ${typed}.`
    : 'Enter your name above to add your availability.';
  cells.mine.forEach((cell, i) => {
    const v = mine?.[i] || SLOT.none;
    SLOT_CLASS.forEach((name, k) => { if (name) cell.classList.toggle(name, k === v); });
  });

  const total = Object.keys(state.p).length;
  const t = tally();
  cells.group.forEach((cell, i) => {
    cell.style.setProperty('--a', total ? t.attend[i] / total : 0);
    cell.style.setProperty('--p', total ? t.pref[i] / total : 0);
    cell.classList.toggle('none', t.attend[i] === 0);
    cell.classList.toggle('all', total > 0 && t.attend[i] === total);
    cell.classList.toggle('pref', t.pref[i] > 0);
  });
  $('#legend-max').textContent = total;

  renderParticipants();
  renderBest(t, total);
  if (showDetail.current != null) showDetail(showDetail.current);
}

function renderParticipants() {
  const names = Object.keys(state.p).sort((a, b) => a.localeCompare(b));
  $('#people-count').textContent = names.length
    ? `${names.length} ${names.length === 1 ? 'person has' : 'people have'} responded`
    : 'No responses yet';
  const list = $('#participants');
  list.replaceChildren();
  for (const name of names) {
    const li = el('li', name === me ? 'me' : '', name === me ? `${name} (you)` : name);
    const remove = el('button', null, '×');
    remove.title = `Remove ${name}`;
    remove.setAttribute('aria-label', `Remove ${name}`);
    remove.addEventListener('click', () => {
      if (!confirm(`Remove ${name}'s availability from this event?`)) return;
      delete state.p[name];
      if (name === me) me = '';
      deletePerson(name);
      refresh();
    });
    li.append(remove);
    list.append(li);
  }
}

// Best times: the slots the most people can attend, split into runs with the same number of
// people preferring them, most preferred first.
function renderBest({ attend, pref }, total) {
  const list = $('#best');
  list.replaceChildren();
  const max = attend.reduce((a, b) => Math.max(a, b), 0);
  if (!max) {
    list.append(el('li', 'empty', 'No availability yet — mark some times to see suggestions.'));
    return;
  }

  const spd = slotsPerDay();
  const ranges = [];
  state.d.forEach((day, d) => {
    let start = -1;
    for (let slot = 0; slot <= spd; slot++) {
      const i = d * spd + slot;
      const hit = slot < spd && attend[i] === max;
      const startIdx = d * spd + start;
      if (start >= 0 && (!hit || pref[i] !== pref[startIdx])) {
        ranges.push({ day, from: slotStart(start), to: slotStart(slot), idx: startIdx, pref: pref[startIdx] });
        start = -1;
      }
      if (hit && start < 0) start = slot;
    }
  });
  ranges.sort((a, b) => b.pref - a.pref);  // stable, so ties stay in date order

  const who = max === total ? 'everyone can attend' : `${max} of ${total} can attend`;
  for (const r of ranges.slice(0, 8)) {
    const people = Object.entries(state.p);
    const attending = people.filter(([, s]) => canAttend(s[r.idx])).map(([n]) => n);
    const preferring = people.filter(([, s]) => s[r.idx] === SLOT.preferred).map(([n]) => n);
    const li = el('li');
    li.append(el('strong', null, `${fmtDay(r.day)}, ${fmtTime(r.from)} – ${fmtTime(r.to)}`));
    li.append(` · ${who}${max === total ? '' : ` (${attending.join(', ')})`}`);
    if (preferring.length) li.append(` · preferred by ${preferring.join(', ')}`);
    list.append(li);
  }
  if (ranges.length > 8) list.append(el('li', 'empty', `…and ${ranges.length - 8} more`));
}

function showDetail(i) {
  showDetail.current = i;
  const detail = $('#detail');
  cells.group.forEach((cell) => cell.classList.remove('hover'));
  if (i == null) {
    detail.textContent = "Hover over a slot to see who's free.";
    return;
  }
  cells.group[i].classList.add('hover');
  const spd = slotsPerDay();
  const day = state.d[Math.floor(i / spd)];
  const from = slotStart(i % spd);
  const groups = [[], [], [], []];  // indexed by SLOT value
  for (const [name, slots] of Object.entries(state.p)) groups[slots[i]].push(name);
  const attending = groups[SLOT.available].length + groups[SLOT.preferred].length;

  const line = (label, names) => [el('br'), `${label}: `, el('span', 'who', names.join(', ') || '—')];
  detail.replaceChildren(
    el('strong', null, `${fmtDay(day)}, ${fmtTime(from)} – ${fmtTime(from + state.m)}`),
    ` · ${attending}/${Object.keys(state.p).length} can attend`,
    ...line('Preferred', groups[SLOT.preferred]),
    ...line('Available', groups[SLOT.available]),
    ...line('Not available', groups[SLOT.unavailable]),
    ...line('No answer', groups[SLOT.none]),
  );
}

// ---------- name ----------

function commitName() {
  const name = $('#name').value.trim();
  if (!name || name === me) return;
  if (!state.p[name]) {
    // Renaming yourself keeps your slots; a brand new name starts empty.
    const old = me && state.p[me] ? me : '';
    state.p[name] = old ? state.p[old] : new Uint8Array(slotCount(state));
    savePerson(name);
    if (old) {
      delete state.p[old];
      deletePerson(old);
    }
  }
  me = name;
  localStorage.setItem(NAME_KEY, name);
  refresh();
}

// ---------- painting ----------

function paintTo(i) {
  const spd = slotsPerDay();
  const slots = state.p[me];
  slots.set(drag.base);
  const [d0, d1] = [Math.floor(drag.start / spd), Math.floor(i / spd)].sort((a, b) => a - b);
  const [s0, s1] = [drag.start % spd, i % spd].sort((a, b) => a - b);
  for (let d = d0; d <= d1; d++) {
    for (let s = s0; s <= s1; s++) slots[d * spd + s] = drag.value;
  }
  refresh();
}

function cellAt(e, kind) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const cell = hit?.closest(`#${kind} .cell`);
  return cell ? Number(cell.dataset.i) : null;
}

function initPainting() {
  const grid = $('#mine');
  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !me || !state.p[me] || e.button !== 0) return;
    e.preventDefault();
    const i = Number(cell.dataset.i);
    const value = state.p[me][i] === brush ? SLOT.none : brush;
    drag = { start: i, last: i, value, base: state.p[me].slice() };
    grid.setPointerCapture(e.pointerId);
    paintTo(i);
  });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const i = cellAt(e, 'mine');
    if (i != null && i !== drag.last) {
      drag.last = i;
      paintTo(i);
    }
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    if (me && state.p[me]) savePerson(me);
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);

  const brushes = document.querySelectorAll('.brush');
  brushes.forEach((button) => button.addEventListener('click', () => {
    brush = Number(button.dataset.brush);
    brushes.forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  }));

  const group = $('#group');
  group.addEventListener('pointermove', (e) => {
    const cell = e.target.closest('.cell');
    if (cell) showDetail(Number(cell.dataset.i));
  });
  group.addEventListener('pointerleave', () => showDetail(null));
}

// ---------- actions ----------

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast(state.protected
      ? 'Link copied — remember to send the password separately'
      : 'Link copied — anyone with it can add their availability');
  } catch {
    prompt('Copy this link:', location.href);
  }
}

async function load() {
  const id = location.hash.slice(1);
  if (state && id === state.id) return;
  const seq = ++loadSeq;
  if (!id) return showSetup();
  let ev;
  try {
    ev = await api('GET', `api/events/${encodeURIComponent(id)}`);
  } catch (err) {
    if (seq !== loadSeq) return;
    if (err.status === 401) showUnlock(err.body.title);
    else if (err.status === 404) showSetup("That event couldn't be found. Create a new one below.");
    else showSetup(`Couldn't load that event (${err.message}). Refresh to try again.`);
    return;
  }
  if (seq !== loadSeq) return;
  state = decodeEvent(ev);
  showBoard();
  openStream();
}

initSetupForm();
initUnlockForm();
initPainting();
$('#name').addEventListener('change', commitName);
$('#name').addEventListener('input', () => { if (!me) refresh(); });
$('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('#mine-lock').addEventListener('click', () => {
  if ($('#name').value.trim()) commitName();
  else $('#name').focus();
});
$('#copy').addEventListener('click', copyLink);
$('#new').addEventListener('click', () => {
  history.pushState(null, '', location.pathname + location.search);
  showSetup();
});
window.addEventListener('hashchange', load);
window.addEventListener('popstate', load);
load();
