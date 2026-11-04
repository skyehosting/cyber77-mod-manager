'use strict';

const RETIRED = new Set(['OLD_VERSION', 'ARCHIVED', 'DELETED']);
const catOf = f => String(f.category_name || 'MISCELLANEOUS').toUpperCase();

/**
 * The newest file that replaces `installedId`, or null if it is current.
 *
 * Nexus records "file X was updated by file Y" in `file_updates` (old_file_id → new_file_id); the
 * chain is followed to its end. When an author uploads a new file without linking it, the old file
 * usually moves to Old versions: then the newest current file with the same name is taken.
 *
 * @param {object[]} files       files.json `files`
 * @param {object[]} fileUpdates files.json `file_updates`
 * @param {number}   installedId the file id that is installed
 */
function findUpdate(files, fileUpdates, installedId) {
  const byId = new Map(files.map(f => [Number(f.file_id), f]));
  const next = new Map((fileUpdates || []).map(u => [Number(u.old_file_id), Number(u.new_file_id)]));
  let id = Number(installedId);
  const seen = new Set([id]);
  while (next.has(id) && !seen.has(next.get(id))) {
    id = next.get(id);
    seen.add(id);
  }
  let candidate = id !== Number(installedId) ? byId.get(id) : null;
  if (candidate && RETIRED.has(catOf(candidate))) candidate = null;

  if (!candidate) {
    const installed = byId.get(Number(installedId));
    if (!installed || RETIRED.has(catOf(installed))) {
      const name = String(installed?.name || '').trim().toLowerCase();
      // The installed file is not in the list at all: nothing tells which file follows it.
      if (!name) return null;
      const same = files
        .filter(f => !RETIRED.has(catOf(f)) && Number(f.file_id) !== Number(installedId))
        .filter(f => String(f.name).trim().toLowerCase() === name)
        .sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0));
      candidate = same[0] || null;
    }
  }
  return candidate || null;
}

module.exports = { findUpdate };
