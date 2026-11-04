'use strict';
// Tabs (with the address bar's #hash, so a link can open one) and the latest release's version.

const tabs = [...document.querySelectorAll('[role="tab"]')];
const ids = tabs.map(t => t.getAttribute('aria-controls'));

function show(id, focus = false, remember = true) {
  if (!ids.includes(id)) id = 'overview';
  for (const t of tabs) {
    const on = t.getAttribute('aria-controls') === id;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  }
  // The address remembers a chosen tab (to share or reload); opening the page plainly stays at the top.
  if (remember && location.hash.slice(1) !== id) history.replaceState(null, '', id === 'overview' ? location.pathname : `#${id}`);
}

tabs.forEach((t, i) => {
  t.addEventListener('click', () => show(ids[i]));
  t.addEventListener('keydown', ev => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -i, End: tabs.length - 1 - i }[ev.key];
    if (step === undefined) return;
    ev.preventDefault();
    show(ids[(i + step + tabs.length) % tabs.length], true);
  });
});
// Links that open a tab ("See what it does") scroll to the tabs too.
for (const a of document.querySelectorAll('[data-tab-link]')) {
  a.addEventListener('click', ev => {
    ev.preventDefault();
    show(a.dataset.tabLink);
    document.getElementById('tabs').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
}
addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1), false, false);

// Themes: pick one and the app's pictures change to it (all of a theme's pictures are fetched first,
// so they change together).
const picks = [...document.querySelectorAll('#theme-pick [role="radio"]')];
const shots = [...document.querySelectorAll('.theme-preview img')];
const swapReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function pickTheme(btn, focus = false) {
  for (const b of picks) { const on = b === btn; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; }
  if (focus) btn.focus();
  const id = btn.dataset.theme;
  const name = btn.dataset.name;
  const next = shots.map(img => `assets/themes/${id}-${img.dataset.page}.webp`);
  Promise.all(next.map(src => new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = src; }))).then(() => {
    shots.forEach(img => img.classList.add('swap'));
    setTimeout(() => {
      shots.forEach((img, i) => {
        img.src = next[i];
        img.alt = img.alt.replace(/in the .* theme$/, `in the ${name} theme`);
        img.classList.remove('swap');
      });
      for (const el of document.querySelectorAll('[data-theme-name]')) el.textContent = name;
    }, swapReduced ? 0 : 250);
  });
}
picks.forEach((b, i) => {
  b.addEventListener('click', () => pickTheme(b));
  b.addEventListener('keydown', ev => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (!step) return;
    ev.preventDefault();
    pickTheme(picks[(i + step + picks.length) % picks.length], true);
  });
});

// The newest release, to show its version and date by the Download buttons.
fetch('https://api.github.com/repos/skyehosting/edgerunners-mod-manager/releases/latest')
  .then(r => (r.ok ? r.json() : null))
  .then(rel => {
    if (!rel?.tag_name) return;
    const date = new Date(rel.published_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    for (const el of document.querySelectorAll('[data-version]')) el.textContent = rel.tag_name;
    for (const el of document.querySelectorAll('[data-date]')) el.textContent = `${rel.tag_name}, released ${date}.`;
  })
  .catch(() => {});
