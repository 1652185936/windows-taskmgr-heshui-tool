/**
 * WaterBar shared renderer: colour themes + the liquid taskbar animation.
 * Used by the real taskbar overlay and by the live preview in the settings window.
 *
 * Performance note: this runs all day in a transparent, click-through window. Rasterising long
 * anti-aliased wave paths every frame cost >100% of a CPU core, so wave shapes, glows and texts are
 * drawn ONCE into small sprites/tiles; a frame only stamps those images and fills plain rectangles.
 */

/** Colour themes: `c` = gradient stops along the bar, `glow` = highlight colour. */
export const THEMES = {
  ocean: { name: '深海', c: ['#36E2FF', '#1E8BFF', '#5A5CFF'], glow: '#7DF3FF' },
  aurora: { name: '极光', c: ['#2BF5A6', '#18D4F0', '#8B6CFF'], glow: '#86FFE0' },
  sakura: { name: '樱花', c: ['#FFC2D4', '#FF7EB3', '#C77DFF'], glow: '#FFB8D6' },
  sunset: { name: '落日', c: ['#FFD36E', '#FF8C5A', '#FF4F7B'], glow: '#FFC37F' },
  neon: { name: '霓虹', c: ['#FF2EA6', '#8A2BFF', '#2EE6FF'], glow: '#FF8BE0' },
  matcha: { name: '抹茶', c: ['#D7F57A', '#8EDB6A', '#2FB58A'], glow: '#D4FF9A' },
};

const DRAIN = 1.35; // seconds the "drinking" drain animation lasts
const FLOAT = 2.3; // seconds a floating message lives
const TAU = Math.PI * 2; // full turn
const FONT = '"Microsoft YaHei UI", "Segoe UI", sans-serif'; // UI font stack
const HINT = '点击喝完 · 右键稍后'; // interaction hint under the reminder
/** Two surface layers: wavelength (px at a 48 px bar), scroll speed (px/s), vertical offset (px). */
const LAYERS = [
  { lambda: 170, speed: 34, dy: 0 },
  { lambda: 245, speed: -23, dy: -1.6 },
];
const rgbCache = new Map(); // hex colour → [r, g, b]

/**
 * Converts a #RRGGBB colour plus alpha into a CSS rgba() string.
 * @param {string} hex colour like "#36E2FF"
 * @param {number} a alpha, clamped to 0..1
 * @returns {string} rgba() colour
 */
export function rgba(hex, a) {
  let rgb = rgbCache.get(hex); // cached channels
  if (!rgb) {
    rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    rgbCache.set(hex, rgb);
  }
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`;
}

/**
 * Clamps a value into a range.
 * @param {number} v value
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number} clamped value
 */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Linear interpolation.
 * @param {number} a start
 * @param {number} b end
 * @param {number} k blend 0..1
 * @returns {number} blended value
 */
export const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Cubic ease-in-out.
 * @param {number} k 0..1
 * @returns {number} eased 0..1
 */
export const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);

/**
 * Cubic ease-out.
 * @param {number} k 0..1
 * @returns {number} eased 0..1
 */
export const easeOut = (k) => 1 - (1 - k) ** 3;

/**
 * Back ease-out: overshoots a little, then settles (bouncy pop-in).
 * @param {number} k 0..1
 * @returns {number} eased value, peaks slightly above 1
 */
export const backOut = (k) => 1 + 2.9 * (k - 1) ** 3 + 1.9 * (k - 1) ** 2;

/**
 * Positive modulo (JS % keeps the sign of the dividend).
 * @param {number} a value
 * @param {number} n divisor
 * @returns {number} a mod n in [0, n)
 */
const mod = (a, n) => ((a % n) + n) % n;

/**
 * Two layered sines: the water surface shape of the settings orb.
 * @param {number} x position along the surface (px)
 * @param {number} t animation clock (s)
 * @param {number} ph phase offset, gives a second independent layer
 * @returns {number} height in -1..1
 */
export function wave(x, t, ph) {
  return 0.62 * Math.sin(x * 0.034 + t * 1.9 + ph) + 0.38 * Math.sin(x * 0.081 - t * 2.6 + 1.7 + ph);
}

/**
 * Formats a duration as mm:ss or h:mm:ss.
 * @param {number} ms milliseconds
 * @returns {string} clock text
 */
export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000)); // whole seconds left
  const h = Math.floor(total / 3600); // hours
  const m = Math.floor((total % 3600) / 60); // minutes
  const s = total % 60; // seconds
  const pad = (n) => String(n).padStart(2, '0'); // two-digit helper
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Adds a water-drop outline (tip up) to the current path.
 * @param {CanvasRenderingContext2D} ctx context
 * @param {number} x centre x
 * @param {number} y centre y
 * @param {number} h total height
 * @returns {void}
 */
export function dropPath(ctx, x, y, h) {
  const r = h * 0.36; // radius of the round bottom
  const cy = y + h * 0.5 - r; // centre of the round bottom
  const tip = y - h * 0.5; // top point
  ctx.beginPath();
  ctx.moveTo(x, tip);
  ctx.bezierCurveTo(x + r * 0.3, tip + h * 0.24, x + r, cy - r * 0.45, x + r, cy);
  ctx.arc(x, cy, r, 0, Math.PI, false);
  ctx.bezierCurveTo(x - r, cy - r * 0.45, x - r * 0.3, tip + h * 0.24, x, tip);
  ctx.closePath();
}

/**
 * Fills a four-point twinkle star.
 * @param {CanvasRenderingContext2D} ctx context
 * @param {number} x centre x
 * @param {number} y centre y
 * @param {number} s arm length
 * @returns {void}
 */
function star(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x, y, x + s, y);
  ctx.quadraticCurveTo(x, y, x, y + s);
  ctx.quadraticCurveTo(x, y, x - s, y);
  ctx.quadraticCurveTo(x, y, x, y - s);
  ctx.fill();
}

/**
 * Creates a canvas for an offscreen layer or a sprite.
 * @param {number} w width in device pixels
 * @param {number} h height in device pixels
 * @returns {HTMLCanvasElement} canvas
 */
function makeCanvas(w, h) {
  const cv = document.createElement('canvas'); // offscreen surface
  cv.width = Math.max(1, Math.ceil(w));
  cv.height = Math.max(1, Math.ceil(h));
  return cv;
}

/** The liquid taskbar: owns its particles, draws one frame per `frame(dt)` call. */
export class LiquidBar {
  /**
   * @param {HTMLCanvasElement} canvas target canvas, sized by CSS
   */
  constructor(canvas) {
    this.canvas = canvas; // drawing surface
    this.ctx = canvas.getContext('2d'); // 2D context
    this.opts = { theme: 'ocean', mode: 'fill', opacity: 0.7, side: 'bottom', compact: false, text: '该喝水啦' }; // look & layout
    this.target = 0; // progress the bar should reach (0..1)
    this.p = 0; // progress currently drawn, eases toward target
    this.label = ''; // small status text, e.g. the countdown
    this.remind = false; // reminder wanted
    this.r = 0; // reminder blend 0..1
    this.remindAge = 99; // seconds since the reminder started
    this.drainAge = -1; // seconds into the drink drain, -1 = idle
    this.pHold = 0; // bar width frozen while draining
    this.drainRe = 0; // reminder blend when the drain started
    this.t = 0; // animation clock (s)
    this.w = 0; // canvas CSS width
    this.h = 0; // canvas CSS height
    this.dpr = 1; // device pixel ratio
    this.bubbles = []; // rising bubbles
    this.sparks = []; // twinkles (fill) / comet sparks (line)
    this.drops = []; // splash droplets
    this.rings = []; // ripple rings around the reminder drop
    this.floats = []; // floating messages
    this.acc = { bubble: 0, spark: 0, ring: 0 }; // fractional spawn accumulators
    this.kit = null; // per theme/size sprites, rebuilt by prepare()
    this.badgeKit = null; // reminder badge sprites, rebuilt when the text changes
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  /**
   * Matches the backing store to the CSS size so lines stay crisp.
   * @returns {void}
   */
  resize() {
    const rect = this.canvas.getBoundingClientRect(); // CSS box
    this.dpr = window.devicePixelRatio || 1;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    this.draw(this.geometry()); // resizing wipes the canvas: redraw now instead of showing a blank frame
  }

  /**
   * Merges look/layout options.
   * @param {object} o partial options
   * @returns {void}
   */
  setOptions(o) {
    Object.assign(this.opts, o);
  }

  /**
   * Starts the "time to drink" show: water surges full, text pops in, droplets splash.
   * @returns {void}
   */
  startReminder() {
    if (this.remind) return;
    this.remind = true;
    this.remindAge = 0;
    this.drainAge = -1;
    const g = this.geometry(); // current layout
    // Heights are in units of the bar thickness: an auto-hide strip grows to full size right after this.
    for (let i = 0; i < 46; i++) {
      this.drops.push({
        x: Math.random() * g.L,
        y: 0.55 + Math.random() * 0.4,
        vx: (Math.random() - 0.5) * 90,
        vy: -(2.6 + Math.random() * 3.2),
        age: 0,
        life: 0.9 + Math.random() * 0.6,
        s: 0.9 + Math.random() * 1.6,
      });
    }
  }

  /**
   * The user drank: water drains away, a "+1" message floats up.
   * @param {string} msg floating message
   * @returns {void}
   */
  drink(msg) {
    if (this.drainAge >= 0) {
      if (msg) this.floats.push({ msg, age: 0.3 }); // already draining: just offset a second message
      return;
    }
    this.pHold = lerp(this.p, 1, easeInOut(this.r));
    this.drainRe = easeInOut(this.r); // light-line style only shows water if a reminder was up
    const wasReminding = this.r > 0.05; // the badge still has to fade out
    this.remind = false;
    this.drainAge = 0;
    if (msg) this.floats.push({ msg, age: wasReminding ? -0.4 : 0 });
  }

  /**
   * Reminder dismissed for later: text fades, water recedes to the snooze level.
   * @param {string} msg floating message
   * @returns {void}
   */
  snooze(msg) {
    const wasReminding = this.r > 0.05; // let the badge fade before the message rises
    this.remind = false;
    if (msg) this.floats.push({ msg, age: wasReminding ? -0.4 : 0 });
  }

  /**
   * Advances the animation and draws one frame.
   * @param {number} dt seconds since the last frame
   * @returns {void}
   */
  frame(dt) {
    if ((window.devicePixelRatio || 1) !== this.dpr) this.resize(); // moved to a screen with another DPI
    const step = Math.min(dt, 0.1); // avoid jumps after a stall
    this.t += step;
    this.update(step, this.geometry());
    this.draw(this.geometry());
  }

  /**
   * Busy frames want 60 fps; a calm bar is fine at ~30.
   * @returns {boolean} true while something is moving fast
   */
  get busy() {
    const entering = this.remind && this.remindAge < 3; // pop-in + splash; a reminder left waiting drops to 30 fps
    const leaving = !this.remind && this.r > 0; // badge fading out
    const jumping = Math.abs(this.target - this.p) > 0.01; // big progress change (snooze, reset), not the slow creep
    return entering || leaving || jumping || this.drainAge >= 0 || this.floats.length > 0 || this.drops.length > 0;
  }

  /**
   * Derives everything a frame needs from the current state.
   * @returns {object} frame geometry
   */
  geometry() {
    const o = this.opts; // options
    const vertical = o.side === 'left' || o.side === 'right'; // rotated taskbar
    const L = vertical ? this.h : this.w; // length along the bar
    const S = vertical ? this.w : this.h; // thickness across the bar
    const unit = S / 48; // scale relative to a standard 48 px taskbar
    const re = easeInOut(this.r); // eased reminder blend
    const draining = this.drainAge >= 0; // drink animation running
    const dk = draining ? clamp(this.drainAge / DRAIN, 0, 1) : 0; // drain progress
    const line = o.mode === 'line' || o.compact; // thin light-line style
    const p = draining ? this.pHold : lerp(this.p, 1, re); // drawn liquid progress
    const base = line ? 0.94 * (draining ? this.drainRe : re) : lerp(0.8, 0.94, re); // liquid height fraction
    const level = base * (1 - dk * dk * dk); // drinking lowers the water
    const surge = this.remind ? 3.4 * Math.exp(-this.remindAge * 2.2) : 0; // splash right after the reminder fires
    const amp = unit * (1.4 + 2 * re + surge + 3 * Math.sin(dk * Math.PI)); // wave height
    const full = p >= 0.999; // liquid reaches the far end
    const end = full ? L + 4 : p * L + Math.sin(this.t * 2.2) * 0.8; // liquid front x
    const atBottom = o.side === 'top' || o.side === 'left'; // light line sits on the far edge
    const T = o.compact ? S : Math.max(2, Math.round(S * 0.075)); // light line thickness
    const lineP = draining ? lerp(this.pHold, this.target, easeInOut(dk)) : this.p; // light line progress
    return {
      vertical, L, S, unit, re, dk, draining, line, p, level, amp, full, end, atBottom, T,
      front: p * L, // front without the wobble: used for on/off decisions so they don't flicker
      top: S * (1 - level),
      y0: atBottom ? S - T : 0,
      lineX: lineP * L,
      theme: THEMES[o.theme] || THEMES.ocean,
      alpha: clamp(o.opacity, 0.15, 1),
    };
  }

  /**
   * Moves, spawns and retires particles.
   * @param {number} dt seconds
   * @param {object} g frame geometry
   * @returns {void}
   */
  update(dt, g) {
    this.r = this.remind ? Math.min(1, this.r + dt / 0.8) : Math.max(0, this.r - dt / 0.38);
    this.remindAge += dt;
    if (this.drainAge >= 0) {
      this.drainAge += dt;
      if (this.drainAge >= DRAIN) {
        this.drainAge = -1;
        this.p = this.target;
      }
    } else {
      this.p += (this.target - this.p) * (1 - Math.exp(-dt * 3));
    }

    const wet = g.level > 0.01 && g.front > 2; // there is liquid to fill
    this.acc.bubble += wet ? dt * (g.p * 7 + g.re * 16 + (g.draining ? 46 : 0)) : 0;
    while (this.acc.bubble >= 1 && this.bubbles.length < 90) {
      this.acc.bubble -= 1;
      this.bubbles.push({
        x: Math.random() * Math.max(0, g.end - 14),
        y: g.S + 3,
        r: (0.7 + Math.random() * 1.7) * g.unit,
        vy: (10 + Math.random() * 18) * g.unit * (g.draining ? 2.6 : 1),
        ph: Math.random() * TAU,
      });
    }
    this.acc.bubble %= 1;
    this.bubbles = this.bubbles.filter((b) => {
      b.y -= b.vy * dt;
      b.x += Math.sin(this.t * 2.4 + b.ph) * dt * 6;
      // Pop just under the lowest trough: then bubbles never show above the water without clipping.
      return b.y - b.r > g.top + g.amp && b.x + b.r < g.end - 12;
    });

    if (g.line && g.re < 0.5 && g.lineX > 2) {
      this.acc.spark += dt * 22;
      const dir = g.atBottom ? -1 : 1; // sparks drift into the taskbar
      while (this.acc.spark >= 1) {
        this.acc.spark -= 1;
        this.sparks.push({ line: true, x: g.lineX, y: g.y0 + g.T / 2, vx: -(18 + Math.random() * 60), vy: dir * Math.random() * 16, age: 0, life: 0.45 + Math.random() * 0.5, s: (0.6 + Math.random() * 0.9) * Math.max(1, g.T / 3) });
      }
    } else if (!g.line && !g.full && wet && g.p > 0.01) {
      this.acc.spark += dt * 1.6;
      while (this.acc.spark >= 1) {
        this.acc.spark -= 1;
        this.sparks.push({ line: false, x: g.end - 4 - Math.random() * Math.min(70, g.end), age: 0, life: 0.8 + Math.random() * 0.7, s: (1.6 + Math.random() * 1.8) * g.unit });
      }
    } else {
      this.acc.spark = 0;
    }
    this.sparks = this.sparks.filter((s) => {
      s.age += dt;
      if (s.line) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
      }
      return s.age < s.life;
    });

    this.drops = this.drops.filter((d) => {
      d.vy += 14 * dt; // gravity, in bar thicknesses per s²
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.age += dt;
      return d.age < d.life;
    });

    if (this.remind) {
      this.acc.ring += dt / 1.25;
      if (this.acc.ring >= 1) {
        this.acc.ring -= 1;
        this.rings.push({ age: 0 });
      }
    }
    this.rings = this.rings.filter((r) => (r.age += dt) < 1.6);
    this.floats = this.floats.filter((f) => (f.age += dt) < FLOAT);
  }

  /**
   * (Re)builds the sprites that depend on theme, size and pixel ratio. Cheap when nothing changed.
   * @param {object} g frame geometry
   * @returns {object} sprite kit
   */
  prepare(g) {
    const dpr = this.dpr; // device pixel ratio
    const lp = g.vertical ? this.canvas.height : this.canvas.width; // layer length (device px)
    const sp = g.vertical ? this.canvas.width : this.canvas.height; // layer thickness (device px)
    const key = `${this.opts.theme}|${dpr}|${lp}|${sp}`; // everything the sprites depend on
    if (this.kit?.key === key) return this.kit;

    // Sprites are built near their on-screen size: shrinking a big sprite 10× makes thin rings flicker.
    const bs = Math.max(6, Math.ceil(2 * 2.4 * g.unit * dpr) + 2); // largest bubble, device px
    const bubble = makeCanvas(bs, bs); // bubble sprite, scaled per bubble
    const bc = bubble.getContext('2d'); // bubble context
    const br = bs / 2 - 0.8; // ring radius
    bc.beginPath();
    bc.arc(bs / 2, bs / 2, br, 0, TAU);
    bc.fillStyle = 'rgba(255,255,255,0.2)';
    bc.fill();
    bc.lineWidth = Math.max(1, 0.7 * dpr);
    bc.strokeStyle = 'rgba(255,255,255,0.85)';
    bc.stroke();
    bc.beginPath();
    bc.arc(bs / 2 - br * 0.33, bs / 2 - br * 0.33, Math.max(0.6, br * 0.25), 0, TAU);
    bc.fillStyle = 'rgba(255,255,255,0.9)';
    bc.fill();

    const dot = makeCanvas(32, 32); // glowing splash droplet sprite
    const dc = dot.getContext('2d'); // droplet context
    const dg = dc.createRadialGradient(16, 16, 0, 16, 16, 16); // droplet glow
    dg.addColorStop(0, 'rgba(255,255,255,1)');
    dg.addColorStop(0.3, rgba(g.theme.glow, 0.9));
    dg.addColorStop(1, rgba(g.theme.glow, 0));
    dc.fillStyle = dg;
    dc.fillRect(0, 0, 32, 32);

    const ns = Math.max(4, Math.ceil(12 * g.unit * dpr)); // nose sprite = the largest nose radius
    const nose = makeCanvas(ns, ns); // cuts the rounded top-right corner of the liquid front
    const nc = nose.getContext('2d'); // nose context
    nc.fillRect(0, 0, ns, ns);
    nc.globalCompositeOperation = 'destination-out';
    nc.beginPath();
    nc.arc(0, ns, ns, 0, TAU);
    nc.fill();

    this.kit = {
      key,
      bubble,
      dot,
      nose,
      front: makeCanvas(lp, sp), // front water layer
      back: makeCanvas(lp, sp), // back water layer
      tiles: new Map(), // wave tiles per layer + amplitude
    };
    this.badgeKit = null;
    return this.kit;
  }

  /**
   * One wave period strip for a surface layer at a given amplitude: an "air" mask (opaque above
   * the surface, used to cut the water) and, for the front layer, the glowing surface line.
   * @param {number} i layer index into LAYERS
   * @param {number} amp wave amplitude (CSS px)
   * @param {object} g frame geometry
   * @returns {object} tile: { w, h, cy, yAt, air, line }
   */
  tile(i, amp, g) {
    const kit = this.kit; // current sprite kit
    const ampQ = Math.round(amp * 4) / 4; // quantised amplitude keeps the cache small
    const key = `${i}|${ampQ}`; // cache key
    const hit = kit.tiles.get(key); // cached tile
    if (hit) return hit;
    if (kit.tiles.size > 120) kit.tiles.clear();

    const dpr = this.dpr; // device pixel ratio
    const period = Math.max(16, Math.round(LAYERS[i].lambda * g.unit * dpr)); // one wavelength (device px)
    const w = period * 2; // two periods: the third harmonic below repeats too
    const a = ampQ * dpr; // amplitude (device px)
    const pad = Math.ceil(4 * g.unit * dpr) + 2; // room for the glow line
    const h = Math.ceil(2 * a + 2 * pad); // tile height
    const cy = h / 2; // mean surface inside the tile
    const phase = i * 1.9; // layers start out of step
    /**
     * Surface height inside the tile; periodic over the tile width so tiles join seamlessly.
     * @param {number} x device px from the tile's left edge
     * @returns {number} y in device px
     */
    const yAt = (x) => cy + a * (0.72 * Math.sin((TAU * x) / period + phase) + 0.28 * Math.sin((TAU * 3 * x) / w + 1.1 + phase));

    const air = makeCanvas(w, h); // opaque above the surface
    const ac = air.getContext('2d'); // air context
    ac.beginPath();
    ac.moveTo(0, 0);
    for (let x = 0; x <= w; x += 2) ac.lineTo(x, yAt(x));
    ac.lineTo(w, yAt(w));
    ac.lineTo(w, 0);
    ac.closePath();
    ac.fill();

    let line = null; // glowing surface line (front layer only)
    if (i === 0) {
      line = makeCanvas(w, h);
      const lc = line.getContext('2d'); // line context
      lc.beginPath();
      for (let x = -6; x <= w + 6; x += 2) lc.lineTo(x, yAt(x));
      lc.lineJoin = 'round';
      lc.lineWidth = 4 * g.unit * dpr;
      lc.strokeStyle = rgba(g.theme.glow, 0.24);
      lc.stroke();
      lc.lineWidth = 1.3 * dpr;
      lc.strokeStyle = 'rgba(255,255,255,0.78)';
      lc.stroke();
    }
    const t = { w, h, cy, yAt, air, line }; // the tile
    kit.tiles.set(key, t);
    return t;
  }

  /**
   * Where a surface layer sits this frame (device px).
   * @param {number} i layer index
   * @param {object} g frame geometry
   * @returns {object} { tile, ox, yTop }: tile, horizontal scroll, tile top
   */
  surface(i, g) {
    const tile = this.tile(i, g.amp, g); // wave strip for this amplitude
    const ox = mod(this.t * LAYERS[i].speed * g.unit * this.dpr, tile.w); // scroll offset
    const yTop = (g.top + LAYERS[i].dy * g.unit) * this.dpr - tile.cy; // tile top
    return { tile, ox, yTop };
  }

  /**
   * Surface height of a layer at a device x.
   * @param {object} s layer surface from surface()
   * @param {number} x device px
   * @returns {number} device y
   */
  surfAt(s, x) {
    return s.yTop + s.tile.yAt(mod(x - s.ox, s.tile.w));
  }

  /**
   * Paints one water layer offscreen: colour + gloss, then cuts the air above the waves.
   * @param {HTMLCanvasElement} cv layer canvas
   * @param {object} s layer surface
   * @param {object} g frame geometry
   * @param {number} endP liquid front (device px)
   * @param {number} rp nose radius (device px)
   * @param {boolean} gloss add the glassy highlight
   * @returns {void}
   */
  paintLayer(cv, s, g, endP, rp, gloss) {
    const c = cv.getContext('2d'); // layer context
    c.globalCompositeOperation = 'source-over';
    // Only the part that held water last frame or holds it now needs clearing.
    c.clearRect(0, 0, Math.min(cv.width, Math.ceil(Math.max(endP, cv.wbExtent ?? cv.width)) + 2), cv.height);
    cv.wbExtent = Math.max(0, endP);
    if (endP <= 0) return;
    const top = s.yTop + 1; // start inside the tile's solid air rows, so no seam is left above
    const body = c.createLinearGradient(0, 0, g.full ? cv.width : Math.max(endP, 80 * this.dpr), 0); // colours along the bar
    body.addColorStop(0, g.theme.c[0]);
    body.addColorStop(0.55, g.theme.c[1]);
    body.addColorStop(1, g.theme.c[2]);
    c.fillStyle = body;
    c.fillRect(0, top, endP, cv.height - top);
    if (gloss) {
      const shine = c.createLinearGradient(0, top, 0, cv.height); // glassy top light
      shine.addColorStop(0, 'rgba(255,255,255,0.42)');
      shine.addColorStop(0.35, 'rgba(255,255,255,0.08)');
      shine.addColorStop(1, rgba(g.theme.glow, 0.24));
      c.fillStyle = shine;
      c.fillRect(0, top, endP, cv.height - top);
    }
    c.globalCompositeOperation = 'destination-out';
    for (let x = s.ox - s.tile.w; x < endP; x += s.tile.w) c.drawImage(s.tile.air, x, s.yTop);
    if (rp > 0) {
      const yn = this.surfAt(s, endP - rp); // where the rounded front starts
      c.drawImage(this.kit.nose, endP - rp, yn, rp, rp);
      c.fillStyle = '#000'; // destination-out uses the source alpha: it must be solid
      c.fillRect(endP - rp, 0, rp + 2, yn); // flat top over the nose, matching its outline
    }
    c.globalCompositeOperation = 'source-over';
  }

  /**
   * Draws the whole frame.
   * @param {object} g frame geometry
   * @returns {void}
   */
  draw(g) {
    const { ctx } = this; // context
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (g.L < 1 || g.S < 1) return;
    this.prepare(g);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (g.vertical) {
      ctx.translate(0, this.h);
      ctx.rotate(-Math.PI / 2);
    }
    if (g.line) {
      this.drawLine(g, g.alpha * (1 - g.re));
    } else {
      ctx.fillStyle = rgba('#FFFFFF', 0.1 * g.alpha * (1 - g.re));
      ctx.fillRect(0, g.atBottom ? g.S - 1 : 0, g.L, 1);
    }
    if (g.level > 0.005 && g.front > 1.5) this.drawLiquid(g);
    this.drawDrops(g);
    if (g.re > 0.01) this.drawReminder(g);
    this.drawFloats(g);
    if (this.label && !this.opts.compact && g.re < 0.99 && !g.draining) this.drawLabel(g, 1 - g.re);
  }

  /**
   * The water body: two scrolling wave layers, surface line, bubbles, shimmer, glowing front.
   * @param {object} g frame geometry
   * @returns {void}
   */
  drawLiquid(g) {
    const { ctx, t, dpr, kit } = this; // context, clock, pixel ratio, sprites
    const { L, S, end, theme } = g; // geometry shortcuts
    const breath = 1 - 0.16 * g.re * (0.5 + 0.5 * Math.sin(t * 2.6)); // pulse while reminding
    const a = g.alpha * 0.62 * (1 + 0.38 * g.re) * breath; // body alpha
    const k = 0.45 + 0.55 * g.alpha; // highlight strength
    const R = g.full ? 0 : clamp(Math.min((S - g.top) * 0.5, 12 * g.unit), 0, Math.max(0, end)); // nose radius
    const endP = g.full ? kit.front.width : end * dpr; // liquid front (device px)
    const rp = R * dpr; // nose radius (device px)
    const back = this.surface(1, g); // back wave layer
    const front = this.surface(0, g); // front wave layer
    this.paintLayer(kit.back, back, g, endP, rp, false);
    this.paintLayer(kit.front, front, g, endP, rp, true);
    // Composite only the wet part of the layers (device px source → CSS px destination, 1:1).
    const sw = Math.min(kit.front.width, Math.ceil(endP) + 2); // source width
    const sh = kit.front.height; // source height
    ctx.globalAlpha = a * 0.5;
    ctx.drawImage(kit.back, 0, 0, sw, sh, 0, 0, sw / dpr, sh / dpr);
    ctx.globalAlpha = a;
    ctx.drawImage(kit.front, 0, 0, sw, sh, 0, 0, sw / dpr, sh / dpr);

    ctx.globalAlpha = 0.6 * k;
    ctx.imageSmoothingQuality = 'medium'; // mipmapped downscale: steady rings, no twinkling
    for (const b of this.bubbles) ctx.drawImage(kit.bubble, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    ctx.imageSmoothingQuality = 'low';

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    const deep = Math.min(S, g.top + g.amp); // lowest trough: below it everything is water
    const bodyEnd = g.full ? L : Math.max(0, end - R); // where the straight body ends
    const sweep = ((t % 4.6) / 4.6) * (Math.max(end, 200) + 260) - 130; // shimmer band centre
    const x0 = clamp(sweep - 50, 0, bodyEnd); // shimmer band left
    const x1 = clamp(sweep + 50, 0, bodyEnd); // shimmer band right
    if (x1 > x0) {
      const shine = ctx.createLinearGradient(sweep - 50, 0, sweep + 50, 0); // shimmer band
      shine.addColorStop(0, 'rgba(255,255,255,0)');
      shine.addColorStop(0.5, rgba('#FFFFFF', 0.14 * k));
      shine.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shine;
      ctx.fillRect(x0, deep, x1 - x0, S - deep);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Surface line: stamp the pre-drawn line tiles up to where the rounded nose begins.
    ctx.globalAlpha = k;
    const tile = front.tile; // front wave strip
    const limit = endP - rp; // device x where the line stops
    for (let x = front.ox - tile.w; x < limit; x += tile.w) {
      const sw = Math.min(tile.w, limit - x); // visible part of this tile
      ctx.drawImage(tile.line, 0, 0, sw, tile.h, x / dpr, front.yTop / dpr, sw / dpr, tile.h / dpr);
    }
    if (R > 0) {
      const ys = this.surfAt(front, limit) / dpr; // surface where the nose starts
      ctx.beginPath(); // the nose outline is short: drawing it directly is cheap
      ctx.moveTo(end - R, ys);
      ctx.quadraticCurveTo(end, ys, end, ys + R);
      ctx.lineWidth = 4 * g.unit; // same two strokes as the line tiles, so the glow doesn't stop here
      ctx.strokeStyle = rgba(theme.glow, 0.24);
      ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(255,255,255,0.78)';
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    if (!g.full) {
      const glow = ctx.createRadialGradient(end, S * 0.6, 0, end, S * 0.6, S * 1.15); // glowing liquid front
      glow.addColorStop(0, rgba(theme.glow, 0.45 * k * (1 - g.dk) * clamp(end / S, 0, 1))); // grows in, no pop
      glow.addColorStop(1, rgba(theme.glow, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(end - S * 1.2, -S * 0.6, S * 2.4, S * 2.4);
    }
    ctx.fillStyle = rgba('#FFFFFF', 0.9 * k);
    for (const s of this.sparks) {
      if (s.line) continue;
      const life = Math.sin((s.age / s.life) * Math.PI); // 0 → 1 → 0 twinkle
      star(ctx, s.x, this.surfAt(front, s.x * dpr) / dpr - 2, s.s * (0.25 + life));
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * "流光细线" style: a glowing line with a comet head along the inner taskbar edge.
   * @param {object} g frame geometry
   * @param {number} k overall alpha
   * @returns {void}
   */
  drawLine(g, k) {
    if (k <= 0.005) return;
    const { ctx, t } = this; // context, clock
    const { L, S, T, y0, theme } = g; // geometry shortcuts
    const x = g.lineX; // head position
    ctx.fillStyle = rgba('#FFFFFF', 0.1 * k);
    ctx.fillRect(0, y0, L, T);
    if (x < 0.5) return;

    if (!this.opts.compact) {
      const edge = g.atBottom ? S : 0; // edge the light spills from
      const reach = T * 7; // spill depth
      const spill = ctx.createLinearGradient(0, edge, 0, g.atBottom ? edge - reach : edge + reach); // soft light under the line
      spill.addColorStop(0, rgba(theme.glow, 0.3 * k));
      spill.addColorStop(1, rgba(theme.glow, 0));
      ctx.fillStyle = spill;
      ctx.fillRect(0, g.atBottom ? edge - reach : edge, x, reach);
    }
    const core = ctx.createLinearGradient(0, 0, Math.max(x, 60), 0); // line colours
    core.addColorStop(0, rgba(theme.c[0], k));
    core.addColorStop(0.55, rgba(theme.c[1], k));
    core.addColorStop(1, rgba(theme.c[2], k));
    ctx.fillStyle = core;
    ctx.fillRect(0, y0, x, T);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const pos = ((t * 150 + (i * (x + 80)) / 3) % (x + 80)) - 40; // energy pulse travelling along the line
      const pulse = ctx.createLinearGradient(pos - 40, 0, pos + 40, 0); // pulse shape
      pulse.addColorStop(0, 'rgba(255,255,255,0)');
      pulse.addColorStop(0.5, rgba('#FFFFFF', 0.55 * k));
      pulse.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = pulse;
      ctx.fillRect(Math.max(0, pos - 40), y0, Math.min(80, x - Math.max(0, pos - 40)), T);
    }
    const hy = y0 + T / 2; // head centre y
    const hr = T * 3 + 8; // head glow radius
    const head = ctx.createRadialGradient(x, hy, 0, x, hy, hr); // comet head glow
    head.addColorStop(0, rgba(theme.glow, 0.9 * k));
    head.addColorStop(0.35, rgba(theme.glow, 0.35 * k));
    head.addColorStop(1, rgba(theme.glow, 0));
    ctx.fillStyle = head;
    ctx.fillRect(x - hr, hy - hr, hr * 2, hr * 2);
    ctx.fillStyle = rgba(theme.glow, k);
    for (const s of this.sparks) {
      if (!s.line) continue;
      const size = s.s * 2 * (1 - s.age / s.life); // sparks shrink instead of fading: one colour, cheap rects
      ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.arc(x, hy, Math.max(1.5, T * 0.75), 0, TAU);
    ctx.fillStyle = rgba('#FFFFFF', 0.95 * k);
    ctx.fill();
  }

  /**
   * Splash droplets thrown up when the reminder fires.
   * @param {object} g frame geometry
   * @returns {void}
   */
  drawDrops(g) {
    if (!this.drops.length) return;
    const { ctx } = this; // context
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.drops) {
      const r = d.s * g.unit * 2.2; // sprite radius incl. glow
      ctx.globalAlpha = 1 - d.age / d.life;
      ctx.drawImage(this.kit.dot, d.x - r, d.y * g.S - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Renders text (with an optional glow) into a sprite once.
   * @param {string} str text
   * @param {string} font CSS font
   * @param {number} fs font size (CSS px)
   * @param {string|CanvasGradient|Function} fill fill style, or a factory (ctx, h) => style
   * @param {string} glow glow colour ('' = none)
   * @returns {object} { cv, w, pad, h } in CSS px
   */
  textSprite(str, font, fs, fill, glow) {
    const dpr = this.dpr; // device pixel ratio
    this.ctx.font = font;
    const w = this.ctx.measureText(str).width; // advance width (CSS px)
    const pad = glow ? fs * 0.6 : 2; // room for the glow
    const h = fs * 1.5 + pad * 2; // sprite height (CSS px)
    const cv = makeCanvas((w + pad * 2) * dpr, h * dpr); // sprite surface
    const c = cv.getContext('2d'); // sprite context
    c.scale(dpr, dpr);
    c.font = font;
    c.textBaseline = 'middle';
    c.fillStyle = typeof fill === 'function' ? fill(c, h) : fill;
    if (glow) {
      c.shadowColor = glow;
      c.shadowBlur = fs * 0.55 * dpr;
    }
    c.fillText(str, pad, h / 2 + 1);
    return { cv, w, pad, h };
  }

  /**
   * Sprites for the reminder badge; rebuilt only when text, theme or size change.
   * @param {object} g frame geometry
   * @returns {object} badge kit
   */
  badge(g) {
    const fs = clamp(g.S * 0.4, 12, 30); // main font size
    const text = this.opts.text || '该喝水啦'; // reminder text
    const key = `${this.kit.key}|${text}|${fs}`; // sprites depend on these
    if (this.badgeKit?.key === key) return this.badgeKit;
    const dpr = this.dpr; // device pixel ratio
    const theme = g.theme; // colours
    const font = `700 ${fs}px ${FONT}`; // main font
    /**
     * Vertical white → glow gradient for the reminder text.
     * @param {CanvasRenderingContext2D} c sprite context
     * @param {number} h sprite height
     * @returns {CanvasGradient} fill
     */
    const ink = (c, h) => {
      const grad = c.createLinearGradient(0, h / 2 - fs / 2, 0, h / 2 + fs / 2); // text colours
      grad.addColorStop(0, '#FFFFFF');
      grad.addColorStop(1, theme.glow);
      return grad;
    };
    const chars = [...text].map((ch) => this.textSprite(ch, font, fs, ink, rgba(theme.glow, 0.85))); // one sprite per bobbing letter
    const hint = this.textSprite(HINT, `500 ${Math.max(9, fs * 0.5)}px ${FONT}`, fs * 0.5, 'rgba(255,255,255,0.72)', ''); // hint text

    const dropH = fs * 1.05; // drop icon height
    const dropW = dropH * 0.72; // drop icon width
    const dpad = fs * 0.7; // glow room around the drop
    const drop = makeCanvas((dropW + dpad * 2) * dpr, (dropH + dpad * 2) * dpr); // drop icon sprite
    const dc = drop.getContext('2d'); // drop context
    dc.scale(dpr, dpr);
    const dx = dropW / 2 + dpad; // drop centre in the sprite
    const dy = dropH / 2 + dpad; // drop centre in the sprite
    dropPath(dc, dx, dy, dropH);
    const dropFill = dc.createLinearGradient(0, dy - dropH / 2, 0, dy + dropH / 2); // drop colours
    dropFill.addColorStop(0, '#FFFFFF');
    dropFill.addColorStop(0.45, theme.glow);
    dropFill.addColorStop(1, theme.c[1]);
    dc.shadowColor = rgba(theme.glow, 0.9);
    dc.shadowBlur = fs * 0.6 * dpr;
    dc.fillStyle = dropFill;
    dc.fill();
    dc.shadowBlur = 0;
    dc.beginPath();
    dc.ellipse(dx - dropW * 0.16, dy + dropH * 0.12, dropW * 0.09, dropH * 0.14, -0.4, 0, TAU);
    dc.fillStyle = 'rgba(255,255,255,0.85)';
    dc.fill();

    const spacing = fs * 0.08; // letter spacing
    const textW = chars.reduce((s, c) => s + c.w + spacing, -spacing); // text width
    const gap = fs * 0.5; // gap between pieces
    const ph = Math.min(g.S * 0.78, fs * 1.95); // pill height
    const pill = makeCanvas(1, 1); // sized in drawReminder (depends on whether the hint fits)
    this.badgeKit = { key, fs, chars, hint, drop, dropW, dropH, dpad, spacing, textW, gap, ph, pill, pillKey: '' };
    return this.badgeKit;
  }

  /**
   * Centre badge: bouncing drop, ripples, wavy "该喝水啦" text and a hint — all stamped sprites.
   * @param {object} g frame geometry
   * @returns {void}
   */
  drawReminder(g) {
    const { ctx, t, dpr } = this; // context, clock, pixel ratio
    const { L, S, theme } = g; // geometry shortcuts
    const b = this.badge(g); // badge sprites
    const showHint = L > b.textW + b.hint.w + b.dropW + b.fs * 6; // hide the hint on short bars
    const total = b.dropW + b.gap + b.textW + (showHint ? b.gap * 1.3 + b.hint.w : 0); // content width
    const cx = L / 2; // badge centre x
    const cy = S / 2; // badge centre y
    const x0 = cx - total / 2; // content left
    const pw = total + b.ph * 1.1; // pill width
    const pop = this.remind ? backOut(clamp(this.remindAge / 0.75, 0, 1)) : 1; // pop-in scale

    const pillKey = `${pw}|${b.ph}`; // pill sprite depends on its size
    if (b.pillKey !== pillKey) {
      b.pill.width = Math.ceil((pw + 4) * dpr);
      b.pill.height = Math.ceil((b.ph + 4) * dpr);
      const pc = b.pill.getContext('2d'); // pill context
      pc.scale(dpr, dpr);
      pc.beginPath();
      pc.roundRect(2, 2, pw, b.ph, b.ph / 2);
      pc.fillStyle = 'rgba(6, 12, 26, 0.34)';
      pc.fill();
      pc.lineWidth = 1;
      pc.strokeStyle = 'rgba(255,255,255,0.38)';
      pc.stroke();
      b.pillKey = pillKey;
    }

    ctx.save();
    ctx.globalAlpha = g.re;
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
    ctx.translate(-cx, -cy);
    const px = cx - pw / 2 - 2; // pill sprite left
    const py = cy - b.ph / 2 - 2; // pill sprite top
    ctx.drawImage(b.pill, px, py, b.pill.width / dpr, b.pill.height / dpr);
    const sx = cx - pw / 2 + (((t % 2.8) / 2.8) * (pw + 160) - 80); // shine sweep x
    const sweepL = clamp(sx - 40, cx - pw / 2 + b.ph / 2, cx + pw / 2 - b.ph / 2); // keep the shine off the round ends
    const sweepR = clamp(sx + 40, cx - pw / 2 + b.ph / 2, cx + pw / 2 - b.ph / 2); // (no clip path needed)
    if (sweepR > sweepL) {
      const sweep = ctx.createLinearGradient(sx - 40, 0, sx + 40, 0); // shine band
      sweep.addColorStop(0, 'rgba(255,255,255,0)');
      sweep.addColorStop(0.5, 'rgba(255,255,255,0.13)');
      sweep.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = sweep;
      ctx.fillRect(sweepL, cy - b.ph / 2 + 1, sweepR - sweepL, b.ph - 2);
      ctx.globalCompositeOperation = 'source-over';
    }

    const dx = x0 + b.dropW / 2; // drop centre x
    const base = cy + b.dropH * 0.45; // where ripples spread
    ctx.lineWidth = 1.2;
    for (const r of this.rings) {
      const k = r.age / 1.6; // ring progress
      const rx = 4 + easeOut(k) * b.fs * 2.6; // ring radius
      ctx.beginPath();
      ctx.ellipse(dx, base, rx, rx * 0.28, 0, 0, TAU);
      ctx.strokeStyle = rgba(theme.glow, (1 - k) * 0.75);
      ctx.stroke();
    }
    const hop = Math.abs(Math.sin(t * 3.4)); // 0 = touching down
    const dy = cy - hop * S * 0.08; // drop centre y
    const sqx = 1 + (1 - hop) * 0.12; // squash wide on touchdown
    const sqy = 1 - (1 - hop) * 0.1; // and flat
    const dw = b.drop.width / dpr; // drop sprite width
    const dh = b.drop.height / dpr; // drop sprite height
    const bottom = dy + b.dropH / 2; // squash is anchored at the drop's bottom
    ctx.drawImage(b.drop, dx - (dw * sqx) / 2, bottom - (b.dropH + b.dpad) * sqy, dw * sqx, dh * sqy);

    let x = x0 + b.dropW + b.gap; // pen position
    b.chars.forEach((c, i) => {
      const y = cy + Math.sin(t * 3.2 + i * 0.75) * S * 0.035; // each letter floats on its own wave
      ctx.drawImage(c.cv, x - c.pad, y - c.h / 2, c.cv.width / dpr, c.cv.height / dpr);
      x += c.w + b.spacing;
    });
    if (showHint) {
      const hx = x - b.spacing + b.gap * 1.3; // hint left
      ctx.drawImage(b.hint.cv, hx - b.hint.pad, cy - b.hint.h / 2, b.hint.cv.width / dpr, b.hint.cv.height / dpr);
    }
    ctx.restore();
  }

  /**
   * Floating messages ("+1 杯", "稍后提醒") rising from the centre.
   * @param {object} g frame geometry
   * @returns {void}
   */
  drawFloats(g) {
    if (!this.floats.length) return;
    const { ctx, dpr } = this; // context, pixel ratio
    const fs = clamp(g.S * 0.3, 11, 22); // message font size
    for (const f of this.floats) {
      if (f.age < 0) continue; // still waiting for the badge to fade
      if (f.key !== this.kit.key) {
        // (Re)build when theme / size / DPI changed, e.g. an auto-hide strip that just grew.
        f.sprite = this.textSprite(f.msg, `700 ${fs}px ${FONT}`, fs, '#FFFFFF', rgba(g.theme.glow, 0.9));
        f.key = this.kit.key;
      }
      const k = f.age / FLOAT; // life progress
      ctx.globalAlpha = k < 0.12 ? k / 0.12 : 1 - ((k - 0.12) / 0.88) ** 2; // fade in, then out
      const s = f.sprite; // message sprite
      const y = g.S / 2 - easeOut(k) * g.S * 0.22; // rising
      ctx.drawImage(s.cv, g.L / 2 - s.w / 2 - s.pad, y - s.h / 2, s.cv.width / dpr, s.cv.height / dpr);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Small countdown label riding next to the liquid front.
   * @param {object} g frame geometry
   * @param {number} k alpha
   * @returns {void}
   */
  drawLabel(g, k) {
    const { ctx } = this; // context
    const fs = clamp(g.S * 0.22, 9, 13); // label font size
    ctx.font = `600 ${fs}px Bahnschrift, ${FONT}`;
    const w = ctx.measureText(this.label).width; // label width
    const head = g.line ? g.lineX : g.end; // label follows the front, flips left near the end
    const x = g.full ? g.L - w - 8 : head + 10 + w < g.L - 4 ? head + 10 : head - w - 12; // label left
    const y = g.line ? (g.atBottom ? g.y0 - fs * 0.8 : g.T + fs * 0.8) : Math.max(fs * 0.7, g.S * 0.15); // label middle
    const lx = clamp(x, 6, g.L - w - 6); // label left after clamping
    ctx.fillStyle = `rgba(4, 10, 24, ${0.38 * k})`; // a small pill keeps it readable (cheaper than shadowBlur)
    ctx.beginPath();
    ctx.roundRect(lx - 5, y - fs * 0.62, w + 10, fs * 1.24, fs * 0.62);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgba('#FFFFFF', 0.94 * k);
    ctx.fillText(this.label, lx, y + 0.5);
  }
}
