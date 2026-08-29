/**
 * Routes for the user-facing web app.
 *
 * The developer console in `api.js` exposes one endpoint per table, which is right for debugging
 * and wrong for a person filling in a form. These endpoints are shaped around what someone
 * actually does — "find me a caregiver", "send this person my request", "accept this job" — so the
 * web app can stay a form and a result page.
 *
 * Every explanation returned here is derived from the deterministic feature values the engine
 * already computed. No model writes any of it (V4 §0, §21).
 */

import { Router } from 'express';
import { store } from '../store/index.js';
import { runMatchingForRequest, runRecommendedJobs } from '../services/matching.js';
import * as wf from '../services/workflow.js';
import { resolveId } from '../lib/ids.js';
import { ingestEvent, timeline } from '../services/monitoring.js';
import { evaluatePair } from '../matching/engine.js';
import { locationFor, exact as exactLoc } from '../lib/location.js';
import { buildDistanceOptions, caregiverDistanceNote } from '../services/distanceOptions.js';
import * as notifications from '../services/notifications.js';

export const appApi = Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });

/** Trade-offs worth telling the family about, read straight off the feature values. */
function concernsFor(c) {
  const f = c.feature_values?.family ?? {};
  const out = [];
  if (f.budget_rate_fit != null && f.budget_rate_fit < 100) out.push('ค่าบริการสูงกว่างบที่ตั้งไว้');
  if (c.distance_km != null && c.distance_km > (c.service_radius_km ?? 25) * 0.7) {
    out.push(`อยู่ค่อนข้างไกล ${c.distance_km} กม.`);
  }
  if (f.condition_experience_fit != null && f.condition_experience_fit < 50) {
    out.push('ยังไม่เคยดูแลภาวะนี้โดยตรง');
  }
  if (f.trust_history_score != null && f.trust_history_score < 60) {
    out.push('ประวัติการทำงานในระบบยังไม่มาก');
  }
  if (c.exceptional_match) out.push('อยู่นอกระยะบริการปกติ อาจมีค่าเดินทางและค่าที่พักเพิ่ม');
  return out;
}

const FILTER_LABELS = {
  verification_status: 'ยังไม่ผ่านการยืนยันตัวตน',
  mandatory_required_skill: 'ไม่มีทักษะที่จำเป็น',
  mandatory_credential: 'ไม่มีใบรับรองที่กำหนด',
  minimum_skill_level: 'ระดับทักษะไม่ถึงเกณฑ์',
  availability: 'ไม่ว่างในช่วงเวลานี้',
  service_radius: 'อยู่นอกพื้นที่ให้บริการ',
  shift_length: 'ชั่วโมงงานเกินที่รับได้',
  mandatory_language: 'ไม่ตรงภาษาที่กำหนด',
  mandatory_gender: 'ไม่ตรงเพศที่กำหนด',
  caregiver_task_exclusion: 'ไม่รับงานลักษณะนี้',
  hospital_escort: 'ไม่รับพาไปโรงพยาบาล',
  heavy_lifting: 'ไม่รับงานยกเคลื่อนย้าย',
  budget_below_minimum: 'งบต่ำกว่าค่าบริการขั้นต่ำ',
  live_in: 'ไม่รับงานอยู่ประจำ',
};

/** Why the others were excluded, grouped — so the family can see the filter did something real. */
function summariseFilters(filtered) {
  const counts = {};
  for (const c of filtered) {
    for (const f of c.failed_filters ?? []) counts[f] = (counts[f] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([filter, count]) => ({ filter, label: FILTER_LABELS[filter] ?? filter, count }));
}

/**
 * Everything the "find a caregiver" form produces, in one call: create the elderly profile if the
 * form supplied one, create and confirm the care request, run matching, and return cards that
 * already carry their reasons.
 */
appApi.post('/find-caregivers', async (req, res) => {
  const body = req.body ?? {};
  const familyId = resolveId(body.family_id ?? 'FAM-1');

  let elderlyId = body.elderly_id ? resolveId(body.elderly_id) : null;
  if (!elderlyId) {
    const elderly = await store.insert('elderly_profiles', {
      family_id: familyId,
      display_name: body.elderly_name || 'ผู้สูงอายุ',
      age: body.elderly_age ?? null,
      gender: body.elderly_gender ?? null,
      basic_conditions: body.conditions ?? [],
      mobility_level: body.mobility ?? 'INDEPENDENT',
      preferred_language: body.languages ?? ['TH'],
      latitude: body.latitude ?? 6.541,
      longitude: body.longitude ?? 101.28,
      province: body.province ?? 'ยะลา',
      district: body.district ?? null,
    });
    elderlyId = elderly.id;
  }

  const requirements = [
    ...(body.required_skills ?? []).map((code) => ({
      requirement_type: 'SKILL', requirement_code: code, strength: 'MANDATORY', minimum_level: null,
    })),
    ...(body.required_languages ?? []).map((code) => ({
      requirement_type: 'LANGUAGE', requirement_code: code, strength: 'MANDATORY', minimum_level: null,
    })),
    ...(body.gender_preference
      ? [{ requirement_type: 'GENDER', requirement_code: body.gender_preference, strength: 'MANDATORY', minimum_level: null }]
      : []),
  ];

  const careRequest = await store.insert('care_requests', {
    family_id: familyId,
    elderly_id: elderlyId,
    status: 'CONFIRMED',
    visibility: body.visibility ?? 'MATCHED_ONLY',
    care_date: body.care_date,
    start_time: body.start_time,
    end_time: body.end_time,
    budget: body.budget ?? null,
    conditions_relevant: body.conditions ?? [],
    mobility_requirement: body.mobility ?? 'INDEPENDENT',
    latitude: body.latitude ?? 6.541,
    longitude: body.longitude ?? 101.28,
    tasks: (body.tasks ?? []).map((t) => ({ task_code: t, must_do: true })),
    requirements,
    hospital_visit: Boolean(body.hospital_visit),
    transport_required: Boolean(body.transport_required),
    lifting_required: Boolean(body.lifting_required),
    night_monitoring: Boolean(body.night_monitoring),
    live_in_required: Boolean(body.live_in_required),
    recurring_job: Boolean(body.recurring_job),
    continuity_preference: body.continuity_preference ?? 'ONE_TIME',
    minimum_experience: body.minimum_experience ?? null,
    accept_out_of_area: Boolean(body.accept_out_of_area),
    search_radius_km: Number(body.search_radius_km ?? 25),
    additional_notes: body.notes ?? null,
    environment: body.environment ?? {},
    scenario: 'สร้างจากเว็บผู้ใช้',
  });

  const matching = await runMatchingForRequest(careRequest.id);
  const explain = (c) => ({ ...c, why: wf.agreementReasons(c), concerns: concernsFor(c) });

  // Both distance answers, priced, so the family compares them instead of finding a far candidate
  // sitting quietly in a list that never mentions the extra cost.
  const byId = new Map();
  for (const c of [...matching.recommended_nearby, ...matching.exceptional_matches]) {
    byId.set(c.caregiver_id, await store.find('caregiver_profiles', c.caregiver_id));
  }

  ok(res, {
    care_request: careRequest,
    distance_options: buildDistanceOptions(matching, byId, careRequest),
    matching: {
      score_version: matching.score_version,
      weight_version: matching.weight_version,
      runtime_ms: matching.runtime_ms,
      candidate_count: matching.candidate_count,
      recommended_nearby: matching.recommended_nearby.map(explain),
      exceptional_matches: matching.exceptional_matches.map(explain),
      filtered_out_count: matching.filtered_out.length,
      filtered_out_reasons: summariseFilters(matching.filtered_out),
    },
  });
});

/**
 * "Send my request to this person." The care plan gate (V4 §25) is real, so this creates and
 * confirms the plan from what the family already told us rather than bouncing them to another form.
 */
appApi.post('/send-request', async (req, res) => {
  const care_request_id = resolveId(req.body?.care_request_id);
  const caregiver_id = resolveId(req.body?.caregiver_id);

  // Record which of the two distance answers the family actually pursued, rather than inferring
  // it later from whoever they happened to contact.
  if (req.body?.distance_choice) {
    await store.update('care_requests', care_request_id, {
      distance_choice: req.body.distance_choice,
    });
  }

  let plan = await wf.confirmedPlanFor(care_request_id);
  if (!plan) {
    const cr = await store.find('care_requests', care_request_id);
    if (!cr) return fail(res, 404, 'NOT_FOUND');
    plan = await wf.createCarePlan({
      care_request_id,
      plan_date: cr.care_date,
      shift_start: cr.start_time,
      shift_end: cr.end_time,
    });
    for (const t of cr.tasks ?? []) {
      await wf.addCarePlanTask(plan.id, { task_code: t.task_code, critical_task: Boolean(t.must_do) });
    }
    // Take the confirmed row back, or the response would report the plan as DRAFT after
    // confirming it — a status the caller would then display.
    plan = await wf.confirmCarePlan(plan.id);
  }

  await wf.recordInterest('FAMILY', { care_request_id, caregiver_id });
  const jr = await wf.sendJobRequest({ care_request_id, caregiver_id });
  if (jr.error) return fail(res, 409, jr.error, jr);
  ok(res, { job_request: jr, care_plan: plan });
});

/** The caregiver's side: what the request looks like to them, with their own fit reasons. */
appApi.get('/inbox/:caregiverId', async (req, res) => {
  const caregiverId = resolveId(req.params.caregiverId);
  const requests = await store.findMany('job_requests', { caregiver_id: caregiverId });

  const out = await Promise.all(
    requests.map(async (jr) => {
      const cr = await store.find('care_requests', jr.care_request_id);
      const elderly = cr ? await store.find('elderly_profiles', cr.elderly_id) : null;
      const cg = await store.find('caregiver_profiles', caregiverId);
      const scored = cr && cg ? evaluatePair(cr, cg) : null;
      return {
        job_request: jr,
        // privacy-safe summary only, until there is a relationship (V4 §23, V5 §4)
        job: cr && {
          care_date: cr.care_date,
          start_time: cr.start_time,
          end_time: cr.end_time,
          budget: cr.budget,
          area: [elderly?.district, elderly?.province].filter(Boolean).join(', ') || 'ยะลา',
          elderly_age: elderly?.age ?? null,
          elderly_gender: elderly?.gender ?? null,
          mobility: cr.mobility_requirement,
          relevant_conditions: cr.conditions_relevant ?? [],
          must_do_tasks: (cr.tasks ?? []).filter((t) => t.must_do).map((t) => t.task_code),
          required_skills: (cr.requirements ?? [])
            .filter((r) => r.requirement_type === 'SKILL')
            .map((r) => r.requirement_code),
          hospital_escort_required: cr.hospital_visit,
          lifting_required: cr.lifting_required,
          night_monitoring: cr.night_monitoring,
          // Approximate until this request is accepted; exact afterwards.
          location: locationFor(cr, 'CAREGIVER', jr.status === 'ACCEPTED'),
        },
        scores: scored && {
          base_job_fit: scored.base_job_fit,
          final_job_fit: scored.final_job_fit,
          base_mutual_fit: scored.base_mutual_fit,
          final_mutual_fit: scored.final_mutual_fit,
          distance_km: scored.distance_km,
        },
        why: scored ? wf.agreementReasons(scored) : [],
      };
    }),
  );

  ok(res, { inbox: out.sort((a, b) => String(b.job_request.sent_at).localeCompare(String(a.job_request.sent_at))) });
});

/** Accept or decline, as one call. Accepting also records the caregiver's side of the interest. */
appApi.post('/respond', async (req, res) => {
  const { job_request_id, accept, accommodation_agreed = false, note = null, reason = null } = req.body ?? {};
  const jr = await store.find('job_requests', job_request_id);
  if (!jr) return fail(res, 404, 'NOT_FOUND');

  if (!accept) {
    return ok(res, { accepted: false, job_request: await wf.declineJobRequest(job_request_id, reason) });
  }

  await wf.recordInterest('CAREGIVER', {
    care_request_id: jr.care_request_id,
    caregiver_id: jr.caregiver_id,
    accept_exceptional_distance: true,
  });
  const result = await wf.acceptJobRequest(job_request_id, { note, accommodation_agreed });
  if (result.error) return fail(res, 409, result.error, result);
  ok(res, { accepted: true, ...result });
});

/** Everything the "match complete" screen needs, in one read. */
appApi.get('/summary/:jobRequestId', async (req, res) => {
  const jr = await store.find('job_requests', req.params.jobRequestId);
  if (!jr) return fail(res, 404, 'NOT_FOUND');
  const cr = await store.find('care_requests', jr.care_request_id);
  const cg = await store.find('caregiver_profiles', jr.caregiver_id);
  const elderly = cr ? await store.find('elderly_profiles', cr.elderly_id) : null;
  const thread = await store.findOne('chat_threads', {
    care_request_id: jr.care_request_id, caregiver_id: jr.caregiver_id,
  });
  const jobs = await store.findMany('jobs', { job_request_id: jr.id });

  ok(res, {
    job_request: jr,
    care_request: cr,
    elderly,
    caregiver: cg && {
      id: cg.id, code: cg.code, display_name: cg.display_name, gender: cg.gender,
      years_experience: cg.years_experience, skills: cg.skills, languages: cg.languages,
      final_trust_score: cg.final_trust_score, trust_status: cg.trust_status,
      completed_jobs: cg.completed_jobs, review_count: cg.review_count,
      expected_rate: cg.expected_rate,
    },
    chat_thread_id: thread?.id ?? null,
    job_id: jobs[0]?.id ?? null,
  });
});

// ═══════════════════════════════════════════ account switching

/**
 * Accounts the tester can switch between.
 *
 * This is an account switcher, not a role toggle: picking a caregiver here means acting *as that
 * person*, so the inbox, the recommended jobs and the fit scores all belong to them. That is what
 * makes it possible to walk both halves of a match without logging in and out.
 */
appApi.get('/accounts', async (_req, res) => {
  const profiles = await store.findMany('profiles', {});
  const caregivers = await store.findMany('caregiver_profiles', {});

  const families = profiles
    .filter((p) => p.role === 'FAMILY')
    .map((p) => ({ id: p.id, code: p.code, display_name: p.display_name, email: p.email }));

  const cgs = caregivers.map((c) => ({
    id: c.id,
    code: c.code,
    display_name: c.display_name,
    gender: c.gender,
    years_experience: c.years_experience,
    skills: c.skills ?? [],
    languages: c.languages ?? [],
    expected_rate: c.expected_rate,
    service_radius_km: c.service_radius_km,
    final_trust_score: c.final_trust_score,
    verification_status: c.verification_status,
    out_of_area_enabled: c.out_of_area_enabled,
    nighttime_ok: c.nighttime_ok,
  }));

  ok(res, {
    families: families.sort((a, b) => String(a.code).localeCompare(String(b.code))),
    caregivers: cgs.sort((a, b) => String(a.code).localeCompare(String(b.code))),
  });
});

// ═══════════════════════════════════════════ caregiver-initiated journey (V5 §4, §16)

/** Jobs recommended to a caregiver, with the reasons they fit — the mirror of find-caregivers. */
appApi.get('/caregiver/:caregiverId/jobs', async (req, res) => {
  const caregiverId = resolveId(req.params.caregiverId);
  const result = await runRecommendedJobs(caregiverId);
  if (!result) return fail(res, 404, 'NOT_FOUND');

  const interests = await store.findMany('caregiver_interests', { caregiver_id: caregiverId });
  const interested = new Set(interests.filter((i) => i.interested).map((i) => i.care_request_id));

  const decorate = (c) => ({
    ...c,
    why: wf.agreementReasons(c),
    concerns: concernsFor(c),
    already_interested: interested.has(c.care_request_id),
  });

  ok(res, {
    caregiver_id: caregiverId,
    recommended_nearby: result.recommended_nearby.map(decorate),
    exceptional_matches: result.exceptional_matches.map(decorate),
    candidate_count: result.candidate_count,
    runtime_ms: result.runtime_ms,
  });
});

/** The caregiver says "I want this job" (V5 §16 step 6-7). */
appApi.post('/caregiver-interest', async (req, res) => {
  const care_request_id = resolveId(req.body?.care_request_id);
  const caregiver_id = resolveId(req.body?.caregiver_id);
  const result = await wf.recordInterest('CAREGIVER', {
    care_request_id,
    caregiver_id,
    interested: req.body?.interested !== false,
    accept_exceptional_distance: Boolean(req.body?.accept_exceptional_distance),
  });
  ok(res, result);
});

/** What a family sees: who has asked to take their job, and how well each one fits (V5 §16 step 9-11). */
appApi.get('/family/:familyId/incoming', async (req, res) => {
  const familyId = resolveId(req.params.familyId);
  const requests = (await store.findMany('care_requests', { family_id: familyId }))
    .filter((cr) => cr.status === 'CONFIRMED');

  const out = [];
  for (const cr of requests) {
    const interests = await store.findMany('caregiver_interests', {
      care_request_id: cr.id,
      interested: true,
    });
    if (!interests.length) continue;

    const candidates = [];
    for (const i of interests) {
      const cg = await store.find('caregiver_profiles', i.caregiver_id);
      if (!cg) continue;
      const scored = evaluatePair(cr, cg);
      const familyInterest = await store.findOne('family_interests', {
        care_request_id: cr.id,
        caregiver_id: cg.id,
      });
      candidates.push({
        ...scored,
        caregiver: {
          id: cg.id, code: cg.code, display_name: cg.display_name, gender: cg.gender,
          years_experience: cg.years_experience, skills: cg.skills, languages: cg.languages,
          expected_rate: cg.expected_rate, final_trust_score: cg.final_trust_score,
          trust_status: cg.trust_status, completed_jobs: cg.completed_jobs,
          review_count: cg.review_count, verification_status: cg.verification_status,
        },
        why: wf.agreementReasons(scored),
        concerns: concernsFor(scored),
        family_already_interested: Boolean(familyInterest?.interested),
      });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.final_mutual_fit - a.final_mutual_fit);
      // The family owns this location, so they see it exactly.
      out.push({ care_request: cr, location: locationFor(cr, 'FAMILY'), candidates });
    }
  }
  ok(res, { incoming: out });
});

/** The family says yes back — the point at which a mutual match actually exists (V5 §5). */
appApi.post('/family-accept-interest', async (req, res) => {
  const care_request_id = resolveId(req.body?.care_request_id);
  const caregiver_id = resolveId(req.body?.caregiver_id);
  const result = await wf.recordInterest('FAMILY', { care_request_id, caregiver_id });
  ok(res, result);
});

// ═══════════════════════════════════════════ the job itself (V4 §31-§34, V5 §11-§13)

/** Everything the "งานที่กำลังทำ" screen needs: plan tasks, events so far, state and alerts. */
appApi.get('/job/:jobId', async (req, res) => {
  const job = await store.find('jobs', req.params.jobId);
  if (!job) return fail(res, 404, 'NOT_FOUND');

  const cr = await store.find('care_requests', job.care_request_id);
  const cg = await store.find('caregiver_profiles', job.caregiver_id);
  const elderly = cr ? await store.find('elderly_profiles', cr.elderly_id) : null;
  const plan = await wf.confirmedPlanFor(job.care_request_id);
  const planTasks = plan ? await store.findMany('daily_care_tasks', { care_plan_id: plan.id }) : [];
  const tl = await timeline(job.id);
  const reports = await store.findMany('care_reports', { job_id: job.id });
  const review = await store.findOne('family_reviews', { job_id: job.id });

  // Which planned tasks have actually been completed, read from the event stream rather than
  // from a flag someone could set independently.
  const completed = new Set(
    tl.events.filter((e) => e.event_type === 'TASK_COMPLETED').map((e) => e.payload?.task_code),
  );

  ok(res, {
    job,
    care_request: cr,
    elderly: elderly && {
      display_name: elderly.display_name, age: elderly.age, gender: elderly.gender,
      mobility_level: elderly.mobility_level, basic_conditions: elderly.basic_conditions,
    },
    caregiver: cg && {
      id: cg.id, code: cg.code, display_name: cg.display_name,
      final_trust_score: cg.final_trust_score, trust_status: cg.trust_status,
      completed_jobs: cg.completed_jobs, review_count: cg.review_count,
    },
    // The job is running, so both sides see the real pin and the geofence the rules use.
    location: cr ? exactLoc(cr.latitude, cr.longitude, cr.geofence_radius_m) : null,
    caregiver_base: cg && Number.isFinite(cg.base_latitude)
      ? { latitude: cg.base_latitude, longitude: cg.base_longitude }
      : null,
    tasks: planTasks.map((t) => ({ ...t, done: completed.has(t.task_code) })),
    events: tl.events,
    transitions: tl.transitions,
    alerts: tl.alerts,
    state: job.current_state,
    reports,
    review,
    rule_version: tl.rule_version,
  });
});

/** One care event. The rule engine decides the state — nothing here is AI (V4 §31). */
appApi.post('/job/:jobId/event', async (req, res) => {
  const result = await ingestEvent(req.params.jobId, {
    event_type: req.body?.event_type,
    payload: req.body?.payload ?? {},
    dedupe_key: req.body?.dedupe_key ?? null,
    event_seq: req.body?.event_seq ?? null,
  });
  if (result.error) return fail(res, 404, result.error);
  ok(res, result);
});

/** The caregiver's end-of-shift report. AI structures the wording only; it may add no events. */
appApi.post('/job/:jobId/report', async (req, res) => {
  const job = await store.find('jobs', req.params.jobId);
  if (!job) return fail(res, 404, 'NOT_FOUND');

  const ai = await import('../services/aiGateway.js');
  const text = req.body?.text ?? '';
  const structured = text ? await ai.structureReport(text) : { ai_available: false, structured: null };

  const report = await store.insert('care_reports', {
    job_id: job.id,
    source: 'TEXT',
    transcript: text || null,
    confirmed: true,
    completed_tasks: structured.structured?.completed_tasks ?? [],
    delayed_tasks: structured.structured?.delayed_tasks ?? [],
    incomplete_tasks: structured.structured?.incomplete_tasks ?? [],
    incidents_reported: structured.structured?.incidents_reported ?? [],
    observations: structured.structured?.observations ?? null,
    notes: structured.structured?.notes ?? null,
    check_in: job.check_in_at ?? null,
    check_out: job.check_out_at ?? null,
  });

  await notifications.notifyReportReady(report);

  ok(res, {
    report,
    ai: {
      available: structured.ai_available,
      degraded: structured.degraded ?? false,
      degraded_reason: structured.degraded_reason ?? null,
    },
  });
});

/** The family's review, and the trust recomputation it triggers (V4 §33, §34). */
appApi.post('/job/:jobId/review', async (req, res) => {
  const result = await wf.submitReview({ job_id: req.params.jobId, ...(req.body ?? {}) });
  if (result.error) return fail(res, 409, result.error, result);
  ok(res, result);
});

/** Chat, so both sides of the switcher can talk on the same thread. */
appApi.get('/chat/:threadId', async (req, res) =>
  ok(res, { messages: await wf.listMessages(req.params.threadId) }),
);

appApi.post('/chat/:threadId', async (req, res) => {
  const result = await wf.postMessage({
    thread_id: req.params.threadId,
    sender_role: req.body?.sender_role === 'CAREGIVER' ? 'CAREGIVER' : 'FAMILY',
    body: req.body?.body ?? '',
  });
  if (result.error) return fail(res, result.error === 'CHAT_LOCKED' ? 403 : 404, result.error, result);
  ok(res, { message: result });
});

/** Everything a given account currently has in flight, for the "my jobs" screens. */
appApi.get('/my/:kind/:id', async (req, res) => {
  const { kind } = req.params;
  const id = resolveId(req.params.id);

  if (kind === 'caregiver') {
    const jobs = await store.findMany('jobs', { caregiver_id: id });
    const requests = await store.findMany('job_requests', { caregiver_id: id });
    return ok(res, {
      jobs: await Promise.all(jobs.map(async (j) => ({
        ...j, care_request: await store.find('care_requests', j.care_request_id),
      }))),
      pending_requests: requests.filter((r) => ['PENDING', 'VIEWED'].includes(r.status)).length,
    });
  }

  const requests = await store.findMany('care_requests', { family_id: id });
  const jobs = [];
  for (const cr of requests) {
    for (const j of await store.findMany('jobs', { care_request_id: cr.id })) {
      jobs.push({ ...j, care_request: cr });
    }
  }
  ok(res, { jobs, care_requests: requests });
});


// ───────────────────────────────────────────── notifications (V5 §29)

/**
 * The notification inbox.
 *
 * Thirteen event types exist; this endpoint does not care which. It answers one question — what has
 * happened that this person has not seen — and it answers it for exactly one recipient, so a
 * caregiver id can never be used to read a family's inbox.
 *
 * `who` is FAMILY or CAREGIVER, and `id` is a profile id for a family or a caregiver-profile id
 * for a caregiver. Readable codes (FAM-1, CG-03) resolve the same way they do everywhere else.
 */
appApi.get('/notifications/:who/:id', async (req, res) => {
  const who = String(req.params.who).toUpperCase();
  if (who !== 'FAMILY' && who !== 'CAREGIVER') return fail(res, 400, 'BAD_RECIPIENT_TYPE');

  const id = resolveId(req.params.id);
  const unreadOnly = req.query.unread === 'true' || req.query.unread === '1';
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const items = await notifications.listFor(who, id, { unreadOnly, limit });
  ok(res, {
    recipient_type: who,
    recipient_id: id,
    unread_count: await notifications.unreadCount(who, id),
    count: items.length,
    notifications: items,
  });
});

/** Just the badge number, for a header that polls. */
appApi.get('/notifications/:who/:id/unread-count', async (req, res) => {
  const who = String(req.params.who).toUpperCase();
  if (who !== 'FAMILY' && who !== 'CAREGIVER') return fail(res, 400, 'BAD_RECIPIENT_TYPE');
  const id = resolveId(req.params.id);
  ok(res, { unread_count: await notifications.unreadCount(who, id) });
});

/** Mark one notification as read. */
appApi.post('/notifications/:id/read', async (req, res) => {
  const updated = await notifications.markRead(req.params.id);
  if (!updated) return fail(res, 404, 'NOT_FOUND');
  ok(res, { notification: updated });
});

/** Mark everything in one inbox as read. */
appApi.post('/notifications/:who/:id/read-all', async (req, res) => {
  const who = String(req.params.who).toUpperCase();
  if (who !== 'FAMILY' && who !== 'CAREGIVER') return fail(res, 400, 'BAD_RECIPIENT_TYPE');
  const id = resolveId(req.params.id);
  ok(res, { marked_read: await notifications.markAllRead(who, id) });
});

/** The catalogue of types, so a client can map each one to an icon and a destination screen. */
appApi.get('/notification-types', (_req, res) => {
  ok(res, { types: notifications.NOTIFICATION_TYPES });
});
