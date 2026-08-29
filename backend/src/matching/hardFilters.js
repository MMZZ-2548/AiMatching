/**
 * Hard filters — V4 §14, reconciled in SCORING_SPEC §2.
 *
 * Fourteen absolute gates. A candidate failing any one is ineligible and GPT may never override
 * (V4 §14). `service_radius` is the sole soft filter: a candidate failing *only* that one is
 * re-examined by exceptional.js (V5 §25 — distance is the only permitted soft exception).
 */

import { POLICY } from './config.js';
import { resolveTravel } from './geo.js';

export const SOFT_FILTER = 'service_radius';

const toMin = (t) => {
  if (t == null) return null;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Does the caregiver's declared availability cover the whole requested window? */
export function coversWindow(caregiver, careRequest) {
  const need = { start: toMin(careRequest.start_time), end: toMin(careRequest.end_time) };
  if (need.start == null || need.end == null) return false;
  const date = careRequest.care_date ? new Date(`${careRequest.care_date}T00:00:00Z`) : null;
  const weekday = date ? date.getUTCDay() : null;

  const slots = (caregiver.availability ?? []).filter((a) =>
    a.recurring ? a.weekday === weekday : a.specific_date === careRequest.care_date,
  );
  // A window is covered when at least one slot contains it end-to-end. Overnight requests
  // (end < start) are checked against a slot that also wraps midnight.
  return slots.some((s) => {
    const ss = toMin(s.start_time);
    const se = toMin(s.end_time);
    if (ss == null || se == null) return false;
    if (need.end >= need.start) return ss <= need.start && se >= need.end;
    return ss <= need.start && se <= ss && se >= need.end;
  });
}

/** Overlap against jobs the caregiver has already accepted — the double-booking gate. */
export function hasCollision(caregiver, careRequest, busy = []) {
  const s = toMin(careRequest.start_time);
  const e = toMin(careRequest.end_time);
  return busy.some(
    (b) =>
      b.caregiver_id === caregiver.id &&
      b.care_date === careRequest.care_date &&
      toMin(b.start_time) < e &&
      toMin(b.end_time) > s,
  );
}

const mandatory = (req, type) =>
  (req.requirements ?? []).filter((r) => r.requirement_type === type && r.strength === 'MANDATORY');

const shiftHours = (req) => {
  const s = toMin(req.start_time);
  const e = toMin(req.end_time);
  if (s == null || e == null) return 0;
  return ((e - s + 1440) % 1440 || 1440) / 60;
};

/**
 * @returns {{eligible:boolean, failed:string[], results:object, travel:object}}
 */
export function runHardFilters(careRequest, caregiver, ctx = {}) {
  const { busy = [], matrix = null } = ctx;
  const travel = resolveTravel(caregiver, careRequest, matrix);
  const results = {};
  const fail = (id, reason) => {
    results[id] = { pass: false, reason };
  };
  const pass = (id) => {
    results[id] = { pass: true };
  };

  // 1 — verification
  if (caregiver.verification_status === 'VERIFIED') pass('verification_status');
  else fail('verification_status', `verification_status=${caregiver.verification_status}`);

  // 2 — mandatory skills
  const skills = new Set(caregiver.skills ?? []);
  const missingSkills = mandatory(careRequest, 'SKILL')
    .map((r) => r.requirement_code)
    .filter((c) => !skills.has(c));
  if (missingSkills.length === 0) pass('mandatory_required_skill');
  else fail('mandatory_required_skill', `missing: ${missingSkills.join(', ')}`);

  // 3 — mandatory credential
  const validCreds = new Set(
    (caregiver.certificates ?? [])
      .filter((c) => c.verified && (!c.expires_at || new Date(c.expires_at) >= new Date()))
      .map((c) => c.credential_code),
  );
  const missingCreds = mandatory(careRequest, 'CREDENTIAL')
    .map((r) => r.requirement_code)
    .filter((c) => !validCreds.has(c));
  if (missingCreds.length === 0) pass('mandatory_credential');
  else fail('mandatory_credential', `missing: ${missingCreds.join(', ')}`);

  // 4 — minimum skill level
  const levels = caregiver.skill_levels ?? {};
  const belowLevel = mandatory(careRequest, 'SKILL')
    .filter((r) => r.minimum_level != null && (levels[r.requirement_code] ?? 0) < r.minimum_level)
    .map((r) => `${r.requirement_code}<${r.minimum_level}`);
  if (belowLevel.length === 0) pass('minimum_skill_level');
  else fail('minimum_skill_level', belowLevel.join(', '));

  // 5 — availability (covers the window, night capability, no collision)
  const covered = coversWindow(caregiver, careRequest);
  const nightOk = !careRequest.night_monitoring || caregiver.nighttime_ok;
  const collision = hasCollision(caregiver, careRequest, busy);
  if (covered && nightOk && !collision) pass('availability');
  else
    fail(
      'availability',
      !covered ? 'window not covered' : collision ? 'double booking' : 'night shift refused',
    );

  // 6 — service radius (SOFT: exceptional.js may re-admit)
  if (travel.distance_km == null) pass('service_radius');
  else if (travel.distance_km <= Number(caregiver.service_radius_km)) pass('service_radius');
  else
    fail(
      'service_radius',
      `${travel.distance_km.toFixed(1)}km > ${caregiver.service_radius_km}km`,
    );

  // 7 — shift length
  const hrs = shiftHours(careRequest);
  if (hrs <= Number(caregiver.max_hours_per_shift)) pass('shift_length');
  else fail('shift_length', `${hrs}h > ${caregiver.max_hours_per_shift}h`);

  // 8 — mandatory language
  const langs = new Set(caregiver.languages ?? []);
  const missingLang = mandatory(careRequest, 'LANGUAGE')
    .map((r) => r.requirement_code)
    .filter((c) => !langs.has(c));
  if (missingLang.length === 0) pass('mandatory_language');
  else fail('mandatory_language', `missing: ${missingLang.join(', ')}`);

  // 9 — gender, only when explicitly MANDATORY (V4 §14.9)
  const genderReq = mandatory(careRequest, 'GENDER')[0];
  if (!genderReq || caregiver.gender === genderReq.requirement_code) pass('mandatory_gender');
  else fail('mandatory_gender', `requires ${genderReq.requirement_code}`);

  // 10 — caregiver task exclusions vs MUST_DO tasks
  const excluded = new Set(caregiver.not_preferred_job_types ?? []);
  const refusedTasks = (careRequest.tasks ?? [])
    .filter((t) => t.must_do && excluded.has(t.task_code))
    .map((t) => t.task_code);
  if (refusedTasks.length === 0) pass('caregiver_task_exclusion');
  else fail('caregiver_task_exclusion', `refuses: ${refusedTasks.join(', ')}`);

  // 11 — hospital escort
  if (!careRequest.hospital_visit || caregiver.hospital_escort_ok) pass('hospital_escort');
  else fail('hospital_escort', 'escort required, caregiver refuses');

  // 12 — heavy lifting
  if (!careRequest.lifting_required || caregiver.lifting_job_ok) pass('heavy_lifting');
  else fail('heavy_lifting', 'lifting required, caregiver refuses');

  // 13 — budget below minimum (policy-gated, SCORING_SPEC §2)
  const belowMin =
    careRequest.budget != null && Number(careRequest.budget) < Number(caregiver.minimum_rate);
  if (!belowMin || POLICY.budgetBelowMinimum !== 'FILTER') pass('budget_below_minimum');
  else fail('budget_below_minimum', `${careRequest.budget} < ${caregiver.minimum_rate}`);

  // 14 — live-in
  if (!careRequest.live_in_required || caregiver.live_in_ok) pass('live_in');
  else fail('live_in', 'live-in required, caregiver refuses');

  const failed = Object.entries(results)
    .filter(([, v]) => !v.pass)
    .map(([k]) => k);

  return { eligible: failed.length === 0, failed, results, travel };
}

/** True when the only thing standing in the way is distance (V5 §25). */
export function failsOnlyOnDistance(failed) {
  return failed.length === 1 && failed[0] === SOFT_FILTER;
}
