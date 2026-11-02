#!/usr/bin/env node
'use strict';
/*
 * Screenshots of the real app, for design review.
 *   node tools/capture.js <outDir>
 * Launches Electron with a throwaway profile (CMM_USER_DATA), fills the UI with demo data, and
 * captures each state at several display setups. A setup is the CSS viewport the app gets plus the
 * Windows scale factor, e.g. a 4K screen at 150% = 2560x1440 CSS @1.5 (a 3840x2160 PNG).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'shots'));
const PORT = 9400 + Math.floor(Math.random() * 400);

const SETUPS = [
  { id: 'fhd-100', w: 1920, h: 1080, s: 1, note: '1920x1080 16:9 at 100%' },
  { id: 'fhd-125', w: 1536, h: 864, s: 1.25, note: '1920x1080 16:9 at 125%' },
  { id: 'fhd-150', w: 1280, h: 720, s: 1.5, note: '1920x1080 16:9 at 150%' },
  { id: 'qhd-100', w: 2560, h: 1440, s: 1, note: '2560x1440 16:9 at 100%' },
  { id: 'qhd-125', w: 2048, h: 1152, s: 1.25, note: '2560x1440 16:9 at 125%' },
  { id: '4k-150', w: 2560, h: 1440, s: 1.5, note: '3840x2160 16:9 at 150%' },
  { id: '4k-200', w: 1920, h: 1080, s: 2, note: '3840x2160 16:9 at 200%' },
  { id: 'uw-3440', w: 3440, h: 1440, s: 1, note: '3440x1440 21:9 ultrawide at 100%' },
  { id: 'uw-2560', w: 2560, h: 1080, s: 1, note: '2560x1080 21:9 ultrawide at 100%' },
  { id: 'suw-5120', w: 5120, h: 1440, s: 1, note: '5120x1440 32:9 super-ultrawide at 100%' },
  { id: 'wxga-1610', w: 1680, h: 1050, s: 1, note: '1680x1050 16:10 at 100%' },
  { id: 'sxga-54', w: 1280, h: 1024, s: 1, note: '1280x1024 5:4 at 100%' },
  { id: 'min-window', w: 900, h: 580, s: 1, note: 'the smallest window the app allows (900x580)' },
];

const STATES = {
  mods: { all: true, run: "goTo('mods'); state.modSel = new Set(['m3','m5']); renderMods();" },
  downloads: { all: true, run: "goTo('downloads'); state.dlSel = new Set(['d2','d3']); renderDownloads();" },
  gamelog: { all: true, run: "goTo('gamelog'); setTab('timeline');" },
  'gamelog-problems': { only: ['fhd-100', 'fhd-150', 'uw-3440', 'min-window'], run: "goTo('gamelog'); setTab('problems');" },
  settings: { only: ['fhd-100', 'fhd-150', 'qhd-100', 'uw-3440', 'min-window'], run: "goTo('settings');" },
  drawer: { only: ['fhd-100', 'fhd-150', 'uw-3440', 'min-window'], run: "goTo('mods'); openDrawer('m3');" },
  'drawer-conflicts': { only: ['fhd-100', 'fhd-150', 'min-window'], run: "goTo('mods'); openDrawer('m12', 'conflicts');" },
  'drawer-update': { only: ['fhd-100'], run: "goTo('mods'); openDrawer('m9', 'health');" },
  deps: { only: ['fhd-100', 'fhd-150', 'qhd-100', 'min-window'], run: "goTo('downloads'); chooseRequirements(window.demoPlan);" },
  profiles: { all: true, run: "goTo('profiles');" },
  'profile-delete': { only: ['fhd-100'], run: "goTo('profiles'); prof.confirming = 'p3'; renderProfilesPage(true);" },
  'profile-new': { only: ['fhd-100', 'min-window'], run: "goTo('profiles'); newProfileDialog();" },
  'profile-import': { only: ['fhd-100', 'fhd-150', 'min-window'], run: 'demoImport();' },
  files: { only: ['fhd-100', 'fhd-150', 'qhd-100', '4k-200', 'min-window'], run: "goTo('downloads'); chooseFiles(window.demoPlan);" },
  menu: { only: ['fhd-100', 'min-window'], run: "goTo('mods'); document.querySelector('#mods-more').click();" },
  'mods-vortex': { only: ['fhd-100', 'min-window'], run: "setModFilter('vortex');" },
  browse: { all: true, run: 'demoBrowse();' },
  'browse-detail': { only: ['fhd-100', 'min-window'], run: 'demoBrowse(); openMod(br.result.mods[1]);', wait: 4000 },
  'gamelog-manager': { only: ['fhd-100', 'min-window'], run: "goTo('gamelog'); setTab('manager');" },
  drop: { only: ['fhd-100'], run: "goTo('mods'); document.querySelector('#drop-zone').hidden = false;" },
  'mods-updates': { only: ['fhd-100'], run: "setModFilter('updates');" },
  fomod: { only: ['fhd-100', 'fhd-150', '4k-200', 'uw-3440', 'sxga-54', 'min-window'], run: 'demoWizard();' },
  confirm: { only: ['fhd-100', 'min-window'], run: "goTo('mods'); confirmBox('Uninstall mods', 'Uninstall 2 mods? Their files leave the game folder. The downloaded archives stay in your library.', 'Uninstall', true);" },
  console: { only: ['fhd-100', 'fhd-150', 'min-window'], run: "goTo('mods'); setConsoleOpen(true);" },
  'mods-empty': { only: ['fhd-100', 'min-window'], run: "applySnapshot({...window.__demo.snap, mods: [], conflicts: {}}); goTo('mods');" },
  'mods-narrow-rail': { only: ['min-window'], run: "goTo('mods'); state.modSel = new Set(['m3']); renderMods();" },
};

const DEMO = fs.readFileSync(path.join(__dirname, 'demo-data.js'), 'utf8');

async function cdpConnect() {
  let targets = [];
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      if (targets.some(t => t.type === 'page' && t.url.includes('index.html'))) break;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const page = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('App window did not come up');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}, ms = 20000) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timed out`)); }, ms);
    pending.set(i, d => { clearTimeout(t); resolve(d); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`eval failed: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  return { ws, send, evaluate };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-capture-'));
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${PORT}`], { env: { ...process.env, CMM_USER_DATA: userData, CMM_CAPTURE: '1', CMM_VORTEX_APPDATA: '' }, stdio: 'ignore' });
  const shots = [];
  try {
    const { ws, send, evaluate } = await cdpConnect();
    await new Promise(r => setTimeout(r, 1500));
    await evaluate(DEMO);
    for (const [name, st] of Object.entries(STATES)) {
      for (const setup of SETUPS) {
        if (st.only && !st.only.includes(setup.id)) continue;
        const t0 = Date.now();
        await send('Emulation.setDeviceMetricsOverride', { width: setup.w, height: setup.h, deviceScaleFactor: setup.s, mobile: false });
        await evaluate('resetDemo()');
        await evaluate(`${st.run}; 0`);
        await new Promise(r => setTimeout(r, st.wait || 350));
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        const file = `${name}--${setup.id}.png`;
        fs.writeFileSync(path.join(OUT, file), Buffer.from(shot.result.data, 'base64'));
        shots.push({ file, state: name, setup: setup.id, css: `${setup.w}x${setup.h}`, scale: setup.s, physical: `${Math.round(setup.w * setup.s)}x${Math.round(setup.h * setup.s)}`, display: setup.note });
        console.log(`${file} ${Date.now() - t0}ms`);
      }
    }
    const errors = await evaluate('JSON.stringify(window.__uiErrors || [])');
    ws.close();
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ app: 'Cyber Mod Manager', shots, uiErrors: JSON.parse(errors) }, null, 2));
    console.log(`\n${shots.length} screenshots in ${OUT}`);
  } finally {
    child.kill();
  }
})().catch(err => { console.error(err); process.exit(1); });
