'use strict';
const http = require('http');
const https = require('https');

/*
 * How much a model can read at once (its context window), and keeping a long chat inside it.
 *
 * The size comes from the server where it says so (all asked at once; the first that answers, in
 * this order, wins). The size the model RUNS with, not the one it was trained for:
 *   llama.cpp, llama-swap, Jan, TabbyAPI   GET /props(?model=<id>) → default_generation_settings.n_ctx
 *   llama-swap                             GET /upstream/<id>/props
 *   Ollama                                 GET /api/ps → models[].context_length (while it is loaded)
 *   LM Studio                              GET /api/v1/models → loaded_instances[].config.context_length
 *   KoboldCpp                              GET /api/extra/true_max_context_length → value
 *   LocalAI                                GET /v1/models/capabilities → data[].context_size
 *   TabbyAPI                               GET /v1/model → parameters.max_seq_len
 *   vLLM, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together…  GET /v1/models → their entry
 *   Anthropic                              GET /v1/models/<id> → max_input_tokens (else 200,000)
 * Else from the provider's "too long" error, which usually names the limit, or, for servers that
 * silently cut the chat instead (Ollama, KoboldCpp, text-generation-webui), from a reply that read
 * far fewer tokens than were sent. Settings → AI assistant → Context window overrides all of it.
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
  const runtime = num(m.loaded_context_length) || num(m.max_model_len) || num(m.meta?.n_ctx) || num(m.context_length) || num(m.context_window)
    || num(m.max_input_tokens) || num(m.max_context_length) || num(m.top_provider?.context_length) || num(m.contextLength) || num(m.inputTokenLimit) || num(m.context_size);
  if (runtime) return { tokens: runtime, source: 'the server\'s model list' };
  const trained = num(m.meta?.n_ctx_train);
  return trained ? { tokens: trained, source: 'the model\'s trained size (the server may run it smaller)' } : { tokens: 0 };
}

/**
 * Ask the provider how big the model's context window is. Resolves { tokens, source }, tokens 0
 * when nothing says. `get` is the HTTP GET (replaced in tests).
 */
async function detectContext({ provider, endpoint, key, model }, get = getJson) {
  const same = m => m && [m.id, m.name, m.model, m.key, m.model_key].some(v => v && String(v) === model);
  const pick = list => {
    const entries = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
    return entries.find(same) || (entries.length === 1 ? entries[0] : null);
  };
  if (provider === 'anthropic') {
    const b = String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1(\/messages)?$/, '') || 'https://api.anthropic.com';
    const m = await get(`${b}/v1/models/${encodeURIComponent(model || '')}`, { 'x-api-key': key || '', 'anthropic-version': '2023-06-01' });
    return num(m?.max_input_tokens) ? { tokens: num(m.max_input_tokens), source: 'Anthropic (the model\'s max input)' } : { tokens: ANTHROPIC_WINDOW, source: 'Anthropic\'s size for Claude models' };
  }
  const base = String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!base) return { tokens: 0 };
  const root = base.replace(/\/v1$/, '');
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const id = encodeURIComponent(model || '');
  const props = p => num(p?.default_generation_settings?.n_ctx) || num(p?.n_ctx);
  // Every server's own way, asked at once; the first in this list that answers wins.
  const probes = [
    [`${root}/props?model=${id}`, props, 'the server (llama.cpp)'],
    [`${root}/upstream/${id}/props`, props, 'the server (llama.cpp)'],
    [`${root}/props`, props, 'the server (llama.cpp)'],
    [`${root}/api/ps`, r => num(pick(r?.models)?.context_length), 'Ollama (the loaded model)'],
    [`${root}/api/v1/models`, r => num((pick(r)?.loaded_instances || []).map(i => i?.config?.context_length).find(Boolean)), 'LM Studio (the loaded model)'],
    [`${root}/api/extra/true_max_context_length`, r => num(r?.value), 'the server (KoboldCpp)'],
    [`${base}/models/capabilities`, r => num(pick(r)?.context_size), 'the server (LocalAI)'],
    [`${base}/model`, r => num(r?.parameters?.max_seq_len) || num(r?.max_model_len), 'the server (TabbyAPI)'],
    [`${base}/models`, r => fromModelEntry(pick(r)), ''],
  ];
  const answers = await Promise.all(probes.map(([url]) => get(url, headers).catch(() => null)));
  for (let i = 0; i < probes.length; i++) {
    if (!answers[i]) continue;
    const v = probes[i][1](answers[i]);
    if (typeof v === 'object' && v.tokens) return v;
    if (typeof v === 'number' && v) return { tokens: v, source: probes[i][2] };
  }
  return { tokens: 0 };
}

// How providers word "the request is too long" (llama.cpp, vLLM, TabbyAPI, OpenAI, Azure, Anthropic,
// Gemini, Mistral, DeepSeek, Together, OpenRouter, Cerebras…), and where each puts the limit.
const OVER = /exceed(?:s|ed)? the (?:available )?context|context(?:_| )(?:length|size|window)|maximum context|prompt is too long|too many tokens|exceed_context_size|input tokens? exceed|exceeds the maximum number of tokens|too large for model|larger than the max context|must be <=|input too long|maximum input length|fills the context|while limit is/i;
const LIMITS = [
  /maximum context length is ([\d,]+)/i, // OpenAI, vLLM, DeepSeek, Azure
  /exceed(?:s|ed)? the configured limit of ([\d,]+)/i, // OpenAI (newer models)
  />\s*([\d,]+)\s*maximum/i, // Anthropic: "210000 tokens > 200000 maximum"
  /maximum number of tokens allowed \(([\d,]+)\)/i, // Gemini
  /only supports up to ([\d,]+)/i, // Gemini (Vertex)
  /model with ([\d,]+) maximum context length/i, // Mistral
  /available context size (?:of )?\(?([\d,]+)/i, // llama.cpp, TabbyAPI
  /max context size \(([\d,]+)/i, // llama.cpp (context shift on)
  /must be <=\s*([\d,]+)/i, // Together
  /limit is ([\d,]+)/i, // Cerebras, Bedrock
  /maximum input length is ([\d,]+)/i,
];

/** A provider's "the request is too long" error: is it one, and the limit it names (or 0). */
function contextError(err) {
  const text = String(err?.message || err || '');
  const over = !!err?.contextLimit || /context_length_exceeded|exceed_context_size/i.test(err?.errorType || '') || OVER.test(text);
  if (!over) return { over: false, limit: 0 };
  const m = LIMITS.map(re => text.match(re)).find(Boolean);
  return { over: true, limit: num(err?.contextLimit) || (m ? num(m[1].replace(/,/g, '')) : 0) };
}

/**
 * A server that silently cuts a chat that is too long (Ollama, KoboldCpp, text-generation-webui)
 * says so only in its count: the reply read far fewer tokens than were sent. No real text has more
 * than about 8 characters a token, so fewer than 0.12 tokens a character means part was dropped; and
 * once this model's own rate is known (perChar), well under it does too.
 */
function wasCut(chars, input, perChar = 0) {
  if (chars <= 8000 || !(input > 0)) return false;
  return input / chars < 0.12 || (perChar > 0 && input < chars * perChar * 0.6);
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
  detectContext, contextError, wasCut, fromModelEntry, renderHistory, withSummary, getJson,
  SUMMARY_PROMPT, SUMMARY_HEAD, ANTHROPIC_WINDOW, ASSUMED_WINDOW, COMPACT_AT, TARGET,
};
