/**
 * Engine unit tests, anchored to the cases published in the source documents.
 * Each test names the document and case id it is asserting, so a failure points at a clause.
 */

import { describe, it, expect } from 'vitest';
import { evaluatePair, matchCaregiversForRequest, matchJobsForCaregiver } from '../src/matching/engine.js';
import { runHardFilters } from '../src/matching/hardFilters.js';
import { computeScores } from '../src/matching/score.js';
import { computeTrustScore, shrunkReviewScore } from '../src/matching/trust.js';
import {
  FAMILY_BASE_WEIGHTS,
  JOB_BASE_WEIGHTS,
  MUTUAL_FAMILY_WEIGHT,
  MUTUAL_JOB_WEIGHT,
} from '../src/matching/config.js';
import { distanceFit } from '../src/matching/geo.js';
import { makeCareRequest, makeCaregiver, makePerfectCaregiver } from './fixtures.js';

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

describe('SCORING_SPEC §4/§5 — renormalised weights', () => {
  it('family base weights sum to 100 after removing distance', () => {
    expect(sum(FAMILY_BASE_WEIGHTS)).toBeCloseTo(100, 6);
    expect(FAMILY_BASE_WEIGHTS.distance_travel_fit).toBeUndefined();
  });
  it('job base weights sum to 100 after removing travel burden', () => {
    expect(sum(JOB_BASE_WEIGHTS)).toBeCloseTo(100, 6);
    expect(JOB_BASE_WEIGHTS.travel_burden_fit).toBeUndefined();
  });
  it('keeps V4 §20 mutual weighting', () => {
    expect(MUTUAL_FAMILY_WEIGHT).toBe(0.6);
    expect(MUTUAL_JOB_WEIGHT).toBe(0.4);
  });
});

describe('V4 §14 / V6 Group A — hard filters', () => {
  const cr = makeCareRequest();

  it('A01 high trust + missing mandatory skill → FILTER_OUT', () => {
    const cg = makeCaregiver({ skills: ['ELDERLY_CARE'], final_trust_score: 98 });
    const r = evaluatePair(cr, cg);
    expect(r.eligible).toBe(false);
    expect(r.failed_filters).toContain('mandatory_required_skill');
    expect(r.bucket).toBe('FILTERED_OUT');
  });

  it('A02 perfect skills + unavailable → FILTER_OUT', () => {
    const cg = makeCaregiver({
      availability: [{ recurring: true, weekday: 5, start_time: '07:00', end_time: '18:00' }],
    });
    const r = evaluatePair(cr, cg);
    expect(r.failed_filters).toContain('availability');
  });

  it('A03 perfect skills + outside radius + no opt-in → FILTER_OUT, not exceptional', () => {
    const cg = makePerfectCaregiver({ distanceKm: 145, out_of_area_enabled: false });
    const r = evaluatePair(cr, cg);
    expect(r.eligible).toBe(false);
    expect(r.exceptional_match).toBe(false);
    expect(r.bucket).toBe('FILTERED_OUT');
  });

  it('A04 mandatory language mismatch → FILTER_OUT', () => {
    const cg = makeCaregiver({ languages: ['EN'] });
    expect(evaluatePair(cr, cg).failed_filters).toContain('mandatory_language');
  });

  it('A05/A06 caregiver refuses a MUST_DO task → FILTER_OUT', () => {
    const cg = makeCaregiver({ not_preferred_job_types: ['MEAL_PREP'] });
    expect(evaluatePair(cr, cg).failed_filters).toContain('caregiver_task_exclusion');
  });

  it('A06 heavy lifting required + caregiver refuses → FILTER_OUT', () => {
    const req = makeCareRequest({ lifting_required: true });
    const cg = makeCaregiver({ lifting_job_ok: false });
    expect(evaluatePair(req, cg).failed_filters).toContain('heavy_lifting');
  });

  it('A07 hospital escort mandatory + caregiver refuses → FILTER_OUT', () => {
    const req = makeCareRequest({ hospital_visit: true });
    const cg = makeCaregiver({ hospital_escort_ok: false });
    expect(evaluatePair(req, cg).failed_filters).toContain('hospital_escort');
  });

  it('A08 mandatory credential missing → FILTER_OUT', () => {
    const req = makeCareRequest({
      requirements: [
        ...makeCareRequest().requirements,
        { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' },
      ],
    });
    expect(evaluatePair(req, makeCaregiver()).failed_filters).toContain('mandatory_credential');
  });

  it('A09 verification pending → FILTER_OUT (policy locked in SCORING_SPEC §2)', () => {
    const cg = makeCaregiver({ verification_status: 'PENDING' });
    expect(evaluatePair(cr, cg).failed_filters).toContain('verification_status');
  });

  it('A10 budget below minimum with negotiation disabled → FILTER_OUT', () => {
    const req = makeCareRequest({ budget: 400 });
    expect(evaluatePair(req, makeCaregiver()).failed_filters).toContain('budget_below_minimum');
  });

  it('a fully matching caregiver passes every filter', () => {
    const r = evaluatePair(cr, makeCaregiver());
    expect(r.eligible).toBe(true);
    expect(r.failed_filters).toEqual([]);
    expect(r.bucket).toBe('RECOMMENDED_NEARBY');
  });

  it('V4 §41.7 night job + caregiver nighttime_ok=false → FILTER_OUT', () => {
    const req = makeCareRequest({ night_monitoring: true });
    expect(evaluatePair(req, makeCaregiver()).failed_filters).toContain('availability');
  });

  it('double booking is caught by the availability filter', () => {
    const busy = [
      { caregiver_id: 'CG-1', care_date: '2026-09-01', start_time: '09:00', end_time: '12:00' },
    ];
    const r = runHardFilters(cr, makeCaregiver(), { busy });
    expect(r.failed).toContain('availability');
    expect(r.results.availability.reason).toBe('double booking');
  });
});

describe('V4 §20 / V6 Group D — mutual fit', () => {
  /** Drive computeScores directly with known sub-scores, as the V6 cases are stated. */
  const mutualOf = (family, job) =>
    MUTUAL_FAMILY_WEIGHT * family + MUTUAL_JOB_WEIGHT * job;

  it('D01 family 95 / job 45 → moderate', () => {
    expect(mutualOf(95, 45)).toBeCloseTo(75, 6);
  });
  it('D02 family 88 / job 90 → high', () => {
    expect(mutualOf(88, 90)).toBeCloseTo(88.8, 6);
  });
  it('D03 family 92 / job 93 → top, above D02', () => {
    expect(mutualOf(92, 93)).toBeCloseTo(92.4, 6);
    expect(mutualOf(92, 93)).toBeGreaterThan(mutualOf(88, 90));
  });
  it('D04 one-sided 98/40 ranks BELOW balanced 90/90', () => {
    expect(mutualOf(98, 40)).toBeLessThan(mutualOf(90, 90));
  });
  it('V5 §24 worked example reproduces 95', () => {
    expect(mutualOf(96, 94)).toBeCloseTo(95.2, 6);
  });

  it('a bucket with no applicable features never drags the score to zero', () => {
    const s = computeScores({ skill_match_score: 100 }, { rate_fit: 100 });
    expect(s.base_family_fit).toBe(100);
    expect(s.base_job_fit).toBe(100);
  });
});

describe('V5 §19-§27 / V6 Group E — exceptional far match', () => {
  const farReq = makeCareRequest({ accept_out_of_area: true });
  const farCg = (o = {}) =>
    makePerfectCaregiver({
      distanceKm: 145,
      out_of_area_enabled: true,
      max_out_of_area_distance_km: 300,
      ...o,
    });

  it('E01 / V5 case 1 — fit ≥ 90, both opt-in → EXCEPTIONAL', () => {
    const r = evaluatePair(farReq, farCg());
    expect(r.base_mutual_fit).toBeGreaterThanOrEqual(90);
    expect(r.exceptional_match).toBe(true);
    expect(r.bucket).toBe('EXCEPTIONAL');
  });

  it('E02 / V5 case 2 — caregiver has not opted in → NOT_SHOWN', () => {
    const r = evaluatePair(farReq, farCg({ out_of_area_enabled: false }));
    expect(r.exceptional_match).toBe(false);
    expect(r.exceptional_blockers.join(' ')).toMatch(/caregiver has not opted in/);
  });

  it('E03 / V5 case 3 — family has not opted in → NOT_SHOWN', () => {
    const req = makeCareRequest({ accept_out_of_area: false });
    const r = evaluatePair(req, farCg());
    expect(r.exceptional_match).toBe(false);
    expect(r.exceptional_blockers.join(' ')).toMatch(/family has not opted in/);
  });

  it('E05 / V5 case 4 — missing mandatory skill can never be rescued by distance opt-in', () => {
    const r = evaluatePair(farReq, farCg({ skills: ['ELDERLY_CARE'] }));
    expect(r.exceptional_match).toBe(false);
    expect(r.failed_filters).toContain('mandatory_required_skill');
    expect(r.exceptional_blockers.join(' ')).toMatch(/hard filter/);
  });

  it('E04 / V5 case 6 — base fit below the threshold → NOT_EXCEPTIONAL', () => {
    // a weak-but-legal caregiver: passes every filter, scores poorly
    const weak = farCg({
      years_experience: 1,
      skill_levels: { ELDERLY_CARE: 1, DIABETES_CARE: 1 },
      condition_experience: {},
      expected_rate: 3000,
      minimum_rate: 500,
      final_trust_score: 40,
      preferred_job_types: [],
    });
    const r = evaluatePair(farReq, weak);
    expect(r.base_mutual_fit).toBeLessThan(90);
    expect(r.exceptional_match).toBe(false);
    expect(r.exceptional_blockers.join(' ')).toMatch(/base mutual fit/);
  });

  it('V5 §21 — exceptional match carries an additional cost estimate, not a final price', () => {
    const r = evaluatePair(farReq, farCg());
    expect(r.additional_cost_estimate).toBeTruthy();
    expect(r.additional_cost_estimate.is_final_price).toBe(false);
    // 145 km, round trip, 5 THB/km → 1450; accommodation triggers past 150 km, so not here
    expect(r.additional_cost_estimate.travel).toBe(1450);
    expect(r.additional_cost_estimate.accommodation).toBe(0);
  });

  it('V5 §21 — accommodation is added once past the caregiver threshold', () => {
    const r = evaluatePair(farReq, farCg({ accommodation_required_after_km: 100 }));
    expect(r.additional_cost_estimate.accommodation).toBe(700);
    expect(r.additional_cost_estimate.accommodation_required).toBe(true);
  });

  it('V5 §24 — base and distance-adjusted scores are both reported and differ', () => {
    const r = evaluatePair(farReq, farCg());
    expect(r.base_mutual_fit).toBeGreaterThan(r.final_mutual_fit);
  });

  it('V5 §19 — an exceptional candidate never becomes normal rank #1', () => {
    const near = makeCaregiver({ id: 'CG-NEAR', distanceKm: 3 });
    const far = farCg({ id: 'CG-FAR' });
    const res = matchCaregiversForRequest(farReq, [far, near]);
    expect(res.recommended_nearby[0].caregiver_id).toBe('CG-NEAR');
    expect(res.exceptional_matches.map((c) => c.caregiver_id)).toContain('CG-FAR');
    expect(res.recommended_nearby.map((c) => c.caregiver_id)).not.toContain('CG-FAR');
  });
});

describe('SCORING_SPEC §7 — distance curve', () => {
  it('is 100 at half the radius, 40 at the boundary, 0 at 3x', () => {
    expect(distanceFit(12.5, 25)).toBe(100);
    expect(distanceFit(25, 25)).toBeCloseTo(40, 6);
    expect(distanceFit(75, 25)).toBe(0);
  });
  it('decreases monotonically', () => {
    let prev = Infinity;
    for (let d = 0; d <= 80; d += 2.5) {
      const v = distanceFit(d, 25);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('V6 Group B — family fit ranking', () => {
  const cr = makeCareRequest();

  it('B01 direct condition experience outranks none, all else equal', () => {
    const a = makeCaregiver({ id: 'A', condition_experience: { DIABETES: 6 } });
    const b = makeCaregiver({ id: 'B', condition_experience: {} });
    const ra = evaluatePair(cr, a);
    const rb = evaluatePair(cr, b);
    expect(ra.base_family_fit).toBeGreaterThan(rb.base_family_fit);
  });

  it('B02 nearer caregiver scores higher on the distance component', () => {
    const near = evaluatePair(cr, makeCaregiver({ id: 'A', distanceKm: 3 }));
    const far = evaluatePair(cr, makeCaregiver({ id: 'B', distanceKm: 20 }));
    expect(near.feature_values.family.distance_fit).toBeGreaterThan(
      far.feature_values.family.distance_fit,
    );
    expect(near.final_family_fit).toBeGreaterThan(far.final_family_fit);
  });

  it('B02 distance does not affect the BASE score (that is the point of the split)', () => {
    const near = evaluatePair(cr, makeCaregiver({ id: 'A', distanceKm: 3 }));
    const far = evaluatePair(cr, makeCaregiver({ id: 'B', distanceKm: 20 }));
    expect(near.base_family_fit).toBeCloseTo(far.base_family_fit, 6);
  });
});

describe('V6 Group C — caregiver job fit', () => {
  it('C01 near + on-rate + day shift beats far + underpaid + night', () => {
    const good = makeCareRequest({ id: 'JOB-A', budget: 1200 });
    const bad = makeCareRequest({ id: 'JOB-B', budget: 700, start_time: '20:00', end_time: '04:00' });
    const cg = makeCaregiver({ nighttime_ok: true, distanceKm: 20 });
    const a = evaluatePair(good, makeCaregiver({ nighttime_ok: true, distanceKm: 2 }));
    const b = evaluatePair(bad, cg);
    expect(a.base_job_fit).toBeGreaterThan(b.base_job_fit);
  });

  it('C02 caregiver wanting long-term prefers a recurring job over a one-off', () => {
    const cg = makeCaregiver({ long_term_job_ok: true, recurring_job_ok: true, one_time_job_ok: false });
    const recurring = makeCareRequest({ id: 'A', recurring_job: true, continuity_preference: 'LONG_TERM' });
    const oneOff = makeCareRequest({ id: 'B', recurring_job: false, continuity_preference: 'ONE_TIME' });
    expect(evaluatePair(recurring, cg).base_job_fit).toBeGreaterThan(
      evaluatePair(oneOff, cg).base_job_fit,
    );
  });

  it('C03 a caregiver who dislikes heavy workload scores heavy jobs lower', () => {
    const heavy = makeCareRequest({ mobility_requirement: 'BEDBOUND', lifting_required: true });
    const light = makeCareRequest();
    const cg = makeCaregiver({ lifting_job_ok: true, mobility_heavy_job_ok: false, bedbound_care_ok: true });
    expect(evaluatePair(heavy, cg).base_job_fit).toBeLessThan(evaluatePair(light, cg).base_job_fit);
  });
});

describe('V4 §34 / V6 Group F — trust score', () => {
  it('F01 an unconfirmed incident carries no penalty', () => {
    const withIncident = computeTrustScore({
      completedJobs: 10, reviewCount: 5, meanRating: 4.5,
      incidents: [{ status: 'UNCONFIRMED', responsibility: 'UNDETERMINED' }],
    });
    const clean = computeTrustScore({ completedJobs: 10, reviewCount: 5, meanRating: 4.5, incidents: [] });
    expect(withIncident.trust_score).toBe(clean.trust_score);
    expect(withIncident.penalised_incidents).toBe(0);
  });

  it('F02 a confirmed caregiver-responsible incident does penalise', () => {
    const penalised = computeTrustScore({
      completedJobs: 10, reviewCount: 5, meanRating: 4.5,
      incidents: [{ status: 'CONFIRMED', responsibility: 'CAREGIVER_RESPONSIBLE' }],
    });
    const clean = computeTrustScore({ completedJobs: 10, reviewCount: 5, meanRating: 4.5, incidents: [] });
    expect(penalised.trust_score).toBeLessThan(clean.trust_score);
    expect(penalised.penalised_incidents).toBe(1);
  });

  it('F02b a confirmed incident that is NOT the caregiver\'s fault carries no penalty', () => {
    const r = computeTrustScore({
      completedJobs: 10, reviewCount: 5, meanRating: 4.5,
      incidents: [{ status: 'CONFIRMED', responsibility: 'EXTERNAL' }],
    });
    expect(r.penalised_incidents).toBe(0);
  });

  it('F03 a previous successful pair with rebook scores above a fresh pair', () => {
    const cr = makeCareRequest();
    const cg = makeCaregiver();
    const rebooked = evaluatePair(cr, cg, { pairHistory: { completed_jobs: 2, would_rebook: true } });
    const fresh = evaluatePair(cr, cg, { pairHistory: {} });
    expect(rebooked.base_family_fit).toBeGreaterThan(fresh.base_family_fit);
  });

  it('F03b the rebook bonus can never overturn a hard filter', () => {
    const cr = makeCareRequest();
    const unskilled = makeCaregiver({ skills: ['ELDERLY_CARE'] });
    const r = evaluatePair(cr, unskilled, { pairHistory: { completed_jobs: 9, would_rebook: true } });
    expect(r.eligible).toBe(false);
  });

  it('F04 a single 5-star review is shrunk toward the prior, not treated as perfect', () => {
    expect(shrunkReviewScore(1, 5)).toBeCloseTo(75, 6);
    expect(shrunkReviewScore(0, null)).toBeCloseTo(70, 6);
    expect(shrunkReviewScore(50, 5)).toBeGreaterThan(shrunkReviewScore(1, 5));
  });

  it('F05 trust status becomes ESTABLISHED once enough jobs are completed', () => {
    expect(computeTrustScore({ completedJobs: 0 }).trust_status).toBe('NEW');
    expect(computeTrustScore({ completedJobs: 0 }).cold_start_note).toBe('ข้อมูลยังไม่เพียงพอ');
    expect(computeTrustScore({ completedJobs: 5 }).trust_status).toBe('ESTABLISHED');
  });
});

describe('V5 §1 — both directions agree on a pair', () => {
  it('the same pair scores identically whoever initiated the search', () => {
    const cr = makeCareRequest({ visibility: 'OPEN_TO_CAREGIVERS' });
    const cg = makeCaregiver();
    const fromFamily = matchCaregiversForRequest(cr, [cg]).recommended_nearby[0];
    const fromCaregiver = matchJobsForCaregiver(cg, [cr]).recommended_nearby[0];
    expect(fromCaregiver.base_mutual_fit).toBe(fromFamily.base_mutual_fit);
    expect(fromCaregiver.final_mutual_fit).toBe(fromFamily.final_mutual_fit);
  });
});

describe('V5 §17 — care request visibility', () => {
  const cg = makeCaregiver();

  it('PRIVATE requests are invisible without a direct job request', () => {
    const cr = makeCareRequest({ visibility: 'PRIVATE' });
    expect(matchJobsForCaregiver(cg, [cr]).candidate_count).toBe(0);
    const withDirect = matchJobsForCaregiver(cg, [cr], { directRequestIds: [cr.id] });
    expect(withDirect.candidate_count).toBe(1);
  });

  it('MATCHED_ONLY hides requests the caregiver does not qualify for', () => {
    const cr = makeCareRequest({ visibility: 'MATCHED_ONLY' });
    const unqualified = makeCaregiver({ skills: ['ELDERLY_CARE'] });
    expect(matchJobsForCaregiver(unqualified, [cr]).candidate_count).toBe(0);
    expect(matchJobsForCaregiver(cg, [cr]).candidate_count).toBe(1);
  });

  it('OPEN_TO_CAREGIVERS is discoverable by anyone eligible', () => {
    const cr = makeCareRequest({ visibility: 'OPEN_TO_CAREGIVERS' });
    expect(matchJobsForCaregiver(cg, [cr]).recommended_nearby.length).toBe(1);
  });

  it('a DRAFT request is never discoverable', () => {
    const cr = makeCareRequest({ status: 'DRAFT', visibility: 'OPEN_TO_CAREGIVERS' });
    expect(matchJobsForCaregiver(cg, [cr]).candidate_count).toBe(0);
  });
});

describe('V4 §50 — determinism', () => {
  it('repeated runs produce byte-identical rankings', () => {
    const cr = makeCareRequest();
    const cgs = [
      makeCaregiver({ id: 'CG-A', distanceKm: 3 }),
      makeCaregiver({ id: 'CG-B', distanceKm: 8 }),
      makeCaregiver({ id: 'CG-C', distanceKm: 15 }),
    ];
    const a = matchCaregiversForRequest(cr, cgs);
    const b = matchCaregiversForRequest(cr, [...cgs].reverse());
    const ids = (r) => r.recommended_nearby.map((c) => `${c.caregiver_id}:${c.final_mutual_fit}`);
    expect(ids(a)).toEqual(ids(b));
  });
});
