/**
 * Matching orchestration — turns stored rows into engine inputs, persists the run, and returns the
 * V5 §27 result shape.
 *
 * The engine itself is pure (backend/src/matching/*). This layer only fetches, adapts and stores,
 * so the numbers a benchmark produces and the numbers the API returns come from the same code.
 */

import { store } from '../store/index.js';
import { matchCaregiversForRequest, matchJobsForCaregiver, evaluatePair } from '../matching/engine.js';
import { ENV } from '../lib/env.js';
import { approximate } from '../lib/location.js';
import { estimateAdditionalCost } from '../matching/exceptional.js';
import * as notifications from './notifications.js';

/**
 * Accepted jobs become busy intervals, which is what the double-booking filter reads.
 *
 * Two exclusions matter. A job for the request currently being matched must not count, or
 * re-running matching for a request would filter out the very caregiver already doing it.
 * A finished or cancelled job holds no capacity either — only SCHEDULED and IN_PROGRESS do.
 */
async function busyIntervals(excludeCareRequestId = null) {
  const jobs = await store.findMany('jobs', {});
  const out = [];
  for (const j of jobs) {
    if (!['SCHEDULED', 'IN_PROGRESS'].includes(j.status)) continue;
    if (excludeCareRequestId && j.care_request_id === excludeCareRequestId) continue;
    const cr = await store.find('care_requests', j.care_request_id);
    if (!cr) continue;
    out.push({
      caregiver_id: j.caregiver_id,
      care_date: cr.care_date,
      start_time: cr.start_time,
      end_time: cr.end_time,
    });
  }
  return out;
}

/** Prior completed work between this family and this caregiver (V4 §41.17, V6 F03). */
async function pairHistoryLookup() {
  const jobs = await store.findMany('jobs', { status: 'COMPLETED' });
  const reviews = await store.findMany('family_reviews', {});
  const reviewByJob = new Map(reviews.map((r) => [r.job_id, r]));
  const map = new Map();
  for (const j of jobs) {
    const cr = await store.find('care_requests', j.care_request_id);
    if (!cr) continue;
    const key = `${cr.family_id}|${j.caregiver_id}`;
    const prev = map.get(key) ?? { completed_jobs: 0, would_rebook: false };
    prev.completed_jobs += 1;
    if (reviewByJob.get(j.id)?.would_rebook) prev.would_rebook = true;
    map.set(key, prev);
  }
  return (careRequest, caregiver) => map.get(`${careRequest.family_id}|${caregiver.id}`) ?? {};
}

async function buildContext(excludeCareRequestId = null) {
  return {
    busy: await busyIntervals(excludeCareRequestId),
    pairHistoryFor: await pairHistoryLookup(),
  };
}

async function persistRun(direction, result, { careRequestId = null, caregiverId = null }) {
  const run = await store.insert('matching_runs', {
    care_request_id: careRequestId,
    caregiver_id: caregiverId,
    direction,
    score_version: ENV.scoreVersion,
    weight_version: ENV.weightVersion,
    candidate_count: result.candidate_count,
    runtime_ms: result.runtime_ms,
  });

  const all = [...result.recommended_nearby, ...result.exceptional_matches, ...result.filtered_out];
  for (const c of all) {
    await store.insert('matching_candidates', {
      matching_run_id: run.id,
      care_request_id: c.care_request_id,
      caregiver_id: c.caregiver_id,
      eligible: c.eligible,
      failed_filters: c.failed_filters,
      base_family_fit: c.base_family_fit,
      base_job_fit: c.base_job_fit,
      base_mutual_fit: c.base_mutual_fit,
      final_family_fit: c.final_family_fit,
      final_job_fit: c.final_job_fit,
      final_mutual_fit: c.final_mutual_fit,
      distance_km: c.distance_km,
      travel_minutes: c.travel_minutes,
      bucket: c.bucket,
      exceptional_match: c.exceptional_match,
      additional_cost_estimate: c.additional_cost_estimate,
      rank_in_bucket: c.rank_in_bucket ?? null,
      feature_values: c.feature_values,
      bucket_values: c.bucket_values,
      hard_filter_results: c.hard_filter_results,
    });
  }
  return run;
}

/** Family → Caregiver (V4 §22, V5 §3). */
export async function runMatchingForRequest(careRequestId) {
  const careRequest = await store.find('care_requests', careRequestId);
  if (!careRequest) return null;
  const caregivers = await store.findMany('caregiver_profiles', {});
  const ctx = await buildContext(careRequestId);

  const result = matchCaregiversForRequest(careRequest, caregivers, ctx);
  const run = await persistRun('FAMILY_TO_CAREGIVER', result, { careRequestId });
  await announceRun(careRequest, result, caregivers);

  return { matching_run_id: run.id, ...result, ...(await decorate(result)) };
}

/**
 * The two notifications a matching run produces (V5 §29, types 4 and 8).
 *
 * The caregivers who came out of the run are told a job matches them, and the family is told
 * separately about any exceptional far candidate — separately because that one is a decision about
 * money and travel, not a ranking, and it must never arrive looking like an ordinary top result.
 *
 * Both are raised once per pair. A family reloading their results is not a new event.
 */
async function announceRun(careRequest, result, caregivers) {
  // A private request is being drafted, not offered. Nobody is told about it.
  if (careRequest.visibility === 'PRIVATE') return;

  const blurb = await notifications.jobBlurb(careRequest);
  const byId = new Map(caregivers.map((c) => [c.id, c]));

  for (const candidate of result.recommended_nearby ?? []) {
    await notifications.notifyOnce('NEW_MATCHING_JOB', candidate.caregiver_id, blurb, {
      care_request_id: careRequest.id,
      caregiver_id: candidate.caregiver_id,
    });
  }

  for (const candidate of result.exceptional_matches ?? []) {
    const extra = estimateAdditionalCost(byId.get(candidate.caregiver_id), candidate.distance_km ?? 0);
    await notifications.notifyOnce(
      'NEW_EXCEPTIONAL_CANDIDATE',
      careRequest.family_id,
      {
        caregiver_name: await notifications.caregiverName(candidate.caregiver_id),
        base_mutual_fit: candidate.base_mutual_fit,
        distance_km: candidate.distance_km,
        extra_cost: extra?.total_extra ?? 0,
      },
      { care_request_id: careRequest.id, caregiver_id: candidate.caregiver_id },
    );
  }
}

/** Caregiver → Job (V4 §23, V5 §4). */
export async function runRecommendedJobs(caregiverId) {
  const caregiver = await store.find('caregiver_profiles', caregiverId);
  if (!caregiver) return null;
  const careRequests = await store.findMany('care_requests', {});
  const direct = (await store.findMany('job_requests', { caregiver_id: caregiverId })).map(
    (j) => j.care_request_id,
  );
  const ctx = { ...(await buildContext()), directRequestIds: direct };

  const result = matchJobsForCaregiver(caregiver, careRequests, ctx);
  const run = await persistRun('CAREGIVER_TO_JOB', result, { caregiverId });

  return { matching_run_id: run.id, ...result, ...(await decorate(result, { caregiverView: true })) };
}

/**
 * Attach the display fields each side's card needs (V5 §3, §4). The caregiver's view of a family
 * job gets the privacy-safe summary only — V4 §23 and V5 §4 both forbid exposing detailed health
 * data before there is any relationship.
 */
async function decorate(result, { caregiverView = false } = {}) {
  const enrich = async (list) =>
    Promise.all(
      list.map(async (c) => {
        const cg = await store.find('caregiver_profiles', c.caregiver_id);
        const cr = await store.find('care_requests', c.care_request_id);
        return {
          ...c,
          caregiver: cg ? publicCaregiver(cg) : null,
          job: cr ? (caregiverView ? privacySafeJob(cr, await store.find('elderly_profiles', cr.elderly_id)) : publicJob(cr)) : null,
        };
      }),
    );
  return {
    recommended_nearby: await enrich(result.recommended_nearby),
    exceptional_matches: await enrich(result.exceptional_matches),
    filtered_out: result.filtered_out.map((c) => ({
      caregiver_id: c.caregiver_id,
      care_request_id: c.care_request_id,
      failed_filters: c.failed_filters,
      exceptional_blockers: c.exceptional_blockers,
    })),
  };
}

export function publicCaregiver(cg) {
  return {
    id: cg.id,
    display_name: cg.display_name,
    gender: cg.gender,
    years_experience: cg.years_experience,
    skills: cg.skills,
    skill_levels: cg.skill_levels,
    languages: cg.languages,
    verification_status: cg.verification_status,
    expected_rate: cg.expected_rate,
    minimum_rate: cg.minimum_rate,
    service_radius_km: cg.service_radius_km,
    transport_mode: cg.transport_mode,
    final_trust_score: cg.final_trust_score,
    trust_status: cg.trust_status,
    completed_jobs: cg.completed_jobs,
    review_count: cg.review_count,
    out_of_area_enabled: cg.out_of_area_enabled,
  };
}

function publicJob(cr) {
  return {
    id: cr.id,
    care_date: cr.care_date,
    start_time: cr.start_time,
    end_time: cr.end_time,
    budget: cr.budget,
    visibility: cr.visibility,
    scenario: cr.scenario ?? null,
  };
}

/**
 * V4 §23 / V5 §4 — what a caregiver may see about a job before any relationship exists.
 * Deliberately omits address, allergies, medical devices, emergency contact, free-text notes and
 * exact coordinates; district and province only, and only the conditions relevant to the work.
 */
export function privacySafeJob(cr, elderly) {
  return {
    id: cr.id,
    care_date: cr.care_date,
    start_time: cr.start_time,
    end_time: cr.end_time,
    budget: cr.budget,
    visibility: cr.visibility,
    scenario: cr.scenario ?? null,
    area: elderly ? [elderly.district, elderly.province].filter(Boolean).join(', ') || 'ยะลา' : null,
    // An area, never the address — the exact pin is disclosed only after acceptance (lib/location.js).
    location: approximate(cr.latitude, cr.longitude),
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
    continuity: cr.continuity_preference,
  };
}

/** V4 §39 TAB 4 / V5 §28 — full breakdown for one pair, for the Matching Debug page. */
export async function debugPair(careRequestId, caregiverId) {
  const careRequest = await store.find('care_requests', careRequestId);
  const caregiver = await store.find('caregiver_profiles', caregiverId);
  if (!careRequest || !caregiver) return null;
  const ctx = await buildContext();
  return {
    care_request: careRequest,
    caregiver: publicCaregiver(caregiver),
    ...evaluatePair(careRequest, caregiver, ctx),
  };
}
