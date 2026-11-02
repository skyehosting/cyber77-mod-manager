'use strict';
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const ARRAYS = new Set([
  'file', 'folder', 'installStep', 'group', 'plugin', 'flag', 'pattern',
  'flagDependency', 'fileDependency', 'dependencies', 'gameDependency', 'fommDependency',
]);

/** ModuleConfig.xml is often UTF-16; decode by BOM or by the zero-byte pattern. */
function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length > 1 && buf[1] === 0 && buf[0] !== 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}

const norm = p => String(p ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
const text = v => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

function sortBy(items, order) {
  if (order === 'Explicit') return items;
  const sorted = [...items].sort((a, b) => String(a['@_name'] || '').localeCompare(String(b['@_name'] || '')));
  return order === 'Descending' ? sorted.reverse() : sorted;
}

function entries(node) {
  if (!node) return [];
  const out = [];
  for (const f of node.file || []) {
    const source = norm(f['@_source']);
    const dest = f['@_destination'];
    out.push({ kind: 'file', source, destination: dest === undefined ? source : norm(dest), priority: Number(f['@_priority'] || 0) });
  }
  for (const f of node.folder || []) {
    out.push({ kind: 'folder', source: norm(f['@_source']), destination: norm(f['@_destination'] ?? ''), priority: Number(f['@_priority'] || 0) });
  }
  return out;
}

function cond(node) {
  if (!node) return null;
  const items = [];
  for (const f of node.flagDependency || []) items.push({ flag: String(f['@_flag'] || ''), value: String(f['@_value'] ?? '') });
  for (const f of node.fileDependency || []) items.push({ file: norm(f['@_file']), state: String(f['@_state'] || 'Active') });
  for (const _ of [...(node.gameDependency || []), ...(node.fommDependency || [])]) items.push({ always: true });
  for (const d of node.dependencies || []) items.push(cond(d));
  return { op: node['@_operator'] === 'Or' ? 'Or' : 'And', items };
}

function typeDesc(node) {
  if (!node) return { def: 'Optional', patterns: [] };
  if (node.type) return { def: String(node.type['@_name'] || 'Optional'), patterns: [] };
  const dt = node.dependencyType || {};
  const patterns = (dt.patterns?.pattern || []).map(p => ({ cond: cond(p.dependencies?.[0]), type: String(p.type?.['@_name'] || 'Optional') }));
  return { def: String(dt.defaultType?.['@_name'] || 'Optional'), patterns };
}

function parseModuleConfig(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: n => ARRAYS.has(n), trimValues: true });
  const doc = parser.parse(xml);
  const cfg = doc.config || doc['fomod:config'];
  if (!cfg) throw new Error('ModuleConfig.xml has no <config> element');

  const steps = sortBy(cfg.installSteps?.installStep || [], cfg.installSteps?.['@_order'] || 'Ascending').map(step => ({
    name: String(step['@_name'] || 'Options'),
    visible: cond(step.visible?.dependencies?.[0] || step.visible),
    groups: sortBy(step.optionalFileGroups?.group || [], step.optionalFileGroups?.['@_order'] || 'Ascending').map(g => ({
      name: String(g['@_name'] || ''),
      type: String(g['@_type'] || 'SelectAny'),
      plugins: sortBy(g.plugins?.plugin || [], g.plugins?.['@_order'] || 'Ascending').map(p => ({
        name: String(p['@_name'] || ''),
        description: text(p.description),
        image: norm(p.image?.['@_path'] || ''),
        files: entries(p.files),
        flags: (p.conditionFlags?.flag || []).map(f => ({ name: String(f['@_name'] || ''), value: text(f) })),
        typeDesc: typeDesc(p.typeDescriptor),
      })),
    })),
  }));

  const conditional = (cfg.conditionalFileInstalls?.patterns?.pattern || []).map(p => ({
    cond: cond(p.dependencies?.[0]),
    files: entries(p.files),
  }));

  return {
    moduleName: text(cfg.moduleName),
    requiredFiles: entries(cfg.requiredInstallFiles),
    steps,
    conditional,
  };
}

/**
 * Look for fomod/ModuleConfig.xml in an extracted archive.
 * Returns { basePath, configPath } (basePath relative to the root, '' at the top) or null.
 */
function findFomod(files) {
  const hits = files.filter(f => /(^|\/)fomod\/moduleconfig\.xml$/i.test(f)).sort((a, b) => a.length - b.length);
  if (!hits.length) return null;
  const configPath = hits[0];
  const basePath = configPath.split('/').slice(0, -2).join('/');
  return { basePath, configPath };
}

function loadFomod(extractDir, files) {
  const found = findFomod(files);
  if (!found) return null;
  const xml = decode(fs.readFileSync(path.join(extractDir, found.configPath)));
  return { ...found, config: parseModuleConfig(xml) };
}

module.exports = { parseModuleConfig, findFomod, loadFomod, decode };
