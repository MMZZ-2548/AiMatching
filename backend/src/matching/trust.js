/**
 * Trust Score — V4 §34, with the cold-start formula defined in SCORING_SPEC §10.
 *
 * Explainable and deterministic; GPT never computes or adjusts it (V4 §4).
 * The penalty gate is the important part: an incident lowers trust only when it is CONFIRMED
 * *and* attributed to the caregiver. Unconfirmed alerts, GPS noise and geofence exits never do
 * (V4 §34, V6 F01) — the whole point is that a monitoring signal is not evidence.
 */

import { TRUST } from './config.js';

const clamp = (v) => Math.min(100, Math.max(0, v));

/**
 * Bayesian shrinkage toward the platform prior, so a single glowing review cannot mint a
 * perfect score (V6 F04 requires exactly this behaviour).
 */
export function shrunkReviewScore(reviewCount, meanRating) {
  const n = Number(reviewCount ?? 0);
  const k = TRUST.shrinkageK;
  if (n === 0) return TRUST.priorRating * 20;
  const mean = Number(meanRating ?? TRUST.priorRating);
  return ((n * mean + k * TRUST.priorRating) / (n + k)) * 20;
}

export function behaviorReliability({ completedJobs = 0, onTimeCheckIns = 0, checkIns = 0, planAdherence = null }) {
  if (completedJobs === 0) return TRUST.priorRating * 20; // same neutral prior as reviews
  const punctuality = checkIns > 0 ? (onTimeCheckIns / checkIns) * 100 : 70;
  const adherence = planAdherence != null ? planAdherence : 70;
  return clamp(0.5 * punctuality + 0.5 * adherence);
}

export function credentialScore({ claimedSkills = [], verifiedCredentialSkills = [] }) {
  if (claimedSkills.length === 0) return 100;
  const verified = new Set(verifiedCredentialSkills);
  return clamp((claimedSkills.filter((s) => verified.has(s)).length / claimedSkills.length) * 100);
}

/** Only CONFIRMED + CAREGIVER_RESPONSIBLE incidents count (V4 §34). */
export function countPenalisedIncidents(incidents = []) {
  return incidents.filter(
    (i) => i.status === 'CONFIRMED' && i.responsibility === 'CAREGIVER_RESPONSIBLE',
  ).length;
}

export function incidentComponent(incidents = []) {
  return clamp(100 - TRUST.incidentPenaltyEach * countPenalisedIncidents(incidents));
}

export function computeTrustScore(input) {
  const {
    reviewCount = 0,
    meanRating = null,
    incidents = [],
    completedJobs = 0,
    onTimeCheckIns = 0,
    checkIns = 0,
    planAdherence = null,
    claimedSkills = [],
    verifiedCredentialSkills = [],
  } = input;

  const components = {
    behavior_reliability: behaviorReliability({ completedJobs, onTimeCheckIns, checkIns, planAdherence }),
    family_review: shrunkReviewScore(reviewCount, meanRating),
    credential: credentialScore({ claimedSkills, verifiedCredentialSkills }),
    incident: incidentComponent(incidents),
  };

  const w = TRUST.weights;
  const trust_score = clamp(
    w.behavior * components.behavior_reliability +
      w.review * components.family_review +
      w.credential * components.credential +
      w.incident * components.incident,
  );

  return {
    trust_score: Math.round(trust_score * 100) / 100,
    components,
    trust_status: completedJobs >= TRUST.establishedAfterJobs ? 'ESTABLISHED' : 'NEW',
    // V4 §34 cold-start copy; the score is still used, only labelled
    cold_start_note: completedJobs >= TRUST.establishedAfterJobs ? null : 'ข้อมูลยังไม่เพียงพอ',
    penalised_incidents: countPenalisedIncidents(incidents),
    trust_version: TRUST.version ?? (process.env.TRUST_SCORE_VERSION ?? 'trust-v4'),
  };
}
