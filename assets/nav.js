// ============================================================
// Mobile navigation. Progressive enhancement: the markup ships with the panel
// open and no trigger, so if this file fails to load the links are all still
// there and reachable. The script adds the trigger and closes the panel.
//
// Loaded as a plain module on every page; it initialises itself.
// ============================================================

const nav = document.querySelector('.nav__inner');
const panel = nav && nav.querySelector('.nav__panel');

if (nav && panel) {
  if (!panel.id) panel.id = 'nav-menu';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav__toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panel.id);
  toggle.innerHTML = '<span class="nav__burger" aria-hidden="true"></span><span>Menu</span>';

  // Trigger goes before the panel so the tab order is trigger then contents.
  panel.parentNode.insertBefore(toggle, panel);

  // Duplicate the primary CTA into the bar itself. On a phone the one thing that
  // must never be behind a menu is the way to become a customer.
  const cta = panel.querySelector('.btn');
  if (cta) {
    const copy = cta.cloneNode(true);
    copy.classList.add('nav__cta');
    toggle.parentNode.insertBefore(copy, toggle.nextSibling);
  }

  // The panel starts closed only now that a trigger exists to open it.
  panel.hidden = true;

  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';

  function open() {
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onOutside, true);
  }

  function close({ refocus = false } = {}) {
    toggle.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside, true);
    // Only on a deliberate dismissal. Stealing focus back after someone taps a
    // link would fight the navigation they just asked for.
    if (refocus) toggle.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close({ refocus: true }); }
  }

  function onOutside(e) {
    if (!isOpen()) return;
    if (panel.contains(e.target) || toggle.contains(e.target)) return;
    close();
  }

  toggle.addEventListener('click', () => (isOpen() ? close({ refocus: true }) : open()));

  // Following a link closes it, including a same-page anchor, where no navigation
  // happens and the panel would otherwise sit open over the section just jumped to.
  panel.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });

  // Crossing the breakpoint while open leaves an orphaned panel on the desktop
  // layout, where CSS puts the links back in the bar.
  const wide = matchMedia('(min-width: 861px)');
  const sync = () => { if (wide.matches) close(); };
  wide.addEventListener('change', sync);
  sync();
}
