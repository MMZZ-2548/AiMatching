/**
 * Score assembly — SCORING_SPEC §3 (buckets), §4/§5 (base), §6 (mutual), §7 (distance reintegration).
 *
 * Pure arithmetic. No LLM touches any number here (V4 §0, §4).
 */

import {
  FAMILY_FEATURE_BUCKETS,
  JOB_FEATURE_BUCKETS,
  FAMILY_BASE_WEIGHTS,
  JOB_BASE_WEIGHTS,
  FAMILY_DISTANCE_BUCKET,
  JOB_DISTANCE_BUCKET,
  FAMILY_DISTANCE_SHARE,
  JOB_DISTANCE_SHARE,
  MUTUAL_FAMILY_WEIGHT,
  MUTUAL_JOB_WEIGHT,
  NEUTRAL,
} from './config.js';

/**
 * Collapse features into buckets by mean of the applicable members.
 * A bucket whose members are all inapplicable is itself inapplicable and is excluded from the
 * weighted sum, with the remaining weights renormalised — so a request that says nothing about,
 * say, language never dilutes the score with a phantom zero.
 */
export function toBuckets(features, mapping) {
  const acc = {};
  for (const [feature, value] of Object.entries(features)) {
    const bucket = mapping[feature];
    if (!bucket || value == null || !isFinite(value)) continue;
    (acc[bucket] ??= []).push(value);
  }
  const out = {};
  for (const [bucket, vals] of Object.entries(acc)) {
    out[bucket] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  return out;
}

/** Weighted sum over the buckets that have values, renormalised across those weights. */
export function weightedScore(buckets, weights) {
  let num = 0;
  let den = 0;
  for (const [bucket, weight] of Object.entries(weights)) {
    const v = buckets[bucket];
    if (v == null) continue;
    num += v * weight;
    den += weight;
  }
  return den === 0 ? NEUTRAL : num / den;
}

/**
 * @returns full score breakdown for one (care_request, caregiver) pair.
 */
export function computeScores(familyFeatureValues, jobFeatureValues) {
  const familyBuckets = toBuckets(familyFeatureValues, FAMILY_FEATURE_BUCKETS);
  const jobBuckets = toBuckets(jobFeatureValues, JOB_FEATURE_BUCKETS);

  // ── base: distance excluded, remaining weights renormalised to 100 (SCORING_SPEC §4, §5)
  const base_family_fit = weightedScore(familyBuckets, FAMILY_BASE_WEIGHTS);
  const base_job_fit = weightedScore(jobBuckets, JOB_BASE_WEIGHTS);
  const base_mutual_fit =
    MUTUAL_FAMILY_WEIGHT * base_family_fit + MUTUAL_JOB_WEIGHT * base_job_fit;

  // ── final: distance re-enters at its original V4 weight (SCORING_SPEC §7)
  const familyDistance = familyBuckets[FAMILY_DISTANCE_BUCKET];
  const jobDistance = jobBuckets[JOB_DISTANCE_BUCKET];

  const final_family_fit =
    familyDistance == null
      ? base_family_fit
      : (1 - FAMILY_DISTANCE_SHARE) * base_family_fit + FAMILY_DISTANCE_SHARE * familyDistance;
  const final_job_fit =
    jobDistance == null
      ? base_job_fit
      : (1 - JOB_DISTANCE_SHARE) * base_job_fit + JOB_DISTANCE_SHARE * jobDistance;
  const final_mutual_fit =
    MUTUAL_FAMILY_WEIGHT * final_family_fit + MUTUAL_JOB_WEIGHT * final_job_fit;

  return {
    base_family_fit,
    base_job_fit,
    base_mutual_fit,
    final_family_fit,
    final_job_fit,
    final_mutual_fit,
    familyBuckets,
    jobBuckets,
  };
}

export const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
