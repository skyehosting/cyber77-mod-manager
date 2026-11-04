'use strict';
/* global api, $, h, icon, run, store, state, THEMES, THEME_ORDER, themeMini, chooseTheme, themeState, loadSettings, renderStatus */

// ---------------------------------------------------------------- the setup wizard

/*
 * The first time the app opens: a welcome, then one thing per step (the game folder, the Nexus
 * key, the optional AI helper, a look), then the app. Every step can be skipped, and so can the
 * whole wizard. Settings > Advanced opens it again. Someone already using the app (a key saved,
 * mods installed) never sees it unasked. Until it decides, the app stays hidden behind it
 * (themes.js marks the page in <head>, so nothing flashes).
 */

const SETUP_STEPS = ['welcome', 'game', 'nexus', 'ai', 'look', 'done'];
const su = { step: 0, busy: false, result: { game: false, nexus: '', ai: '' }, prevFocus: null };

async function maybeStartSetup() {
  if (store.get('setup.done', false)) { revealApp(); return; }
  const [s, snap] = await Promise.all([api.getSettings(), api.snapshot()]);
  if (s.ok?.hasApiKey || s.ok?.hasAiKey || snap.ok?.mods?.length || snap.ok?.downloads?.length) {
    store.set('setup.done', true);
    revealApp();
    return;
  }
  openSetup();
}

/** The app behind the wizard: shown (it fades in when the wizard closes). */
function revealApp() {
  delete document.documentElement.dataset.setup;
  $('#shell').inert = false;
}

function openSetup() {
  su.prevFocus = document.activeElement;
  su.step = 0;
  su.result = { game: false, nexus: '', ai: '' };
  const el = $('#setup');
  el.hidden = false;
  el.classList.remove('leaving');
  $('#shell').inert = true;
  document.documentElement.dataset.setup = 'open';
  showSetupStep(0, 0);
}

async function closeSetup() {
  store.set('setup.done', true);
  const el = $('#setup');
  el.classList.add('leaving');
  revealApp();
  await new Promise(r => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420));
  el.hidden = true;
  el.classList.remove('leaving');
  el.replaceChildren();
  // What the wizard saved shows in Settings and in the sidebar at once.
  await loadSettings();
  renderStatus();
  (su.prevFocus && document.contains(su.prevFocus) ? su.prevFocus : $('#play-btn'))?.focus();
}

/** Move to a step; dir 1 slides in from the right, -1 from the left, 0 just fades. */
function showSetupStep(i, dir = 1) {
  su.step = i;
  const box = $('#setup');
  const id = SETUP_STEPS[i];
  const olds = [...box.querySelectorAll('.su-step:not(.out)')];
  const step = h('section', { class: `su-step su-${id}`, dataset: { dir: String(dir) }, 'aria-labelledby': `su-title-${id}` }, ...SETUP_BUILD[id]());
  const frame = box.querySelector('.su-frame') || setupFrame(box);
  paintSetupProgress();
  for (const old of olds) {
    old.classList.add('out');
    old.dataset.dir = String(dir);
    old.inert = true;
    setTimeout(() => old.remove(), 350);
  }
  frame.querySelector('.su-stage').append(step);
  // The step's title gets the focus, so a screen reader reads where you are.
  requestAnimationFrame(() => step.querySelector('.su-title')?.focus({ preventScroll: true }));
}

function setupFrame(box) {
  const frame = h('div', { class: 'su-frame' },
    h('header', { class: 'su-top' },
      h('span', { class: 'su-brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('brand')), 'Cyber Mod Manager'),
      h('ol', { class: 'su-dots', 'aria-label': 'Setup steps' }),
      h('button', { type: 'button', class: 'btn btn-sm su-skip-all', onclick: closeSetup }, 'Skip setup')),
    h('div', { class: 'su-stage' }));
  box.replaceChildren(frame);
  return frame;
}

function paintSetupProgress() {
  const steps = SETUP_STEPS.slice(1, -1);
  const at = su.step - 1;
  const dots = $('#setup .su-dots');
  dots.hidden = su.step === 0 || su.step === SETUP_STEPS.length - 1;
  dots.replaceChildren(...steps.map((s, i) => h('li', {
    class: `su-dot${i < at ? ' done' : ''}${i === at ? ' on' : ''}`, 'aria-current': i === at ? 'step' : null,
  }, h('span', { class: 'sr-only' }, `Step ${i + 1} of ${steps.length}: ${SETUP_NAMES[s]}${i < at ? ' (done)' : ''}`))));
  $('#setup .su-skip-all').hidden = su.step === 0 || su.step === SETUP_STEPS.length - 1;
}

const SETUP_NAMES = { game: 'Your game', nexus: 'Nexus Mods', ai: 'AI helper', look: 'The look' };
const next = () => showSetupStep(Math.min(su.step + 1, SETUP_STEPS.length - 1), 1);
const back = () => showSetupStep(Math.max(su.step - 1, 0), -1);

/** A step's parts: kicker, title, words, a picture of what it is for, its controls, and the buttons. */
function stepParts({ kicker, title, text, art, body, primary, skip, noBack }) {
  const id = SETUP_STEPS[su.step];
  return [
    h('div', { class: 'su-copy' },
      kicker ? h('span', { class: 'su-kicker' }, kicker) : null,
      h('h2', { class: 'su-title', id: `su-title-${id}`, tabindex: '-1' }, title),
      h('p', { class: 'su-text' }, text),
      body || null),
    art ? h('div', { class: 'su-art', 'aria-hidden': 'true' }, art) : null,
    h('div', { class: 'su-nav' },
      noBack ? null : h('button', { type: 'button', class: 'btn btn-ghost', onclick: back }, icon('arrow-left'), h('span', {}, 'Back')),
      h('span', { class: 'su-nav-gap' }),
      skip ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: skip.fn }, skip.label) : null,
      primary),
  ].filter(Boolean);
}

const primaryBtn = (label, fn, ico = 'chevron-right') => h('button', { type: 'button', class: 'btn btn-primary su-next', onclick: fn }, h('span', {}, label), icon(ico));
const statusLine = () => h('p', { class: 'su-status', role: 'status', 'aria-live': 'polite' });
const setStatus = (el, kind, text) => {
  el.className = `su-status ${kind}`;
  const ico = { ok: 'check', bad: 'alert', warn: 'info' }[kind];
  el.replaceChildren(...(ico ? [icon(ico)] : []), h('span', {}, text));
};

// Pictures of what each step is for, drawn in the theme's own colours.
const ART = {
  game() {
    return h('div', { class: 'su-mock su-mock-game' },
      h('div', { class: 'su-folder' }, icon('folder'), h('span', { class: 'mono' }, 'Cyberpunk 2077')),
      ...['archive\\pc\\mod', 'bin\\x64\\Cyberpunk2077.exe', 'r6\\scripts'].map((p, i) =>
        h('div', { class: `su-file${i === 1 ? ' hit' : ''}` }, icon(i === 1 ? 'check' : 'folder'), h('span', { class: 'mono' }, p))));
  },
  nexus() {
    return h('div', { class: 'su-mock' },
      h('div', { class: 'su-mrow' }, h('span', { class: 'su-thumb' }), h('span', { class: 'su-mname' }, h('b', {}, 'Night City Lights'), h('span', {}, 'Download, install, done')),
        h('span', { class: 'su-mbtn' }, icon('download'), 'Download')),
      h('div', { class: 'su-mrow' }, h('span', { class: 'su-thumb b' }), h('span', { class: 'su-mname' }, h('b', {}, 'ArchiveXL'), h('div', { class: 'bar' }, h('div', { style: 'width:64%' }))),
        h('span', { class: 'tag tag-info' }, '1.28.6 available')),
      h('div', { class: 'su-mrow' }, h('span', { class: 'su-thumb c' }), h('span', { class: 'su-mname' }, h('b', {}, 'Cyber Engine Tweaks'), h('span', {}, 'Up to date')),
        h('span', { class: 'tag tag-ok' }, 'Installed')));
  },
  ai() {
    return h('div', { class: 'su-mock su-chat' },
      h('div', { class: 'su-bub me' }, 'My game crashes after the intro. Why?'),
      h('div', { class: 'su-bub' }, 'ArchiveXL can\'t read ', h('code', {}, 'arms.xl'), ': line 3 is missing a colon. Want me to fix it?'),
      h('div', { class: 'su-approve' }, h('span', {}, icon('shield'), 'Changes wait for your OK'), h('span', { class: 'su-mbtn' }, 'Approve')));
  },
};

const SETUP_BUILD = {
  welcome() {
    return [h('div', { class: 'su-hello' },
      h('span', { class: 'su-hello-mark brand-mark', 'aria-hidden': 'true' }, icon('brand')),
      h('h1', { class: 'su-title su-hello-title', id: 'su-title-welcome', tabindex: '-1' }, 'Welcome to Cyber Mod Manager'),
      h('p', { class: 'su-hello-text' }, 'Mods for Cyberpunk 2077: found, installed, kept in order, and fixed when something breaks. Let\'s get you set up. It takes about a minute, and every step can be skipped.'),
      h('div', { class: 'su-hello-go' },
        h('button', { type: 'button', class: 'btn btn-primary su-next', onclick: next }, h('span', {}, 'Get started'), icon('chevron-right')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeSetup }, 'Skip and open the app')))];
  },

  game() {
    const status = statusLine();
    const paint = async () => {
      const snap = await api.snapshot();
      const g = snap.ok?.game || {};
      su.result.game = !!g.valid;
      if (g.valid) setStatus(status, 'ok', `Found: ${g.path}`);
      else setStatus(status, 'warn', g.path ? `No Cyberpunk2077.exe in ${g.path}` : 'Not found yet: let the app look for it, or choose the folder');
    };
    paint();
    const find = h('button', { type: 'button', class: 'btn' }, icon('search'), h('span', {}, 'Find it for me'));
    find.onclick = async () => { find.disabled = true; setStatus(status, '', 'Looking in Steam, GOG and Epic…'); await api.detectGame(); await paint(); find.disabled = false; };
    const pick = h('button', { type: 'button', class: 'btn' }, icon('folder'), h('span', {}, 'Choose folder…'));
    pick.onclick = async () => {
      const p = await run(api.pickFolder('Select the Cyberpunk 2077 folder'));
      if (!p) return;
      await run(api.setSettings({ gamePath: p }));
      await paint();
    };
    return stepParts({
      kicker: 'Step 1 of 4 · Your game', title: 'Where is Cyberpunk 2077?',
      text: 'Mods go into the game\'s folder. The app usually finds it by itself; check it here, or point to it.',
      body: h('div', { class: 'su-ctl' }, status, h('div', { class: 'su-row' }, find, pick)),
      art: ART.game(), primary: primaryBtn('Continue', next), skip: { label: 'Skip for now', fn: next },
    });
  },

  nexus() {
    const status = statusLine();
    const key = h('input', { type: 'password', spellcheck: 'false', autocomplete: 'off', placeholder: 'Paste your personal API key', 'aria-label': 'Nexus Mods API key' });
    const check = async () => {
      const v = key.value.trim();
      if (!v) { setStatus(status, 'bad', 'Paste the key first'); key.focus(); return false; }
      setStatus(status, '', 'Checking…');
      const saved = await api.setSettings({ apiKey: v });
      if (saved.error) { setStatus(status, 'bad', saved.error); return false; }
      const r = await api.validateKey();
      if (r.error) { setStatus(status, 'bad', r.error); return false; }
      state.keyUser = r.ok;
      key.value = '';
      key.placeholder = 'Saved';
      su.result.nexus = r.ok.name;
      setStatus(status, 'ok', `Signed in as ${r.ok.name}${r.ok.isPremium ? ' · Premium: direct downloads' : ' · free account: one click per file on Nexus'}`);
      renderStatus();
      return true;
    };
    key.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); check(); } });
    const go = primaryBtn('Continue', async () => { if (key.value.trim() && !await check()) return; next(); });
    if (su.result.nexus) setStatus(status, 'ok', `Signed in as ${su.result.nexus}`);
    return stepParts({
      kicker: 'Step 2 of 4 · Nexus Mods', title: 'Connect your Nexus account',
      text: 'Your personal API key lets the app download mods, check them for updates, and fetch what they need. It is stored encrypted on this PC and never shown again.',
      body: h('div', { class: 'su-ctl' },
        h('button', { type: 'button', class: 'btn su-link', onclick: () => api.openLink('https://next.nexusmods.com/settings/api-keys') }, icon('external'), h('span', {}, 'Open my API key page on Nexus')),
        h('ol', { class: 'su-how' }, h('li', {}, 'Sign in on that page'), h('li', {}, 'Copy the key under "Personal API Key"'), h('li', {}, 'Paste it here')),
        h('div', { class: 'su-row' }, key, h('button', { type: 'button', class: 'btn', onclick: check }, 'Check key')),
        status),
      art: ART.nexus(), primary: go, skip: { label: 'Skip for now', fn: next },
    });
  },

  ai() {
    const status = statusLine();
    const provider = h('select', { 'aria-label': 'Provider' },
      h('option', { value: 'openai' }, 'OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio…)'), h('option', { value: 'anthropic' }, 'Anthropic (Claude)'));
    const endpoint = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Endpoint' });
    const model = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'Model' });
    const aiKey = h('input', { type: 'password', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'API key', placeholder: 'Not needed for local models' });
    const examples = () => {
      const ex = provider.value === 'anthropic' ? { e: 'https://api.anthropic.com', m: 'e.g. claude-sonnet-5-5' } : { e: 'https://api.openai.com/v1', m: 'e.g. gpt-5.1' };
      endpoint.placeholder = ex.e;
      model.placeholder = ex.m;
    };
    provider.addEventListener('change', examples);
    for (const x of [provider, endpoint, model, aiKey]) x.addEventListener('input', () => { su.result.ai = ''; });
    api.getSettings().then(r => {
      const s = r.ok || {};
      provider.value = s.aiProvider || 'openai';
      endpoint.value = s.aiEndpoint || '';
      model.value = s.aiModel || '';
      if (s.hasAiKey) aiKey.placeholder = `Saved key ${s.aiKeyHint}`;
      examples();
    });
    const save = () => {
      const patch = { aiProvider: provider.value, aiEndpoint: endpoint.value.trim(), aiModel: model.value.trim() };
      if (aiKey.value.trim()) patch.aiKey = aiKey.value.trim();
      return api.setSettings(patch);
    };
    const test = async () => {
      if (!endpoint.value.trim() || !model.value.trim()) { setStatus(status, 'bad', 'Fill in the endpoint and the model first'); return false; }
      setStatus(status, '', 'Asking the model to reply…');
      const saved = await save();
      if (saved.error) { setStatus(status, 'bad', saved.error); return false; }
      aiKey.value = '';
      const r = await api.aiTest();
      if (r.error) { setStatus(status, 'bad', `${r.error} Fix it, or choose Skip for now.`); return false; }
      su.result.ai = model.value.trim();
      setStatus(status, 'ok', `Connected: ${r.ok}`);
      return true;
    };
    const field = (label, input) => h('label', { class: 'su-field' }, h('span', {}, label), input);
    return stepParts({
      kicker: 'Step 3 of 4 · AI helper (optional)', title: 'Want a helper that reads your logs?',
      text: 'The AI assistant reads your mods and game logs, explains crashes in plain words, and suggests fixes. It changes nothing without your OK. It uses your own AI provider, or a model running on this PC (Ollama: http://localhost:11434/v1).',
      body: h('div', { class: 'su-ctl su-grid' },
        field('Provider', provider), field('Endpoint', endpoint), field('Model', model), field('API key', aiKey),
        h('div', { class: 'su-row' }, h('button', { type: 'button', class: 'btn', onclick: test }, 'Test'), status)),
      art: ART.ai(),
      primary: primaryBtn('Continue', async () => {
        const filled = [endpoint.value.trim(), model.value.trim()].filter(Boolean).length;
        if (filled === 1) { setStatus(status, 'warn', 'Fill in both the endpoint and the model, or choose Skip for now'); return; }
        if (filled === 2 && !su.result.ai && !await test()) return;
        next();
      }),
      skip: { label: 'Skip for now', fn: next },
    });
  },

  look() {
    const ids = THEME_ORDER.filter(id => THEMES[id]);
    const grid = h('div', { class: 'su-themes', role: 'radiogroup', 'aria-label': 'Theme' });
    const paint = () => grid.replaceChildren(...ids.map(id => {
      const on = themeState.id === id;
      return h('button', {
        type: 'button', class: `theme-card${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', dataset: { theme: id },
        onclick: () => { chooseTheme(id); paint(); grid.querySelector('.on')?.focus(); },
        onkeydown: ev => {
          const to = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
          if (!to) return;
          ev.preventDefault();
          chooseTheme(ids[(ids.indexOf(id) + to + ids.length) % ids.length]);
          paint();
          grid.querySelector('.on')?.focus();
        },
      }, themeMini(THEMES[id].tokens), h('span', { class: 'theme-card-text' }, h('span', { class: 'theme-card-name' }, on ? icon('check') : null, THEMES[id].name)));
    }));
    paint();
    return stepParts({
      kicker: 'Step 4 of 4 · The look', title: 'Pick a look',
      text: 'The whole app changes as you choose. Settings > Interface has these too, and a Custom theme you can write yourself.',
      body: grid, primary: primaryBtn('Continue', next),
    });
  },

  done() {
    const r = su.result;
    const item = (ok, label, note) => h('li', { class: ok ? 'ok' : '' }, icon(ok ? 'check' : 'minus-circle'), h('span', {}, h('b', {}, label), h('span', {}, note)));
    return [h('div', { class: 'su-hello su-end' },
      h('span', { class: 'su-hello-mark su-done-mark', 'aria-hidden': 'true' }, icon('check')),
      h('h1', { class: 'su-title su-hello-title', id: 'su-title-done', tabindex: '-1' }, 'You\'re all set'),
      h('ul', { class: 'su-summary' },
        item(r.game, 'Game folder', r.game ? 'Found' : 'Not set: Settings > Game'),
        item(!!r.nexus, 'Nexus Mods', r.nexus ? `Signed in as ${r.nexus}` : 'Skipped: Settings > Nexus Mods'),
        item(!!r.ai, 'AI helper', r.ai ? `Using ${r.ai}` : 'Skipped: Settings > AI Assistant'),
        item(true, 'Look', THEMES[themeState.id]?.name || 'Custom')),
      h('p', { class: 'su-hello-text' }, 'Settings > Advanced can run this setup again any time.'),
      h('div', { class: 'su-hello-go' }, h('button', { type: 'button', class: 'btn btn-primary su-next', onclick: closeSetup }, h('span', {}, 'Open the app'), icon('chevron-right'))))];
  },
};

// Keys inside the wizard stay in it; Esc does nothing (Skip setup is always on screen).
$('#setup').addEventListener('keydown', ev => {
  ev.stopPropagation();
  if (ev.key !== 'Tab') return;
  const f = [...$('#setup').querySelectorAll('button:not([disabled]), input, select, [tabindex="0"]')].filter(x => x.offsetParent && x.tabIndex >= 0 && !x.closest('.su-step.out'));
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
  if (!ev.shiftKey && i === f.length - 1) { ev.preventDefault(); f[0].focus(); }
});
$('#s-setup-open').addEventListener('click', openSetup);
window.addEventListener('DOMContentLoaded', maybeStartSetup);
