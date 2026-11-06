'use strict';
/*
 * The same mod on the other site: a mod shared from mod.io for a friend who uses Nexus Mods (or the
 * other way round). The other site is searched by the mod's name; each result is scored on how alike
 * the names are, whether the author is the same and whether the version matches. The score only
 * orders the list: the user always confirms which one is the same mod (nothing downloads on a guess).
 */

/** Words of a name, lower case, letters and digits only ("Night City Interactions [DQC]" → night city interactions dqc). */
function words(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019`]/g, '').split(/[^a-z0-9]+/).filter(Boolean); // (here's = heres)
}

/** How alike two names are, 0..1 (pairs of letters in common, Dice; whole-word matches weigh in too). */
function nameScore(a, b) {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const ja = wa.join(' ');
  const jb = wb.join(' ');
  if (ja === jb) return 1;
  const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  const ga = grams(ja);
  const gb = grams(jb);
  let common = 0;
  for (const [k, n] of ga) common += Math.min(n, gb.get(k) || 0);
  const dice = (2 * common) / Math.max(1, ja.length - 1 + jb.length - 1);
  const sa = new Set(wa);
  const shared = wb.filter(w => sa.has(w)).length / Math.max(wa.length, wb.length);
  return Math.min(1, 0.6 * dice + 0.4 * shared);
}

const sameAuthor = (a, b) => { const x = words(a).join(''); const y = words(b).join(''); return !!x && x === y; };
const sameVersion = (a, b) => { const x = String(a || '').trim().replace(/^v/i, ''); const y = String(b || '').trim().replace(/^v/i, ''); return !!x && x === y; };

/**
 * Score candidates for `want` ({ name, author, version }): each gets score 0..1 and a short word
 * ("same name and author" …). Best first; at most `max`.
 */
function rank(want, candidates, max = 8) {
  return candidates.map(c => {
    const ns = nameScore(want.name, c.name);
    const author = sameAuthor(want.author, c.author);
    const version = sameVersion(want.version, c.version);
    const score = Math.min(1, ns * 0.75 + (author ? 0.2 : 0) + (version ? 0.05 : 0));
    const why = [ns >= 0.95 ? 'same name' : ns >= 0.6 ? 'similar name' : 'different name', author ? 'same author' : want.author && c.author ? 'another author' : '', version ? 'same version' : ''].filter(Boolean).join(', ');
    return { ...c, score: Math.round(score * 100) / 100, why, likely: score >= 0.85 };
  }).sort((a, b) => b.score - a.score).slice(0, max);
}

module.exports = { nameScore, rank, words };
