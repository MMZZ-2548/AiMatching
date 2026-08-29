/**
 * Matching configuration — every constant the engine uses.
 * Normative source: docs/SCORING_SPEC.md (which reconciles V4 §14-§20, V5 §19-§27, V6 §6-§11).
 *
 * Nothing here is learned. All weights are configurable and versioned (V4 §18).
 */

export const SCORE_VERSION = process.env.MATCHING_SCORE_VERSION ?? 'matching-v4';
export const WEIGHT_VERSION = process.env.WEIGHT_PROFILE_VERSION ?? 'weights-v4-default';
export const TRUST_VERSION = process.env.TRUST_SCORE_VERSION ?? 'trust-v4';

/** V4 §18 — Family Fit buckets, as authored. Sums to 100. */
export const FAMILY_WEIGHTS_V4 = {
  skill_match: 20,
  experience_condition_fit: 15,
  schedule_fit: 12,
  distance_travel_fit: 10,
  trust_history: 10,
  task_expectation_fit: 8,
  mobility_physical_fit: 7,
  budget_rate_fit: 5,
  language_communication_fit: 5,
  continuity_fit: 4,
  care_style_preference_fit: 4,
};

/** V4 §19 — Caregiver Job Fit buckets, as authored. Sums to 100. */
export const JOB_WEIGHTS_V4 = {
  rate_fit: 20,
  schedule_preference_fit: 18,
  travel_burden_fit: 15,
  job_type_preference_fit: 15,
  physical_workload_fit: 12,
  continuity_preference_fit: 8,
  shift_length_fit: 5,
  transport_hospital_fit: 4,
  environment_fit: 3,
};

/**
 * The distance buckets are excluded from the *base* scores and reintegrated afterwards
 * (SCORING_SPEC §4, §5, §7). This is the one structural change to V4, made because V5 §20.3
 * tests the exceptional threshold against the score "ก่อน distance penalty" — impossible if
 * distance is baked in. V4's weights themselves are untouched.
 */
export const FAMILY_DISTANCE_BUCKET = 'distance_travel_fit';
export const JOB_DISTANCE_BUCKET = 'travel_burden_fit';

/** Renormalise the non-distance buckets back to 100. */
function renormalise(weights, excludeKey) {
  const kept = Object.entries(weights).filter(([k]) => k !== excludeKey);
  const total = kept.reduce((s, [, v]) => s + v, 0);
  return Object.fromEntries(kept.map(([k, v]) => [k, (v * 100) / total]));
}

export const FAMILY_BASE_WEIGHTS = renormalise(FAMILY_WEIGHTS_V4, FAMILY_DISTANCE_BUCKET);
export const JOB_BASE_WEIGHTS = renormalise(JOB_WEIGHTS_V4, JOB_DISTANCE_BUCKET);

/** Share the distance bucket reclaims when reintegrated (SCORING_SPEC §7). */
export const FAMILY_DISTANCE_SHARE = FAMILY_WEIGHTS_V4[FAMILY_DISTANCE_BUCKET] / 100; // 0.10
export const JOB_DISTANCE_SHARE = JOB_WEIGHTS_V4[JOB_DISTANCE_BUCKET] / 100;          // 0.15

/** V4 §20 — Mutual Fit. Family-weighted by design; see SCORING_SPEC §6. */
export const MUTUAL_FAMILY_WEIGHT = Number(process.env.MUTUAL_FAMILY_WEIGHT ?? 0.6);
export const MUTUAL_JOB_WEIGHT = Number(process.env.MUTUAL_JOB_WEIGHT ?? 0.4);

/**
 * SCORING_SPEC §3 — feature → bucket. Every feature named in V4 §15/§16 and V6 §7/§8
 * lands in exactly one bucket. A bucket scores the mean of its *applicable* members;
 * a non-applicable feature is dropped, not scored zero (V4 §41.20 — unknown optional
 * field is neutral, and zeroing it would be a silent penalty).
 */
export const FAMILY_FEATURE_BUCKETS = {
  skill_match_score: 'skill_match',
  skill_level_fit: 'skill_match',
  experience_match: 'experience_condition_fit',
  condition_experience_fit: 'experience_condition_fit',
  schedule_fit: 'schedule_fit',
  distance_fit: 'distance_travel_fit',
  travel_time_fit: 'distance_travel_fit',
  trust_history_score: 'trust_history',
  previous_successful_match: 'trust_history',
  task_expectation_fit: 'task_expectation_fit',
  personal_care_compatibility: 'task_expectation_fit',
  mobility_support_fit: 'mobility_physical_fit',
  physical_workload_fit: 'mobility_physical_fit',
  transport_fit: 'mobility_physical_fit',
  budget_rate_fit: 'budget_rate_fit',
  language_match: 'language_communication_fit',
  communication_style_fit: 'language_communication_fit',
  continuity_fit: 'continuity_fit',
  care_style_fit: 'care_style_preference_fit',
  caregiver_preference_fit: 'care_style_preference_fit',
};

export const JOB_FEATURE_BUCKETS = {
  rate_fit: 'rate_fit',
  minimum_rate_fit: 'rate_fit',
  schedule_preference_fit: 'schedule_preference_fit',
  day_night_preference_fit: 'schedule_preference_fit',
  recurring_schedule_fit: 'schedule_preference_fit',
  travel_burden_fit: 'travel_burden_fit',
  travel_compensation_fit: 'travel_burden_fit',
  location_preference_fit: 'travel_burden_fit',
  job_type_preference_fit: 'job_type_preference_fit',
  caregiver_task_preference_fit: 'job_type_preference_fit',
  caregiver_condition_preference_fit: 'job_type_preference_fit',
  caregiver_priority_fit: 'job_type_preference_fit',
  physical_workload_fit: 'physical_workload_fit',
  lifting_transfer_fit: 'physical_workload_fit',
  continuity_preference_fit: 'continuity_preference_fit',
  work_duration_fit: 'continuity_preference_fit',
  shift_length_fit: 'shift_length_fit',
  hospital_escort_fit: 'transport_hospital_fit',
  transport_fit: 'transport_hospital_fit',
  environment_fit: 'environment_fit',
};

/** V5 §20 — exceptional far match. */
export const EXCEPTIONAL = {
  enabled: (process.env.EXCEPTIONAL_MATCH_ENABLED ?? 'true') === 'true',
  baseFitThreshold: Number(process.env.EXCEPTIONAL_BASE_FIT_THRESHOLD ?? 90),
  mandatorySkillsRequired: (process.env.EXCEPTIONAL_MANDATORY_SKILLS_REQUIRED ?? 'true') === 'true',
  maxDistanceKm: Number(process.env.EXCEPTIONAL_MAX_DISTANCE_KM ?? 300),
  requireCaregiverOptIn: (process.env.EXCEPTIONAL_REQUIRE_CAREGIVER_OPT_IN ?? 'true') === 'true',
  requireFamilyOptIn: (process.env.EXCEPTIONAL_REQUIRE_FAMILY_OPT_IN ?? 'true') === 'true',
};

/** Config decisions the source documents left open — locked in SCORING_SPEC §2. */
export const POLICY = {
  budgetBelowMinimum: process.env.BUDGET_BELOW_MINIMUM_POLICY ?? 'FILTER', // FILTER | NEGOTIATION
  verificationPending: 'FILTER_OUT',
  chatUnlockStage: process.env.CHAT_UNLOCK_STAGE ?? 'MUTUAL_MATCH',
};

/** V4 §34 — Trust Score. */
export const TRUST = {
  weights: { behavior: 0.5, review: 0.3, credential: 0.1, incident: 0.1 },
  shrinkageK: 5,
  priorRating: 3.5,
  incidentPenaltyEach: 25,
  establishedAfterJobs: 3,
};

/** Neutral score for a feature with no data — never 0, which would be a hidden penalty. */
export const NEUTRAL = 50;
