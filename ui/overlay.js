import { LiquidBar, fmtClock, clamp } from './liquid.js';

const { invoke } = window.__TAURI__.core; // backend commands
const { listen } = window.__TAURI__.event; // backend events
const bar = new LiquidBar(document.getElementById('bar')); // the liquid renderer
let snap = null; // latest backend snapshot
let audio = null; // lazily created AudioContext
let quiet = 0; // timer that suspends the AudioContext after a sound

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
 * One synthesized water drop: a fast rising "bloop".
 * @param {number} at start time on the audio clock
 * @param {number} freq start frequency (Hz)
 * @param {number} vol peak gain
 * @returns {void}
 */
function bloop(at, freq, vol) {
  const osc = audio.createOscillator(); // tone source
  const gain = audio.createGain(); // envelope
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(freq * 2.4, at + 0.09);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(vol, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
  osc.connect(gain).connect(audio.destination);
  osc.start(at);
  osc.stop(at + 0.26);
}

/**
 * Plays a short melody of drops.
 * @param {Array<[number, number, number]>} notes [delay s, frequency Hz, volume]
 * @returns {void}
 */
function play(notes) {
  try {
    audio ??= new AudioContext();
    clearTimeout(quiet);
    audio.resume();
    const t0 = audio.currentTime + 0.03; // schedule slightly ahead
    notes.forEach(([dt, f, v]) => bloop(t0 + dt, f, v));
    // A running AudioContext keeps waking the audio thread every few ms: park it when done.
    quiet = setTimeout(() => audio.suspend(), 1500);
  } catch {
    // no audio device: stay silent
  }
}

/**
 * Applies a backend snapshot and fires the matching animation.
 * @param {object} next new snapshot
 * @returns {void}
 */
function apply(next) {
  const fresh = !snap || next.seq !== snap.seq; // a new action happened
  snap = next;
  const s = next.settings; // user settings
  bar.setOptions({ theme: s.theme, mode: s.mode, opacity: s.opacity, text: s.text, side: next.side, compact: next.compact });
  if (next.reminding && !bar.remind) {
    bar.startReminder();
    if (fresh && next.action === 'remind' && s.sound) play([[0, 520, 0.3], [0.17, 690, 0.26], [0.36, 600, 0.22]]);
  } else if (!next.reminding && fresh && next.action === 'drink') {
    bar.drink(`+1 杯 · 今天第 ${s.cups} 杯`);
    if (s.sound) play([[0, 880, 0.12], [0.1, 1320, 0.1]]);
  } else if (!next.reminding && bar.remind) {
    const minutes = Math.min(5, next.intervalMs / 120000); // the backend snoozes min(5 min, half the interval)
    bar.snooze(next.action === 'snooze' ? `好的，${+minutes.toFixed(1)} 分钟后再提醒` : '');
  }
  document.body.classList.toggle('clickable', next.reminding);
  document.body.classList.toggle('paused', next.pausedAt != null);
}

let last = performance.now(); // previous drawn frame time
let due = 0; // when the next frame is due

/**
 * Animation loop: 60 fps while something moves fast, 30 fps when calm. rAF itself follows the
 * screen (240 Hz on some laptops), so frames are skipped explicitly to save power. Scheduling
 * against a due time (not "time since last frame") keeps the rate steady on 75/144 Hz screens.
 * @param {number} now rAF timestamp
 * @returns {void}
 */
function loop(now) {
  requestAnimationFrame(loop);
  // Hidden for a fullscreen app: WebView2 doesn't know, so stop drawing ourselves.
  if (!snap || snap.hidden || now < due - 2) return;
  const waiting = bar.remind && bar.remindAge > 8; // a reminder nobody answered yet: keep it alive, cheaper
  due = Math.max(due + 1000 / (bar.busy ? 60 : waiting ? 20 : 30), now);
  const dt = (now - last) / 1000; // seconds since last draw
  last = now;
  bar.target = progressOf(snap);
  const s = snap.settings; // user settings
  bar.label = snap.pausedAt != null ? '⏸ 已暂停' : s.showTime ? `💧 ${fmtClock(snap.intervalMs - (Date.now() - snap.cycleStart))}` : '';
  bar.frame(dt);
}

document.addEventListener('click', () => {
  if (snap?.reminding) invoke('action', { what: 'drink' });
});
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (snap?.reminding) invoke('action', { what: 'snooze' });
});

// Listen first, keep the newest event that arrives before the first snapshot, then use whichever is
// newer: a "remind" sent during page load must not be lost (the backend already made us clickable).
let early = null; // newest event received before get_state answered
await listen('state', (e) => {
  if (snap) apply(e.payload);
  else if (!early || e.payload.seq >= early.seq) early = e.payload;
});
const first = await invoke('get_state'); // initial snapshot
apply(early && early.seq > first.seq ? early : first);
requestAnimationFrame(loop);
