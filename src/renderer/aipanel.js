'use strict';
/* global api, applyTheme, themeStore */
/*
 * The floating AI settings window (opened by the gear on the AI page). The same settings as Settings →
 * AI assistant: a change in either shows in both, and each is saved at once. Saved setups switch
 * provider, model, endpoint, key and the rest in one click; keys stay in the main process (only "has
 * a key" and its last 4 characters come here). Dragged by its title bar anywhere; Reset puts it back
 * beside the app; Esc or ✕ closes it.
 */

// (themes.js names the window after the app once the page is loaded: this one keeps its own name)
document.title = 'AI settings';
document.addEventListener('DOMContentLoaded', () => { document.title = 'AI settings'; });
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** A line under the Test button says what happened (this window has no toasts). */
let statusTimer = null;
function status(text, kind = '') {
  const st = $('#ai-p-status');
  st.className = `hint${kind ? ` ${kind}` : ''}`;
  st.textContent = text;
  clearTimeout(statusTimer);
  if (kind !== 'busy' && text) statusTimer = setTimeout(() => { if (st.textContent === text) st.textContent = ''; }, 8000);
}
/** An API call: its result, or null with the error shown. */
async function run(p) {
  const r = await p;
  if (r?.error) { status(r.error, 'bad'); return null; }
  return r?.ok ?? null;
}

/** A small dialog inside this window: resolves the value of the button pressed (false: closed). */
function dialog({ title, body, buttons }) {
  const back = $('#aip-dialog-back');
  const box = $('#aip-dialog');
  const opener = document.activeElement;
  return new Promise(resolve => {
    // While it is open, what is behind it cannot be reached (Tab stays in it); Esc closes it from anywhere.
    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); done(false); return; }
      if (ev.key !== 'Tab') return;
      const items = [...box.querySelectorAll('button, input')];
      const i = items.indexOf(document.activeElement);
      if (ev.shiftKey && i <= 0) { ev.preventDefault(); items[items.length - 1].focus(); } else if (!ev.shiftKey && i === items.length - 1) { ev.preventDefault(); items[0].focus(); }
    };
    const done = v => {
      back.hidden = true;
      $('.aip-body').inert = false;
      $('.aip-head').inert = false;
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
      resolve(v);
    };
    box.replaceChildren(
      h('h2', {}, title),
      body,
      h('div', { class: 'aip-dialog-foot' }, ...buttons.map(b => h('button', { type: 'button', class: `btn btn-sm ${b.kind || ''}`, onclick: () => done(b.value) }, b.label))));
    back.hidden = false;
    $('.aip-body').inert = true;
    $('.aip-head').inert = true;
    document.addEventListener('keydown', onKey, true);
    (box.querySelector('input') || box.querySelector('.btn-primary') || box.querySelector('button'))?.focus();
  });
}

const side = { presets: [] };

/** The settings in use, the saved setups, and which one matches them (if any). */
async function fill() {
  const s = (await api.getSettings()).ok;
  if (!s) return;
  for (const el of $$('[data-k]')) if (document.activeElement !== el) el.value = s[el.dataset.k] ?? '';
  if (!s.aiContext && document.activeElement !== $('#ai-p-context')) $('#ai-p-context').value = '';
  // (the key field is left as it is: a key being typed is not wiped by a change elsewhere; it empties
  // itself once saved)
  $('#ai-p-key').placeholder = s.hasAiKey ? `Saved key ${s.aiKeyHint}` : 'Not needed for local models';
  $('#ai-p-key-hint').textContent = s.hasAiKey ? 'Stored encrypted. Paste a new one to replace it.' : 'Stored encrypted.';
  $('#ai-p-reasoning-row').hidden = s.aiProvider === 'anthropic';
  side.presets = s.aiPresets || [];
  side.loaded = s; // what is saved now (closing compares a field being typed in with it)
  side.keySaved = s.aiKeySaved;
  side.keyHint = s.aiKeyHint;
  const same = p => p.provider === s.aiProvider && p.endpoint === s.aiEndpoint && p.model === s.aiModel && (p.reasoning || '') === (s.aiReasoning || '');
  const current = side.presets.find(same);
  const sel = $('#ai-p-preset');
  sel.replaceChildren(
    h('option', { value: '' }, side.presets.length ? (current ? 'Choose a setup…' : 'Not saved') : 'None saved yet'),
    ...side.presets.map(p => h('option', { value: p.id }, `${p.name}${p.model ? ` · ${p.model}` : ''}`)));
  sel.value = current?.id || '';
  $('#ai-p-preset-del').disabled = !current;
}

// A field changed: saved at once (this window and the Settings page then show it). `saving` is the
// save under way, so closing waits for it.
let saving = Promise.resolve();
for (const el of $$('[data-k]')) {
  el.addEventListener('change', () => {
    const k = el.dataset.k;
    const value = k === 'aiContext' && el.value === '' ? 0 : el.value;
    saving = (async () => {
      if (await run(api.setSettings({ [k]: value }))) status('Saved', 'ok');
      if (k === 'aiProvider') $('#ai-p-reasoning-row').hidden = el.value === 'anthropic';
    })();
  });
}
$('#ai-p-key').addEventListener('change', ev => {
  const v = ev.target.value.trim();
  if (!v) return;
  saving = (async () => { if (await run(api.setSettings({ aiKey: v }))) { ev.target.value = ''; status('API key saved', 'ok'); } })();
});
/** Close it: a field being typed in is saved first (Esc closes without the field losing focus). */
async function closePanel() {
  const el = document.activeElement;
  const k = el?.dataset?.k;
  const differs = k ? el.value !== (k === 'aiContext' && !side.loaded?.[k] ? '' : String(side.loaded?.[k] ?? '')) : el?.id === 'ai-p-key' && !!el.value.trim();
  if (differs) el.dispatchEvent(new Event('change')); // starts its save
  await saving;
  api.aiPanelClose();
}

/** Save the settings in use as a setup, asking its name. Resolves whether it was saved. */
async function savePreset() {
  const input = h('input', { type: 'text', maxlength: '40', 'aria-label': 'Name of the setup' });
  input.value = $('#ai-p-model').value.trim().slice(0, 40);
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); $('#aip-dialog .btn-primary')?.click(); } });
  setTimeout(() => input.select());
  const ok = await dialog({
    title: 'Save these AI settings',
    body: h('div', { class: 'ai-field' }, h('label', {}, 'Name'), input,
      h('p', { class: 'hint' }, 'Format, model, endpoint, key, reasoning, steps, time limit and context window. A setup of the same name is replaced; its key is stored encrypted.')),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, kind: 'btn-primary' }],
  });
  const name = input.value.trim();
  if (!ok || !name) return false;
  if (!(await run(api.aiPresetSave(name)))) return false;
  status(`Saved "${name}"`, 'ok');
  return true;
}
$('#ai-p-preset-save').addEventListener('click', () => savePreset());

// One click: a saved setup becomes the one in use. A key in use that no setup holds would be lost:
// asked first, with the choice to save the settings in use before switching.
$('#ai-p-preset').addEventListener('change', async ev => {
  const id = ev.target.value;
  if (!id) return;
  if (!side.keySaved) {
    const go = await dialog({
      title: 'Keep the key in use?',
      body: h('p', {}, `The API key in use (${side.keyHint}) is not in a saved setup. Switching replaces it with the setup's own key (or none), and it cannot be shown again.`),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Switch anyway', value: 'switch' }, { label: 'Save it first', value: 'save', kind: 'btn-primary' }],
    });
    if (go === 'save' ? !(await savePreset()) : go !== 'switch') { await fill(); return; }
  }
  if (await run(api.aiPresetApply(id))) status(`Using "${side.presets.find(p => p.id === id)?.name || 'the saved setup'}"`, 'ok');
  else await fill();
});
$('#ai-p-preset-del').addEventListener('click', async () => {
  const p = side.presets.find(x => x.id === $('#ai-p-preset').value);
  if (!p) return;
  const ok = await dialog({
    title: `Delete "${p.name}"?`,
    body: h('p', {}, 'The settings in use stay as they are; only the saved setup (and its copy of the key) goes.'),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'btn-danger' }],
  });
  if (ok && await run(api.aiPresetDelete(p.id))) status(`Deleted "${p.name}"`);
});
$('#ai-p-test').addEventListener('click', async () => {
  status('Asking the model to reply…', 'busy');
  const r = await api.aiTest();
  if (r.error) status(r.error, 'bad'); else status(`Connected: ${r.ok}`, 'ok');
});

$('#aip-close').addEventListener('click', () => closePanel());
$('#aip-reset').addEventListener('click', () => api.aiPanelReset());
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && $('#aip-dialog-back').hidden) closePanel(); });

// Changed here, in Settings, or a setup switched: shown here too. The theme follows the app's.
api.onSettingsChanged(() => fill());
window.addEventListener('storage', ev => { if (ev.key === 'theme' || ev.key === 'theme.custom') applyTheme(themeStore.get('theme', 'netrunner')); }); // eslint-disable-line no-undef
fill();
