/**
 * Feature extraction — every feature named in V4 §15 (family) and V4 §16 (caregiver job).
 *
 * Each function returns a number in 0..100, or `null` when the feature does not apply to this
 * request. `null` means "drop from the bucket mean", never "score zero": V4 §41.20 requires an
 * unknown optional field to be neutral, and zeroing it would be a silent penalty. Callers that
 * need an explicit neutral use NEUTRAL (50).
 */

import { NEUTRAL } from './config.js';
import { distanceFit, travelTimeFit } from './geo.js';

const clamp = (v) => Math.min(100, Math.max(0, v));
const pct = (n, d) => (d === 0 ? null : clamp((n / d) * 100));

const MOBILITY_RANK = {
  INDEPENDENT: 0,
  SUPERVISION: 1,
  WALKING_ASSIST: 2,
  TRANSFER_ASSIST: 3,
  WHEELCHAIR: 4,
  BEDBOUND: 5,
};

/** Requirement strengths carry different pull on soft scores (V4 §17). */
const STRENGTH_WEIGHT = { MANDATORY: 3, IMPORTANT: 2, NICE_TO_HAVE: 1, NOT_IMPORTANT: 0 };

const reqsOf = (cr, type) => (cr.requirements ?? []).filter((r) => r.requirement_type === type);

/** Weighted coverage of a requirement list against a possessed set. */
function coverage(reqs, owned) {
  const have = new Set(owned ?? []);
  let num = 0;
  let den = 0;
  for (const r of reqs) {
    const w = STRENGTH_WEIGHT[r.strength] ?? 1;
    den += w;
    if (have.has(r.requirement_code)) num += w;
  }
  return den === 0 ? null : clamp((num / den) * 100);
}

// ───────────────────────────────────────────────────────── family side

export function familyFeatures(careRequest, caregiver, travel, ctx = {}) {
  const f = {};
  const skillReqs = reqsOf(careRequest, 'SKILL');

  f.skill_match_score = coverage(skillReqs, caregiver.skills);

  // How far each held skill exceeds (or falls short of) the requested level. Same shape as
  // experience_match: meeting the bar scores 80, and depth above it earns the rest — clamping at
  // the bar would rate a level-5 caregiver identically to a level-2 one on a level-2 request.
  const levels = caregiver.skill_levels ?? {};
  const levelled = skillReqs.filter((r) => r.minimum_level != null);
  f.skill_level_fit = levelled.length
    ? levelled.reduce((s, r) => s + levelDepth(levels[r.requirement_code] ?? 0, r.minimum_level), 0) /
      levelled.length
    : null;

  // Years of experience against the family's stated minimum. Meeting the bar scores 80 and
  // exceeding it earns the rest with diminishing returns (100 at three times the minimum) —
  // a hard clamp at the bar would make a 12-year veteran indistinguishable from a 2-year one.
  f.experience_match = experienceMatch(
    Number(caregiver.years_experience ?? 0),
    careRequest.minimum_experience,
  );

  const conds = careRequest.conditions_relevant ?? [];
  const exp = caregiver.condition_experience ?? {};
  f.condition_experience_fit = conds.length
    ? pct(conds.filter((c) => (exp[c] ?? 0) > 0).length, conds.length)
    : null;

  // can the caregiver support the elderly person's mobility level?
  const needRank = MOBILITY_RANK[careRequest.mobility_requirement];
  if (needRank == null) f.mobility_support_fit = null;
  else if (needRank >= MOBILITY_RANK.WHEELCHAIR)
    f.mobility_support_fit = caregiver.bedbound_care_ok || caregiver.mobility_heavy_job_ok ? 100 : 20;
  else if (needRank >= MOBILITY_RANK.TRANSFER_ASSIST)
    f.mobility_support_fit = caregiver.mobility_heavy_job_ok ? 100 : 40;
  else f.mobility_support_fit = 100;

  const tasks = careRequest.tasks ?? [];
  const notPreferred = new Set(caregiver.not_preferred_job_types ?? []);
  const preferred = new Set(caregiver.preferred_job_types ?? []);
  f.task_expectation_fit = tasks.length
    ? clamp(
        (tasks.reduce((s, t) => {
          if (notPreferred.has(t.task_code)) return s + 0;
          if (preferred.has(t.task_code)) return s + 1;
          return s + 0.7; // accepted but not a stated preference
        }, 0) /
          tasks.length) *
          100,
      )
    : null;

  const personalTasks = tasks.filter((t) => PERSONAL_CARE.has(t.task_code));
  f.personal_care_compatibility = personalTasks.length
    ? clamp(
        (personalTasks.filter((t) => !notPreferred.has(t.task_code)).length / personalTasks.length) *
          100,
      )
    : null;

  f.distance_fit = distanceFit(travel.distance_km, caregiver.service_radius_km);
  f.travel_time_fit = travelTimeFit(travel.travel_minutes, caregiver.max_travel_time_minutes);

  // schedule: already gated by the hard filter, so this measures comfort — how much slack the
  // caregiver's declared availability leaves around the requested window
  f.schedule_fit = scheduleSlack(caregiver, careRequest);

  // budget against what the caregiver expects to be paid
  const budget = careRequest.budget;
  const expected = Number(caregiver.expected_rate ?? 0);
  f.budget_rate_fit =
    budget == null || expected === 0 ? null : budget >= expected ? 100 : clamp((budget / expected) * 100);

  f.language_match = coverage(reqsOf(careRequest, 'LANGUAGE'), caregiver.languages);
  f.communication_style_fit = coverage(
    reqsOf(careRequest, 'COMMUNICATION'),
    caregiver.communication_styles,
  );
  f.care_style_fit = coverage(reqsOf(careRequest, 'CARE_STYLE'), caregiver.care_styles);

  // continuity: does the caregiver take the shape of engagement the family wants?
  f.continuity_fit = continuityFit(careRequest.continuity_preference, caregiver);

  f.physical_workload_fit = workloadFit(careRequest, caregiver);

  f.transport_fit =
    careRequest.transport_required || careRequest.hospital_visit
      ? caregiver.transport_mode && caregiver.transport_mode !== 'NONE'
        ? 100
        : 20
      : null;

  f.trust_history_score = Number(caregiver.final_trust_score ?? 0);

  // V4 §41.17 / V6 F03 — a prior successful pairing is a bonus, never a gate
  const hist = ctx.pairHistory ?? {};
  f.previous_successful_match =
    hist.completed_jobs > 0 ? (hist.would_rebook ? 100 : 70) : NEUTRAL;

  // overall read of whether this job matches what the caregiver says they want
  f.caregiver_preference_fit = jobShapeFit(careRequest, caregiver);

  return f;
}

const PERSONAL_CARE = new Set(['BATHING', 'TOILETING', 'DRESSING', 'GROOMING', 'INCONTINENCE']);

function levelDepth(have, required) {
  const min = Number(required);
  if (!(min > 0)) return null;
  if (have < min) return clamp((have / min) * 80);
  return clamp(80 + 20 * Math.min(1, (have - min) / min));
}

function experienceMatch(years, minimum) {
  if (minimum == null || Number(minimum) <= 0) {
    return clamp(Math.min(1, years / 5) * 100); // no stated minimum: mild credit up to 5 years
  }
  const min = Number(minimum);
  if (years < min) return clamp((years / min) * 80);
  return clamp(80 + 20 * Math.min(1, (years - min) / (2 * min)));
}

function scheduleSlack(caregiver, careRequest) {
  const toMin = (t) => {
    if (t == null) return null;
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const s = toMin(careRequest.start_time);
  const e = toMin(careRequest.end_time);
  if (s == null || e == null) return null;
  const date = careRequest.care_date ? new Date(`${careRequest.care_date}T00:00:00Z`) : null;
  const weekday = date ? date.getUTCDay() : null;
  const slots = (caregiver.availability ?? []).filter((a) =>
    a.recurring ? a.weekday === weekday : a.specific_date === careRequest.care_date,
  );
  if (!slots.length) return 0;
  const best = Math.max(
    ...slots.map((sl) => {
      const ss = toMin(sl.start_time);
      const se = toMin(sl.end_time);
      if (ss == null || se == null) return 0;
      if (ss > s || se < e) return 0;
      const slack = (s - ss) + (se - e); // minutes of headroom on both sides
      return Math.min(100, 60 + Math.min(40, (slack / 120) * 40));
    }),
  );
  return best;
}

function continuityFit(pref, caregiver) {
  if (!pref) return null;
  if (pref === 'ONE_TIME') return caregiver.one_time_job_ok ? 100 : 30;
  if (pref === 'RECURRING') return caregiver.recurring_job_ok ? 100 : 30;
  if (pref === 'LONG_TERM')
    return caregiver.long_term_job_ok ? 100 : caregiver.recurring_job_ok ? 60 : 25;
  return null;
}

function workloadFit(careRequest, caregiver) {
  const heavy =
    careRequest.lifting_required ||
    ['TRANSFER_ASSIST', 'WHEELCHAIR', 'BEDBOUND'].includes(careRequest.mobility_requirement);
  if (!heavy) return 100;
  if (caregiver.mobility_heavy_job_ok && caregiver.lifting_job_ok) return 100;
  if (caregiver.mobility_heavy_job_ok || caregiver.lifting_job_ok) return 60;
  return 20;
}

function jobShapeFit(careRequest, caregiver) {
  const signals = [];
  const conds = careRequest.conditions_relevant ?? [];
  if (conds.includes('DEMENTIA')) signals.push(caregiver.dementia_care_ok ? 100 : 20);
  if (careRequest.mobility_requirement === 'BEDBOUND')
    signals.push(caregiver.bedbound_care_ok ? 100 : 20);
  if (careRequest.hospital_visit) signals.push(caregiver.hospital_escort_ok ? 100 : 20);
  if (careRequest.night_monitoring) signals.push(caregiver.nighttime_ok ? 100 : 20);
  if (!signals.length) return caregiver.general_care_ok ? 100 : NEUTRAL;
  return signals.reduce((a, b) => a + b, 0) / signals.length;
}

// ───────────────────────────────────────────────────────── caregiver job side

export function jobFeatures(careRequest, caregiver, travel) {
  const f = {};
  const budget = careRequest.budget;
  const min = Number(caregiver.minimum_rate ?? 0);
  const expected = Number(caregiver.expected_rate ?? 0);

  // pay: does the offer clear what they want, and what they will not go below
  f.rate_fit =
    budget == null || expected === 0 ? null : budget >= expected ? 100 : clamp((budget / expected) * 100);
  f.minimum_rate_fit =
    budget == null || min === 0 ? null : budget >= min ? 100 : clamp((budget / min) * 100);

  f.schedule_preference_fit = scheduleSlack(caregiver, careRequest);

  const isNight = careRequest.night_monitoring || startsAtNight(careRequest.start_time);
  f.day_night_preference_fit = isNight
    ? caregiver.nighttime_ok
      ? 100
      : 0
    : caregiver.daytime_ok
      ? 100
      : 30;

  f.recurring_schedule_fit = careRequest.recurring_job
    ? caregiver.recurring_job_ok
      ? 100
      : 20
    : caregiver.one_time_job_ok
      ? 100
      : 40;

  f.travel_burden_fit = distanceFit(travel.distance_km, caregiver.service_radius_km);

  // does the family's budget cover the trip the caregiver is being asked to make?
  const travelCost = (travel.distance_km ?? 0) * 2 * Number(caregiver.travel_fee_per_km ?? 0);
  f.travel_compensation_fit =
    travelCost === 0 ? null : budget == null ? null : clamp(((budget - travelCost) / budget) * 100);

  f.location_preference_fit = travelTimeFit(travel.travel_minutes, caregiver.max_travel_time_minutes);

  const preferred = new Set(caregiver.preferred_job_types ?? []);
  const notPreferred = new Set(caregiver.not_preferred_job_types ?? []);
  const tasks = careRequest.tasks ?? [];
  f.caregiver_task_preference_fit = tasks.length
    ? clamp(
        (tasks.reduce(
          (s, t) => s + (notPreferred.has(t.task_code) ? 0 : preferred.has(t.task_code) ? 1 : 0.7),
          0,
        ) /
          tasks.length) *
          100,
      )
    : null;

  f.job_type_preference_fit = jobShapeFit(careRequest, caregiver);

  const conds = careRequest.conditions_relevant ?? [];
  const exp = caregiver.condition_experience ?? {};
  f.caregiver_condition_preference_fit = conds.length
    ? pct(conds.filter((c) => (exp[c] ?? 0) > 0).length, conds.length)
    : null;

  // V4 §17 — the caregiver's own top-3 priorities, scored against this job
  f.caregiver_priority_fit = priorityFit(caregiver, { f, travel, careRequest });

  f.physical_workload_fit = workloadFit(careRequest, caregiver);
  f.lifting_transfer_fit = careRequest.lifting_required
    ? caregiver.lifting_job_ok
      ? 100
      : 0
    : null;

  f.continuity_preference_fit = continuityFit(careRequest.continuity_preference, caregiver);
  f.work_duration_fit = durationFit(careRequest, caregiver);
  f.shift_length_fit = durationFit(careRequest, caregiver);

  f.hospital_escort_fit = careRequest.hospital_visit
    ? caregiver.hospital_escort_ok
      ? 100
      : 0
    : null;
  f.transport_fit = careRequest.transport_required
    ? caregiver.transport_mode && caregiver.transport_mode !== 'NONE'
      ? 100
      : 20
    : null;

  f.environment_fit = environmentFit(careRequest, caregiver);

  return f;
}

function startsAtNight(startTime) {
  if (!startTime) return false;
  const h = Number(String(startTime).split(':')[0]);
  return h >= 20 || h < 6;
}

function durationFit(careRequest, caregiver) {
  const toMin = (t) => {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const s = toMin(careRequest.start_time);
  const e = toMin(careRequest.end_time);
  if (!isFinite(s) || !isFinite(e)) return null;
  const hrs = ((e - s + 1440) % 1440 || 1440) / 60;
  const max = Number(caregiver.max_hours_per_shift ?? 12);
  if (hrs > max) return 0;
  // a shift close to (but under) the ceiling is the most economical use of a trip
  return clamp(50 + (hrs / max) * 50);
}

function environmentFit(careRequest, caregiver) {
  const env = careRequest.environment ?? {};
  const signals = [];
  if (env.pets != null) signals.push(env.pets && !caregiver.pet_home_ok ? 0 : 100);
  if (env.smoking != null) signals.push(env.smoking && !caregiver.smoking_environment_ok ? 0 : 100);
  return signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : null;
}

/** Mean of the features backing whatever the caregiver named as their top 3 (V4 §17). */
const PRIORITY_SOURCES = {
  rate: (s) => s.f.rate_fit,
  distance: (s) => s.f.travel_burden_fit,
  time: (s) => s.f.schedule_preference_fit,
  job_type: (s) => s.f.job_type_preference_fit,
  workload: (s) => s.f.physical_workload_fit,
  continuity: (s) => s.f.continuity_preference_fit,
  shift_type: (s) => s.f.day_night_preference_fit,
};

function priorityFit(caregiver, scope) {
  const picks = caregiver.priority_preferences ?? [];
  const vals = picks
    .map((p) => PRIORITY_SOURCES[p.priority_key]?.(scope))
    .filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}
