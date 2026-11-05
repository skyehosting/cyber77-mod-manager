'use strict';
// The window shown while the app checks for an update before opening (main.js updateAtLaunch).
// The main process calls say(text, percent); percent -1: busy without a known amount.
(() => {
  if (new URLSearchParams(location.search).get('light') === '1') document.documentElement.classList.add('light');
  const bar = document.getElementById('bar');
  const status = document.getElementById('status');
  window.say = (text, pct) => {
    status.textContent = String(text);
    const known = Number.isFinite(pct) && pct >= 0;
    bar.classList.toggle('busy', !known);
    bar.firstElementChild.style.width = known ? `${Math.min(100, pct)}%` : '';
    if (known) bar.setAttribute('aria-valuenow', String(Math.round(pct))); else bar.removeAttribute('aria-valuenow');
  };
})();
