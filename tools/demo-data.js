// Evaluated inside the app window by tools/capture.js: realistic demo content for screenshots.
(() => {
  window.__uiErrors = [];
  window.addEventListener('error', e => window.__uiErrors.push(e.message));
  const now = Date.now();
  const mod = (id, name, modName, type, version, extra = {}) => ({
    id, key: id, name, modName, modId: 100 + id.length, fileId: 1, game: 'cyberpunk2077', version, category: 'MAIN',
    author: extra.author || 'psiberx', type, skipped: 0, warnings: [], enabled: true, priority: 1, installedAt: now - 86400000,
    fomod: false, dependencyOf: '', fileCount: 3, roots: [], ...extra,
  });
  const mods = [
    mod('m1', 'Cyber Engine Tweaks', 'Cyber Engine Tweaks', 'ASI + CET', '1.38.1', { author: 'yamashi', fileCount: 41, priority: 14 }),
    mod('m2', 'RED4ext', 'RED4ext', 'RED4ext', '1.31.0', { author: 'WopsS', fileCount: 6, priority: 13, dependencyOf: 'ArchiveXL' }),
    mod('m3', 'ArchiveXL', 'ArchiveXL', 'RED4ext + Redscript', '1.28.6', { fileCount: 9, priority: 12, roots: ['red4ext/plugins/ArchiveXL'] }),
    mod('m4', 'TweakXL', 'TweakXL', 'RED4ext + Redscript', '1.12.0', { fileCount: 7, priority: 11, roots: ['red4ext/plugins/TweakXL'] }),
    mod('m5', 'Appearance Menu Mod - Main', 'Appearance Menu Mod', 'CET + Archive', '2.12.3', { author: 'MaximiliumM', fileCount: 312, priority: 10, roots: ['bin/x64/plugins/cyber_engine_tweaks/mods/AppearanceMenuMod'] }),
    mod('m6', 'Rain Overhaul - Heavy', 'Rain Overhaul', 'Archive + TweakXL', '3.1', { author: 'Wrinkled', priority: 9, category: 'OPTIONAL', warnings: ['"Heavy/rain.archive" and "Light/rain.archive" both install to archive/pc/mod/rain.archive; kept the first.'] }),
    mod('m7', 'Immersive First Person', 'Immersive First Person', 'CET + RED4ext', '1.4.2', { author: 'Avi', priority: 8 }),
    mod('m8', 'LUT Switcher', 'LUT Switcher', 'CET + Redscript', '2.0.1', { author: 'FireDragon', priority: 7, enabled: false }),
    mod('m9', 'Better Vehicle Handling', 'Better Vehicle Handling', 'TweakXL', '1.0.4', { author: 'Erok', priority: 6, health: { missing: 2, replaced: 0 } }),
    mod('m10', 'Night City Interactions - Core (FOMOD)', 'Night City Interactions', 'Archive + Redscript (FOMOD)', '0.9.8', { author: 'theCryptic', priority: 5, fomod: true }),
    mod('m11', 'Hair Pack - Long Straight', 'Hair Pack', 'ArchiveXL', '1.2', { author: 'Saxa', priority: 4 }),
    mod('m12', 'Hair Pack - Long Wavy', 'Hair Pack', 'ArchiveXL', '1.2', { author: 'Saxa', priority: 3, category: 'OPTIONAL' }),
    mod('m13', 'Codeware', 'Codeware', 'RED4ext + Redscript', '1.21.2', { priority: 2, dependencyOf: 'Appearance Menu Mod' }),
    mod('m14', 'redscript', 'redscript', 'Other', '0.5.32', { author: 'jac3km4', priority: 1, enabled: false }),
  ];
  const conflicts = {
    m11: { wins: 4, loses: 0, with: ['m12'] },
    m12: { wins: 0, loses: 4, with: ['m11'] },
    m6: { wins: 1, loses: 0, with: ['m9'] },
    m9: { wins: 0, loses: 1, with: ['m6'] },
  };
  const dl = (key, modName, name, fileName, category, version, size, extra = {}) => ({
    key, modName, name, fileName, category, version, size, author: extra.author || 'psiberx', installed: true, exists: true, dependencyOf: '', ...extra,
  });
  const downloads = [
    dl('d1', 'Appearance Menu Mod', 'Appearance Menu Mod - Main', 'AppearanceMenuMod-790-2-12-3.zip', 'MAIN', '2.12.3', 48_812_544, { author: 'MaximiliumM' }),
    dl('d2', 'Appearance Menu Mod', 'AMM Collabs - Decor Pack', 'AMM-Collabs-790-1-4.7z', 'OPTIONAL', '1.4', 251_658_240, { author: 'MaximiliumM', installed: false }),
    dl('d3', 'Appearance Menu Mod', 'AMM - Old Locations Fix', 'AMM-Locations-Fix-790-1-0.zip', 'MISCELLANEOUS', '1.0', 412_000, { author: 'MaximiliumM', installed: false }),
    dl('d4', 'ArchiveXL', 'ArchiveXL', 'ArchiveXL-4198-1-28-6.zip', 'MAIN', '1.28.6', 1_843_200),
    dl('d5', 'Codeware', 'Codeware', 'Codeware-7780-1-21-2.zip', 'MAIN', '1.21.2', 2_621_440, { dependencyOf: 'Appearance Menu Mod' }),
    dl('d6', 'Hair Pack', 'Hair Pack - Long Straight', 'HairPack-Straight-1-2.7z', 'MAIN', '1.2', 96_468_992, { author: 'Saxa' }),
    dl('d7', 'Hair Pack', 'Hair Pack - Long Wavy', 'HairPack-Wavy-1-2.7z', 'OPTIONAL', '1.2', 102_760_448, { author: 'Saxa' }),
    dl('d8', 'Rain Overhaul', 'Rain Overhaul - Heavy', 'RainOverhaul-Heavy-3-1.rar', 'OPTIONAL', '3.1', 14_680_064, { author: 'Wrinkled', exists: false }),
  ];
  const jobs = [
    { id: 9, name: 'Night City Interactions - Voice Pack', modName: 'Night City Interactions', category: 'OPTIONAL', status: 'downloading', received: 612_000_000, total: 1_480_000_000, speed: 38_400_000 },
    { id: 8, name: 'Night City Interactions - Core', modName: 'Night City Interactions', category: 'MAIN', status: 'downloading', received: 51_000_000, total: 64_000_000, speed: 27_100_000 },
    { id: 7, name: 'Virtual Atelier', modName: 'Virtual Atelier', category: 'MAIN', status: 'queued', received: 0, total: 3_100_000, speed: 0, dependencyOf: 'Night City Interactions' },
    { id: 6, name: 'Mod Settings', modName: 'Mod Settings', category: 'MAIN', status: 'error', received: 0, total: 900_000, speed: 0, error: 'Forbidden (403). Direct API download links need a Premium account.' },
    { id: 5, name: 'ArchiveXL', modName: 'ArchiveXL', category: 'MAIN', status: 'done', received: 1_843_200, total: 1_843_200, speed: 0 },
  ];
  const snap = {
    mods, conflicts, downloads, jobs, pendingFomod: [],
    game: { path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077', valid: true },
    rate: { hourly: 2491, daily: 19876 },
    gameStatus: { running: true, since: now - 23 * 60000, pid: 1234, sources: 119, followed: 35 },
    updates: {
      m5: { fileId: 9001, name: 'Appearance Menu Mod - Main', fileName: 'AppearanceMenuMod-790-2-13-0.zip', category: 'MAIN', version: '2.13.0', size: 49_100_000, from: '2.12.3' },
      m7: { fileId: 9002, name: 'Immersive First Person', fileName: 'IFP-1-5-0.zip', category: 'MAIN', version: '1.5.0', size: 820_000, from: '1.4.2' },
    },
    lastUpdateCheck: now - 5 * 60000,
    profiles: {
      active: 'default',
      list: [
        { id: 'default', name: 'Default', count: 12, created: now - 41 * 86400000, codeTag: '3F9K2A' },
        { id: 'p2', name: 'Photo mode', count: 5, created: now - 12 * 86400000, codeTag: 'B71E04' },
        { id: 'p3', name: 'Vanilla+', count: 3, created: now - 2 * 86400000, codeTag: '0C55D9' },
      ],
    },
    vortex: {
      installed: true, running: false, busy: false, activeProfileName: '2.5 Singleplayer', snapshotTime: now - 3600000, deployedAt: now - 7200000,
      profiles: [
        { id: 'vp1', name: 'Default', active: false, count: 13 },
        { id: 'vp2', name: '2.5 Singleplayer', active: true, count: 64 },
        { id: 'vp3', name: 'Multiplayer', active: false, count: 12 },
      ],
      mods: [
        ['vx:a1', 'Ultra Plus', 10490, '5.2.1', 'sammilucia', true, 48, 'Archive + CET', 9],
        ['vx:a2', 'Nova LUT', 2593, '2.3', 'Lowkey', true, 4, 'Archive', 9],
        ['vx:a3', 'Weather Probability Rebalance', 9872, '1.6', 'DJ_Kovrik', false, 2, 'TweakXL', 9],
        ['vx:a4', 'Enhanced Vehicle System', 6789, '0.9.4', 'Gaia', true, 17, 'CET + Redscript', 9],
        ['vx:a5', 'Codeware', 7780, '1.21.2', 'psiberx', true, 6, 'RED4ext + Redscript', 3],
        ['vx:a6', 'Codeware', 7780, '1.19.0', 'psiberx', false, 6, 'RED4ext + Redscript', 40],
      ].map(([id, name, modId, version, author, enabled, fileCount, type, days]) => ({ id, vortexId: id.slice(3), source: 'vortex', name, modName: name, fileName: name, modId, game: 'cyberpunk2077', version, author, type, enabled, fileCount, installedAt: now - days * 86400000, category: 'VORTEX' })),
      overlaps: { m6: ['vx:a3'] },
    },
  };
  window.__demo = { snap };

  // Demo console lines (the app's own messages).
  const logs = [
    ['info', 'Found Cyberpunk 2077 at C:\\Program Files (x86)\\Steam\\steamapps\\common\\Cyberpunk 2077'],
    ['info', 'Appearance Menu Mod: 3 of 9 files match the chosen categories'],
    ['info', 'Dependency Codeware (needed by Appearance Menu Mod): queuing Codeware-7780-1-21-2.zip'],
    ['info', 'Requirement RED4ext of ArchiveXL: already in the game folder (red4ext/RED4ext.dll), installed outside this app'],
    ['success', 'Downloaded ArchiveXL-4198-1-28-6.zip (ArchiveXL)'],
    ['success', 'Installed ArchiveXL as RED4ext + Redscript (9 files)'],
    ['warn', 'Rain Overhaul - Heavy: "Heavy/rain.archive" and "Light/rain.archive" both install to archive/pc/mod/rain.archive; kept the first.'],
    ['error', 'Download failed: Mod Settings (Mod Settings)', 'Forbidden (403). Direct API download links need a Premium account.'],
  ];
  logs.forEach(([level, message, detail], i) => addLog({ time: now - (logs.length - i) * 7000, level, message, detail }));

  // Demo files for the details drawer.
  fetchModFiles = async id => (id === 'm3' ? [
    'red4ext/plugins/ArchiveXL/ArchiveXL.dll', 'red4ext/plugins/ArchiveXL/ArchiveXL.pdb', 'red4ext/plugins/ArchiveXL/Bundle/ArchiveXL.archive',
    'red4ext/plugins/ArchiveXL/Bundle/PlayerBaseScope.xl', 'r6/scripts/ArchiveXL/ArchiveXL.reds', 'r6/scripts/ArchiveXL/ArchiveXL.Hooks.reds',
    'r6/config/redsUserHints/ArchiveXL.toml', 'archive/pc/mod/ArchiveXL_Base.archive', 'archive/pc/mod/ArchiveXL_Base.archive.xl',
  ].map((dest, i) => ({ dest, deployed: i !== 7, owner: i === 7 ? 'm4' : 'm3' })) : (() => {
    // Every other demo mod: a plausible file list of the size the table shows.
    const m = mods.find(x => x.id === id);
    const slug = (m?.modName || 'Mod').replace(/[^A-Za-z]/g, '');
    const missing = m?.health?.missing || 0;
    return Array.from({ length: Math.min(m?.fileCount || 3, 12) }, (_, i) => ({
      dest: i === 0 ? `archive/pc/mod/${slug}.archive` : i === 1 ? `r6/tweaks/${slug}/${slug}.yaml` : `archive/pc/mod/${slug}_${i}.archive`,
      deployed: i >= missing, owner: i >= missing ? id : null,
    }));
  })());

  fetchModConflicts = async id => ({
    m11: [{ id: 'm12', name: 'Hair Pack - Long Wavy', priority: 3, weWin: true, files: ['archive/pc/mod/hair_long.archive', 'archive/pc/mod/hair_long.archive.xl', 'archive/pc/mod/hair_shared_textures.archive', 'r6/tweaks/HairPack/hair.yaml'] }],
    m12: [{ id: 'm11', name: 'Hair Pack - Long Straight', priority: 4, weWin: false, files: ['archive/pc/mod/hair_long.archive', 'archive/pc/mod/hair_long.archive.xl', 'archive/pc/mod/hair_shared_textures.archive', 'r6/tweaks/HairPack/hair.yaml'] }],
    m6: [{ id: 'm9', name: 'Better Vehicle Handling', priority: 6, weWin: true, files: ['r6/tweaks/vehicles/handling.yaml'] }],
    m9: [{ id: 'm6', name: 'Rain Overhaul - Heavy', priority: 9, weWin: false, files: ['r6/tweaks/vehicles/handling.yaml'] }],
  })[id] || [];

  window.demoPlan = {
    token: 'demo',
    errors: [],
    mods: [{
      modId: 790, game: 'cyberpunk2077', name: 'Appearance Menu Mod', author: 'MaximiliumM', files: [{}],
      summary: 'Change NPC appearances, spawn characters and props, build decor scenes and save your favourite looks.',
      allFiles: [
        ['Appearance Menu Mod - Main', 'MAIN', '2.12.3', 48_812_544, 6, true, true, 'The main file. Needs Cyber Engine Tweaks, Codeware and ArchiveXL.'],
        ['AMM Collabs - Decor Pack', 'OPTIONAL', '1.4', 251_658_240, 20, false, false, 'Over 3,000 extra props for decor scenes, made with other modders. Large download.'],
        ['AMM Custom Appearances Starter', 'OPTIONAL', '1.1', 3_400_000, 34, false, false, 'Example custom appearances you can copy and edit.'],
        ['AMM - Old Locations Fix', 'MISCELLANEOUS', '1.0', 412_000, 60, false, false, 'Restores the pre-2.0 saved locations list.'],
        ['Appearance Menu Mod - Main', 'OLD_VERSION', '2.11.0', 47_100_000, 120, false, false, 'For game version 2.02 and earlier.'],
        ['Appearance Menu Mod - Main', 'OLD_VERSION', '2.10.2', 46_000_000, 190, false, false, ''],
      ].map(([name, category, version, size, days, selected, downloaded, description], i) => ({
        fileId: 9100 + i, name, fileName: `${name.replace(/\W+/g, '')}-${version}.zip`, category, version, size,
        uploaded: Math.floor((now - days * 86400000) / 1000), selected, downloaded, description,
      })),
    }],
    deps: [
      { modId: 7780, name: 'Codeware', requiredBy: ['Appearance Menu Mod'], status: 'missing', files: [{ fileName: 'Codeware-7780-1-21-2.zip', size: 2_621_440 }] },
      { modId: 4575, name: 'Input Loader', requiredBy: ['Codeware'], status: 'missing', files: [{ fileName: 'InputLoader-4575-0-2-6.zip', size: 310_000 }] },
      { modId: 4198, name: 'ArchiveXL', requiredBy: ['Appearance Menu Mod'], status: 'disabled', detail: 'Installed but disabled — will be enabled' },
      { modId: 2380, name: 'RED4ext', requiredBy: ['Codeware', 'ArchiveXL'], status: 'in-game', detail: 'Already in the game folder (red4ext/RED4ext.dll), installed by another tool' },
      { modId: 107, name: 'Cyber Engine Tweaks', requiredBy: ['Appearance Menu Mod'], status: 'installed', detail: 'Installed and enabled' },
      { modId: 0, name: 'Visual C++ Redistributable', requiredBy: ['Cyber Engine Tweaks'], status: 'external', url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe', detail: 'Not hosted on Nexus' },
    ],
  };

  pickProfileFile = async () => ({
    token: 'demo', name: 'Kai — photo mode setup',
    mods: [
      { name: 'Cyber Engine Tweaks', version: '1.38.1', status: 'installed', detail: 'Already installed', size: 0 },
      { name: 'ArchiveXL', version: '1.28.6', status: 'installed', detail: 'Already installed', size: 0 },
      { name: 'Appearance Menu Mod - Main', version: '2.12.3', status: 'downloaded', detail: 'Downloaded — will be installed', size: 0 },
      { name: 'Photo Mode Unlocker', version: '3.2', status: 'download', detail: 'PhotoModeUnlocker-3-2.zip', size: 1_200_000 },
      { name: 'Better Lighting', version: '1.1', status: 'newer', detail: 'That version is gone; will get v1.4', size: 38_000_000 },
      { name: 'Night City Interactions - Core', version: '0.9.8', status: 'download', detail: 'NCI-Core-0-9-8.7z', size: 64_000_000, fomod: true },
      { name: 'Custom poses (personal)', version: '', status: 'local', detail: 'A local file on the sender\'s PC — ask them for it', size: 0 },
    ],
  });
  window.demoImport = async () => { goTo('profiles'); importReview(await pickProfileFile()); };

  // Browse: a fixed page of results (no network), with two mods already installed.
  const thumb = id => `https://staticdelivery.nexusmods.com/mods/3333/images/thumbnails/${id}`;
  const browseMods = [
    // 102 and 103 are demo mods that are installed (see mod() above).
    [102, 'Cyber Engine Tweaks', 'yamashi', 'Modders Resources', 'Scripting framework for modding Cyberpunk 2077.', 196000, 6900000],
    [103, 'ArchiveXL', 'psiberx', 'Modders Resources', 'Archive extension loader', 146131, 13858976],
    [790, 'Appearance Menu Mod', 'MaximiliumM', 'Appearance', 'Change NPC appearances, spawn characters and props, build decor scenes.', 98000, 4100000],
    [2675, 'Immersive First Person 2.0 - Camera Rework and Native Height Adjustment', 'Avi', 'Gameplay', 'See your body, guns and cars in first person the way you expect.', 31000, 1500000],
    [4454, 'Virtual Car Dealer', 'MisterChedda', 'Gameplay', 'Buy cars from the Autofixer and other dealers through a browser site.', 29000, 1400000],
    [12044, 'Military Accessories - Modular Armor Pads Pack - ArchiveXL (4.0)', 'ScorpionTank', 'Armour and Clothing', 'Large pack of modular armor pads. 114 Items. Both Vs.', 7244, 2191013],
    [11467, 'Preem Rain', 'Wrinkled', 'Visuals and Graphics', 'Rain that looks and sounds like rain.', 6100, 380000],
    [3483, 'Constant Rain', 'Cookie', 'Visuals and Graphics', 'Makes it rain more often in Night City.', 1200, 90000],
  ].map(([modId, name, author, category, summary, endorsements, downloads], i) => ({
    modId, name, author, category, summary, endorsements, downloads, version: '1.0', adult: false,
    thumbnail: '', picture: '', updatedAt: new Date(now - (i + 1) * 9 * 86400000).toISOString(), createdAt: '',
  }));
  window.demoBrowse = () => {
    goTo('browse');
    br.seq++;
    br.q = '';
    $('#browse-q').value = '';
    br.result = { total: 25705, page: 1, perPage: 20, exact: false, mods: browseMods };
    $('#browse-status').classList.remove('busy');
    closeMod();
    renderResults();
  };

  window.resetDemo = () => {
    // Dialogs left open by the previous shot never resolve: drop them from the dialog queue.
    modalChain = Promise.resolve();
    modalClose = null;
    state.modFilter = 'all';
    setSegActive('#mods-filter', 'f', 'all');
    document.querySelector('#modal-back').hidden = true;
    document.querySelector('#drawer').hidden = true;
    state.drawerMod = null;
    setConsoleOpen(false);
    state.modSel = new Set();
    state.dlSel = new Set();
    applySnapshot(snap);
    state.jobs = new Map(jobs.map(j => [j.id, j]));
    renderDownloads();
    installs = [
      { store: 'steam', label: 'Steam', path: snap.game.path },
      { store: 'gog', label: 'GOG', path: 'D:\\GOG Games\\Cyberpunk 2077' },
    ];
    renderInstalls();
    renderPlay();
    prof.editing = null;
    prof.confirming = null;
    renderProfilesPage(true);
    document.querySelector('#mods-more-menu').hidden = true;
    document.querySelector('#drop-zone').hidden = true;
    gl.status = snap.gameStatus;
    renderGameStatus();
    document.querySelectorAll('.page').forEach(p => { p.scrollTop = 0; });
  };

  window.demoWizard = () => {
    runWizard({
      token: 'demo', name: 'Night City Interactions 0.9.8', imageBase: '',
      fileStates: {},
      config: {
        moduleName: 'Night City Interactions',
        requiredFiles: [],
        conditional: [],
        steps: [{
          name: 'Choose your edition', visible: null,
          groups: [{
            name: 'Core package', type: 'SelectExactlyOne', plugins: [
              { name: 'Full — every interaction, vendors and side jobs', description: 'Adds over 300 interactions across Night City: street vendors, bar seating, ripperdoc chats and gigs.\n\nRequires ArchiveXL, TweakXL and Codeware.', image: '', files: [], flags: [], typeDesc: { def: 'Recommended', patterns: [] } },
              { name: 'Lite — interactions only', description: 'Only the interaction prompts, no new vendors.', image: '', files: [], flags: [], typeDesc: { def: 'Optional', patterns: [] } },
              { name: 'Legacy 1.6 build', description: 'For game version 1.6 only.', image: '', files: [], flags: [], typeDesc: { def: 'NotUsable', patterns: [] } },
            ],
          }, {
            name: 'Optional extras', type: 'SelectAny', plugins: [
              { name: 'Voice pack (English)', description: 'Fully voiced lines for new NPC conversations.', image: '', files: [], flags: [], typeDesc: { def: 'Optional', patterns: [] } },
              { name: 'Compatibility patch for Rain Overhaul', description: 'Install if you use Rain Overhaul.', image: '', files: [], flags: [], typeDesc: { def: 'Optional', patterns: [] } },
            ],
          }],
        }, { name: 'Language', visible: null, groups: [{ name: 'Subtitles', type: 'SelectExactlyOne', plugins: [{ name: 'English', description: '', image: '', files: [], flags: [], typeDesc: { def: 'Optional', patterns: [] } }] }] }],
      },
    });
  };
  resetDemo();
  return 'ok';
})();
