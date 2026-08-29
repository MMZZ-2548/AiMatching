/**
 * TrustCare Controlled Mutual Matching Benchmark — generator.
 * V6 §5: 120 cases, Group A 30 / B 25 / C 25 / D 20 / E 10 / F 10.
 *
 * LABEL: CONTROLLED_TEST. These are team-authored scenarios that test rule and ranking
 * conformance. They are NOT real-world validation and the report must never present them as
 * matching accuracy (V6 §0, §4).
 *
 * Deterministic by construction (V6 §23.5): every case is written out explicitly or derived from a
 * seeded LCG, so regenerating produces a byte-identical file.
 *
 *   node scripts/generate_controlled_mutual_dataset.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCareRequest, makeCaregiver, makePerfectCaregiver } from '../backend/tests/fixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEED = 20260831;

/** Tiny deterministic LCG — no Math.random anywhere in this file. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const rnd = lcg(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const cases = [];
let counter = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };

/**
 * @param group   A..F
 * @param kind    RANKING for pairwise ordering cases, DECISION for filter/flag cases
 * @param expected  what the engine must produce
 */
function addCase({ group, title, kind, expected, care_request, caregivers, ctx = {}, notes, ...extra }) {
  counter[group] += 1;
  cases.push({
    case_id: `${group}${String(counter[group]).padStart(2, '0')}`,
    group,
    title,
    kind,
    expected,
    care_request,
    caregivers,
    ctx,
    notes: notes ?? null,
    // Group C carries `jobs`, Group D carries `inputs`, Group F carries `trust_input`.
    ...extra,
  });
}

// ═══════════════════════════════════════════ GROUP A — hard filter (30)
// V6 §6. Each case asserts a single filter decision. The ten named cases from the document come
// first; the remainder exercise the four V4 §14 filters V6 did not name (gender, live-in,
// skill level, shift length) plus the pass-through control.

const A = [
  ['A01 high trust + missing mandatory skill', { skills: ['ELDERLY_CARE'], final_trust_score: 98 }, 'mandatory_required_skill'],
  ['A02 perfect skills + unavailable', { availability: [{ recurring: true, weekday: 5, start_time: '07:00', end_time: '18:00' }] }, 'availability'],
  ['A04 mandatory language mismatch', { languages: ['EN'] }, 'mandatory_language'],
  ['A05 caregiver refuses a MUST_DO task', { not_preferred_job_types: ['MEAL_PREP'] }, 'caregiver_task_exclusion'],
  ['A09 verification pending', { verification_status: 'PENDING' }, 'verification_status'],
  ['A09b verification rejected', { verification_status: 'REJECTED' }, 'verification_status'],
  ['A09c unverified caregiver', { verification_status: 'UNVERIFIED' }, 'verification_status'],
  ['minimum skill level not met', { skill_levels: { ELDERLY_CARE: 1, DIABETES_CARE: 1 } }, 'minimum_skill_level'],
  ['both mandatory skills missing', { skills: [] }, 'mandatory_required_skill'],
  ['night capability absent for a day job is irrelevant', { nighttime_ok: false }, null],
];
for (const [title, cgOverride, expectedFilter] of A) {
  const req = title.includes('minimum skill level')
    ? makeCareRequest({
        requirements: [
          { requirement_type: 'SKILL', requirement_code: 'ELDERLY_CARE', strength: 'MANDATORY', minimum_level: 3 },
          { requirement_type: 'SKILL', requirement_code: 'DIABETES_CARE', strength: 'MANDATORY', minimum_level: 3 },
          { requirement_type: 'LANGUAGE', requirement_code: 'TH', strength: 'MANDATORY' },
        ],
      })
    : makeCareRequest();
  addCase({
    group: 'A',
    title,
    kind: 'DECISION',
    expected: expectedFilter
      ? { decision: 'FILTER_OUT', failed_filter: expectedFilter }
      : { decision: 'ELIGIBLE' },
    care_request: req,
    caregivers: [makeCaregiver(cgOverride)],
  });
}

// request-side filters
const AReq = [
  ['A03 outside radius, no exceptional opt-in', { }, { distanceKm: 145, out_of_area_enabled: false }, 'service_radius'],
  ['A06 heavy lifting required, caregiver refuses', { lifting_required: true }, { lifting_job_ok: false }, 'heavy_lifting'],
  ['A07 hospital escort required, caregiver refuses', { hospital_visit: true }, { hospital_escort_ok: false }, 'hospital_escort'],
  ['A08 mandatory credential missing', {
    requirements: [
      ...makeCareRequest().requirements,
      { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' },
    ],
  }, {}, 'mandatory_credential'],
  ['A10 budget below minimum, negotiation disabled', { budget: 400 }, {}, 'budget_below_minimum'],
  ['night monitoring, caregiver refuses nights', { night_monitoring: true }, { nighttime_ok: false }, 'availability'],
  ['live-in required, caregiver refuses', { live_in_required: true }, { live_in_ok: false }, 'live_in'],
  ['mandatory gender mismatch', {
    requirements: [...makeCareRequest().requirements, { requirement_type: 'GENDER', requirement_code: 'FEMALE', strength: 'MANDATORY' }],
  }, { gender: 'MALE' }, 'mandatory_gender'],
  ['shift longer than the caregiver ceiling', { start_time: '06:00', end_time: '22:00' }, { max_hours_per_shift: 8 }, 'shift_length'],
  ['A08b credential present but unverified', {
    requirements: [...makeCareRequest().requirements, { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' }],
  }, { certificates: [{ credential_code: 'NURSE_AIDE', verified: false }] }, 'mandatory_credential'],
  ['A08c credential verified but expired', {
    requirements: [...makeCareRequest().requirements, { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' }],
  }, { certificates: [{ credential_code: 'NURSE_AIDE', verified: true, expires_at: '2020-01-01' }] }, 'mandatory_credential'],
  ['credential verified and current passes', {
    requirements: [...makeCareRequest().requirements, { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' }],
  }, { certificates: [{ credential_code: 'NURSE_AIDE', verified: true, expires_at: '2030-01-01' }] }, null],
  ['optional language mismatch scores lower but does not filter', {
    requirements: [
      ...makeCareRequest().requirements,
      { requirement_type: 'LANGUAGE', requirement_code: 'MS', strength: 'NICE_TO_HAVE' },
    ],
  }, {}, null],
  ['gender preference that is not MANDATORY never filters', {
    requirements: [...makeCareRequest().requirements, { requirement_type: 'GENDER', requirement_code: 'FEMALE', strength: 'IMPORTANT' }],
  }, { gender: 'MALE' }, null],
  ['budget exactly at the minimum is allowed', { budget: 700 }, { minimum_rate: 700 }, null],
  ['distance exactly at the radius boundary is allowed', {}, { distanceKm: 25 }, null],
  ['fully matching control', {}, {}, null],
  ['shift exactly at the ceiling is allowed', { start_time: '08:00', end_time: '16:00' }, { max_hours_per_shift: 8 }, null],
  ['MUST_DO task the caregiver merely does not prefer still filters', {}, { not_preferred_job_types: ['MEDICATION_REMINDER'] }, 'caregiver_task_exclusion'],
  ['a non-MUST_DO excluded task does not filter', {
    tasks: [{ task_code: 'MEAL_PREP', must_do: true }, { task_code: 'COMPANIONSHIP', must_do: false }],
  }, { not_preferred_job_types: ['COMPANIONSHIP'] }, null],
];
for (const [title, reqOverride, cgOverride, expectedFilter] of AReq) {
  addCase({
    group: 'A',
    title,
    kind: 'DECISION',
    expected: expectedFilter
      ? { decision: 'FILTER_OUT', failed_filter: expectedFilter }
      : { decision: 'ELIGIBLE' },
    care_request: makeCareRequest(reqOverride),
    caregivers: [makeCaregiver(cgOverride)],
  });
}

// ═══════════════════════════════════════════ GROUP B — family fit (25)
// V6 §7. Each case is a pair differing in exactly one feature; the expectation is an ordering,
// never an absolute score, so the case stays valid if weights are retuned.

const B_PAIRS = [
  ['B01 direct condition experience wins', { condition_experience: { DIABETES: 6 } }, { condition_experience: {} }],
  ['B02 nearer caregiver wins on final fit', { distanceKm: 3 }, { distanceKm: 20 }, 'final_family_fit'],
  ['more years of experience wins', { years_experience: 10 }, { years_experience: 2 }],
  ['higher skill level wins', { skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5 } }, { skill_levels: { ELDERLY_CARE: 2, DIABETES_CARE: 2 } }, null, null, 'LEVELLED'],
  ['higher trust history wins', { final_trust_score: 95 }, { final_trust_score: 55 }],
  ['rate inside budget wins', { expected_rate: 800 }, { expected_rate: 1600 }],
  ['task preference alignment wins', { preferred_job_types: ['MEAL_PREP', 'MEDICATION_REMINDER'] }, { preferred_job_types: [] }],
  ['transport available wins when escort is needed', { transport_mode: 'CAR', hospital_escort_ok: true }, { transport_mode: 'NONE', hospital_escort_ok: true }],
  ['wider availability window wins on schedule slack', { availability: [{ recurring: true, weekday: 2, start_time: '06:00', end_time: '20:00' }] }, { availability: [{ recurring: true, weekday: 2, start_time: '08:00', end_time: '16:00' }] }],
  ['heavy-capable caregiver wins a heavy job', { mobility_heavy_job_ok: true, lifting_job_ok: true }, { mobility_heavy_job_ok: false, lifting_job_ok: false }],
  ['more condition experience years is not worse', { condition_experience: { DIABETES: 10 } }, { condition_experience: { DIABETES: 1 } }, null, 'GTE'],
  ['dementia-capable wins a dementia case', { dementia_care_ok: true }, { dementia_care_ok: false }],
  ['language coverage wins', { languages: ['TH', 'MS'] }, { languages: ['TH'] }],
];

for (const [title, aOver, bOver, scoreKey, cmp, variant] of B_PAIRS) {
  const heavy = title.includes('heavy');
  const dementia = title.includes('dementia');
  const escort = title.includes('escort');
  const langCase = title.includes('language coverage');
  const req = makeCareRequest({
    ...(variant === 'LEVELLED'
      ? {
          requirements: [
            { requirement_type: 'SKILL', requirement_code: 'ELDERLY_CARE', strength: 'MANDATORY', minimum_level: 2 },
            { requirement_type: 'SKILL', requirement_code: 'DIABETES_CARE', strength: 'MANDATORY', minimum_level: 2 },
            { requirement_type: 'LANGUAGE', requirement_code: 'TH', strength: 'MANDATORY' },
          ],
        }
      : {}),
    ...(heavy ? { lifting_required: true, mobility_requirement: 'TRANSFER_ASSIST' } : {}),
    ...(dementia ? { conditions_relevant: ['DEMENTIA'] } : {}),
    ...(escort ? { hospital_visit: true, transport_required: true } : {}),
    ...(langCase
      ? {
          requirements: [
            ...makeCareRequest().requirements,
            { requirement_type: 'LANGUAGE', requirement_code: 'MS', strength: 'IMPORTANT' },
          ],
        }
      : {}),
  });
  const base = dementia ? { condition_experience: { DEMENTIA: 4 }, dementia_care_ok: true } : {};
  addCase({
    group: 'B',
    title,
    kind: 'RANKING',
    expected: {
      comparison: cmp ?? 'GT',
      score: scoreKey ?? 'base_family_fit',
      winner: 'CG-A',
      loser: 'CG-B',
    },
    care_request: req,
    caregivers: [
      makeCaregiver({ id: 'CG-A', ...base, ...aOver }),
      makeCaregiver({ id: 'CG-B', ...base, ...bOver }),
    ],
  });
}

// B03 from the document: trust vs coverage — the expectation depends on configured weights, so it
// is written as a *stability* assertion rather than a fixed winner. V6 §7 states the case as
// "B can rank above A depending configured weights", which cannot be a pass/fail expectation.
addCase({
  group: 'B',
  title: 'B03 high trust / weak coverage vs lower trust / full coverage',
  kind: 'STABILITY',
  expected: {
    comparison: 'DETERMINISTIC',
    note: 'V6 §7 B03 leaves the winner weight-dependent; asserted as reproducibility, not ordering',
  },
  care_request: makeCareRequest(),
  caregivers: [
    makeCaregiver({ id: 'CG-A', final_trust_score: 90, condition_experience: {}, preferred_job_types: [] }),
    makeCaregiver({ id: 'CG-B', final_trust_score: 75, condition_experience: { DIABETES: 5 } }),
  ],
});

// score-stability cases: identical inputs must produce identical scores across runs
for (let i = 0; i < 11; i += 1) {
  const km = 2 + i * 2;
  addCase({
    group: 'B',
    title: `score stability at ${km} km`,
    kind: 'STABILITY',
    expected: { comparison: 'DETERMINISTIC' },
    care_request: makeCareRequest(),
    caregivers: [makeCaregiver({ id: `CG-S${i}`, distanceKm: km, final_trust_score: 60 + i * 3 })],
  });
}

// ═══════════════════════════════════════════ GROUP C — caregiver job fit (25)
// V6 §8. Two jobs, one caregiver; the caregiver must prefer the job matching their stated wants.

const C_PAIRS = [
  ['C01 near + on-rate + day beats far + underpaid + night', { budget: 1200 }, { budget: 750, start_time: '20:00', end_time: '04:00' }, { nighttime_ok: true }],
  ['C02 long-term caregiver prefers recurring work', { recurring_job: true, continuity_preference: 'LONG_TERM' }, { recurring_job: false, continuity_preference: 'ONE_TIME' }, { long_term_job_ok: true, one_time_job_ok: false }],
  ['C03 workload-averse caregiver scores a heavy job lower', {}, { mobility_requirement: 'BEDBOUND', lifting_required: true }, { lifting_job_ok: true, bedbound_care_ok: true, mobility_heavy_job_ok: false }],
  ['higher budget wins', { budget: 1500 }, { budget: 800 }, {}],
  ['shorter travel wins', {}, {}, {}, 'DISTANCE'],
  ['day shift preferred when nights are refused', {}, { start_time: '22:00', end_time: '06:00', night_monitoring: true }, { nighttime_ok: false }],
  ['a job matching preferred task types wins', { tasks: [{ task_code: 'MEAL_PREP', must_do: true }] }, { tasks: [{ task_code: 'BATHING', must_do: true }] }, { preferred_job_types: ['MEAL_PREP'] }],
  ['escort-capable caregiver prefers the escort job they opted into', { hospital_visit: true, transport_required: true }, { hospital_visit: false }, { hospital_escort_ok: true, transport_mode: 'CAR' }, 'GTE'],
  ['a job within condition experience wins', { conditions_relevant: ['DIABETES'] }, { conditions_relevant: ['STROKE'] }, { condition_experience: { DIABETES: 6 } }],
  ['fuller shift beats a very short one', { start_time: '08:00', end_time: '16:00' }, { start_time: '08:00', end_time: '10:00' }, {}],
  ['pet-free home preferred when the caregiver cannot work with pets', { environment: { pets: false } }, { environment: { pets: true } }, { pet_home_ok: false }],
  ['smoke-free home preferred', { environment: { smoking: false } }, { environment: { smoking: true } }, { smoking_environment_ok: false }],
];

for (const [title, jobAOver, jobBOver, cgOver, cmp] of C_PAIRS) {
  const isDistance = cmp === 'DISTANCE';
  const jobA = makeCareRequest({ id: 'JOB-A', ...jobAOver });
  const jobB = makeCareRequest({ id: 'JOB-B', ...jobBOver });
  addCase({
    group: 'C',
    title,
    kind: 'RANKING',
    expected: {
      comparison: cmp === 'GTE' ? 'GTE' : 'GT',
      score: isDistance ? 'final_job_fit' : 'base_job_fit',
      winner_job: 'JOB-A',
      loser_job: 'JOB-B',
    },
    care_request: null,
    jobs: [jobA, jobB],
    caregivers: [makeCaregiver(isDistance ? { ...cgOver, distanceKm: 3 } : cgOver)],
    ctx: isDistance ? { far_variant_km: 22 } : {},
  });
}

// preference-constraint pass cases: a stated exclusion must never be recommended
const C_CONSTRAINTS = [
  ['a caregiver who refuses nights is never recommended a night job', { night_monitoring: true }, { nighttime_ok: false }],
  ['a caregiver who refuses lifting is never recommended a lifting job', { lifting_required: true }, { lifting_job_ok: false }],
  ['a caregiver who refuses escort is never recommended an escort job', { hospital_visit: true }, { hospital_escort_ok: false }],
  ['a caregiver who refuses live-in is never recommended live-in work', { live_in_required: true }, { live_in_ok: false }],
  ['a caregiver is never recommended a job below their minimum rate', { budget: 300 }, { minimum_rate: 700 }],
  ['a caregiver is never recommended a shift beyond their ceiling', { start_time: '05:00', end_time: '23:00' }, { max_hours_per_shift: 8 }],
  ['a caregiver is never recommended a job outside their radius', {}, { distanceKm: 90, out_of_area_enabled: false }],
  ['a caregiver is never recommended a task they exclude', {}, { not_preferred_job_types: ['MEAL_PREP'] }],
  ['a caregiver is never recommended work needing a skill they lack', {}, { skills: ['ELDERLY_CARE'] }],
  ['a caregiver is never recommended work in a language they lack', {}, { languages: ['EN'] }],
  ['an unverified caregiver receives no recommendations at all', {}, { verification_status: 'PENDING' }],
  ['a caregiver is never recommended a job clashing with an accepted one', {}, {}, 'BUSY'],
  ['an eligible caregiver IS recommended (control)', {}, {}, 'CONTROL'],
];
for (const [title, reqOver, cgOver, mode] of C_CONSTRAINTS) {
  addCase({
    group: 'C',
    title,
    kind: 'DECISION',
    expected: { decision: mode === 'CONTROL' ? 'RECOMMENDED' : 'NOT_RECOMMENDED' },
    care_request: makeCareRequest({ visibility: 'OPEN_TO_CAREGIVERS', ...reqOver }),
    caregivers: [makeCaregiver(cgOver)],
    ctx:
      mode === 'BUSY'
        ? { busy: [{ caregiver_id: 'CG-1', care_date: '2026-09-01', start_time: '09:00', end_time: '12:00' }] }
        : {},
  });
}

// ═══════════════════════════════════════════ GROUP D — mutual fit (20)
// V6 §9. The point of the group: a high Family Fit alone must not win.

const D_DIRECT = [
  ['D01 family 95 / job 45 → moderate', 95, 45, 'MODERATE'],
  ['D02 family 88 / job 90 → high', 88, 90, 'HIGH'],
  ['D03 family 92 / job 93 → top', 92, 93, 'HIGH'],
  ['V5 §24 example 96 / 94', 96, 94, 'HIGH'],
  ['balanced mid pair', 70, 70, 'MODERATE'],
  ['both low', 40, 40, 'LOW'],
  ['family high job very low still clears 60 — the 0.60/0.40 family bias, SCORING_SPEC §6', 99, 10, 'MODERATE'],
  ['job high family very low', 10, 99, 'LOW'],
];
for (const [title, family, job, band] of D_DIRECT) {
  addCase({
    group: 'D',
    title,
    kind: 'FORMULA',
    expected: { mutual: 0.6 * family + 0.4 * job, band },
    inputs: { base_family_fit: family, base_job_fit: job },
    care_request: null,
    caregivers: [],
  });
}

const D_ORDER = [
  ['D04 one-sided 98/40 ranks below balanced 90/90', [98, 40], [90, 90]],
  ['one-sided 100/30 ranks below balanced 80/80', [100, 30], [80, 80]],
  ['balanced 85/85 ranks above 95/60', [95, 60], [85, 85]],
  ['balanced 75/75 ranks above 90/45', [90, 45], [75, 75]],
  ['a slightly more balanced pair with the same family fit wins', [92, 84], [92, 88]],
];
for (const [title, pairA, pairB] of D_ORDER) {
  addCase({
    group: 'D',
    title,
    kind: 'FORMULA_ORDER',
    expected: { lower: pairA, higher: pairB },
    care_request: null,
    caregivers: [],
  });
}

// end-to-end mutual: same pair evaluated from both directions must agree (V5 §1)
for (let i = 0; i < 7; i += 1) {
  addCase({
    group: 'D',
    title: `both directions agree on the same pair (${i + 1})`,
    kind: 'SYMMETRY',
    expected: { comparison: 'IDENTICAL' },
    care_request: makeCareRequest({
      visibility: 'OPEN_TO_CAREGIVERS',
      budget: 800 + i * 120,
    }),
    caregivers: [makeCaregiver({ id: `CG-M${i}`, distanceKm: 2 + i * 3, expected_rate: 700 + i * 100 })],
  });
}

// ═══════════════════════════════════════════ GROUP E — exceptional far match (10)
// V6 §10 + V5 §26.

const farReq = (over = {}) => makeCareRequest({ accept_out_of_area: true, ...over });
const farCg = (over = {}) =>
  makePerfectCaregiver({ distanceKm: 145, out_of_area_enabled: true, max_out_of_area_distance_km: 300, ...over });

const E = [
  ['E01 fit ≥ 90, 145 km, both opt-in', farReq(), farCg(), 'EXCEPTIONAL_MATCH'],
  ['E02 caregiver has not opted in', farReq(), farCg({ out_of_area_enabled: false }), 'NOT_SHOWN'],
  ['E03 family has not opted in', farReq({ accept_out_of_area: false }), farCg(), 'NOT_SHOWN'],
  ['E04 base fit below threshold', farReq(), farCg({ years_experience: 1, skill_levels: { ELDERLY_CARE: 1, DIABETES_CARE: 1 }, condition_experience: {}, expected_rate: 3000, final_trust_score: 40, preferred_job_types: [] }), 'NOT_EXCEPTIONAL'],
  ['E05 missing mandatory skill is never rescued by distance', farReq(), farCg({ skills: ['ELDERLY_CARE'] }), 'FILTER_OUT'],
  ['V5 case 5 fit 91 at 45 km', farReq(), farCg({ distanceKm: 45 }), 'EXCEPTIONAL_MATCH'],
  ['beyond the platform maximum distance', farReq(), farCg({ distanceKm: 320 }), 'NOT_SHOWN'],
  ['beyond the caregiver personal out-of-area limit', farReq(), farCg({ max_out_of_area_distance_km: 100 }), 'NOT_SHOWN'],
  ['unavailable AND far is filtered, never exceptional', farReq(), farCg({ availability: [{ recurring: true, weekday: 6, start_time: '06:00', end_time: '20:00' }] }), 'FILTER_OUT'],
  ['accommodation is disclosed past the caregiver threshold', farReq(), farCg({ accommodation_required_after_km: 100 }), 'EXCEPTIONAL_WITH_ACCOMMODATION'],
];
for (const [title, req, cg, expected] of E) {
  addCase({
    group: 'E',
    title,
    kind: 'DECISION',
    expected: { decision: expected },
    care_request: req,
    caregivers: [cg],
  });
}

// ═══════════════════════════════════════════ GROUP F — feedback / trust history (10)
// V6 §11.

const F = [
  ['F01 unconfirmed incident → no penalty', { incidents: [{ status: 'UNCONFIRMED', responsibility: 'UNDETERMINED' }] }, 'NO_PENALTY'],
  ['F01b GPS/geofence event alone → no penalty', { incidents: [{ status: 'REPORTED', responsibility: 'UNDETERMINED' }] }, 'NO_PENALTY'],
  ['F02 confirmed caregiver-responsible incident → penalty', { incidents: [{ status: 'CONFIRMED', responsibility: 'CAREGIVER_RESPONSIBLE' }] }, 'PENALTY'],
  ['F02b confirmed but externally caused → no penalty', { incidents: [{ status: 'CONFIRMED', responsibility: 'EXTERNAL' }] }, 'NO_PENALTY'],
  ['F02c dismissed incident → no penalty', { incidents: [{ status: 'DISMISSED', responsibility: 'CAREGIVER_RESPONSIBLE' }] }, 'NO_PENALTY'],
  ['F04 a single 5-star review is shrunk toward the prior', { reviewCount: 1, meanRating: 5, completedJobs: 1 }, 'SHRUNK'],
  ['F04b many 5-star reviews approach the ceiling', { reviewCount: 50, meanRating: 5, completedJobs: 50 }, 'HIGH_REVIEW'],
  ['F05 zero completed jobs → NEW status', { completedJobs: 0 }, 'COLD_START'],
  ['F05b enough completed jobs → ESTABLISHED', { completedJobs: 8, reviewCount: 6, meanRating: 4.4 }, 'ESTABLISHED'],
];
for (const [title, input, expected] of F) {
  addCase({ group: 'F', title, kind: 'TRUST', expected: { decision: expected }, trust_input: input, care_request: null, caregivers: [] });
}

// F03 rebook signal, evaluated through the engine
addCase({
  group: 'F',
  title: 'F03 a previous successful pair with rebook scores above a fresh pair',
  kind: 'RANKING',
  expected: { comparison: 'GT', score: 'base_family_fit', winner: 'CG-REBOOK', loser: 'CG-FRESH' },
  care_request: makeCareRequest(),
  caregivers: [makeCaregiver({ id: 'CG-REBOOK' }), makeCaregiver({ id: 'CG-FRESH' })],
  ctx: { pair_history: { 'CG-REBOOK': { completed_jobs: 3, would_rebook: true } } },
});

// ═══════════════════════════════════════════ write out

const counts = cases.reduce((a, c) => ({ ...a, [c.group]: (a[c.group] ?? 0) + 1 }), {});
const expectedCounts = { A: 30, B: 25, C: 25, D: 20, E: 10, F: 10 };

console.log('Group counts:', counts, '| total', cases.length);
let ok = true;
for (const [g, n] of Object.entries(expectedCounts)) {
  if (counts[g] !== n) {
    console.error(`  MISMATCH group ${g}: got ${counts[g]}, V6 §5 requires ${n}`);
    ok = false;
  }
}
if (cases.length !== 120) {
  console.error(`  MISMATCH total: got ${cases.length}, V6 §5 requires 120`);
  ok = false;
}

mkdirSync(resolve(ROOT, 'data'), { recursive: true });

const jsonl = cases.map((c) => JSON.stringify(c)).join('\n');
writeFileSync(resolve(ROOT, 'data/trustcare_controlled_mutual_120.jsonl'), jsonl + '\n');

const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [
  'case_id,group,kind,title,expected',
  ...cases.map((c) =>
    [c.case_id, c.group, c.kind, c.title, JSON.stringify(c.expected)].map(csvEscape).join(','),
  ),
].join('\n');
writeFileSync(resolve(ROOT, 'data/trustcare_controlled_mutual_120.csv'), csv + '\n');

console.log(`\nWrote data/trustcare_controlled_mutual_120.jsonl (seed ${SEED})`);
console.log('Wrote data/trustcare_controlled_mutual_120.csv');
if (!ok) process.exit(1);
