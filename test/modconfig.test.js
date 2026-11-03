'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact, setValues, isConfigFile, secretName } = require('../src/core/secrets');
const { ModConfig, handRoot } = require('../src/core/modConfig');
const { GameFiles } = require('../src/core/gameFiles');
const { ownerRoot } = require('../src/core/gameLogs');
const { Assistant } = require('../src/core/ai');
const { makeTools } = require('../src/core/aiTools');

// Fake keys are built in pieces, so the secret check (which scans this file) does not take them for real ones.
const SK = 'sk' + '-';
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `cmm-${name}-`));
const put = (root, rel, body) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };

test('secrets are hidden before the AI sees a file: by name, by shape, in XML and in web addresses', () => {
  const json = redact('{\n  "apiKey": "' + SK + 'proj-abcdefghijklmnopqrstuvwxyz0123456789",\n  "token": "",\n  "model": "gpt-4o",\n  "volume": 0.8\n}');
  assert.match(json.text, /"apiKey": "\[hidden: set, 44 characters, starts "sk-…"\]"/);
  assert.match(json.text, /"token": "\[hidden: empty\]"/);
  assert.match(json.text, /"model": "gpt-4o"/, 'ordinary settings stay');
  assert.ok(!json.text.includes('abcdefghij'), 'no part of the key past its first 3 characters');
  assert.strictEqual(json.hidden, 2);

  const ini = redact('[OpenAI]\napi_key = abcd1234efgh5678ijkl9012mnop\npassword=\nname = Johnny\nhotkey = F1');
  assert.match(ini.text, /api_key = \[hidden: set, 28 characters, starts "abc…"\]/);
  assert.match(ini.text, /password=\[hidden: empty\]/);
  assert.match(ini.text, /name = Johnny\nhotkey = F1$/, 'names and hotkeys stay');

  const lua = redact('config = {\n  apiKey = "YOUR_KEY_HERE",\n  elevenlabs_key = "abc",\n  toggleKey = "K",\n}');
  assert.match(lua.text, /apiKey = "\[hidden: placeholder "YOUR_KEY_HERE", not a real value\]"/);
  assert.match(lua.text, /elevenlabs_key = "\[hidden: set, 3 characters\]"/);
  assert.match(lua.text, /toggleKey = "K"/);

  const yaml = redact('openai:\n  key: ' + SK + 'ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\nsecret: hunter2');
  assert.match(yaml.text, /key: \[hidden: set, 45 characters, starts "sk-…"\]/, 'a key-shaped value whatever its name');
  assert.match(yaml.text, /secret: \[hidden: set, 7 characters\]/);

  const xml = redact('<Settings><ApiKey>abc123def456ghi789jkl012</ApiKey><Mode>fast</Mode><Auth token="zz-12"/></Settings>');
  assert.match(xml.text, /<ApiKey>\[hidden: set, 24 characters, starts "abc…"\]<\/ApiKey><Mode>fast<\/Mode>/);
  assert.match(xml.text, /token="\[hidden: set, 5 characters\]"/);

  assert.match(redact('url = https://api.x.com/v1?api_key=abcdef123456&lang=en').text, /api_key=\[hidden: set, 12 characters\]&lang=en/);
  assert.strictEqual(redact('texture = base\\characters\\common\\h1_base_color_d41d8cd98f00b204e98009.xbm').hidden, 0, 'game paths are not keys');

  assert.ok(isConfigFile('bin/x64/plugins/cyber_engine_tweaks/mods/X/settings.json'));
  assert.ok(isConfigFile('red4ext/plugins/X/config.ini'));
  assert.ok(!isConfigFile('archive/pc/mod/x.archive.xl') && !isConfigFile('r6/tweaks/x.yaml') && !isConfigFile('r6/scripts/x.reds'), 'mod content is not settings');
  assert.ok(secretName('openaiKey') && secretName('elevenlabs_key') && !secretName('hotkey') && !secretName('key'));
});

test('form values are written into the config file, keeping its format', () => {
  const json = '{\n    "openai": { "apiKey": "", "model": "gpt" },\n    "volume": 3\n}\n';
  const outJson = setValues(json, 'x.json', [{ key: 'openai.apiKey', value: 'sk-new' }, { key: 'volume', value: '5' }, { key: 'added', value: 'yes' }]);
  assert.deepStrictEqual(JSON.parse(outJson), { openai: { apiKey: 'sk-new', model: 'gpt' }, volume: 5, added: 'yes' });
  assert.match(outJson, /^ {4}"openai"/m, 'its indent');

  const ini = '[General]\r\nname = x\r\n[OpenAI]\r\napi_key = \r\nmodel = "gpt" ; c\r\n';
  const outIni = setValues(ini, 'c.ini', [{ key: 'OpenAI.api_key', value: 'k1' }, { key: 'OpenAI.model', value: 'o1' }]);
  assert.strictEqual(outIni, '[General]\r\nname = x\r\n[OpenAI]\r\napi_key = k1\r\nmodel = "o1" ; c\r\n', 'CRLF, quotes and comments kept');
  assert.match(setValues('[a]\nkey = 1\n', 'c.toml', [{ key: 'a.key', value: 'text' }]), /key = "text"/, 'TOML strings are quoted');

  const yaml = 'openai:\n  model: gpt\n  key: ""\nother:\n  key: z\n';
  assert.strictEqual(setValues(yaml, 'c.yaml', [{ key: 'openai.key', value: 'k"2' }]), 'openai:\n  model: gpt\n  key: "k\\"2"\nother:\n  key: z\n');
  assert.match(setValues('return { apiKey = "", n = 3 }', 'c.lua', [{ key: 'apiKey', value: 'abc' }, { key: 'n', value: '4' }]), /apiKey = "abc", n = 4 }/);
  assert.strictEqual(setValues('<c><ApiKey></ApiKey></c>', 'c.xml', [{ key: 'ApiKey', value: 'a<b' }]), '<c><ApiKey>a&lt;b</ApiKey></c>');
  assert.throws(() => setValues('[a]\nx = 1\n', 'c.ini', [{ key: 'a.missing', value: '1' }]), /was not found/);
  assert.throws(() => setValues('{oops', 'c.json', [{ key: 'a', value: '1' }]), /not valid JSON/);
  assert.throws(() => setValues('x', 'c.reds', [{ key: 'a', value: '1' }]), /cannot be filled in/);
});

/** A game folder with one mod of this app (enabled, deployed as hardlinks), one disabled, and loose files. */
function fixture() {
  const root = tmp('modcfg');
  const game = path.join(root, 'game');
  const staging = path.join(root, 'staging');
  const backups = path.join(root, 'originals');
  for (const rel of ['r6/scripts/A/a.reds', 'bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua']) {
    put(path.join(staging, 'a'), rel, `-- ${rel}\r\nlocal x = 1\r\n`);
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.linkSync(path.join(staging, 'a', rel), path.join(game, rel));
  }
  put(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json', '{"apiKey": ""}');
  put(path.join(staging, 'b'), 'r6/tweaks/b.yaml', 'B: 1\n');
  put(game, 'red4ext/plugins/Hand/config.ini', '[x]\ny = 1\n');
  put(game, 'archive/pc/mod/loose.archive', Buffer.from([0, 1, 2]));
  const manager = {
    data: { mods: {
      a: { id: 'a', name: 'Mod A', enabled: true, files: ['r6/scripts/A/a.reds', 'bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua'] },
      b: { id: 'b', name: 'Mod B', enabled: false, files: ['r6/tweaks/b.yaml'] },
    } },
    deployer: { owners: () => ({ 'r6/scripts/a/a.reds': 'a', 'bin/x64/plugins/cyber_engine_tweaks/mods/a/init.lua': 'a' }) },
    settings: { stagingDir: staging },
    vortex: { root: path.join(root, 'Vortex'), read: () => ({ mods: [] }) },
    snapshot: () => ({ vortex: { mods: [] } }),
    gameDir: () => game,
    fileOwners() {
      const files = new Map(Object.entries(this.deployer.owners()).map(([k]) => [k, { mod: 'Mod A', by: 'Cyber Mod Manager' }]));
      return { files, roots: new Map([['bin/x64/plugins/cyber_engine_tweaks/mods/a', { mod: 'Mod A', by: 'Cyber Mod Manager' }]]) };
    },
  };
  const files = new GameFiles({ getGameDir: () => game, owners: () => manager.fileOwners(), ownerRoot });
  return { root, game, staging, backups, manager, files, config: new ModConfig({ manager, files, ownerRoot, backupDir: backups }) };
}

test('mod config lists every mod (and files no manager put there) with each file where it really is', () => {
  const { root, config } = fixture();
  try {
    const list = config.list();
    assert.deepStrictEqual(list.map(m => [m.key, m.enabled, m.source]), [
      ['hand:archive/pc/mod', true, 'hand'], ['hand:red4ext/plugins/Hand', true, 'hand'], ['app:a', true, 'app'], ['app:b', false, 'app'],
    ].sort((x, y) => list.findIndex(m => m.key === x[0]) - list.findIndex(m => m.key === y[0])));
    assert.strictEqual(list.length, 4);

    const a = config.modFiles('app:a');
    assert.deepStrictEqual(a.files.map(f => [f.rel, f.loc.base, f.editable, f.note]), [
      ['r6/scripts/A/a.reds', 'game', true, ''],
      ['bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua', 'game', true, ''],
      ['bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json', 'game', true, 'Made by the mod'],
    ]);
    const b = config.modFiles('app:b');
    assert.deepStrictEqual(b.files.map(f => [f.loc, f.note]), [[{ base: 'app', id: 'b', rel: 'r6/tweaks/b.yaml' }, 'Stored copy: the mod is disabled']]);
    assert.deepStrictEqual(config.modFiles('hand:archive/pc/mod').files.map(f => [f.rel, f.editable]), [['archive/pc/mod/loose.archive', false]]);
    assert.strictEqual(handRoot('r6/scripts/Foo/x.reds', ownerRoot), 'r6/scripts/Foo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one row per mod: its own copy, the copy Vortex keeps and loose folders of it are its parts; saving can reach the other copies', () => {
  const { root, game, staging, manager, config } = fixture();
  try {
    // Mod A was moved here from Vortex: Vortex keeps its copy, switched off. One file is the same
    // file (hardlinked), the other a separate copy.
    const vxStage = path.join(root, 'Vortex', 'cyberpunk2077', 'mods', 'a-vortex');
    fs.mkdirSync(path.join(vxStage, 'r6/scripts/A'), { recursive: true });
    fs.linkSync(path.join(staging, 'a', 'r6/scripts/A/a.reds'), path.join(vxStage, 'r6/scripts/A/a.reds'));
    put(vxStage, 'bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua', '-- separate\r\n');
    manager.data.mods.a.fromVortex = 'a-vortex';
    manager.vortex.read = () => ({ mods: [
      { id: 'vx:a-vortex', vortexId: 'a-vortex', name: 'Mod A', enabled: false, fileCount: 2, deployedFiles: [] },
      { id: 'vx:only', vortexId: 'only', name: 'Only In Vortex', enabled: true, fileCount: 0, deployedFiles: [] },
    ] });
    manager.data.vortexAdopted = { 'a-vortex': 'a' };
    manager.vortexTwins = () => ({});
    // Loose files named like a mod join it; the shared archive folder never does.
    put(game, 'r6/scripts/Mod B/extra.reds', '// loose');

    const list = config.list();
    const a = list.find(m => m.key === 'app:a');
    assert.deepStrictEqual(a.parts.map(p => [p.key, p.source, p.note || '']), [['app:a', 'app', ''], ['vx:a-vortex', 'vortex', 'Kept by Vortex, switched off']]);
    assert.strictEqual(a.fileCount, 4, 'both copies counted');
    const b = list.find(m => m.key === 'app:b');
    assert.deepStrictEqual(b.parts.map(p => p.key), ['app:b', 'hand:r6/scripts/Mod B'], 'the loose "Mod B" folder is part of Mod B');
    assert.ok(list.some(m => m.key === 'hand:archive/pc/mod' && m.parts.length === 1), 'a shared folder stays its own row');
    assert.ok(list.some(m => m.key === 'vx:only'), 'a mod only in Vortex is its own row');
    assert.ok(!list.some(m => m.key === 'vx:a-vortex' || m.key === 'hand:r6/scripts/Mod B'), 'no second rows');

    // The editor's view of the other copies: one is the same file, one is separate.
    const vxFiles = config.modFiles('vx:a-vortex').files;
    const loc = rel => vxFiles.find(f => f.rel === rel).loc;
    assert.deepStrictEqual(config.twins({ base: 'game', rel: 'r6/scripts/A/a.reds' }, [loc('r6/scripts/A/a.reds')]), [{ exists: true, linked: true }]);
    assert.deepStrictEqual(config.twins({ base: 'game', rel: 'bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua' }, [loc('bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua')]), [{ exists: true, linked: false }]);
    // "Save both": the separate copy gets the text, in its own line endings.
    config.writeLike(loc('bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua'), 'new\ntext\n');
    assert.strictEqual(fs.readFileSync(path.join(vxStage, 'bin/x64/plugins/cyber_engine_tweaks/mods/A/init.lua'), 'utf8'), 'new\r\ntext\r\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the editor saves in place (hardlinks stay linked), keeps line endings, the original, and refuses stale or outside writes', () => {
  const { root, game, staging, backups, config } = fixture();
  try {
    const loc = { base: 'game', rel: 'r6/scripts/A/a.reds' };
    const f = config.read(loc);
    assert.strictEqual(f.eol, '\r\n');
    assert.strictEqual(f.text, '-- r6/scripts/A/a.reds\nlocal x = 1\n', 'the editor gets LF');
    assert.strictEqual(f.hasBackup, false);

    const w = config.write(loc, 'changed\nline 2\n', { mtime: f.mtime, eol: f.eol, bom: f.bom });
    assert.strictEqual(fs.readFileSync(path.join(game, loc.rel), 'utf8'), 'changed\r\nline 2\r\n', 'written back with CRLF');
    assert.strictEqual(fs.readFileSync(path.join(staging, 'a', loc.rel), 'utf8'), 'changed\r\nline 2\r\n', 'the hardlinked stored copy is the same file');
    assert.ok(fs.existsSync(path.join(backups, 'game', 'r6', 'scripts', 'A', 'a.reds')), 'the original is kept outside the game folder');

    // Changed on disk since it was read: not overwritten unless asked.
    const later = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(game, loc.rel), later, later);
    assert.throws(() => config.write(loc, 'mine', { mtime: w.mtime }), e => e.conflict === true);
    config.write(loc, 'mine\n', { mtime: w.mtime, force: true });

    const back = config.restore(loc);
    assert.strictEqual(back.text, '-- r6/scripts/A/a.reds\nlocal x = 1\n', 'the original is back');

    // A disabled mod's stored copy can be edited too.
    const bloc = { base: 'app', id: 'b', rel: 'r6/tweaks/b.yaml' };
    config.write(bloc, 'B: 2\n', { mtime: config.read(bloc).mtime });
    assert.strictEqual(fs.readFileSync(path.join(staging, 'b', 'r6/tweaks/b.yaml'), 'utf8'), 'B: 2\n');

    // UTF-16 with a byte-order mark is read and written back as UTF-16.
    put(game, 'r6/config/u16.xml', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a>1</a>', 'utf16le')]));
    const u = config.read({ base: 'game', rel: 'r6/config/u16.xml' });
    assert.deepStrictEqual([u.text, u.bom], ['<a>1</a>', 'utf16le']);
    config.write({ base: 'game', rel: 'r6/config/u16.xml' }, '<a>2</a>', { mtime: u.mtime, bom: u.bom });
    assert.strictEqual(fs.readFileSync(path.join(game, 'r6/config/u16.xml')).subarray(2).toString('utf16le'), '<a>2</a>');

    for (const bad of [{ base: 'game', rel: '../outside.txt' }, { base: 'game', rel: path.join(root, 'x.txt') }, { base: 'app', id: '../b', rel: 'x' }, { base: 'nope', rel: 'x' }]) {
      assert.throws(() => config.resolve(bad), /outside the mod folders|Unknown file location/);
    }
    assert.throws(() => config.read({ base: 'game', rel: 'archive/pc/mod/loose.archive' }), /binary/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('AI: settings files are read only with approval and never with their secrets; a form writes what the user typed', async () => {
  const { root, game, manager, files, config } = fixture();
  try {
    const logger = { success() {}, info() {}, warn() {}, error() {}, history: [] };
    const tools = makeTools({ manager, gameLogs: { entries: [], status: () => ({}) }, logger, web: {}, files, config, allMods: () => [], deployRedmods: async () => null });
    // Without approval: no reading of settings files, and they are not searched.
    assert.match(await tools.read('read_mod_file', { path: 'bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json' }), /use read_config_files/);
    put(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/A/notes.txt', 'token = abcdefghijklmnopqrstuvwxyz123456\n');
    const found = JSON.parse(await tools.read('search_mod_files', { text: 'apikey' }));
    assert.strictEqual(found.matches.length, 0);
    assert.strictEqual(found.settingsFilesNotSearched, 2);
    assert.match(JSON.parse(await tools.read('search_mod_files', { text: 'token' })).matches[0].text, /token = \[hidden: set, 32 characters/);
    assert.ok(tools.ask('ask_user_to_fill', { path: 'red4ext/plugins/Hand/config.ini', fields: [{ key: 'x.missing', label: 'M' }], reason: 'r' }).error.match(/was not found/));
    assert.ok(tools.ask('read_config_files', { paths: ['nope.json'], reason: 'r' }).error);

    // The model asks; the turn waits for the user's answer.
    const settings = { get: k => ({ aiProvider: 'openai', aiEndpoint: 'http://x', aiModel: 'm' })[k], aiKey: '' };
    const replies = [
      { text: '', calls: [{ id: '1', name: 'read_config_files', args: { paths: ['bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json'], reason: 'To see what is missing' } }] },
      { text: '', calls: [{ id: '2', name: 'ask_user_to_fill', args: { path: 'bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json', reason: 'Your key is empty', fields: [{ key: 'apiKey', label: 'OpenAI key' }] } }] },
      { text: 'All set.', calls: [] },
    ];
    const seen = [];
    const a = new Assistant({ detect: async () => ({ tokens: 0 }), settings, tools, file: path.join(root, 'chat.json'), call: async ({ history }) => { seen.push(JSON.parse(JSON.stringify(history))); return replies.shift(); } });
    const until = async fn => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(fn()); };
    const turn = a.send('Set up mod A');
    await until(() => a.view().transcript.some(x => x.type === 'access' && x.status === 'pending'));
    assert.strictEqual(a.view().waiting, true);
    const access = a.view().transcript.find(x => x.type === 'access');
    await a.decide(access.id, true);
    await until(() => a.view().transcript.some(x => x.type === 'form' && x.status === 'pending'));
    const form = a.view().transcript.find(x => x.type === 'form');
    assert.strictEqual(form.fields[0].secret, true, 'a key field is typed hidden');
    await a.decide(form.id, true, { apiKey: `${SK}very-secret-value-1234567890` });
    await turn;

    assert.match(seen[1].at(-1).results[0].content, /\\"apiKey\\": \\"\[hidden: empty\]\\"/, 'the model saw the setting, not a value');
    assert.match(seen[2].at(-1).results[0].content, /"result":"set"/); // the value never goes back to the model
    const everything = JSON.stringify([seen, a.view(), fs.readFileSync(path.join(root, 'chat.json'), 'utf8')]);
    assert.ok(!everything.includes('very-secret'), 'what the user typed never reaches the model or the saved chat');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(game, 'bin/x64/plugins/cyber_engine_tweaks/mods/A/settings.json'), 'utf8')), { apiKey: `${SK}very-secret-value-1234567890` });
    assert.deepStrictEqual(a.view().transcript.filter(x => x.type === 'access' || x.type === 'form').map(x => x.status), ['approved', 'saved']);

    // Declined, and Stop while waiting.
    replies.push({ text: '', calls: [{ id: '3', name: 'read_config_files', args: { paths: ['red4ext/plugins/Hand/config.ini'], reason: 'r' } }] }, { text: 'OK.', calls: [] });
    const t2 = a.send('again');
    await until(() => a.view().transcript.filter(x => x.type === 'access').length === 2);
    await a.decide(a.view().transcript.filter(x => x.type === 'access')[1].id, false);
    await t2;
    assert.match(seen.at(-1).at(-1).results[0].content, /declined/);
    replies.push({ text: '', calls: [{ id: '4', name: 'read_config_files', args: { paths: ['red4ext/plugins/Hand/config.ini'], reason: 'r' } }] });
    const t3 = a.send('once more');
    await until(() => a.view().waiting);
    a.stop();
    await t3;
    assert.strictEqual(a.view().transcript.filter(x => x.type === 'access').at(-1).status, 'expired');
    assert.strictEqual(a.view().busy, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a form key path cannot reach Object.prototype, and a settings file named another way still needs approval', () => {
  const { setValues, isConfigFile } = require('../src/core/secrets');
  assert.throws(() => setValues('{"a":1}', 'x.json', [{ key: '__proto__.shell', value: 'cmd' }]), /not a setting name/);
  assert.strictEqual(({}).shell, undefined);
  for (const p of ['r6/config/settings.json::$DATA', 'settings.json.', 'settings.json ']) assert.strictEqual(isConfigFile(p), true, p);
});
