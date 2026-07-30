// ============================================================
// Package cards collapse on narrow viewports only.
//
// The markup ships with every <details class="plan__body"> open, so a visitor
// without JS, and every desktop visitor, sees the full descriptions exactly as
// before. This file closes them below the breakpoint, where five stacked
// descriptions accounted for most of the pricing section's height.
//
// The closed state stays meaningful: the package name and its price are both
// outside the collapsed region, so the two facts someone scans for are always
// visible and only the detail is a tap away.
// ============================================================

const BREAK = '(max-width: 720px)';
// Package cards and process steps use the same pattern, so they share the logic.
const cards = [...document.querySelectorAll('details.plan__body, details.step__body')];

if (cards.length) {
  const narrow = matchMedia(BREAK);

  // Remember anything the visitor opened themselves, so a resize does not
  // silently undo their choice.
  const openedByUser = new WeakSet();
  cards.forEach((d) => {
    d.addEventListener('toggle', () => {
      if (!narrow.matches) return;
      if (d.open) openedByUser.add(d);
      else openedByUser.delete(d);
    });
  });

  function sync() {
    for (const d of cards) {
      d.open = narrow.matches ? openedByUser.has(d) : true;
    }
  }

  narrow.addEventListener('change', sync);
  sync();
}
