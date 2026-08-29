/**
 * Matching engine — the single entry point for both directions.
 *
 *   matchCaregiversForRequest()  Family → Caregiver   (V4 §22, V5 §3)
 *   matchJobsForCaregiver()      Caregiver → Job      (V4 §23, V5 §4)
 *
 * Both directions run the identical pipeline and produce identical scores for a given pair —
 * V5 §1 requires each side to see both fit numbers, so the same pair must never disagree
 * depending on who asked. The only difference is what gets ranked.
 *
 * Deterministic: same inputs ⇒ same output, always (V4 §50).
 */

import { runHardFilters, SOFT_FILTER } from './hardFilters.js';
import { familyFeatures, jobFeatures } from './features.js';
import { computeScores, round2 } from './score.js';
import { evaluateExceptional, estimateAdditionalCost } from './exceptional.js';
import { SCORE_VERSION, WEIGHT_VERSION } from './config.js';

/**
 * Score one pair, all the way through. Shared by both directions.
 */
export function evaluatePair(careRequest, caregiver, ctx = {}) {
  const filters = runHardFilters(careRequest, caregiver, ctx);
  const { travel } = filters;

  const pairHistory = ctx.pairHistoryFor?.(careRequest, caregiver) ?? ctx.pairHistory ?? {};
  const fFeatures = familyFeatures(careRequest, caregiver, travel, { pairHistory });
  const jFeatures = jobFeatures(careRequest, caregiver, travel, { pairHistory });
  const scores = computeScores(fFeatures, jFeatures);

  let exceptional = { exceptional: false, reasons: [], blockers: [] };
  let additional_cost_estimate = null;

  if (!filters.eligible && filters.failed.includes(SOFT_FILTER)) {
    exceptional = evaluateExceptional({
      failed: filters.failed,
      baseMutualFit: scores.base_mutual_fit,
      distanceKm: travel.distance_km,
      caregiver,
      careRequest,
    });
    if (exceptional.exceptional) {
      additional_cost_estimate = estimateAdditionalCost(caregiver, travel.distance_km);
    }
  }

  const bucket = filters.eligible
    ? 'RECOMMENDED_NEARBY'
    : exceptional.exceptional
      ? 'EXCEPTIONAL'
      : 'FILTERED_OUT';

  return {
    care_request_id: careRequest.id,
    caregiver_id: caregiver.id,
    eligible: filters.eligible,
    failed_filters: filters.failed,
    hard_filter_results: filters.results,

    base_family_fit: round2(scores.base_family_fit),
    base_job_fit: round2(scores.base_job_fit),
    base_mutual_fit: round2(scores.base_mutual_fit),
    final_family_fit: round2(scores.final_family_fit),
    final_job_fit: round2(scores.final_job_fit),
    final_mutual_fit: round2(scores.final_mutual_fit),

    distance_km: round2(travel.distance_km),
    travel_minutes: travel.travel_minutes == null ? null : Math.round(travel.travel_minutes),
    travel_source: travel.source,
    service_radius_km: Number(caregiver.service_radius_km),

    bucket,
    exceptional_match: exceptional.exceptional,
    exceptional_reasons: exceptional.reasons,
    exceptional_blockers: exceptional.blockers,
    additional_cost_estimate,

    feature_values: { family: fFeatures, job: jFeatures },
    bucket_values: { family: scores.familyBuckets, job: scores.jobBuckets },
    score_version: SCORE_VERSION,
    weight_version: WEIGHT_VERSION,
  };
}

/**
 * Rank by distance-adjusted score. Ties break on base score, then on id, so the ordering is
 * total and reproducible across runs (V4 §50 requires determinism).
 */
function rankDescending(list, key) {
  return [...list].sort(
    (a, b) =>
      (b[key] ?? -1) - (a[key] ?? -1) ||
      (b.base_mutual_fit ?? -1) - (a.base_mutual_fit ?? -1) ||
      String(a.caregiver_id).localeCompare(String(b.caregiver_id)),
  );
}

function bucketise(evaluated) {
  const nearby = rankDescending(
    evaluated.filter((c) => c.bucket === 'RECOMMENDED_NEARBY'),
    'final_mutual_fit',
  );
  // Exceptional candidates are ranked among themselves and returned as a separate list. They are
  // never merged into the normal ranking — V5 §19 is explicit that a far candidate must not
  // become normal rank #1 no matter how well it scores.
  const exceptional = rankDescending(
    evaluated.filter((c) => c.bucket === 'EXCEPTIONAL'),
    'base_mutual_fit',
  );
  const filtered = evaluated.filter((c) => c.bucket === 'FILTERED_OUT');

  nearby.forEach((c, i) => (c.rank_in_bucket = i + 1));
  exceptional.forEach((c, i) => (c.rank_in_bucket = i + 1));

  return { recommended_nearby: nearby, exceptional_matches: exceptional, filtered_out: filtered };
}

/** Family → Caregiver (V4 §22). */
export function matchCaregiversForRequest(careRequest, caregivers, ctx = {}) {
  const started = Date.now();
  const evaluated = caregivers.map((cg) => evaluatePair(careRequest, cg, ctx));
  const result = bucketise(evaluated);
  return {
    direction: 'FAMILY_TO_CAREGIVER',
    care_request_id: careRequest.id,
    score_version: SCORE_VERSION,
    weight_version: WEIGHT_VERSION,
    runtime_ms: Date.now() - started,
    candidate_count: evaluated.length,
    ...result,
  };
}

/**
 * Caregiver → Job (V4 §23, V5 §4).
 * Visibility is applied before scoring: PRIVATE requests are only reachable through a direct
 * job request, and MATCHED_ONLY requires the caregiver to have survived the hard filters
 * (V5 §17). Cold-messaging a family with no care request is impossible by construction.
 */
export function matchJobsForCaregiver(caregiver, careRequests, ctx = {}) {
  const started = Date.now();
  const directRequestIds = new Set(ctx.directRequestIds ?? []);

  const visible = careRequests.filter((cr) => {
    if (cr.status !== 'CONFIRMED') return false;
    if (cr.visibility === 'OPEN_TO_CAREGIVERS') return true;
    if (cr.visibility === 'PRIVATE') return directRequestIds.has(cr.id);
    return true; // MATCHED_ONLY — decided by the hard filters below
  });

  const evaluated = visible.map((cr) => evaluatePair(cr, caregiver, ctx));

  // MATCHED_ONLY: a request the caregiver did not qualify for stays invisible to them,
  // rather than appearing in a "filtered out" list that would leak the family's existence.
  const byId = new Map(visible.map((cr) => [cr.id, cr]));
  const permitted = evaluated.filter((c) => {
    const cr = byId.get(c.care_request_id);
    if (cr.visibility !== 'MATCHED_ONLY') return true;
    return c.eligible || c.exceptional_match;
  });

  const result = bucketise(permitted);
  const rankJobs = (list) => list.map((c, i) => ({ ...c, rank_in_bucket: i + 1 }));

  return {
    direction: 'CAREGIVER_TO_JOB',
    caregiver_id: caregiver.id,
    score_version: SCORE_VERSION,
    weight_version: WEIGHT_VERSION,
    runtime_ms: Date.now() - started,
    candidate_count: permitted.length,
    recommended_nearby: rankJobs(
      rankDescending(result.recommended_nearby, 'final_job_fit'),
    ),
    exceptional_matches: rankJobs(result.exceptional_matches),
    filtered_out: result.filtered_out,
  };
}
