// ============================================================
// The nav mark assembles itself out of scattered dots on page load, once, then
// hands back to the static <img> so no render loop is left running in the nav.
//
// Loaded as a plain module script on every page; it initialises itself.
//
// Deliberately NOT the luminance dither used on plates and headings. That maps a
// whole image onto a single ink, which for the roundel would throw away the
// indigo disc and the bone field inside it — the logo would arrive as a flat
// silhouette. Instead the real artwork is revealed through a dot mask that fills
// in: same visual idea, brand colours intact.
// ============================================================

const DUR = 680;
const CELL = 3;      // mask cell in CSS px. At a 42px mark that is a 14x14 grid,
                     // coarse enough to read as dots at this size.
const JITTER = 2.6;  // cell-widths of travel before a cell settles
// Fraction of the run any single cell takes to fade in. Cell start times are
// spread across the remaining (1 - WINDOW), which is what guarantees every cell
// reaches full opacity exactly at the end. Comparing a cell's hash directly
// against progress instead leaves the last-arriving cells permanently part
// transparent, so the mark never actually finishes assembling.
const WINDOW = 0.42;

/** Deterministic 0..1 per cell, so the reveal order is stable across frames. */
function cellNoise(x, y) {
  let h = (x * 73856093) ^ (y * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function initLogoResolve(img) {
  if (!img || img.dataset.resolveOn === '1') return;
  // Respect reduced motion by simply not running: the static mark is already the
  // finished state, so there is nothing to fall back to.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const w = img.clientWidth || img.width;
  const h = img.clientHeight || img.height;
  if (!w || !h) return;
  img.dataset.resolveOn = '1';

  const wrap = document.createElement('span');
  wrap.className = 'markfx';
  img.parentNode.insertBefore(wrap, img);
  wrap.appendChild(img);

  const cv = document.createElement('canvas');
  cv.className = 'markfx__c';
  cv.setAttribute('aria-hidden', 'true');
  wrap.appendChild(cv);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');

  // Rasterise the artwork once at target size and blit cells from that, rather
  // than re-scaling the full-resolution source on every cell of every frame.
  const flat = document.createElement('canvas');
  flat.width = W;
  flat.height = H;
  flat.getContext('2d').drawImage(img, 0, 0, W, H);

  const cell = Math.max(2, CELL * dpr);
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);

  wrap.classList.add('markfx--running');
  const t0 = performance.now();

  function frame(now) {
    // Progress is linear on purpose: cells arrive at a constant rate, and the
    // easing lives on each cell's own fade. Easing the schedule instead front
    // loaded it badly — half the mark landed in the first fifth of the run.
    const p = Math.min(1, (now - t0) / DUR);
    ctx.clearRect(0, 0, W, H);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const start = cellNoise(x, y) * (1 - WINDOW);
        const raw = (p - start) / WINDOW;
        if (raw <= 0) continue;           // this cell has not arrived yet
        const local = raw >= 1 ? 1 : 1 - (1 - raw) * (1 - raw);
        const a = cellNoise(x + 811, y + 419) * 6.2832;
        const d = (1 - local) * cell * JITTER;
        const sx = x * cell;
        const sy = y * cell;
        const cw = Math.min(cell, W - sx);
        const chh = Math.min(cell, H - sy);
        ctx.globalAlpha = local;
        ctx.drawImage(
          flat, sx, sy, cw, chh,
          sx + Math.cos(a) * d, sy + Math.sin(a) * d, cw, chh
        );
      }
    }
    ctx.globalAlpha = 1;

    if (p < 1) requestAnimationFrame(frame);
    else {
      // Hand back to the <img> and drop the canvas: nothing should keep painting
      // in the nav for the rest of the session.
      wrap.classList.remove('markfx--running');
      cv.remove();
    }
  }

  requestAnimationFrame(frame);
}

const mark = document.querySelector('.nav__mark');
if (mark) {
  if (mark.complete && mark.naturalWidth) initLogoResolve(mark);
  else mark.addEventListener('load', () => initLogoResolve(mark), { once: true });
}
