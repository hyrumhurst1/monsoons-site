// ============================================================
// Mounting a dithered still plate. Four pages were each hand-rolling this, with
// slightly different logic, which is exactly how one of them ended up fetching a
// 1400px source during first paint for a plate three screens down.
//
//   mountPlate(canvas, img, ditherOpts, { rootMargin })
// ============================================================

import { initDither } from './dither.js';

/**
 * Defer the source fetch until the plate is near the viewport, then start the
 * engine once the bytes land.
 *
 * Deferral is done by holding the URL in `data-src` rather than with
 * `loading="lazy"`, and that is not a stylistic choice. These source images are
 * `display: none` by design — they are dither input, not content — and a lazy
 * image with no layout box gives the browser no way to judge viewport proximity,
 * so it may never fetch at all. Marking them lazy silently emptied a plate.
 */
export function mountPlate(canvas, img, opts = {}, { rootMargin = '300px' } = {}) {
  if (!canvas || !img) return null;

  let started = false;
  const start = () => {
    if (started || !img.naturalWidth) return;
    started = true;
    initDither(canvas, img, { fit: 'cover', ...opts });
  };

  const io = new IntersectionObserver(
    (entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();
      // Kick off the fetch now if it has been held back.
      if (!img.getAttribute('src') && img.dataset.src) {
        img.src = img.dataset.src;
      }
      if (img.complete && img.naturalWidth) start();
      else img.addEventListener('load', start, { once: true });
    },
    { rootMargin }
  );
  io.observe(canvas);
  return io;
}
