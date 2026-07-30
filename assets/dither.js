// ============================================================
// Ordered-dither engine, extracted so the hero and the lab share one
// implementation. Renders a <video> to a <canvas> as a Bayer dot field.
//
// initDither(canvas, video, opts) -> { setOpts, stop }
// ============================================================

function bayer(n) {
  if (n === 1) return [[0]];
  const p = bayer(n / 2);
  const s = p.length;
  const m = Array.from({ length: n }, () => new Array(n));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const q = y < s ? (x < s ? 0 : 2) : x < s ? 3 : 1;
      m[y][x] = 4 * p[y % s][x % s] + q;
    }
  return m;
}
const BAYER = bayer(8);
const BN = 64;

/** Deterministic 0..1 per cell. Same cell, same value, every frame. */
function cellNoise(x, y) {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Any CSS colour a caller is likely to hand us: #abc, #aabbcc, or the
 * rgb()/rgba() form that getComputedStyle always returns.
 *
 * This used to accept hex only, and the failure was nasty enough to be worth
 * recording. Passing a computed "rgb(28, 26, 23)" made slice(1,3) parse as NaN,
 * so fillStyle became "rgba(NaN,NaN,8,0.8)". Canvas silently ignores an invalid
 * fillStyle and keeps the previous one, which here was the ground colour — so
 * every dot painted in the ground and the plate looked blank with no console
 * error and no exception to catch.
 */
function toRgb(c) {
  const fallback = { r: 232, g: 228, b: 218 };
  if (typeof c !== 'string') return fallback;
  const s = c.trim();
  if (s[0] === '#') {
    const h =
      s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
    const v = {
      r: parseInt(h.slice(1, 3), 16),
      g: parseInt(h.slice(3, 5), 16),
      b: parseInt(h.slice(5, 7), 16),
    };
    return Number.isNaN(v.r + v.g + v.b) ? fallback : v;
  }
  const m = s.match(/-?\d*\.?\d+/g);
  if (m && m.length >= 3) return { r: +m[0], g: +m[1], b: +m[2] };
  return fallback;
}

export const DEFAULTS = {
  pixelSize: 8,
  spacing: 0.38,
  dotScale: 0.82,
  levels: 5,
  whiteClip: 0.16,   // clip the top N of the histogram — see note below
  // Auto-levels stretches the plate's real tonal range to fill the dot range,
  // which is right for photographs. Text and the logo are already pure ink on
  // pure ground, so stretching a two-spike histogram just eats the antialiased
  // edge and the glyphs come back jagged. Those sources set this false.
  autoLevels: true,
  contrast: 14,
  brightness: 6,
  floor: 0.008,
  ink: '#e8e4da',
  ground: '#16202b',
  // Composite the dots over whatever is behind the canvas instead of over an
  // opaque ground. Needed wherever the canvas is larger than the thing it draws
  // — dithered text has to bleed past its line box to catch descenders, and an
  // opaque ground would paint that bleed over the neighbouring elements.
  transparent: false,
  shape: 'dot',
  fit: 'contain',   // 'contain' shows the whole plate, 'cover' fills the box
  // Backing-store multiplier. A plate is large enough that one device pixel per
  // CSS pixel gives plenty of cells, but a 38px-tall heading only yields nine
  // dot rows across its cap height at that density, which renders as sub-pixel
  // mush. Oversampling buys cells without making the dots coarser on screen.
  density: 1,
  leanRadius: 0.6,   // pointer field radius as a fraction of canvas width
  leanStrength: 7,   // cells of horizontal displacement at full strength

  // Per-cell positional jitter in pixels, on a stable per-cell angle. Animating
  // this to 0 is what makes a plate look like it assembles itself out of loose
  // dots. Distinct from `smooth`, which jitters the threshold rather than the
  // position, so it changes which dots exist rather than where they sit.
  scatter: 0,

  // A minority of cells painted in a second colour and allowed to drift, so the
  // field reads as alive rather than as a static screen. The set of cells is
  // chosen by a stable hash and never changes: picking new cells every frame
  // makes the whole plate flicker, whereas holding the set and moving only the
  // positions reads as motion.
  altInk: null,      // null disables. Any CSS colour.
  altRate: 0.06,     // fraction of cells promoted to altInk
  altDrift: 1.6,     // px of travel, peak to peak
  altSpeed: 0.012,   // phase advance per frame

  // Travelling crest, like a wave through a crowd. Dots swell and lift as it
  // passes, then settle. Off by default.
  wave: false,
  waveSpeed: 0.0022,  // phase advance per frame
  waveWidth: 0.28,    // crest width as a fraction of the canvas
  waveGain: 1.15,     // extra dot radius at the crest
  waveLift: 9,        // pixels the crest rises
  waveTilt: 0.35,     // crest slant, so it sweeps rather than moving as a wall
  waveDir: 1,         // 1 travels left to right, -1 right to left

  // Smoothing. Bayer repeats an 8x8 threshold pattern, which reads as a hard
  // regular grid. A stable per-cell hash offsets each threshold slightly,
  // breaking that regularity into something closer to blue noise without
  // shimmering between frames. 0 is pure Bayer, 1 is fully scattered.
  smooth: 0.55,
  // Temporal easing. Without it the dot field is recomputed from scratch every
  // frame, so dots pop in and out and the whole plate crawls. Blending this
  // frame's luminance into the last one makes cells ease between states.
  // 0 disables it; 0.8 is very smooth but laggy on fast motion.
  temporal: 0.45,
  // Above this per-cell frame-to-frame delta, temporal easing is released so
  // motion stays responsive. Below it, history is held so still areas do not
  // pop or band. Fixed easing everywhere is what made the plates feel slow.
  temporalBreak: 0.06,
  // Gamma below 1 lifts midtones before quantising, so gradients step less
  // visibly across the available tone levels.
  gamma: 0.85,

  // ---- scheduling ----
  // Frames per second for a source that genuinely changes on its own: a video, or
  // a still with `wave` on. 0 means this instance never runs a loop and only
  // redraws when something asks it to — which is correct for every static plate.
  //
  // This exists because the engine used to schedule requestAnimationFrame
  // unconditionally, forever, for every instance on the page. A full-width plate
  // does a source draw, a getImageData, a luminance pass, per-cell math and
  // thousands of canvas paths per frame; doing that at 60fps for artwork that
  // never changes is most of a mobile device's main thread. A Lighthouse mobile
  // lab attributed ~168s of script evaluation to this file.
  fps: 0,
  // Skip drawing while the canvas is off screen or the tab is in the background.
  // Only ever worth disabling for something that must keep state warm.
  gateOnVisibility: true,
};

// Natural size and readiness for a <video>, an <img>, or a <canvas>.
// Canvas is here so text and the logo can be dithered: both are drawn to an
// offscreen canvas first, then fed through this engine like any other plate.
// Order matters — a <video> also has .width, so videoWidth has to win.
const srcW = (s) => s.videoWidth ?? s.naturalWidth ?? s.width ?? 0;
const srcH = (s) => s.videoHeight ?? s.naturalHeight ?? s.height ?? 0;
const srcReady = (s) => {
  if (s.tagName === 'CANVAS') return s.width > 0 && s.height > 0;
  if (s.tagName === 'IMG') return s.complete && s.naturalWidth > 0;
  return s.readyState >= 2;
};

export function initDither(canvas, video, options = {}) {
  let P = { ...DEFAULTS, ...options };
  const ctx = canvas.getContext('2d', { alpha: !!P.transparent });
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  // Reveal mode paints the dither into its own layer, then masks that layer to
  // a soft disc under the cursor. The plate itself stays untouched.
  const dl = document.createElement('canvas');
  const dctx = dl.getContext('2d');
  let reveal = 0; // eased 0..1 so it fades in and out instead of snapping

  let cols = 0, rows = 0, pinned = null, raf = 0, stopped = false, running = true;
  let wavePhase = 0, altPhase = 0;
  let prevLum = null;   // previous frame's luminance, for temporal easing
  let lum = null;       // reused across frames while cols/rows are stable
  const buckets = new Map();  // reused; arrays are truncated, not reallocated
  const ptr = { x: -1e5, y: -1e5, active: false };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A coarse pointer has no hover, so pointer deformation is dead weight there,
  // and a narrow viewport is usually a phone doing the most work for the least
  // gain. Both fall back to a single static render.
  const coarse = matchMedia('(pointer: coarse)').matches;
  const staticOnly = reduceMotion || coarse || innerWidth < 720;

  let pending = false;   // one queued draw at most
  let onScreen = !P.gateOnVisibility;

  /**
   * Ask for exactly one frame. Repeated calls inside the same frame collapse into
   * one draw, which is what makes pointermove safe to wire directly: a mouse can
   * emit far more events than there are frames.
   */
  function requestDraw() {
    if (pending || stopped) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; draw(); });
  }

  /**
   * The continuous path, for sources that change by themselves. Still driven by
   * rAF — so the browser stops it in a background tab for free — but it only
   * draws when the frame budget has elapsed, and it exits entirely when the
   * canvas scrolls away rather than spinning on a canvas nobody can see.
   */
  let last = 0;
  function loop(ts) {
    if (stopped || !running || !animated()) { raf = 0; return; }
    if (P.gateOnVisibility && (!onScreen || document.hidden)) { raf = 0; return; }
    const gap = 1000 / Math.max(1, P.fps);
    if (ts - last >= gap) { last = ts; draw(); }
    raf = requestAnimationFrame(loop);
  }
  const animated = () => !staticOnly && P.fps > 0;
  function startLoop() {
    if (raf || stopped || !running || !animated()) return;
    if (P.gateOnVisibility && (!onScreen || document.hidden)) return;
    raf = requestAnimationFrame(loop);
  }
  function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  if (!staticOnly) {
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect();
      ptr.x = ((e.clientX - r.left) / r.width) * canvas.width;
      ptr.y = ((e.clientY - r.top) / r.height) * canvas.height;
      ptr.active = true;
      // One frame per pointer move, not a loop that outlives the gesture.
      if (!animated()) requestDraw();
    });
    canvas.addEventListener('pointerleave', () => {
      ptr.active = false;
      if (!animated()) requestDraw();   // settle back to the undeformed field
    });
  }

  // Visibility gating. An off-screen or background canvas draws nothing.
  const io = new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    if (onScreen) { startLoop(); requestDraw(); } else stopLoop();
  }, { rootMargin: '120px' });
  if (P.gateOnVisibility) io.observe(canvas);

  const onVis = () => { if (document.hidden) stopLoop(); else startLoop(); };
  document.addEventListener('visibilitychange', onVis);

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 1.5) * (P.density || 1);
    // Floor at 8, not at plate dimensions. This only exists to keep the canvas
    // from being zero-sized mid-layout; a large floor silently stretches any
    // source smaller than it, which is what squashed the dithered headings 5x
    // vertically when they were 39px tall and the floor was 200.
    canvas.width = Math.max(8, Math.floor(rect.width * dpr));
    canvas.height = Math.max(8, Math.floor(rect.height * dpr));
    pinned = null;
  }
  // Assigning canvas.width clears the bitmap, so a resize must be followed by a
  // redraw or a static plate goes blank and never comes back.
  function onResize() { size(); requestDraw(); }
  const ro = new ResizeObserver(onResize);
  ro.observe(canvas.parentElement);
  const onMeta = () => { size(); requestDraw(); startLoop(); };
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('load', onMeta);
  size();

  // Auto-levels must be pinned for the whole sequence — recomputing per
  // frame makes dot density visibly pulse. And the white point clips the
  // top slice deliberately: on a night plate the moon is a tiny bright
  // outlier, and letting it set white crushes the rain into black.
  function pin(lum) {
    if (!P.autoLevels) { pinned = { lo: 0, hi: 1 }; return; }
    const hist = new Uint32Array(256);
    for (let i = 0; i < lum.length; i++) hist[(lum[i] * 255) | 0]++;
    const total = lum.length;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * P.whiteClip) { hi = i; break; } }
    pinned = { lo: lo / 255, hi: Math.max(hi / 255, lo / 255 + 0.05) };
  }

  function draw() {
    if (srcReady(video) && canvas.width) {
      const cell = P.pixelSize;
      const cw = Math.ceil(canvas.width / cell);
      const ch = Math.ceil(canvas.height / cell);
      if (cw !== cols || ch !== rows) { cols = cw; rows = ch; pinned = null; }

      buf.width = cols; buf.height = rows;
      bctx.clearRect(0, 0, cols, rows);

      // One fit calculation, used for both the cell buffer and the full-size
      // plate. If these are computed separately the revealed dots drift out of
      // register with the image underneath them.
      const bufRect = fitRect(cols, rows);
      bctx.drawImage(video, bufRect.sx, bufRect.sy, bufRect.sw, bufRect.sh,
                            bufRect.dx, bufRect.dy, bufRect.dw, bufRect.dh);

      const px = bctx.getImageData(0, 0, cols, rows).data;
      // Reused while the grid is stable. A fresh Float32Array per frame is a
      // megabyte-scale allocation per second on a full-width plate, and the GC
      // pressure showed up as long tasks rather than as slow drawing.
      if (!lum || lum.length !== cols * rows) lum = new Float32Array(cols * rows);
      for (let i = 0, p = 0; i < lum.length; i++, p += 4)
        lum[i] = (0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]) / 255;

      // Motion-adaptive easing. A single blend factor across the whole frame
      // either bands in the still areas or smears the moving ones; scaling the
      // factor by how much each cell actually changed gets both.
      if (P.temporal > 0) {
        if (!prevLum || prevLum.length !== lum.length) {
          prevLum = lum.slice();
        } else {
          const kMax = P.temporal;
          const brk = P.temporalBreak;
          for (let i = 0; i < lum.length; i++) {
            const delta = Math.abs(lum[i] - prevLum[i]);
            // Full easing when static, none once the cell is clearly moving.
            const k = delta >= brk ? 0 : kMax * (1 - delta / brk);
            prevLum[i] = prevLum[i] * k + lum[i] * (1 - k);
            lum[i] = prevLum[i];
          }
        }
      }

      if (!pinned) pin(lum);
      const { lo, hi } = pinned;
      const span = hi - lo;
      const c = 1 + P.contrast / 50;
      const b = P.brightness / 100;
      const L = Math.max(2, P.levels);
      const ink = toRgb(P.ink);
      const altOn = !!P.altInk && P.altRate > 0 && !staticOnly;
      const alt = altOn ? toRgb(P.altInk) : ink;
      if (altOn) altPhase += P.altSpeed;
      const rMax = (cell * (1 - P.spacing) / 2) * P.dotScale;
      const R = canvas.width * P.leanRadius;

      const isReveal = P.mode === 'reveal';
      if (P.wave && !staticOnly) {
        wavePhase += P.waveSpeed;
        if (wavePhase > 1 + P.waveWidth) wavePhase = -P.waveWidth;
      }

      // Ease the reveal so entering and leaving the plate feels physical.
      // Reduced-motion users still get the interaction, just without the ramp:
      // the reveal is the point of the hero, not decoration on top of it.
      const want = isReveal && ptr.active ? 1 : 0;
      reveal = reduceMotion ? want : reveal + (want - reveal) * 0.12;
      if (reveal < 0.004) reveal = 0;

      // Target surface: main canvas normally, the masked layer in reveal mode.
      let g = ctx;
      if (isReveal) {
        ctx.fillStyle = P.ground;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const m = fitRect(canvas.width, canvas.height);
        ctx.drawImage(video, m.sx, m.sy, m.sw, m.sh, m.dx, m.dy, m.dw, m.dh);
        if (reveal === 0) return;
        if (dl.width !== canvas.width || dl.height !== canvas.height) {
          dl.width = canvas.width; dl.height = canvas.height;
        }
        dctx.globalCompositeOperation = 'source-over';
        dctx.clearRect(0, 0, dl.width, dl.height);
        dctx.fillStyle = P.ground;
        dctx.fillRect(0, 0, dl.width, dl.height);
        g = dctx;
      } else if (P.transparent) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = P.ground;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // In reveal mode only the cells under the brush can ever be seen, so
      // bound the loop to that box instead of walking the whole grid.
      const brush = canvas.width * P.revealRadius;
      let x0 = 0, x1 = cols, y0 = 0, y1 = rows;
      if (isReveal) {
        x0 = Math.max(0, Math.floor((ptr.x - brush) / cell));
        x1 = Math.min(cols, Math.ceil((ptr.x + brush) / cell));
        y0 = Math.max(0, Math.floor((ptr.y - brush) / cell));
        y1 = Math.min(rows, Math.ceil((ptr.y + brush) / cell));
      }

      // Truncate rather than reallocate. The key set is bounded by levels x inks,
      // so it stabilises after one frame and this Map stops growing.
      for (const arr of buckets.values()) arr.length = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const cx = x * cell + cell / 2;
          const cy = y * cell + cell / 2;
          let sxi = x, syi = y;

          if (!isReveal && ptr.active && !staticOnly) {
            const dx = cx - ptr.x, dy = cy - ptr.y;
            const d = Math.hypot(dx, dy);
            if (d < R) {
              const f = (1 - d / R) ** 2;
              sxi = Math.min(cols - 1, Math.max(0, Math.round(x + (dx / (d || 1)) * f * P.leanStrength)));
              syi = Math.min(rows - 1, Math.max(0, Math.round(y - f * 3)));
            }
          }

          let v = (lum[syi * cols + sxi] - lo) / span;
          v = (v - 0.5) * c + 0.5 + b;
          if (v < P.floor) continue;
          v = v > 1 ? 1 : v;

          let t = (BAYER[y & 7][x & 7] + 0.5) / BN;
          if (P.smooth > 0) {
            t += (cellNoise(x, y) - 0.5) * P.smooth;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
          }
          const vg = P.gamma === 1 ? v : Math.pow(v, P.gamma);
          const scaled = vg * (L - 1);
          const base = Math.floor(scaled);
          const lvl = Math.min(L - 1, scaled - base > t ? base + 1 : base);
          if (lvl <= 0) continue;
          const tone = lvl / (L - 1);

          let dx2 = cx, dy2 = cy, r = rMax * tone;

          const isAlt = altOn && cellNoise(x + 1301, y + 7919) < P.altRate;
          if (isAlt && P.altDrift > 0) {
            // Each drifting cell gets its own phase offset, so they wander
            // independently instead of sliding as one block.
            const ph = altPhase + cellNoise(x + 53, y + 131) * 6.2832;
            dx2 += Math.cos(ph) * P.altDrift;
            dy2 += Math.sin(ph * 0.73) * P.altDrift * 0.7;
          }

          if (P.scatter > 0) {
            // Second hash on a shifted coordinate so the angle is independent of
            // the threshold noise; reusing one hash makes the scatter correlate
            // with which dots survive and the field visibly streaks.
            const a = cellNoise(x + 811, y + 419) * 6.2832;
            const m = P.scatter * (0.35 + 0.65 * cellNoise(y + 233, x + 977));
            dx2 += Math.cos(a) * m;
            dy2 += Math.sin(a) * m;
          }

          if (P.wave && !staticOnly) {
            // Distance from this cell to the crest, slanted so the wave sweeps
            // diagonally instead of advancing as a flat wall.
            const ux = P.waveDir < 0 ? 1 - x / cols : x / cols;
            const u = ux + (y / rows) * P.waveTilt;
            const d = Math.abs(u - wavePhase);
            if (d < P.waveWidth) {
              // cos falloff: smooth in and out, no visible seam at the edges.
              const amp = 0.5 + 0.5 * Math.cos((d / P.waveWidth) * Math.PI);
              const e = amp * amp;
              r *= 1 + e * P.waveGain;
              dy2 -= e * P.waveLift;
            }
          }

          // Batched by colour and tone so the whole field is a handful of fills
          // rather than one per dot. The leading flag keeps the two inks apart.
          const key = (isAlt ? 'a' : 'n') + tone.toFixed(2);
          let arr = buckets.get(key);
          if (!arr) buckets.set(key, (arr = []));
          arr.push(dx2, dy2, r);
        }
      }

      for (const [key, arr] of buckets) {
        if (!arr.length) continue;
        const col = key[0] === 'a' ? alt : ink;
        g.fillStyle = `rgba(${col.r},${col.g},${col.b},${key.slice(1)})`;
        g.beginPath();
        for (let i = 0; i < arr.length; i += 3) {
          const r = arr[i + 2];
          if (r <= 0.15) continue;
          if (P.shape === 'square') g.rect(arr[i] - r, arr[i + 1] - r, r * 2, r * 2);
          else { g.moveTo(arr[i] + r, arr[i + 1]); g.arc(arr[i], arr[i + 1], r, 0, 6.2832); }
        }
        g.fill();
      }

      if (isReveal) {
        // Mask the dither layer down to a soft disc, then lay it over the plate.
        const grad = dctx.createRadialGradient(ptr.x, ptr.y, 0, ptr.x, ptr.y, brush);
        grad.addColorStop(0, `rgba(0,0,0,${reveal})`);
        grad.addColorStop(0.55, `rgba(0,0,0,${reveal * 0.85})`);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        dctx.globalCompositeOperation = 'destination-in';
        dctx.fillStyle = grad;
        dctx.fillRect(0, 0, dl.width, dl.height);
        ctx.drawImage(dl, 0, 0);
      }
    }
  }

  /** Kept for the existing callers; a "frame" is now one coalesced draw. */
  function frame() {
    if (stopped || !running) return;
    requestDraw();
    startLoop();
  }

  /**
   * Source and destination rects for drawing the plate into a W x H box.
   * 'cover' crops the source to fill; 'contain' letterboxes the destination.
   * Proportional, so calling it at buffer size and at canvas size yields the
   * same framing and the dither stays in register with the image.
   */
  function fitRect(W, H) {
    const vw = srcW(video), vh = srcH(video);
    const vr = vw / vh, br = W / H;
    if (P.fit === 'cover') {
      let sw = vw, sh = vh, sx = 0, sy = 0;
      if (vr > br) { sw = vh * br; sx = (vw - sw) / 2; }
      else { sh = vw / br; sy = (vh - sh) / 2; }
      return { sx, sy, sw, sh, dx: 0, dy: 0, dw: W, dh: H };
    }
    let dw = W, dh = H, dx = 0, dy = 0;
    if (vr > br) { dh = Math.round(W / vr); dy = Math.round((H - dh) / 2); }
    else { dw = Math.round(H * vr); dx = Math.round((W - dw) / 2); }
    return { sx: 0, sy: 0, sw: vw, sh: vh, dx, dy, dw, dh };
  }

  if (typeof video.play === 'function') video.play().catch(() => {});
  frame();

  return {
    setOpts(next) {
      P = { ...P, ...next };
      pinned = null;
      // An option change can turn animation on or off, and either way the
      // current frame is now stale.
      if (animated()) startLoop(); else stopLoop();
      requestDraw();
    },
    /** One coalesced frame. The normal way to redraw a static plate. */
    requestDraw,
    pause() { running = false; stopLoop(); },
    resume() { if (stopped || running) return; running = true; requestDraw(); startLoop(); },
    /** Draw synchronously, right now. Use when the next frame is too late. */
    step() { if (!stopped) draw(); },
    get running() { return running; },
    get animating() { return !!raf; },
    stop() {
      stopped = true;
      running = false;
      stopLoop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('load', onMeta);
    },
  };
}
