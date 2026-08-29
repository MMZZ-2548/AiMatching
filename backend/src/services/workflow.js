/**
 * Two-sided workflow — interest, mutual match, care-plan gate, job request, chat, review, trust.
 * V4 §24–§26, §33–§34; V5 §5–§13.
 *
 * The consent rules are the point of this file: a high score never books anyone. A mutual match
 * requires both sides to act (V5 §5), a job request cannot leave without a confirmed care plan
 * (V4 §25), and an exceptional-distance booking cannot complete without an accommodation
 * agreement (V5 §26 case 8).
 */

import { store } from '../store/index.js';
import { ENV } from '../lib/env.js';
import { evaluatePair } from '../matching/engine.js';
import { computeTrustScore } from '../matching/trust.js';
import { estimateAdditionalCost } from '../matching/exceptional.js';
import * as notifications from './notifications.js';

async function scorePair(careRequestId, caregiverId) {
  const cr = await store.find('care_requests', careRequestId);
  const cg = await store.find('caregiver_profiles', caregiverId);
  if (!cr || !cg) return null;
  return evaluatePair(cr, cg);
}

// ───────────────────────────────────────────── interest & mutual match (V5 §5)

export async function recordInterest(side, { care_request_id, caregiver_id, interested = true, accept_exceptional_distance = false }) {
  const table = side === 'FAMILY' ? 'family_interests' : 'caregiver_interests';
  const payload = side === 'FAMILY'
    ? { interested }
    : { interested, accept_exceptional_distance };

  await store.upsert(table, { care_request_id, caregiver_id }, payload);

  const fam = await store.findOne('family_interests', { care_request_id, caregiver_id });
  const cg = await store.findOne('caregiver_interests', { care_request_id, caregiver_id });

  // V5 §29 — interest is one of the thirteen notified events, and it goes to the side that did
  // not act. Each side learns the other is interested; neither is told about its own click.
  if (interested) await notifyInterest(side, care_request_id, caregiver_id);

  let status = 'NONE';
  if (fam?.interested && cg?.interested) status = 'MUTUAL_MATCH';
  else if (fam?.interested) status = 'FAMILY_INTERESTED';
  else if (cg?.interested) status = 'CAREGIVER_INTERESTED';

  let mutual = await store.findOne('mutual_matches', { care_request_id, caregiver_id });

  if (status === 'MUTUAL_MATCH') {
    const scored = await scorePair(care_request_id, caregiver_id);

    // V5 §23 — an out-of-area candidate is only a valid interest once the caregiver has explicitly
    // accepted the distance. Without that, both sides can be "interested" and it still is not a match.
    if (scored?.exceptional_match && !cg?.accept_exceptional_distance) {
      await notifications.notify(
        'EXCEPTIONAL_DISTANCE_REQUEST',
        caregiver_id,
        {
          distance_km: scored.distance_km,
          extra_cost: scored.additional_cost_estimate?.total_extra ?? 0,
        },
        { care_request_id, caregiver_id },
      );
      return {
        status: 'CAREGIVER_MUST_ACCEPT_DISTANCE',
        care_request_id,
        caregiver_id,
        distance_km: scored.distance_km,
        additional_cost_estimate: scored.additional_cost_estimate,
      };
    }

    if (!mutual) {
      mutual = await store.insert('mutual_matches', {
        care_request_id,
        caregiver_id,
        base_mutual_fit: scored?.base_mutual_fit ?? null,
        final_mutual_fit: scored?.final_mutual_fit ?? null,
      });
    }
    if (ENV.chatUnlockStage === 'MUTUAL_MATCH') {
      await ensureChatThread(care_request_id, caregiver_id, 'MUTUAL_MATCH');
    }
  }

  return { status, care_request_id, caregiver_id, mutual_match_id: mutual?.id ?? null };
}

/**
 * Tell the other party that someone showed interest (V5 §29, types 1 and 9).
 *
 * The family is told who and how well they fit; the caregiver is told where and when the job is,
 * at the approximate disclosure level, because interest alone does not unlock an address.
 */
async function notifyInterest(side, care_request_id, caregiver_id) {
  const cr = await store.find('care_requests', care_request_id);
  if (!cr) return;

  if (side === 'CAREGIVER') {
    const cg = await store.find('caregiver_profiles', caregiver_id);
    const scored = await scorePair(care_request_id, caregiver_id);
    await notifications.notify(
      'CAREGIVER_INTERESTED',
      cr.family_id,
      {
        caregiver_name: await notifications.caregiverName(caregiver_id),
        mutual_fit: scored?.final_mutual_fit ?? scored?.base_mutual_fit ?? 0,
        years_experience: cg?.years_experience ?? null,
      },
      { care_request_id, caregiver_id },
    );
    return;
  }

  await notifications.notify(
    'FAMILY_INTERESTED',
    caregiver_id,
    await notifications.jobBlurb(cr),
    { care_request_id, caregiver_id },
  );
}

export async function listMutualMatches({ care_request_id, caregiver_id } = {}) {
  const where = {};
  if (care_request_id) where.care_request_id = care_request_id;
  if (caregiver_id) where.caregiver_id = caregiver_id;
  return store.findMany('mutual_matches', where);
}

/** V5 §16 step 9 — the family's view of who has shown interest in their job. */
export async function caregiversInterestedIn(care_request_id) {
  const interests = await store.findMany('caregiver_interests', { care_request_id, interested: true });
  return Promise.all(
    interests.map(async (i) => ({
      ...i,
      caregiver: await store.find('caregiver_profiles', i.caregiver_id),
      scores: await scorePair(care_request_id, i.caregiver_id),
    })),
  );
}

// ───────────────────────────────────────────── care plan (V4 §25, §26)

export async function createCarePlan(payload) {
  return store.insert('daily_care_plans', { status: 'DRAFT', ...payload });
}

export async function addCarePlanTask(care_plan_id, task) {
  return store.insert('daily_care_tasks', { care_plan_id, ...task });
}

export async function confirmCarePlan(id) {
  return store.update('daily_care_plans', id, { status: 'CONFIRMED' });
}

/** V4 §25 — the gate itself. Returns the confirmed plan, or null if there is not one. */
export async function confirmedPlanFor(care_request_id) {
  const plans = await store.findMany('daily_care_plans', { care_request_id, status: 'CONFIRMED' });
  return plans[0] ?? null;
}

// ───────────────────────────────────────────── job request (V5 §6, §7)

export async function sendJobRequest({ care_request_id, caregiver_id, initiated_by = 'FAMILY' }) {
  const plan = await confirmedPlanFor(care_request_id);
  if (!plan) {
    // V4 §25 — blocked, with the exact message the spec prescribes, and without discarding the
    // caregiver the family had selected.
    const cr = await store.find('care_requests', care_request_id);
    await notifications.notify(
      'CARE_PLAN_REQUIRED',
      cr?.family_id,
      { caregiver_name: await notifications.caregiverName(caregiver_id) },
      { care_request_id, caregiver_id },
    );
    return {
      error: 'CARE_PLAN_REQUIRED',
      message: 'กรุณาสร้างและยืนยันรายการงานดูแลก่อนส่งคำขอไปยังผู้ดูแล',
      care_request_id,
      caregiver_id,
    };
  }

  const scored = await scorePair(care_request_id, caregiver_id);
  if (!scored) return { error: 'NOT_FOUND' };
  if (!scored.eligible && !scored.exceptional_match) {
    return { error: 'NOT_ELIGIBLE', failed_filters: scored.failed_filters };
  }

  const existing = await store.findOne('job_requests', { care_request_id, caregiver_id });
  if (existing && ['PENDING', 'VIEWED', 'ACCEPTED'].includes(existing.status)) {
    return { error: 'ALREADY_SENT', job_request: existing };
  }

  const cg = await store.find('caregiver_profiles', caregiver_id);
  const cost = scored.exceptional_match ? estimateAdditionalCost(cg, scored.distance_km) : null;

  const jobRequest = await store.insert('job_requests', {
    care_request_id,
    caregiver_id,
    care_plan_id: plan.id,
    initiated_by,
    status: 'PENDING',
    is_exceptional_distance: scored.exceptional_match,
    additional_cost_estimate: cost,
    accommodation_agreed: false,
    scores: {
      base_family_fit: scored.base_family_fit,
      base_job_fit: scored.base_job_fit,
      base_mutual_fit: scored.base_mutual_fit,
      final_mutual_fit: scored.final_mutual_fit,
    },
  });

  const cr = await store.find('care_requests', care_request_id);
  const blurb = await notifications.jobBlurb(cr);
  const refs = { care_request_id, caregiver_id, job_request_id: jobRequest.id };

  await notifications.notify('DIRECT_JOB_REQUEST', caregiver_id, blurb, refs);

  // An out-of-area request gets a second notification, because what the caregiver actually has to
  // decide is not the job — it is whether the travel and accommodation are worth it (V5 §21).
  if (scored.exceptional_match) {
    await notifications.notify(
      'EXCEPTIONAL_DISTANCE_REQUEST',
      caregiver_id,
      { distance_km: scored.distance_km, extra_cost: cost?.total_extra ?? 0 },
      refs,
    );
  }

  return jobRequest;
}

export async function markViewed(id) {
  const jr = await store.find('job_requests', id);
  if (!jr || jr.status !== 'PENDING') return jr;
  return store.update('job_requests', id, { status: 'VIEWED', viewed_at: new Date().toISOString() });
}

/**
 * V5 §7 — the acceptance summary.
 * Reasons are read straight out of the score breakdown. V5 §7 forbids inventing any reason that is
 * not backed by a computed feature, so every line here names the feature it came from.
 */
export function agreementReasons(scored) {
  const f = scored.feature_values.family;
  const j = scored.feature_values.job;
  const out = [];
  if (f.skill_match_score === 100) out.push({ reason: 'ทักษะที่จำเป็นครบทั้งหมด', feature: 'skill_match_score', value: f.skill_match_score });
  else if (f.skill_match_score != null) out.push({ reason: `ทักษะตรง ${Math.round(f.skill_match_score)}%`, feature: 'skill_match_score', value: f.skill_match_score });
  if (f.condition_experience_fit >= 50) out.push({ reason: 'เคยดูแลภาวะแบบเดียวกัน', feature: 'condition_experience_fit', value: f.condition_experience_fit });
  if (scored.distance_km != null) out.push({ reason: `อยู่ห่างประมาณ ${scored.distance_km} กม.`, feature: 'distance_km', value: scored.distance_km });
  if (j.schedule_preference_fit >= 60) out.push({ reason: 'เวลาอยู่ในช่วงที่คุณว่าง', feature: 'schedule_preference_fit', value: j.schedule_preference_fit });
  if (j.rate_fit === 100) out.push({ reason: 'ค่าตอบแทนตรงตามที่คุณตั้งไว้', feature: 'rate_fit', value: j.rate_fit });
  else if (j.minimum_rate_fit === 100) out.push({ reason: 'ค่าตอบแทนไม่ต่ำกว่าขั้นต่ำของคุณ', feature: 'minimum_rate_fit', value: j.minimum_rate_fit });
  if (j.job_type_preference_fit >= 80) out.push({ reason: 'ตรงกับประเภทงานที่คุณรับ', feature: 'job_type_preference_fit', value: j.job_type_preference_fit });
  if (j.physical_workload_fit >= 80) out.push({ reason: 'ภาระทางกายอยู่ในระดับที่คุณรับได้', feature: 'physical_workload_fit', value: j.physical_workload_fit });
  return out;
}

export async function acceptJobRequest(id, { note = null, accommodation_agreed = false } = {}) {
  const jr = await store.find('job_requests', id);
  if (!jr) return { error: 'NOT_FOUND' };
  if (jr.status === 'ACCEPTED') return { error: 'ALREADY_ACCEPTED', job_request: jr };

  const scored = await scorePair(jr.care_request_id, jr.caregiver_id);

  // V5 §26 case 8 — an exceptional booking needing accommodation cannot complete until the
  // accommodation has actually been agreed. The cost estimate alone is not an agreement.
  const agreed = accommodation_agreed || jr.accommodation_agreed;
  if (jr.is_exceptional_distance && jr.additional_cost_estimate?.accommodation_required && !agreed) {
    return {
      error: 'ACCOMMODATION_AGREEMENT_REQUIRED',
      message: 'งานนอกพื้นที่นี้ต้องมีข้อตกลงเรื่องที่พักก่อนจึงจะยืนยันได้',
      additional_cost_estimate: jr.additional_cost_estimate,
    };
  }

  const reasons = agreementReasons(scored);
  const updated = await store.update('job_requests', id, {
    status: 'ACCEPTED',
    responded_at: new Date().toISOString(),
    accommodation_agreed: agreed,
    agreement_reasons: reasons,
    caregiver_note: note,
  });

  const job = await store.insert('jobs', {
    job_request_id: id,
    care_request_id: jr.care_request_id,
    caregiver_id: jr.caregiver_id,
    status: 'SCHEDULED',
    current_state: 'NORMAL',
  });

  const thread = await ensureChatThread(jr.care_request_id, jr.caregiver_id, 'JOB_ACCEPTED');

  // Both sides are told, because acceptance means something different to each: the family gains a
  // caregiver and an open chat, the caregiver gains a scheduled shift (V5 §29, types 2 and 13).
  const cr = await store.find('care_requests', jr.care_request_id);
  const plan = jr.care_plan_id ? await store.find('daily_care_plans', jr.care_plan_id) : null;
  const planTasks = plan ? await store.findMany('daily_care_tasks', { care_plan_id: plan.id }) : [];
  const refs = {
    care_request_id: jr.care_request_id,
    caregiver_id: jr.caregiver_id,
    job_request_id: id,
    job_id: job.id,
    chat_thread_id: thread.id,
  };

  await notifications.notify(
    'CAREGIVER_ACCEPTED',
    cr?.family_id,
    {
      caregiver_name: await notifications.caregiverName(jr.caregiver_id),
      care_date: cr?.care_date,
      start_time: cr?.start_time,
      end_time: cr?.end_time,
    },
    refs,
  );
  await notifications.notify(
    'JOB_SCHEDULED',
    jr.caregiver_id,
    { ...(await notifications.jobBlurb(cr)), plan_items: planTasks.length },
    refs,
  );

  return { job_request: updated, job, chat_thread_id: thread.id, agreement_reasons: reasons };
}

export async function declineJobRequest(id, reason = null) {
  const jr = await store.find('job_requests', id);
  const updated = await store.update('job_requests', id, {
    status: 'DECLINED',
    responded_at: new Date().toISOString(),
    decline_reason: reason,
  });
  if (!jr) return updated;

  const cr = await store.find('care_requests', jr.care_request_id);
  await notifications.notify(
    'CAREGIVER_DECLINED',
    cr?.family_id,
    { caregiver_name: await notifications.caregiverName(jr.caregiver_id), reason },
    { care_request_id: jr.care_request_id, caregiver_id: jr.caregiver_id, job_request_id: id },
  );
  return updated;
}

// ───────────────────────────────────────────── chat (V4 §24, V5 §9)

export async function ensureChatThread(care_request_id, caregiver_id, unlocked_by) {
  const existing = await store.findOne('chat_threads', { care_request_id, caregiver_id });
  if (existing) return existing;
  return store.insert('chat_threads', { care_request_id, caregiver_id, unlocked_by });
}

/** Chat stays locked until the configured stage is reached (V4 §24). */
export async function chatUnlocked(care_request_id, caregiver_id) {
  if (ENV.chatUnlockStage === 'MUTUAL_MATCH') {
    const m = await store.findOne('mutual_matches', { care_request_id, caregiver_id });
    if (m) return true;
  }
  const jr = await store.findOne('job_requests', { care_request_id, caregiver_id });
  return jr?.status === 'ACCEPTED';
}

export async function postMessage({ thread_id, sender_role, body }) {
  const thread = await store.find('chat_threads', thread_id);
  if (!thread) return { error: 'NOT_FOUND' };
  if (!(await chatUnlocked(thread.care_request_id, thread.caregiver_id))) {
    return { error: 'CHAT_LOCKED', message: 'แชทจะเปิดเมื่อทั้งสองฝ่ายสนใจตรงกัน' };
  }
  const message = await store.insert('chat_messages', { thread_id, sender_role, body, is_system: false });

  // The message goes to whichever side did not send it. Only a short preview travels in the
  // notification; the message itself stays behind the thread's own access rules.
  const preview = String(body ?? '').slice(0, 80);
  const refs = {
    care_request_id: thread.care_request_id,
    caregiver_id: thread.caregiver_id,
    chat_thread_id: thread_id,
  };
  if (sender_role === 'CAREGIVER') {
    const cr = await store.find('care_requests', thread.care_request_id);
    await notifications.notify(
      'CHAT_MESSAGE_FROM_CAREGIVER',
      cr?.family_id,
      { caregiver_name: await notifications.caregiverName(thread.caregiver_id), preview },
      refs,
    );
  } else {
    await notifications.notify('CHAT_MESSAGE_FROM_FAMILY', thread.caregiver_id, { preview }, refs);
  }

  return message;
}

export async function listMessages(thread_id) {
  const msgs = await store.findMany('chat_messages', { thread_id });
  return msgs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// ───────────────────────────────────────────── report (V4 §32)

/**
 * Confirm an end-of-shift report, which is the moment it becomes something the family can read
 * (V4 §32) and therefore the moment they are told about it (V5 §29 type 7).
 *
 * It lives here rather than in the route because two routes and the Supabase smoke test all reach
 * this same step, and a notification that only fires down one of those paths is a notification
 * that will eventually go missing.
 */
export async function confirmReport(id, patch = {}) {
  const report = await store.update('care_reports', id, { confirmed: true, ...patch });
  if (!report) return null;
  await notifications.notifyReportReady(report);
  return report;
}

// ───────────────────────────────────────────── review & trust (V4 §33, §34)

export async function submitReview({ job_id, ...review }) {
  const job = await store.find('jobs', job_id);
  if (!job) return { error: 'NOT_FOUND' };
  if (job.status !== 'COMPLETED') return { error: 'JOB_NOT_COMPLETED' };

  const saved = await store.insert('family_reviews', { job_id, caregiver_id: job.caregiver_id, ...review });
  const trust = await recomputeTrust(job.caregiver_id);
  return { review: saved, trust };
}

export async function recomputeTrust(caregiver_id) {
  const cg = await store.find('caregiver_profiles', caregiver_id);
  if (!cg) return null;

  const reviews = await store.findMany('family_reviews', { caregiver_id });
  const incidents = await store.findMany('incidents', { caregiver_id });
  const jobs = await store.findMany('jobs', { caregiver_id, status: 'COMPLETED' });

  const ratings = reviews.map((r) => r.overall_rating).filter((n) => Number.isFinite(n));
  const meanRating = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : cg.mean_rating;
  const adherence = reviews.length
    ? (reviews.reduce((s, r) => s + (r.care_plan_adherence ?? 4), 0) / reviews.length) * 20
    : null;

  const result = computeTrustScore({
    reviewCount: reviews.length || cg.review_count || 0,
    meanRating,
    incidents,
    completedJobs: jobs.length || cg.completed_jobs || 0,
    onTimeCheckIns: jobs.length,
    checkIns: jobs.length,
    planAdherence: adherence,
    claimedSkills: cg.skills ?? [],
    verifiedCredentialSkills: (cg.certificates ?? []).filter((c) => c.verified).map((c) => c.credential_code),
  });

  await store.update('caregiver_profiles', caregiver_id, {
    final_trust_score: result.trust_score,
    trust_status: result.trust_status,
    review_count: reviews.length || cg.review_count,
    completed_jobs: jobs.length || cg.completed_jobs,
    confirmed_incident_count: result.penalised_incidents,
  });
  await store.insert('trust_score_snapshots', {
    caregiver_id,
    trust_score: result.trust_score,
    components: result.components,
    trust_status: result.trust_status,
    trust_version: ENV.trustVersion,
  });

  return result;
}

/** Admin action — only a confirmed, attributed incident may reduce trust (V4 §34, V6 F01/F02). */
export async function confirmIncident(id, { responsibility, confirmed_by = null }) {
  const inc = await store.update('incidents', id, {
    status: 'CONFIRMED',
    responsibility,
    confirmed_by,
    confirmed_at: new Date().toISOString(),
  });
  if (!inc) return { error: 'NOT_FOUND' };
  const trust = await recomputeTrust(inc.caregiver_id);
  return { incident: inc, trust };
}
