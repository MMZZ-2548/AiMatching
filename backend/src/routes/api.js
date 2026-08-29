/**
 * Node API — V4 §36 route list, plus the V5 additions (recommended jobs, interests,
 * exceptional-distance acceptance, mutual matches).
 *
 * Auth here is the dev-tester identity model: the caller states who they are with `x-role` and
 * `x-actor-id`, which is what makes V5 §14's role switcher possible without re-authenticating.
 * That is only safe because the whole surface is gated behind DEV_TESTER_ENABLED (V4 §39) — the
 * production build must put Supabase Auth in front of it, and the RLS policies in
 * db/migrations/002_rls.sql are what protect the data in that mode.
 */

import { Router } from 'express';
import { store } from '../store/index.js';
import { ENV, envReport } from '../lib/env.js';
import { seed, SEED_ACCOUNTS } from '../seed/seed.js';
import {
  runMatchingForRequest,
  runRecommendedJobs,
  debugPair,
  publicCaregiver,
  privacySafeJob,
} from '../services/matching.js';
import * as wf from '../services/workflow.js';
import { ingestEvent, timeline } from '../services/monitoring.js';
import * as ai from '../services/aiGateway.js';
import { evaluatePair } from '../matching/engine.js';
import { resolveId } from '../lib/ids.js';

export const api = Router();

/**
 * Accept a readable code anywhere an id is expected.
 *
 * Seeded rows keep a uuid primary key derived from their code (lib/ids.js), so the tester, the
 * scenarios and the tests can keep saying "CR-01" while the database keys on uuid. A value that
 * already is a uuid passes through untouched, so this is safe to apply broadly.
 */
const ID_FIELDS = [
  'care_request_id', 'caregiver_id', 'elderly_id', 'family_id',
  'job_id', 'thread_id', 'care_plan_id', 'job_request_id', 'profile_id',
];

api.use((req, _res, next) => {
  for (const key of ['id', 'careRequestId', 'caregiverId']) {
    if (req.params?.[key]) req.params[key] = resolveId(req.params[key]);
  }
  if (req.body && typeof req.body === 'object') {
    for (const f of ID_FIELDS) {
      if (typeof req.body[f] === 'string') req.body[f] = resolveId(req.body[f]);
    }
  }
  next();
});

/**
 * Express 5 serves `req.query` from a getter that re-parses the query string, so mutating it in
 * middleware is silently discarded. Query ids are therefore resolved where they are read.
 */
const q = (req, field) => (req.query?.[field] ? resolveId(req.query[field]) : undefined);

api.param('id', (req, _res, next, v) => { req.params.id = resolveId(v); next(); });
api.param('careRequestId', (req, _res, next, v) => { req.params.careRequestId = resolveId(v); next(); });
api.param('caregiverId', (req, _res, next, v) => { req.params.caregiverId = resolveId(v); next(); });

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });

// ───────────────────────────────────────────── health & meta

api.get('/health', async (_req, res) => {
  const aiHealth = await ai.health();
  ok(res, {
    status: 'up',
    env: envReport(),
    store: { driver: store.driver, counts: await store.counts() },
    ai_service: aiHealth,
  });
});

api.get('/me', (req, res) =>
  ok(res, { role: req.headers['x-role'] ?? null, actor_id: req.headers['x-actor-id'] ?? null }),
);

// ───────────────────────────────────────────── dev tester (V4 §39, V5 §31)

api.post('/dev/seed', async (_req, res) => {
  if (!ENV.devTesterEnabled) return fail(res, 403, 'DEV_TESTER_DISABLED');
  const result = await seed({ reset: true });
  ok(res, { seeded: result, accounts: SEED_ACCOUNTS });
});

api.post('/dev/reset', async (_req, res) => {
  if (!ENV.devTesterEnabled) return fail(res, 403, 'DEV_TESTER_DISABLED');
  await store.reset();
  const result = await seed({ reset: false });
  ok(res, { reset: true, seeded: result });
});

api.get('/dev/accounts', (_req, res) => ok(res, { accounts: SEED_ACCOUNTS }));

// ───────────────────────────────────────────── profiles

api.get('/families', async (_req, res) => ok(res, { families: await store.findMany('profiles', { role: 'FAMILY' }) }));

api.get('/elderly', async (req, res) => {
  const where = q(req, 'family_id') ? { family_id: q(req, 'family_id') } : {};
  ok(res, { elderly: await store.findMany('elderly_profiles', where) });
});

api.get('/caregivers', async (_req, res) => {
  const list = await store.findMany('caregiver_profiles', {});
  ok(res, { caregivers: list.map(publicCaregiver) });
});

api.get('/caregivers/:id', async (req, res) => {
  const cg = await store.find('caregiver_profiles', req.params.id);
  if (!cg) return fail(res, 404, 'NOT_FOUND');
  ok(res, { caregiver: publicCaregiver(cg) });
});

api.patch('/caregivers/:id', async (req, res) => {
  const updated = await store.update('caregiver_profiles', req.params.id, req.body ?? {});
  if (!updated) return fail(res, 404, 'NOT_FOUND');
  ok(res, { caregiver: publicCaregiver(updated) });
});

api.get('/caregivers/:id/trust', async (req, res) => {
  const result = await wf.recomputeTrust(req.params.id);
  if (!result) return fail(res, 404, 'NOT_FOUND');
  ok(res, { trust: result });
});

api.get('/caregivers/:id/trust/history', async (req, res) =>
  ok(res, { history: await store.findMany('trust_score_snapshots', { caregiver_id: req.params.id }) }),
);

// ───────────────────────────────────────────── care requests

api.get('/care-requests', async (req, res) => {
  const where = q(req, 'family_id') ? { family_id: q(req, 'family_id') } : {};
  ok(res, { care_requests: await store.findMany('care_requests', where) });
});

api.post('/care-requests', async (req, res) =>
  ok(res, { care_request: await store.insert('care_requests', { status: 'DRAFT', ...req.body }) }),
);

api.get('/care-requests/:id', async (req, res) => {
  const cr = await store.find('care_requests', req.params.id);
  if (!cr) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_request: cr });
});

api.patch('/care-requests/:id', async (req, res) => {
  const cr = await store.update('care_requests', req.params.id, req.body ?? {});
  if (!cr) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_request: cr });
});

api.post('/care-requests/:id/confirm', async (req, res) => {
  const cr = await store.update('care_requests', req.params.id, { status: 'CONFIRMED' });
  if (!cr) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_request: cr });
});

// ───────────────────────────────────────────── matching

api.post('/matching/:careRequestId/run', async (req, res) => {
  const result = await runMatchingForRequest(req.params.careRequestId);
  if (!result) return fail(res, 404, 'NOT_FOUND');
  ok(res, { matching: result });
});

api.get('/matching/:careRequestId/candidates', async (req, res) => {
  const runs = await store.findMany('matching_runs', { care_request_id: req.params.careRequestId });
  const latest = runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!latest) return fail(res, 404, 'NO_RUN_YET');
  const candidates = await store.findMany('matching_candidates', { matching_run_id: latest.id });
  ok(res, { matching_run: latest, candidates });
});

api.get('/caregiver/:id/recommended-jobs', async (req, res) => {
  const result = await runRecommendedJobs(req.params.id);
  if (!result) return fail(res, 404, 'NOT_FOUND');
  ok(res, { recommendations: result });
});

/** V4 §39 TAB 4 / V5 §28 — the Matching Debug page, including "explain why this is exceptional". */
api.get('/matching/debug/:careRequestId/:caregiverId', async (req, res) => {
  const detail = await debugPair(req.params.careRequestId, req.params.caregiverId);
  if (!detail) return fail(res, 404, 'NOT_FOUND');
  ok(res, { debug: detail });
});

/** V4 §21 — AI-phrased explanation over a completed, deterministic breakdown. */
api.post('/matching/explain/:careRequestId/:caregiverId', async (req, res) => {
  const detail = await debugPair(req.params.careRequestId, req.params.caregiverId);
  if (!detail) return fail(res, 404, 'NOT_FOUND');
  const reasons = wf.agreementReasons(detail);
  const explanation = await ai.explainMatch(detail, reasons);
  ok(res, {
    // scores are echoed unchanged: GPT may not alter rank, score or eligibility (V4 §21)
    scores: {
      base_mutual_fit: detail.base_mutual_fit,
      final_mutual_fit: detail.final_mutual_fit,
      eligible: detail.eligible,
    },
    deterministic_reasons: reasons,
    explanation,
  });
});

// ───────────────────────────────────────────── interest & mutual match

api.post('/family/interests', async (req, res) => ok(res, await wf.recordInterest('FAMILY', req.body)));
api.post('/caregiver/interests', async (req, res) => ok(res, await wf.recordInterest('CAREGIVER', req.body)));

api.get('/mutual-matches', async (req, res) =>
  ok(res, {
    mutual_matches: await wf.listMutualMatches({
      care_request_id: q(req, 'care_request_id'),
      caregiver_id: q(req, 'caregiver_id'),
    }),
  }),
);

api.get('/care-requests/:id/interested-caregivers', async (req, res) =>
  ok(res, { interested: await wf.caregiversInterestedIn(req.params.id) }),
);

api.get('/care-requests/:id/interest-status', async (req, res) => {
  const fam = await store.findMany('family_interests', { care_request_id: req.params.id });
  const cg = await store.findMany('caregiver_interests', { care_request_id: req.params.id });
  ok(res, { family_interests: fam, caregiver_interests: cg });
});

// ───────────────────────────────────────────── care plan

api.post('/care-plans', async (req, res) => {
  const { tasks = [], ...plan } = req.body ?? {};
  const created = await wf.createCarePlan(plan);
  for (const t of tasks) await wf.addCarePlanTask(created.id, t);
  ok(res, { care_plan: created, tasks });
});

api.get('/care-plans/:id', async (req, res) => {
  const plan = await store.find('daily_care_plans', req.params.id);
  if (!plan) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_plan: plan, tasks: await store.findMany('daily_care_tasks', { care_plan_id: plan.id }) });
});

api.post('/care-plans/:id/confirm', async (req, res) => {
  const plan = await wf.confirmCarePlan(req.params.id);
  if (!plan) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_plan: plan });
});

api.get('/care-requests/:id/care-plan', async (req, res) =>
  ok(res, { care_plan: await wf.confirmedPlanFor(req.params.id) }),
);

// ───────────────────────────────────────────── job requests

api.post('/job-requests', async (req, res) => {
  const result = await wf.sendJobRequest(req.body ?? {});
  if (result.error === 'CARE_PLAN_REQUIRED') return res.status(409).json({ ok: false, ...result });
  if (result.error) return fail(res, 400, result.error, result);
  ok(res, { job_request: result });
});

api.get('/job-requests', async (req, res) => {
  const where = {};
  if (q(req, 'caregiver_id')) where.caregiver_id = q(req, 'caregiver_id');
  if (q(req, 'care_request_id')) where.care_request_id = q(req, 'care_request_id');
  const list = await store.findMany('job_requests', where);
  const enriched = await Promise.all(
    list.map(async (jr) => {
      const cr = await store.find('care_requests', jr.care_request_id);
      const elderly = cr ? await store.find('elderly_profiles', cr.elderly_id) : null;
      const cg = await store.find('caregiver_profiles', jr.caregiver_id);
      return {
        ...jr,
        // the caregiver's inbox shows the privacy-safe summary, never the full elderly record
        job: cr ? privacySafeJob(cr, elderly) : null,
        caregiver: cg ? publicCaregiver(cg) : null,
      };
    }),
  );
  ok(res, { job_requests: enriched });
});

api.post('/job-requests/:id/view', async (req, res) => ok(res, { job_request: await wf.markViewed(req.params.id) }));

api.post('/job-requests/:id/accept', async (req, res) => {
  const result = await wf.acceptJobRequest(req.params.id, req.body ?? {});
  if (result.error) return fail(res, result.error === 'NOT_FOUND' ? 404 : 409, result.error, result);
  ok(res, result);
});

api.post('/job-requests/:id/decline', async (req, res) =>
  ok(res, { job_request: await wf.declineJobRequest(req.params.id, req.body?.reason) }),
);

// ───────────────────────────────────────────── chat

api.get('/chats', async (req, res) => {
  const where = {};
  if (q(req, 'care_request_id')) where.care_request_id = q(req, 'care_request_id');
  if (q(req, 'caregiver_id')) where.caregiver_id = q(req, 'caregiver_id');
  ok(res, { chat_threads: await store.findMany('chat_threads', where) });
});

api.get('/chats/:id/messages', async (req, res) =>
  ok(res, { messages: await wf.listMessages(req.params.id) }),
);

api.post('/chats/:id/messages', async (req, res) => {
  const role = req.headers['x-role'] === 'CAREGIVER' ? 'CAREGIVER' : 'FAMILY';
  const result = await wf.postMessage({ thread_id: req.params.id, sender_role: role, body: req.body?.body ?? '' });
  if (result.error) return fail(res, result.error === 'CHAT_LOCKED' ? 403 : 404, result.error, result);
  ok(res, { message: result });
});

// ───────────────────────────────────────────── jobs, monitoring, reports, reviews

api.get('/jobs', async (req, res) => {
  const where = {};
  if (q(req, 'caregiver_id')) where.caregiver_id = q(req, 'caregiver_id');
  if (q(req, 'care_request_id')) where.care_request_id = q(req, 'care_request_id');
  ok(res, { jobs: await store.findMany('jobs', where) });
});

api.post('/jobs/:id/events', async (req, res) => {
  const result = await ingestEvent(req.params.id, req.body ?? {});
  if (result.error) return fail(res, 404, result.error);
  ok(res, result);
});

api.get('/jobs/:id/monitoring', async (req, res) => {
  const job = await store.find('jobs', req.params.id);
  if (!job) return fail(res, 404, 'NOT_FOUND');
  ok(res, { job_id: job.id, state: job.current_state, status: job.status, rule_version: ENV.realtimeRuleVersion });
});

api.get('/jobs/:id/timeline', async (req, res) => ok(res, await timeline(req.params.id)));

api.post('/reports', async (req, res) => {
  const { job_id, text, ...rest } = req.body ?? {};
  const structured = text ? await ai.structureReport(text) : { ai_available: false, structured: null };
  const report = await store.insert('care_reports', {
    job_id,
    source: text ? 'TEXT' : 'MANUAL',
    transcript: text ?? null,
    confirmed: false,
    ...(structured.structured ?? {}),
    ...rest,
  });
  ok(res, { report, ai: { available: structured.ai_available, degraded: structured.degraded ?? false } });
});

api.post('/reports/:id/confirm', async (req, res) => {
  const report = await wf.confirmReport(req.params.id, req.body ?? {});
  if (!report) return fail(res, 404, 'NOT_FOUND');
  ok(res, { report });
});

api.get('/jobs/:id/reports', async (req, res) =>
  ok(res, { reports: await store.findMany('care_reports', { job_id: req.params.id }) }),
);

api.post('/jobs/:id/review', async (req, res) => {
  const result = await wf.submitReview({ job_id: req.params.id, ...(req.body ?? {}) });
  if (result.error) return fail(res, 409, result.error);
  ok(res, result);
});

// ───────────────────────────────────────────── admin (V4 §6, §34)

api.post('/admin/caregivers/:id/verify', async (req, res) => {
  const cg = await store.update('caregiver_profiles', req.params.id, {
    verification_status: req.body?.status ?? 'VERIFIED',
  });
  if (!cg) return fail(res, 404, 'NOT_FOUND');
  ok(res, { caregiver: publicCaregiver(cg) });
});

api.post('/admin/incidents', async (req, res) =>
  ok(res, { incident: await store.insert('incidents', { status: 'REPORTED', responsibility: 'UNDETERMINED', ...req.body }) }),
);

api.post('/admin/incidents/:id/confirm', async (req, res) => {
  const result = await wf.confirmIncident(req.params.id, req.body ?? {});
  if (result.error) return fail(res, 404, result.error);
  ok(res, result);
});

api.get('/admin/incidents', async (_req, res) => ok(res, { incidents: await store.findMany('incidents', {}) }));

// ───────────────────────────────────────────── AI passthrough

api.post('/ai/intake/message', async (req, res) =>
  ok(res, { intake: await ai.intakeExtract(req.body?.text ?? '', req.body?.profile_context ?? {}) }),
);

api.post('/consult/messages', async (req, res) => {
  const conv = req.body?.conversation_id
    ? await store.find('ai_conversations', req.body.conversation_id)
    : await store.insert('ai_conversations', { kind: 'ADVISOR', profile_id: req.body?.user_id ?? null });

  await store.insert('ai_messages', { conversation_id: conv.id, role: 'user', content: req.body?.message ?? '' });
  const history = await store.findMany('ai_messages', { conversation_id: conv.id });

  // V4 §30 — only the context the advisor actually needs, never the full record.
  const context = {};
  if (req.body?.care_request_id) {
    const cr = await store.find('care_requests', req.body.care_request_id);
    if (cr) {
      const elderly = await store.find('elderly_profiles', cr.elderly_id);
      context.care_request = privacySafeJob(cr, elderly);
    }
  }

  const reply = await ai.advisorChat(
    history.map((m) => ({ role: m.role, content: m.content })),
    context,
  );
  if (reply.reply) await store.insert('ai_messages', { conversation_id: conv.id, role: 'assistant', content: reply.reply });

  ok(res, { conversation_id: conv.id, ...reply });
});

// ───────────────────────────────────────────── scenario helper for the tester (V5 §31)

/**
 * Drives one named scenario end to end so the tester can jump straight to an interesting state.
 * Every step goes through the same public service functions the API uses — nothing is faked.
 */
api.post('/dev/scenario/:name', async (req, res) => {
  if (!ENV.devTesterEnabled) return fail(res, 403, 'DEV_TESTER_DISABLED');
  const name = req.params.name;
  const steps = [];
  const log = (step, detail) => steps.push({ step, detail });

  await seed({ reset: true });
  log('seed', 'demo world created');

  if (name === 'exceptional_far_match') {
    const crId = resolveId('CR-12');
    const matching = await runMatchingForRequest(crId);
    log('matching', {
      nearby: matching.recommended_nearby.length,
      exceptional: matching.exceptional_matches.map((c) => ({
        caregiver_id: c.caregiver_id,
        base_mutual_fit: c.base_mutual_fit,
        final_mutual_fit: c.final_mutual_fit,
        distance_km: c.distance_km,
        cost: c.additional_cost_estimate,
      })),
    });
    return ok(res, { scenario: name, steps });
  }

  // default: family-initiated happy path (V5 §15)
  const crId = resolveId(req.body?.care_request_id ?? 'CR-01');
  const matching = await runMatchingForRequest(crId);
  const top = matching.recommended_nearby[0];
  if (!top) return ok(res, { scenario: name, steps, note: 'no eligible caregiver for this request' });
  log('matching', { top: top.caregiver_id, mutual: top.final_mutual_fit });

  await wf.recordInterest('FAMILY', { care_request_id: crId, caregiver_id: top.caregiver_id });
  const mutual = await wf.recordInterest('CAREGIVER', { care_request_id: crId, caregiver_id: top.caregiver_id });
  log('mutual_match', mutual);

  const blocked = await wf.sendJobRequest({ care_request_id: crId, caregiver_id: top.caregiver_id });
  log('job_request_without_plan', blocked);

  const plan = await wf.createCarePlan({ care_request_id: crId, plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00' });
  await wf.addCarePlanTask(plan.id, { task_code: 'MEAL_PREP', critical_task: true, planned_time: '11:30' });
  await wf.confirmCarePlan(plan.id);
  log('care_plan_confirmed', plan.id);

  const jr = await wf.sendJobRequest({ care_request_id: crId, caregiver_id: top.caregiver_id });
  log('job_request_sent', jr.id);

  const accepted = await wf.acceptJobRequest(jr.id, { note: 'ยินดีรับงานครับ' });
  log('accepted', { job_id: accepted.job?.id, reasons: accepted.agreement_reasons?.length });

  const msg = await wf.postMessage({ thread_id: accepted.chat_thread_id, sender_role: 'FAMILY', body: 'สวัสดีค่ะ' });
  log('chat', msg.id ? 'message delivered' : msg);

  ok(res, { scenario: name, steps, job_id: accepted.job?.id, chat_thread_id: accepted.chat_thread_id });
});
