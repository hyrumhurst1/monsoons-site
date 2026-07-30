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

const hexRgb = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

export const DEFAULTS = {
  pixelSize: 8,
  spacing: 0.38,
  dotScale: 0.82,
  levels: 5,
  whiteClip: 0.16,   // clip the top N of the histogram — see note below
  contrast: 14,
  brightness: 6,
  floor: 0.008,
  ink: '#e8e4da',
  ground: '#16202b',
  shape: 'dot',
  fit: 'contain',   // 'contain' shows the whole plate, 'cover' fills the box
  leanRadius: 0.6,   // pointer field radius as a fraction of canvas width
  leanStrength: 7,   // cells of horizontal displacement at full strength

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
};

/** Natural size and readiness for either an <img> or a <video>. */
const srcW = (s) => s.videoWidth ?? s.naturalWidth ?? 0;
const srcH = (s) => s.videoHeight ?? s.naturalHeight ?? 0;
const srcReady = (s) =>
  s.tagName === 'IMG' ? s.complete && s.naturalWidth > 0 : s.readyState >= 2;

export function initDither(canvas, video, options = {}) {
  let P = { ...DEFAULTS, ...options };
  const ctx = canvas.getContext('2d', { alpha: false });
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  // Reveal mode paints the dither into its own layer, then masks that layer to
  // a soft disc under the cursor. The plate itself stays untouched.
  const dl = document.createElement('canvas');
  const dctx = dl.getContext('2d');
  let reveal = 0; // eased 0..1 so it fades in and out instead of snapping

  let cols = 0, rows = 0, pinned = null, raf = 0, stopped = false;
  let wavePhase = 0;
  let prevLum = null;   // previous frame's luminance, for temporal easing
  const ptr = { x: -1e5, y: -1e5, active: false };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.x = ((e.clientX - r.left) / r.width) * canvas.width;
    ptr.y = ((e.clientY - r.top) / r.height) * canvas.height;
    ptr.active = true;
  });
  canvas.addEventListener('pointerleave', () => (ptr.active = false));

  function size() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(240, Math.floor(rect.width * dpr));
    canvas.height = Math.max(200, Math.floor(rect.height * dpr));
    pinned = null;
  }
  const ro = new ResizeObserver(size);
  ro.observe(canvas.parentElement);
  video.addEventListener('loadedmetadata', size);
  video.addEventListener('load', size);
  size();

  // Auto-levels must be pinned for the whole sequence — recomputing per
  // frame makes dot density visibly pulse. And the white point clips the
  // top slice deliberately: on a night plate the moon is a tiny bright
  // outlier, and letting it set white crushes the rain into black.
  function pin(lum) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < lum.length; i++) hist[(lum[i] * 255) | 0]++;
    const total = lum.length;
    let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.02) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * P.whiteClip) { hi = i; break; } }
    pinned = { lo: lo / 255, hi: Math.max(hi / 255, lo / 255 + 0.05) };
  }

  function frame() {
    if (stopped) return;
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
      const lum = new Float32Array(cols * rows);
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
      const ink = hexRgb(P.ink);
      const rMax = (cell * (1 - P.spacing) / 2) * P.dotScale;
      const R = canvas.width * P.leanRadius;

      const isReveal = P.mode === 'reveal';
      if (P.wave && !reduceMotion) {
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
        if (reveal === 0) { raf = requestAnimationFrame(frame); return; }
        if (dl.width !== canvas.width || dl.height !== canvas.height) {
          dl.width = canvas.width; dl.height = canvas.height;
        }
        dctx.globalCompositeOperation = 'source-over';
        dctx.clearRect(0, 0, dl.width, dl.height);
        dctx.fillStyle = P.ground;
        dctx.fillRect(0, 0, dl.width, dl.height);
        g = dctx;
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

      const buckets = new Map();
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const cx = x * cell + cell / 2;
          const cy = y * cell + cell / 2;
          let sxi = x, syi = y;

          if (!isReveal && ptr.active && !reduceMotion) {
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

          if (P.wave && !reduceMotion) {
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

          const key = tone.toFixed(2);
          let arr = buckets.get(key);
          if (!arr) buckets.set(key, (arr = []));
          arr.push(dx2, dy2, r);
        }
      }

      for (const [key, arr] of buckets) {
        g.fillStyle = `rgba(${ink.r},${ink.g},${ink.b},${key})`;
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
    raf = requestAnimationFrame(frame);
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
    setOpts(next) { P = { ...P, ...next }; pinned = null; },
    stop() { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
