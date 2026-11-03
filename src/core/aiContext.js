'use strict';
const http = require('http');
const https = require('https');

/*
 * How much a model can read at once (its context window), and keeping a long chat inside it.
 *
 * The size comes from the server where it says so:
 *   llama.cpp      GET /props → default_generation_settings.n_ctx (the size it was started with)
 *   llama-swap     GET /props?model=<id> (passed on to that model's llama.cpp), or /upstream/<id>/props
 *   OpenRouter, LM Studio and others: their /v1/models entry (context_length, loaded_context_length…)
 *   Anthropic      200,000 tokens for Claude models
 * or from the provider's "too long" error, which usually names the limit. Settings → AI assistant
 * → Context window overrides all of it.
 *
 * Near the limit, the older part of the chat is summarized by the model itself (goals, facts
 * found, what was tried and changed, open questions) and the recent turns are kept word for word.
 */

const ANTHROPIC_WINDOW = 200000;
const ASSUMED_WINDOW = 128000; // nothing said: a common size, corrected by the first "too long" error
const COMPACT_AT = 0.75; // compact when a request would fill this much of the window…
const TARGET = 0.4; // …down to about this much

/** GET a JSON document (short time limit: this is only a question about the server). */
function getJson(url, headers, timeoutMs = 6000) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
      });
      res.on('error', () => resolve(null));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

/** A /v1/models entry's context size, by the names different servers use. */
function fromModelEntry(m) {
  if (!m || typeof m !== 'object') return { tokens: 0 };
  const runtime = num(m.loaded_context_length) || num(m.meta?.n_ctx) || num(m.context_length) || num(m.context_window) || num(m.max_context_length) || num(m.top_provider?.context_length);
  if (runtime) return { tokens: runtime, source: 'the server\'s model list' };
  const trained = num(m.meta?.n_ctx_train);
  return trained ? { tokens: trained, source: 'the model\'s trained size (the server may run it smaller)' } : { tokens: 0 };
}

/**
 * Ask the provider how big the model's context window is. Resolves { tokens, source }, tokens 0
 * when nothing says. `get` is the HTTP GET (replaced in tests).
 */
async function detectContext({ provider, endpoint, key, model }, get = getJson) {
  if (provider === 'anthropic') return { tokens: ANTHROPIC_WINDOW, source: 'Anthropic\'s size for Claude models' };
  const base = String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!base) return { tokens: 0 };
  const root = base.replace(/\/v1$/, '');
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const id = encodeURIComponent(model || '');
  // llama.cpp, directly or through llama-swap: the size the server really runs.
  for (const url of [`${root}/props?model=${id}`, `${root}/upstream/${id}/props`, `${root}/props`]) {
    const p = await get(url, headers);
    const n = num(p?.default_generation_settings?.n_ctx) || num(p?.n_ctx);
    if (n) return { tokens: n, source: 'the server (llama.cpp)' };
  }
  const list = await get(`${base}/models`, headers);
  const entries = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
  const entry = entries.find(m => m?.id === model || m?.name === model || m?.model === model) || (entries.length === 1 ? entries[0] : null);
  return fromModelEntry(entry);
}

/** A provider's "the request is too long" error: is it one, and the limit it names (or 0). */
function contextError(err) {
  const text = String(err?.message || err || '');
  const over = !!err?.contextLimit || /exceed[s]? the (available )?context|context (length|size|window)|maximum context|prompt is too long|too many tokens|context_length_exceeded|exceed_context_size/i.test(text);
  if (!over) return { over: false, limit: 0 };
  const m = text.match(/maximum context length is (\d+)/i) || text.match(/>\s*(\d+)\s*maximum/i) || text.match(/n_ctx\D{0,6}(\d+)/i) || text.match(/context (?:size|window|length)\D{0,12}(\d{4,})/i);
  return { over: true, limit: num(err?.contextLimit) || (m ? num(m[1]) : 0) };
}

const SUMMARY_PROMPT = `The conversation below is getting too long for your context window. Write a summary of it that you will continue from, in place of the conversation itself. Nothing that is not in your summary will be remembered, so keep everything needed to carry on without asking the user again:

## Goal
What the user wants overall, and the problem being worked on now, in their terms.
## What we know
Facts found, with exact names: mods (and versions), files and paths, log lines and errors, crash DLLs, settings and their values, what the tools showed.
## Done and ruled out
What was checked, what was ruled out and why, and every change: proposed, approved, declined or done.
## Open
Questions not yet answered, what the user said they would do or try, and what they asked for that is not finished.
## Next steps
What you were about to do next.

Use the same language as the conversation. Be complete but compact: lists, no repetition, no pleasantries. Never include keys or passwords. Reply with the summary only.`;

/** The part of the history the summary replaces, as plain text the model can read. */
function renderHistory(turns, toolChars) {
  const out = [];
  for (const t of turns) {
    if (t.role === 'user') out.push(`USER: ${t.text}`);
    else if (t.role === 'assistant') {
      if (t.text?.trim()) out.push(`ASSISTANT: ${t.text.trim()}`);
      for (const c of t.calls || []) out.push(`ASSISTANT CALLED ${c.name}(${JSON.stringify(c.args || {}).slice(0, 300)})`);
    } else if (t.role === 'tool') {
      for (const r of t.results || []) {
        const c = String(r.content || '');
        out.push(`RESULT OF ${r.name}: ${c.length > toolChars ? `${c.slice(0, toolChars)}…[cut]` : c}`);
      }
    }
  }
  return out.join('\n\n');
}

const SUMMARY_HEAD = '[Summary of the earlier conversation, written by you when the chat grew near your context limit. Continue from it.]';
const SUMMARY_END = '[End of the summary. The conversation continues:]';

/** Start the history with the summary, before the first user message kept word for word. */
function withSummary(summary, kept) {
  const [first, ...rest] = kept;
  const text = `${SUMMARY_HEAD}\n${summary.trim()}\n${SUMMARY_END}\n\n${first?.role === 'user' ? first.text : ''}`;
  return [{ role: 'user', text }, ...(first?.role === 'user' ? rest : kept)];
}

module.exports = {
  detectContext, contextError, fromModelEntry, renderHistory, withSummary, getJson,
  SUMMARY_PROMPT, SUMMARY_HEAD, ANTHROPIC_WINDOW, ASSUMED_WINDOW, COMPACT_AT, TARGET,
};
