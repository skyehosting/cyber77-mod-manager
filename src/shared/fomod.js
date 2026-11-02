/*
 * FOMOD evaluation shared by the main process (resolving files) and the renderer (the wizard).
 * Works on the normalized config produced by core/fomodParse.js:
 *   { moduleName, requiredFiles: Entry[], steps: Step[], conditional: { cond, files }[] }
 *   Step   { name, visible: Cond|null, groups: Group[] }
 *   Group  { name, type, plugins: Plugin[] }
 *   Plugin { name, description, image, files: Entry[], flags: {name,value}[], typeDesc: { def, patterns: {cond,type}[] } }
 *   Cond   { op: 'And'|'Or', items: ({flag,value}|{file,state}|Cond|{always:true})[] }
 *   Entry  { kind: 'file'|'folder', source, destination, priority }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fomod = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function evalCond(cond, flags, fileStates) {
    if (!cond) return true;
    const test = item => {
      if (item.items) return evalCond(item, flags, fileStates);
      if (item.always) return true;
      if ('flag' in item) return (flags[item.flag] || '') === (item.value || '');
      if ('file' in item) {
        const state = (fileStates && fileStates[String(item.file).toLowerCase().replace(/\\/g, '/')]) || 'Missing';
        return state === item.state;
      }
      return true;
    };
    if (!cond.items.length) return true;
    return cond.op === 'Or' ? cond.items.some(test) : cond.items.every(test);
  }

  function pluginType(plugin, flags, fileStates) {
    const td = plugin.typeDesc || { def: 'Optional', patterns: [] };
    for (const p of td.patterns || []) if (evalCond(p.cond, flags, fileStates)) return p.type;
    return td.def || 'Optional';
  }

  /** Flags set by the selections of every visible step, walked in order. */
  function computeFlags(config, selections, fileStates) {
    const flags = {};
    config.steps.forEach((step, si) => {
      if (!evalCond(step.visible, flags, fileStates)) return;
      step.groups.forEach((group, gi) => {
        const sel = (selections[si] && selections[si][gi]) || [];
        for (const pi of sel) {
          const plugin = group.plugins[pi];
          if (plugin) for (const f of plugin.flags) flags[f.name] = f.value;
        }
      });
    });
    return flags;
  }

  /** Flags produced by steps before `stepIndex` (what that step's visibility and types see). */
  function flagsBefore(config, selections, fileStates, stepIndex) {
    const partial = {};
    for (let i = 0; i < stepIndex; i++) partial[i] = selections[i];
    const cut = Object.assign({}, config, { steps: config.steps.slice(0, stepIndex) });
    return computeFlags(cut, partial, fileStates);
  }

  function visibleSteps(config, selections, fileStates) {
    const out = [];
    config.steps.forEach((step, si) => {
      if (evalCond(step.visible, flagsBefore(config, selections, fileStates, si), fileStates)) out.push(si);
    });
    return out;
  }

  /** Default selection for a group, honouring Required / Recommended / NotUsable types. */
  function defaultSelection(group, flags, fileStates) {
    const types = group.plugins.map(p => pluginType(p, flags, fileStates));
    const idx = t => types.map((x, i) => (x === t ? i : -1)).filter(i => i >= 0);
    const required = idx('Required');
    const recommended = idx('Recommended');
    const usable = types.map((t, i) => (t === 'NotUsable' ? -1 : i)).filter(i => i >= 0);
    switch (group.type) {
      case 'SelectAll': return group.plugins.map((_, i) => i);
      case 'SelectExactlyOne':
      case 'SelectAtLeastOne': {
        const first = required[0] ?? recommended[0] ?? usable[0] ?? 0;
        return group.type === 'SelectAtLeastOne' ? [...new Set([...required, ...recommended, first])] : [first];
      }
      case 'SelectAtMostOne': {
        const first = required[0] ?? recommended[0];
        return first === undefined ? [] : [first];
      }
      default: return [...new Set([...required, ...recommended])];
    }
  }

  function validateGroup(group, selected) {
    const n = selected.length;
    switch (group.type) {
      case 'SelectExactlyOne': return n === 1 ? '' : `"${group.name}": choose exactly one option.`;
      case 'SelectAtLeastOne': return n >= 1 ? '' : `"${group.name}": choose at least one option.`;
      case 'SelectAtMostOne': return n <= 1 ? '' : `"${group.name}": choose at most one option.`;
      default: return '';
    }
  }

  /** Every file entry the chosen options install, lowest priority first (later entries win). */
  function resolveEntries(config, selections, fileStates) {
    const visible = new Set(visibleSteps(config, selections, fileStates));
    const entries = [];
    let order = 0;
    const add = e => entries.push(Object.assign({}, e, { order: order++ }));
    config.requiredFiles.forEach(add);
    config.steps.forEach((step, si) => {
      if (!visible.has(si)) return;
      step.groups.forEach((group, gi) => {
        for (const pi of (selections[si] && selections[si][gi]) || []) {
          const plugin = group.plugins[pi];
          if (plugin) plugin.files.forEach(add);
        }
      });
    });
    const flags = computeFlags(config, selections, fileStates);
    for (const c of config.conditional) if (evalCond(c.cond, flags, fileStates)) c.files.forEach(add);
    entries.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));
    return entries;
  }

  return { evalCond, pluginType, computeFlags, flagsBefore, visibleSteps, defaultSelection, validateGroup, resolveEntries };
}));
