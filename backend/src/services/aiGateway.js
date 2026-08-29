/**
 * Gateway to the Python AI service (V4 §2, §37).
 *
 * Two rules from V4 govern everything here:
 *   §4  GPT may never produce a Match Score, a hard-filter decision, a Trust Score or a realtime
 *       state. This module is only ever called for language work.
 *   §52 If a key or the service is missing, say so — never report a call as successful when it was
 *       not made. Every response carries `ai_available` and `degraded` so a caller can tell the
 *       difference between a real answer and a deterministic fallback.
 */

import { ENV } from '../lib/env.js';

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 20000);

async function callAi(path, body) {
  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, reason: 'MISSING_ENV', missing: ['OPENAI_API_KEY'] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${ENV.pythonAiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-api-key': ENV.pythonAiInternalKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, reason: `AI_${res.status}`, detail: text.slice(0, 300) };
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: err.name === 'AbortError' ? 'AI_TIMEOUT' : 'AI_UNREACHABLE', detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * V4 §21 — turn a completed score breakdown into readable reasons.
 * The scores, ranking and eligibility are passed in and returned untouched; GPT only phrases them.
 * When the service is unavailable, the deterministic reasons already computed from the feature
 * values are returned instead, clearly marked as such.
 */
export async function explainMatch(scored, deterministicReasons) {
  const payload = {
    mutual_fit_score: scored.final_mutual_fit,
    base_mutual_fit: scored.base_mutual_fit,
    family_fit: scored.final_family_fit,
    job_fit: scored.final_job_fit,
    distance_km: scored.distance_km,
    feature_values: scored.feature_values,
    hard_filter_results: scored.hard_filter_results,
    deterministic_reasons: deterministicReasons,
  };
  const r = await callAi('/internal/ai/matching/explain', payload);
  if (!r.ok) {
    return {
      ai_available: false,
      degraded: true,
      degraded_reason: r.reason,
      reasons: deterministicReasons.map((d) => d.reason),
      tradeoffs: [],
      source: 'DETERMINISTIC_FALLBACK',
    };
  }
  return { ai_available: true, degraded: false, source: 'AI', ...r.data };
}

export async function intakeExtract(text, profileContext = {}) {
  const r = await callAi('/internal/ai/intake/extract', { text, profile_context: profileContext });
  return r.ok
    ? { ai_available: true, ...r.data }
    : { ai_available: false, degraded: true, degraded_reason: r.reason, extracted: null, missing_fields: [] };
}

export async function advisorChat(messages, context = {}) {
  const r = await callAi('/internal/ai/advisor/chat', { messages, context });
  return r.ok
    ? { ai_available: true, ...r.data }
    : {
        ai_available: false,
        degraded: true,
        degraded_reason: r.reason,
        reply: 'ขออภัย ระบบผู้ช่วย AI ไม่พร้อมใช้งานขณะนี้ กรุณาลองใหม่อีกครั้ง',
      };
}

export async function structureReport(text) {
  const r = await callAi('/internal/ai/report/structure', { text });
  return r.ok
    ? { ai_available: true, ...r.data }
    : { ai_available: false, degraded: true, degraded_reason: r.reason, structured: null };
}

/**
 * V4 §26 — turn dictated Thai into a timed daily plan.
 * The caller re-checks every time against the source text; this only asks the model.
 */
export async function structureCarePlan(text) {
  const r = await callAi('/internal/ai/careplan/structure', { text });
  return r.ok
    ? { ai_available: true, ...r.data }
    : { ai_available: false, degraded: true, degraded_reason: r.reason, items: [], notes: null };
}

/** V4 §27 — speech to text. Returns an unconfirmed transcript for the user to check. */
export async function transcribe(buffer, filename, contentType, context = 'CARE_PLAN') {
  if (!process.env.OPENAI_API_KEY) {
    return { ai_available: false, degraded_reason: 'MISSING_ENV', transcript: null };
  }
  try {
    const form = new FormData();
    form.append('audio', new Blob([buffer], { type: contentType || 'audio/webm' }), filename || 'audio.webm');
    form.append('context', context);
    const res = await fetch(`${ENV.pythonAiUrl}/internal/ai/transcribe`, {
      method: 'POST',
      headers: { 'x-internal-api-key': ENV.pythonAiInternalKey },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) return { ai_available: false, degraded_reason: `AI_${res.status}`, transcript: null };
    return JSON.parse(text);
  } catch (err) {
    return {
      ai_available: false,
      degraded_reason: err.name === 'TimeoutError' ? 'AI_TIMEOUT' : 'AI_UNREACHABLE',
      transcript: null,
    };
  }
}

export async function health() {
  try {
    const res = await fetch(`${ENV.pythonAiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    return { reachable: res.ok, status: res.status };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}
