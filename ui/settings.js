import { LiquidBar, THEMES, rgba, wave, fmtClock, clamp, easeInOut } from './liquid.js';

const { invoke } = window.__TAURI__.core; // backend commands
const { listen } = window.__TAURI__.event; // backend events
const appWindow = window.__TAURI__.window.getCurrentWindow(); // this settings window
const PRESETS = [15, 30, 45, 60, 90]; // quick interval chips (minutes)
const SIPS = [1, 2, 3, 5]; // per-drink presets, in sips (the sip size itself is a setting, default 20 ml)
const TAU = Math.PI * 2; // full turn
const DEMO = 11; // seconds per preview loop

/**
 * Shortcut for getElementById.
 * @param {string} id element id
 * @returns {HTMLElement} element
 */
const $ = (id) => document.getElementById(id);

let snap = null; // latest backend snapshot (filled right after the event listener is ready)
let settings = {}; // editable copy, sent back on change
let pending = {}; // local edits the backend has not confirmed yet; they win over incoming snapshots
let saveTimer = 0; // debounce handle for saving

/**
 * Progress of the current cycle, 0..1.
 * @param {object} s backend snapshot
 * @returns {number} progress
 */
function progressOf(s) {
  const now = s.pausedAt ?? Date.now(); // a paused cycle stands still
  return clamp((now - s.cycleStart) / s.intervalMs, 0, 1);
}

/**
 * Pushes the current theme colours into the CSS accent variables.
 * @returns {void}
 */
function applyTheme() {
  const th = THEMES[settings.theme] || THEMES.ocean; // active theme
  const style = document.documentElement.style; // root inline style
  style.setProperty('--c0', th.c[0]);
  style.setProperty('--c1', th.c[1]);
  style.setProperty('--c2', th.c[2]);
  style.setProperty('--glow', th.glow);
}

/**
 * Saves settings to the backend shortly after the last change (sliders fire a lot).
 * @returns {void}
 */
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 160);
}

/**
 * Sends pending edits now; keeps them marked until the backend has them.
 * @returns {Promise<void>} resolves once saved
 */
async function flush() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const sent = { ...pending }; // what this save carries
  if (!Object.keys(sent).length) return;
  await invoke('save_settings', { settings: { ...settings } });
  for (const key of Object.keys(sent)) {
    if (pending[key] === sent[key]) delete pending[key];
  }
}

/**
 * Sets the coloured part of a range slider track.
 * @param {HTMLInputElement} input range input
 * @returns {void}
 */
function paintRange(input) {
  const k = (input.value - input.min) / (input.max - input.min); // 0..1 position
  input.style.setProperty('--fill', `${k * 100}%`);
}

/**
 * Builds the static lists (chips, themes) once.
 * @returns {void}
 */
function build() {
  $('chips').innerHTML = PRESETS.map((m) => `<button class="chip" data-min="${m}">${m}</button>`).join('');
  $('amounts').innerHTML = SIPS.map((n) => `<button class="chip" data-sips="${n}">${n} 口</button>`).join('');
  $('themes').innerHTML = Object.entries(THEMES)
    .map(([key, th]) => {
      const vars = `--a:${th.c[0]};--b:${th.c[1]};--c:${th.c[2]}`; // per-swatch colours
      return `<button class="theme" data-theme="${key}" style="${vars}" title="${th.name}"><i class="liq back"></i><i class="liq"></i></button>`;
    })
    .join('');
}

/**
 * Reflects `settings` in every control.
 * @returns {void}
 */
function renderControls() {
  if (document.activeElement !== $('ivInput')) $('ivInput').value = settings.intervalMin;
  document.querySelectorAll('#chips .chip').forEach((c) => c.classList.toggle('on', +c.dataset.min === settings.intervalMin));
  document.querySelectorAll('#amounts .chip').forEach((c) => c.classList.toggle('on', +c.dataset.sips === settings.drinkSips));
  $('amtDesc').textContent = `${settings.drinkSips} 口 = ${settings.drinkSips * settings.sipMl} ml，提醒时点一下就记一次`;
  if (document.activeElement !== $('sipInput')) $('sipInput').value = settings.sipMl;
  $('themeName').textContent = (THEMES[settings.theme] || THEMES.ocean).name;
  $('goalRange').value = settings.goalMl;
  paintRange($('goalRange'));
  $('goalVal').textContent = `${settings.goalMl} ml`;
  $('tWork').checked = settings.workOn;
  $('hours').classList.toggle('off', !settings.workOn);
  for (const [id, key] of [['wStart', 'workStart'], ['wEnd', 'workEnd'], ['lStart', 'lunchStart'], ['lEnd', 'lunchEnd']]) {
    if (document.activeElement !== $(id)) $(id).value = settings[key];
  }
  $('tWeekday').checked = settings.workdaysOnly;
  $('btnDrinkText').textContent = `喝了 ${settings.drinkSips} 口 · ${settings.drinkSips * settings.sipMl} ml`;
  $('seg').dataset.v = settings.mode;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.mode));
  $('opRange').value = Math.round(settings.opacity * 100);
  paintRange($('opRange'));
  $('opVal').textContent = `${Math.round(settings.opacity * 100)}%`;
  document.querySelectorAll('.theme').forEach((t) => t.classList.toggle('on', t.dataset.theme === settings.theme));
  if (document.activeElement !== $('msg')) $('msg').value = settings.text;
  $('tSound').checked = settings.sound;
  $('tAuto').checked = settings.autostart;
  applyTheme();
}

/**
 * Updates today's ml meter and the pause button.
 * @returns {void}
 */
function renderMeter() {
  const { drankMl, goalMl, sipMl } = snap.settings; // today's ml, the goal, ml per sip
  $('mlNow').textContent = drankMl;
  $('mlGoal').textContent = goalMl;
  $('mlSips').textContent = `≈ ${Math.round(drankMl / sipMl)} 口`;
  $('mlFill').style.width = `${clamp(drankMl / goalMl, 0, 1) * 100}%`;
  $('btnPause').textContent = snap.pausedAt != null ? '继续' : '暂停';
}

/**
 * When the next work period starts, for the "resting" text.
 * @param {object} s settings
 * @returns {string} e.g. "13:30" or "明天 09:00"
 */
function nextWorkStart(s) {
  const d = new Date(); // now
  const now = d.getHours() * 60 + d.getMinutes(); // minutes since midnight
  const at = (v) => +v.slice(0, 2) * 60 + +v.slice(3, 5); // "HH:MM" → minutes
  const weekend = s.workdaysOnly && (d.getDay() === 0 || d.getDay() === 6); // no work today
  if (!weekend && now < at(s.workStart)) return s.workStart;
  if (!weekend && now >= at(s.lunchStart) && now < at(s.lunchEnd)) return s.lunchEnd;
  const friday = s.workdaysOnly && (d.getDay() === 5 || d.getDay() === 6 || d.getDay() === 0); // next workday is Monday
  return `${friday ? '周一' : '明天'} ${s.workStart}`;
}

/**
 * Applies a field change and saves.
 * @param {object} patch changed settings
 * @returns {void}
 */
function change(patch) {
  Object.assign(settings, patch);
  Object.assign(pending, patch);
  renderControls();
  save();
}

/** Big glass orb in the settings window: water level = cycle progress. */
class Orb {
  /**
   * @param {HTMLCanvasElement} canvas target canvas
   */
  constructor(canvas) {
    this.canvas = canvas; // drawing surface
    this.ctx = canvas.getContext('2d'); // 2D context
    this.level = 0; // displayed water level 0..1
    this.ring = 0; // displayed ring progress 0..1
    this.t = 0; // animation clock (s)
    this.bubbles = []; // rising bubbles
    this.size = 0; // CSS size
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  /**
   * Matches the backing store to the CSS size.
   * @returns {void}
   */
  resize() {
    const dpr = window.devicePixelRatio || 1; // physical px per CSS px
    this.size = this.canvas.getBoundingClientRect().width;
    this.canvas.width = this.canvas.height = Math.round(this.size * dpr);
    this.dpr = dpr;
  }

  /**
   * Draws one frame.
   * @param {number} dt seconds since last frame
   * @param {number} progress cycle progress 0..1
   * @param {boolean} alert reminder is showing
   * @returns {void}
   */
  frame(dt, progress, alert) {
    if ((window.devicePixelRatio || 1) !== this.dpr) this.resize(); // moved to a screen with another DPI
    const { ctx } = this; // context
    const th = THEMES[settings.theme] || THEMES.ocean; // active theme
    const S = this.size; // CSS size
    const c = S / 2; // centre
    const R = c - 18; // glass radius
    this.t += dt;
    const ease = 1 - Math.exp(-dt * 2.4); // smoothing factor
    this.level += ((alert ? 0.97 : progress) - this.level) * ease;
    this.ring += (progress - this.ring) * ease;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);

    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(c, c, c - 6, 0, TAU);
    ctx.lineWidth = 3;
    ctx.strokeStyle = rgba('#FFFFFF', 0.07);
    ctx.stroke();
    // All ticks in two batched paths (passed / ahead) instead of 60 separate strokes.
    const ticks = [new Path2D(), new Path2D()]; // [passed, ahead]
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU - Math.PI / 2; // tick angle, starting at 12 o'clock like the arc
      const len = i % 5 ? 2.5 : 5; // long tick every 5
      const path = ticks[i / 60 < this.ring ? 0 : 1]; // which batch
      path.moveTo(c + Math.cos(a) * (c - 12), c + Math.sin(a) * (c - 12));
      path.lineTo(c + Math.cos(a) * (c - 12 - len), c + Math.sin(a) * (c - 12 - len));
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba('#FFFFFF', 0.32);
    ctx.stroke(ticks[0]);
    ctx.strokeStyle = rgba('#FFFFFF', 0.1);
    ctx.stroke(ticks[1]);
    if (this.ring > 0.002) {
      const end = -Math.PI / 2 + TAU * this.ring; // arc end angle
      const arc = ctx.createConicGradient(-Math.PI / 2, c, c); // colour sweep
      arc.addColorStop(0, th.c[0]);
      arc.addColorStop(0.5, th.c[1]);
      arc.addColorStop(1, th.c[2]);
      ctx.beginPath();
      ctx.arc(c, c, c - 6, -Math.PI / 2, end);
      // Glow = a wide faint stroke under the real one (shadowBlur re-blurs every frame).
      ctx.lineWidth = 11;
      ctx.strokeStyle = rgba(th.glow, 0.16);
      ctx.stroke();
      ctx.lineWidth = 4;
      ctx.strokeStyle = arc;
      ctx.stroke();
      const hx = c + Math.cos(end) * (c - 6); // head x
      const hy = c + Math.sin(end) * (c - 6); // head y
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, 13); // head glow
      halo.addColorStop(0, rgba(th.glow, 0.7));
      halo.addColorStop(1, rgba(th.glow, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(hx - 13, hy - 13, 26, 26);
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, TAU);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }

    const glass = ctx.createRadialGradient(c - R * 0.3, c - R * 0.4, R * 0.1, c, c, R); // glass body
    glass.addColorStop(0, rgba('#FFFFFF', 0.08));
    glass.addColorStop(1, rgba('#FFFFFF', 0.015));
    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.fillStyle = glass;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R - 1.5, 0, TAU);
    ctx.clip();
    const amp = (alert ? 8 : 4.5) * (0.4 + 0.6 * Math.sin(Math.PI * clamp(this.level, 0.08, 0.92))); // wave height
    const top = c + R - 2 * R * this.level; // water surface y
    const xs = c - R - 4; // left edge
    const xe = c + R + 4; // right edge
    [[2.3, 0.45, -3], [0, 1, 0]].forEach(([ph, a, dy]) => {
      ctx.beginPath();
      ctx.moveTo(xs, S);
      for (let x = xs; x <= xe; x += 3) ctx.lineTo(x, top + dy + amp * wave(x * 1.4, this.t * 1.15, ph));
      ctx.lineTo(xe, S);
      ctx.closePath();
      const body = ctx.createLinearGradient(0, top - amp, 0, c + R); // water colours
      body.addColorStop(0, rgba(th.c[0], 0.92 * a));
      body.addColorStop(0.5, rgba(th.c[1], 0.85 * a));
      body.addColorStop(1, rgba(th.c[2], 0.9 * a));
      ctx.fillStyle = body;
      ctx.fill();
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba('#FFFFFF', 0.6);
    ctx.stroke();

    if (this.level > 0.03 && this.bubbles.length < 26 && Math.random() < dt * (6 + (alert ? 14 : 0))) {
      this.bubbles.push({ x: c + (Math.random() - 0.5) * R * 1.4, y: c + R, r: 1 + Math.random() * 2.6, v: 16 + Math.random() * 26, ph: Math.random() * TAU });
    }
    ctx.lineWidth = 1;
    this.bubbles = this.bubbles.filter((b) => {
      b.y -= b.v * dt;
      b.x += Math.sin(this.t * 2 + b.ph) * dt * 8;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = rgba('#FFFFFF', 0.14);
      ctx.fill();
      ctx.strokeStyle = rgba('#FFFFFF', 0.55);
      ctx.stroke();
      return b.y > top + 2;
    });
    ctx.restore();

    ctx.beginPath();
    ctx.arc(c, c, R, 0, TAU);
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba('#FFFFFF', 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, R - 9, Math.PI * 1.08, Math.PI * 1.42);
    ctx.lineWidth = 5;
    ctx.strokeStyle = rgba('#FFFFFF', 0.22);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c - R * 0.52, c - R * 0.5, 3, 0, TAU);
    ctx.fillStyle = rgba('#FFFFFF', 0.4);
    ctx.fill();
  }
}

/**
 * Updates the orb text block.
 * @param {number} progress cycle progress 0..1
 * @returns {void}
 */
function renderOrbText(progress) {
  const alert = snap.reminding; // reminder showing
  const paused = snap.pausedAt != null; // timer paused
  const rest = snap.resting && !alert; // outside work hours
  setText($('orbCap'), alert ? '时间到啦' : rest ? '休息时间' : paused ? '已暂停' : '距离下次喝水');
  setText($('orbClock'), alert ? snap.settings.text : rest ? nextWorkStart(snap.settings) : fmtClock(snap.intervalMs * (1 - progress)));
  setText($('orbPct'), alert ? '点击任务栏或「喝了」记录' : rest ? '上班后自动开始提醒' : `${Math.floor(progress * 100)}%  ·  每 ${snap.settings.intervalMin} 分钟`);
  if ($('orbInfo').classList.contains('alert') !== alert) $('orbInfo').classList.toggle('alert', alert);
}

/**
 * Writes text only when it changed: rewriting it every frame forces a relayout and a repaint
 * of the blurred text-shadow 30× per second.
 * @param {HTMLElement} el target element
 * @param {string} text new text
 * @returns {void}
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const orb = new Orb($('orb')); // left glass orb
const preview = new LiquidBar($('preview')); // fake taskbar preview
let demoT = 0; // position inside the preview loop

/**
 * Drives the preview through a scripted cycle: fill → reminder → drink.
 * @param {number} dt seconds since last frame
 * @returns {void}
 */
function runDemo(dt) {
  const prev = demoT; // previous loop time
  demoT = (demoT + dt) % DEMO;
  const fillEnd = 6.2; // reminder fires here
  const drinkAt = 9; // demo user "drinks" here
  preview.setOptions({ theme: settings.theme, mode: settings.mode, opacity: settings.opacity, text: settings.text || '该喝水啦', side: 'bottom', compact: false });
  if (demoT < fillEnd) preview.target = easeInOut(demoT / fillEnd);
  if (prev < fillEnd && demoT >= fillEnd) preview.startReminder();
  if (prev < drinkAt && demoT >= drinkAt) {
    preview.target = 0;
    preview.drink(`+${settings.drinkSips * settings.sipMl} ml`);
  }
  preview.frame(dt);
}

/**
 * Shows the real clock in the fake taskbar tray.
 * @returns {void}
 */
function tickClock() {
  const d = new Date(); // now
  $('mockTime').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('mockDate').textContent = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const lastFrame = { orb: performance.now(), demo: performance.now() }; // previous frame time per canvas
let due = 0; // when the next tick is due (keeps a steady rate on any refresh rate)
let orbTurn = false; // which canvas draws on this tick
let minimized = false; // WebView2 keeps running rAF while minimized, so the loop checks this itself

/**
 * Animation loop: the orb and the preview take turns, each at 30 fps. Updating both in the same
 * frame makes the changed area their bounding box (most of the window), which the software
 * compositor then redraws every frame — measured ~4× the cost of taking turns.
 * @param {number} now rAF timestamp
 * @returns {void}
 */
function loop(now) {
  requestAnimationFrame(loop);
  if (minimized || now < due - 2) return;
  // Left open in the background, the window only needs to look alive, not smooth.
  due = Math.max(due + 1000 / (document.hasFocus() ? 60 : 16), now);
  orbTurn = !orbTurn;
  const key = orbTurn ? 'orb' : 'demo'; // canvas drawn on this tick
  const dt = Math.min(0.1, (now - lastFrame[key]) / 1000); // seconds since that canvas last drew
  lastFrame[key] = now;
  if (orbTurn) {
    const progress = progressOf(snap); // cycle progress
    orb.frame(dt, progress, snap.reminding);
    renderOrbText(progress);
  } else {
    runDemo(dt);
  }
}

// Listen first, then load: an event sent while get_state is in flight is not lost
// (and the get_state answer is at least as new as anything sent before it).
let early = null; // newest event that arrived before get_state answered
await listen('state', (e) => {
  if (!snap) {
    if (!early || e.payload.seq >= early.seq) early = e.payload;
    return;
  }
  const fresh = e.payload.seq !== snap.seq; // a new action, not a re-broadcast
  snap = e.payload;
  if (fresh) {
    settings = { ...snap.settings, ...pending }; // unsent edits stay on top
    renderControls();
  }
  renderMeter();
});
const first = await invoke('get_state'); // initial snapshot
snap = early && early.seq > first.seq ? early : first;
settings = { ...snap.settings };

build();
renderControls();
renderMeter();
tickClock();
setInterval(tickClock, 10000);

$('ivInput').addEventListener('change', (e) => change({ intervalMin: clamp(Math.round(+e.target.value) || 30, 1, 180) }));

/**
 * Shows one settings tab.
 * @param {string} tab tab id: rhythm | look | general
 * @returns {void}
 */
function showTab(tab) {
  $('tabs').dataset.v = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === tab));
  try {
    localStorage.setItem('wb.tab', tab);
  } catch {
    // storage blocked: the tab just isn't remembered
  }
}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button')?.dataset.tab; // clicked tab
  if (tab) showTab(tab);
});
let lastTab = 'rhythm'; // tab to open with
try {
  lastTab = localStorage.getItem('wb.tab') || 'rhythm';
} catch {
  // storage blocked: start on the first tab
}
showTab(lastTab);
$('chips').addEventListener('click', (e) => {
  const m = e.target.closest('.chip')?.dataset.min; // chosen preset
  if (m) change({ intervalMin: +m });
});
$('seg').addEventListener('click', (e) => {
  const mode = e.target.closest('button')?.dataset.mode; // chosen style
  if (mode) change({ mode });
});
$('opRange').addEventListener('input', (e) => change({ opacity: e.target.value / 100 }));
$('themes').addEventListener('click', (e) => {
  const theme = e.target.closest('.theme')?.dataset.theme; // chosen theme
  if (theme) change({ theme });
});
$('msg').addEventListener('input', (e) => change({ text: e.target.value }));
$('msg').addEventListener('blur', () => {
  if (!settings.text.trim()) change({ text: '该喝水啦' });
});
$('amounts').addEventListener('click', (e) => {
  const sips = e.target.closest('.chip')?.dataset.sips; // chosen number of sips
  if (sips) change({ drinkSips: +sips });
});
$('sipInput').addEventListener('change', (e) => change({ sipMl: clamp(Math.round(+e.target.value) || 20, 5, 60) }));
$('goalRange').addEventListener('input', (e) => change({ goalMl: +e.target.value }));
$('tWork').addEventListener('change', (e) => change({ workOn: e.target.checked }));
$('tWeekday').addEventListener('change', (e) => change({ workdaysOnly: e.target.checked }));
for (const [id, key] of [['wStart', 'workStart'], ['wEnd', 'workEnd'], ['lStart', 'lunchStart'], ['lEnd', 'lunchEnd']]) {
  // "change" fires once a full HH:MM is entered (not on every keystroke).
  $(id).addEventListener('change', (e) => {
    if (e.target.value) change({ [key]: e.target.value });
  });
}
$('tSound').addEventListener('change', (e) => change({ sound: e.target.checked }));
$('tAuto').addEventListener('change', (e) => change({ autostart: e.target.checked }));
$('btnDrink').addEventListener('click', () => invoke('action', { what: 'drink' }));
$('btnPause').addEventListener('click', () => invoke('action', { what: 'pause' }));
$('btnTest').addEventListener('click', () => invoke('action', { what: 'test' }));
$('btnMin').addEventListener('click', () => {
  minimized = true;
  appWindow.minimize();
});
// Restoring (from the taskbar button or the tray) resizes the window back.
appWindow.onResized(async () => {
  minimized = await appWindow.isMinimized();
});
$('btnClose').addEventListener('click', async () => {
  await flush(); // closing destroys the page: don't drop a save still in its debounce
  appWindow.close();
});
requestAnimationFrame(loop);
