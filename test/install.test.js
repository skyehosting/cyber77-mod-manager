'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Installer } = require('../src/core/installer');
const { parseModuleConfig, decode } = require('../src/core/fomodParse');
const Fomod = require('../src/shared/fomod');

const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };
const have7z = fs.existsSync(SEVEN_ZIP);

const MODULE_CONFIG = `<?xml version="1.0" encoding="UTF-16"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">
  <moduleName>Neon Jackets</moduleName>
  <requiredInstallFiles>
    <file source="core\\NeonCore.archive" destination="archive\\pc\\mod\\NeonCore.archive"/>
  </requiredInstallFiles>
  <installSteps order="Explicit">
    <installStep name="Colour">
      <optionalFileGroups order="Explicit">
        <group name="Pick a colour" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="Pink">
              <description>Hot pink.</description>
              <files><folder source="pink" destination="archive\\pc\\mod"/></files>
              <conditionFlags><flag name="colour">pink</flag></conditionFlags>
              <typeDescriptor><type name="Optional"/></typeDescriptor>
            </plugin>
            <plugin name="Cyan">
              <description>Cool cyan.</description>
              <files><folder source="cyan" destination="archive\\pc\\mod"/></files>
              <conditionFlags><flag name="colour">cyan</flag></conditionFlags>
              <typeDescriptor><type name="Recommended"/></typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Pink extras">
      <visible><flagDependency flag="colour" value="pink"/></visible>
      <optionalFileGroups>
        <group name="Extras" type="SelectAny">
          <plugins>
            <plugin name="Glitter">
              <description>Sparkles.</description>
              <files><file source="extras\\glitter.archive" destination="archive\\pc\\mod\\glitter.archive"/></files>
              <typeDescriptor><type name="Optional"/></typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
  <conditionalFileInstalls>
    <patterns>
      <pattern>
        <dependencies operator="And"><flagDependency flag="colour" value="cyan"/></dependencies>
        <files><file source="extras\\cyan-patch.xl" destination="archive\\pc\\mod\\cyan-patch.xl"/></files>
      </pattern>
    </patterns>
  </conditionalFileInstalls>
</config>`;

function utf16(str) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(str, 'utf16le')]);
}

function makeArchive(name, files) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-arc-')), name);
  execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
  return out;
}

test('UTF-16 ModuleConfig.xml decodes and parses', () => {
  const cfg = parseModuleConfig(decode(utf16(MODULE_CONFIG)));
  assert.strictEqual(cfg.moduleName, 'Neon Jackets');
  assert.strictEqual(cfg.steps.length, 2);
  assert.strictEqual(cfg.steps[0].groups[0].plugins[1].name, 'Cyan');
  assert.deepStrictEqual(cfg.requiredFiles[0], { kind: 'file', source: 'core/NeonCore.archive', destination: 'archive/pc/mod/NeonCore.archive', priority: 0 });
  assert.deepStrictEqual(cfg.steps[1].visible.items[0], { flag: 'colour', value: 'pink' });
});

test('FOMOD defaults, visibility and conditional installs', () => {
  const cfg = parseModuleConfig(MODULE_CONFIG);
  const g = cfg.steps[0].groups[0];
  assert.deepStrictEqual(Fomod.defaultSelection(g, {}, {}), [1], 'Recommended plugin is preselected');
  assert.deepStrictEqual(Fomod.visibleSteps(cfg, { 0: { 0: [1] } }, {}), [0], 'pink step hidden for cyan');
  assert.deepStrictEqual(Fomod.visibleSteps(cfg, { 0: { 0: [0] } }, {}), [0, 1], 'pink step shown for pink');
  assert.strictEqual(Fomod.validateGroup(g, []), '"Pick a colour": choose exactly one option.');
  const cyan = Fomod.resolveEntries(cfg, { 0: { 0: [1] } }, {});
  assert.deepStrictEqual(cyan.map(e => e.source), ['core/NeonCore.archive', 'cyan', 'extras/cyan-patch.xl']);
  // A pink pick in step 2 is ignored once step 2 is hidden.
  const hidden = Fomod.resolveEntries(cfg, { 0: { 0: [1] }, 1: { 0: [0] } }, {});
  assert.ok(!hidden.some(e => e.source === 'extras/glitter.archive'));
});

test('installer: FOMOD archive installs the chosen files', { skip: !have7z && '7-Zip not installed' }, async () => {
  const arc = makeArchive('neon.7z', {
    'Neon Jackets/fomod/ModuleConfig.xml': utf16(MODULE_CONFIG),
    'Neon Jackets/core/NeonCore.archive': 'core',
    'Neon Jackets/pink/jacket.archive': 'pink',
    'Neon Jackets/cyan/jacket.archive': 'cyan',
    'Neon Jackets/extras/glitter.archive': 'glitter',
    'Neon Jackets/extras/cyan-patch.xl': 'xl',
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-inst-'));
  const inst = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => path.join(tmp, 'temp'), log: quiet });
  const session = await inst.prepare(arc);
  assert.ok(session.fomod, 'FOMOD detected');
  assert.strictEqual(session.fomod.basePath, 'Neon Jackets');

  const plan = inst.plan(session, 'Neon', { 0: { 0: [0] }, 1: { 0: [0] } }, {});
  const staged = inst.stage(session, plan, path.join(tmp, 'staging', 'neon'));
  assert.deepStrictEqual(staged.sort(), ['archive/pc/mod/NeonCore.archive', 'archive/pc/mod/glitter.archive', 'archive/pc/mod/jacket.archive']);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'staging', 'neon', 'archive/pc/mod/jacket.archive'), 'utf8'), 'pink');
  assert.match(plan.type, /FOMOD/);
  inst.release(session.token);
});

test('installer: plain zip with a wrapper folder and a CET mod', { skip: !have7z && '7-Zip not installed' }, async () => {
  const arc = makeArchive('mixed.zip', {
    'Mixed-1.0/archive/pc/mod/mixed.archive': 'a',
    'Mixed-1.0/MixedMenu/init.lua': 'lua',
    'Mixed-1.0/README.txt': 'docs',
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-inst-'));
  const inst = new Installer({ getSevenZip: () => SEVEN_ZIP, tempDir: () => path.join(tmp, 'temp'), log: quiet });
  const session = await inst.prepare(arc);
  assert.strictEqual(session.fomod, null);
  const plan = inst.plan(session, 'Mixed');
  const staged = inst.stage(session, plan, path.join(tmp, 'staging', 'm'));
  assert.deepStrictEqual(staged.sort(), ['archive/pc/mod/mixed.archive', 'bin/x64/plugins/cyber_engine_tweaks/mods/MixedMenu/init.lua']);
  inst.release(session.token);
});
