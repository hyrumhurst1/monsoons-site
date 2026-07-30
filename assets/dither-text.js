// ============================================================
// Dithered headings. Renders a heading's own glyphs to an offscreen canvas,
// runs them through the same dither engine as the plates, and resolves the
// dots into place when the heading scrolls into view. On pointer, the field
// displaces around the cursor.
//
//   initDitherText(el, opts) -> controller | null
//   initDitherHeadings(selector, opts) -> controller[]
//
// Returns null and leaves the real text visible if anything is not right, so a
// failure here degrades to a normal heading instead of an empty box.
// ============================================================

import { initDither } from './dither.js';

const SS = 2; // source supersample. The luminance buffer samples at cell
              // resolution, so the source only needs enough detail to
              // downscale cleanly — 2x is plenty and 4x costs memory for nothing.

/**
 * The line boxes the browser actually produced, one per rendered line.
 *
 * This is the whole reason the module works. Re-implementing wrapping with
 * measureText would drift from CSS immediately: `text-wrap: balance` alone
 * moves break points in ways no reimplementation would guess. Instead we let
 * CSS wrap the real text, then read the result back off a Range.
 */
function lineBoxes(node, origin) {
  const text = node.nodeValue;
  const range = document.createRange();
  const breaks = [];
  let lastTop = null;

  for (let i = 1; i <= text.length; i++) {
    range.setStart(node, i - 1);
    range.setEnd(node, i);
    const rects = range.getClientRects();
    if (!rects.length) continue; // whitespace collapsed at a wrap point
    const top = rects[0].top;
    if (lastTop === null) lastTop = top;
    // Half a line is a generous threshold; subpixel jitter is well under it.
    else if (Math.abs(top - lastTop) > rects[0].height * 0.5) {
      breaks.push(i - 1);
      lastTop = top;
    }
  }

  const bounds = [0, ...breaks, text.length];
  const lines = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    range.setStart(node, bounds[i]);
    range.setEnd(node, bounds[i + 1]);
    const r = range.getBoundingClientRect();
    const slice = text.slice(bounds[i], bounds[i + 1]);
    if (!slice.trim()) continue;
    lines.push({
      // Leading whitespace is part of the measured rect, so trim only the end.
      text: slice.replace(/\s+$/, ''),
      left: r.left - origin.left,
      top: r.top - origin.top,
      height: r.height,
    });
  }
  return lines;
}

/**
 * White glyphs on black, sized and positioned against `boxEl` — the bleed box,
 * which is deliberately taller than the text's line box. Descenders legitimately
 * render outside a line box, so a canvas clipped to that box shears the bottom
 * off every 'y', 'p' and 'g'.
 */
function paintSource(src, styleEl, node, boxEl) {
  const cs = getComputedStyle(styleEl);
  const size = parseFloat(cs.fontSize);
  const box = boxEl.getBoundingClientRect();
  const w = box.width, h = box.height;
  if (w < 8 || h < 8) return false;
  const lines = lineBoxes(node, box);
  if (!lines.length) return false;

  src.width = Math.max(2, Math.round(w * SS));
  src.height = Math.max(2, Math.round(h * SS));
  const c = src.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#000';
  c.fillRect(0, 0, src.width, src.height);

  c.setTransform(SS, 0, 0, SS, 0, 0);
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
  // Computed letter-spacing is already resolved to px, which is the only unit
  // canvas letterSpacing reliably takes. Unsupported: it stays '' and the line
  // renders a few px wider, which at this cell size is invisible.
  if ('letterSpacing' in c && cs.letterSpacing !== 'normal') {
    c.letterSpacing = cs.letterSpacing;
  }
  c.fillStyle = '#fff';
  c.textBaseline = 'alphabetic';

  // Canvas has no font-variation-settings, so Fraunces renders at its default
  // axes rather than SOFT 25 / WONK 1. Harmless here: the CSS text is invisible,
  // so there is nothing for the glyphs to misregister against, and a 3-5px dot
  // grid discards that level of detail anyway.
  const m = c.measureText('Hxg');
  const asc = m.fontBoundingBoxAscent || size * 0.8;
  const desc = m.fontBoundingBoxDescent || size * 0.2;

  for (const ln of lines) {
    // CSS centres the glyph box in the line box; half-leading is the remainder.
    const baseline = ln.top + (ln.height - (asc + desc)) / 2 + asc;
    const width = c.measureText(ln.text).width;
    const room = w - ln.left;
    if (width > room && room > 0) {
      // Only reachable when canvas metrics disagree with CSS metrics. Squeeze
      // rather than let the line run off the plate.
      c.save();
      c.translate(ln.left, baseline);
      c.scale(room / width, 1);
      c.fillText(ln.text, 0, 0);
      c.restore();
    } else {
      c.fillText(ln.text, ln.left, baseline);
    }
  }
  return true;
}

/** First non-empty text node, but only if the heading is plain text. */
function soleTextNode(el) {
  const kids = [...el.childNodes].filter(
    (n) => n.nodeType !== Node.TEXT_NODE || n.nodeValue.trim()
  );
  if (kids.length !== 1 || kids[0].nodeType !== Node.TEXT_NODE) return null;
  return kids[0];
}

/** Nearest ancestor with an opaque background, so the plate matches its section. */
function groundOf(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    const m = bg.match(/^rgba?\(([^)]+)\)/);
    if (!m) continue;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    if (parts.length < 4 || parts[3] > 0.99) {
      return `#${parts.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return '#f6f4ef';
}

/** Rec. 709 luma of a #rrggbb string, thresholded. */
function isDark(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r + g + b)) return false;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

export function initDitherText(el, opts = {}) {
  if (el.dataset.ditherOn === '1') return null;
  const node = soleTextNode(el);
  if (!node) return null; // inline markup inside the heading: leave it alone

  // Dot pitch in CSS pixels, and a 2x backing store so a dot narrower than a
  // device pixel still rasterises instead of vanishing.
  //
  // The pitch is what governs legibility, and it is not a free parameter: cell
  // count is boxWidth / pitch, so a heading with a 24px cap height needs a pitch
  // near 2.4 to clear ten dot rows through the capitals. At the 4px the plates
  // use, the same heading gets nine rows for the whole line and turns to mush.
  const DENSITY = 2;
  const pitch = opts.cell ?? 2;
  const cell = pitch * DENSITY;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Wrap the text so it keeps its own layout box while going transparent, and
  // sit the canvas on top of it. The text stays in the DOM, selectable and read
  // by screen readers; the canvas is decoration and says so.
  const span = document.createElement('span');
  span.className = 'dtext__t';
  el.insertBefore(span, node);
  span.appendChild(node);

  // The canvas lives inside a bleed box that extends above and below the line
  // box, so ascender overshoot and descenders both have room. That only works
  // because the dither draws transparent: an opaque ground on a box this size
  // would paint over the label above and the paragraph below.
  const bleed = document.createElement('span');
  bleed.className = 'dtext__bleed';
  bleed.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  canvas.className = 'dtext__c';
  bleed.appendChild(canvas);
  el.appendChild(bleed);
  el.classList.add('dtext');

  const src = document.createElement('canvas');
  let d = null, ready = false;

  function build() {
    if (!paintSource(src, span, node, bleed)) return false;
    const ground = opts.ground || groundOf(el);
    if (!d) {
      d = initDither(canvas, src, {
        pixelSize: cell,
        density: DENSITY,
        transparent: true,   // the bleed box must not paint over its neighbours
        autoLevels: false,   // pure ink on pure ground; see dither.js
        levels: 5,
        // A plate can afford a light touch; a heading cannot. Dots at plate
        // spacing cover about 8% of the box where solid type covers 15%, which
        // made the h2 read lighter than the paragraph beneath it and inverted the
        // hierarchy. Near-zero spacing plus hard contrast pushes stroke cells to
        // full tone so the line carries its proper weight and still reads as dots.
        // High, and for a specific reason: the source is downscaled hard on the
        // way into the cell buffer, so a stroke a few pixels wide averages to
        // mid-grey and few cells ever reach full tone. Gamma alone barely moved
        // it. This pushes those averaged mid-greys back apart.
        contrast: 55,
        brightness: 5,
        floor: 0.05,         // drop the faint halo around the glyph edges
        gamma: 0.72,         // lift midtones so more stroke cells reach full tone
        smooth: 0.34,        // lower than the plates: glyph edges need to hold
        temporal: 0,         // nothing moves unless the pointer moves
        spacing: 0.08,
        dotScale: 1,
        wave: false,
        fit: 'contain',
        ink: opts.ink || getComputedStyle(el).color,
        ground,
        leanRadius: 0.22,
        leanStrength: 3.2,
        // A minority of dots break to a second ink and wander, so the heading
        // reads as alive. White only works where there is something dark behind
        // it — on paper it would vanish into the ground — so the second ink is
        // chosen against the ground: white on indigo, slate on paper. Either way
        // it reads as the field catching light rather than as a second colour.
        altInk: opts.altInk || (isDark(ground) ? '#ffffff' : '#6b727a'),
        altRate: 0.07,
        altDrift: pitch * 0.75,
        altSpeed: 0.014,
        ...opts.dither,
      });
    } else {
      d.setOpts({});
    }
    return true;
  }

  if (!build()) {
    // Roll back to a normal heading rather than leaving an empty canvas.
    el.classList.remove('dtext');
    bleed.remove();
    span.replaceWith(node);
    return null;
  }

  el.dataset.ditherOn = '1';
  el.classList.add('dtext--on');
  d.pause();

  // ---- resolve out of loose dots, once, on first sight ----
  let resolved = false;
  function resolve() {
    if (resolved) return;
    resolved = true;
    if (reduce) { d.setOpts({ scatter: 0 }); d.step(); ready = true; return; }

    const dur = 820;
    const t0 = performance.now();
    d.resume();
    (function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      d.setOpts({
        pixelSize: cell + (1 - e) * cell * 2.1,
        scatter: (1 - e) * cell * 2.6,
        smooth: 0.34 + (1 - e) * 0.7,
      });
      if (p < 1) requestAnimationFrame(tick);
      // No pause at the end: the drifting dots need frames. Visibility, below,
      // is what stops the loop.
      else { d.setOpts({ pixelSize: cell, scatter: 0, smooth: 0.34 }); ready = true; }
    })(t0);
  }

  // Visibility owns the render loop. The drifting dots and the pointer field
  // both need frames, but a heading three screens up does not, and leaving one
  // loop per heading running is how a page with a single motion moment starts
  // costing as much as one with ten.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          resolve();
          if (!reduce) d.resume();
        } else if (resolved && !reduce) {
          d.pause();
        }
      }
    },
    { threshold: 0.2 }
  );
  io.observe(el);

  // A resize changes the line breaks, so the source has to be repainted.
  let rt = 0;
  const ro = new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!paintSource(src, span, node, bleed)) return;
      d.setOpts({});
      d.step();
    }, 120);
  });
  ro.observe(el);

  return {
    el,
    stop() { io.disconnect(); ro.disconnect(); d.stop(); },
  };
}

export function initDitherHeadings(selector, opts = {}) {
  const els = [...document.querySelectorAll(selector)];
  if (!els.length) return [];
  const go = () => els.map((el) => initDitherText(el, opts)).filter(Boolean);
  // Before the webfonts land the line boxes come from the Georgia fallback and
  // every measurement is wrong, so wait rather than paint a heading twice.
  if (document.fonts && document.fonts.status !== 'loaded') {
    const out = [];
    document.fonts.ready.then(() => out.push(...go()));
    return out;
  }
  return go();
}
