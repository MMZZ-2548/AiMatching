/**
 * TrustCare Controlled Mutual Matching Benchmark — runner.
 * V6 §11 STEP 11. LABEL: CONTROLLED_TEST.
 *
 * Executes the 120 generated cases against the real engine and reports the metrics named in
 * V6 §6–§11. These measure *rule and ranking conformance* against team-authored expectations —
 * they are not matching accuracy, and V6 §0 forbids presenting them as such.
 *
 *   node scripts/run_controlled_matching_benchmark.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePair,
  matchCaregiversForRequest,
  matchJobsForCaregiver,
} from '../backend/src/matching/engine.js';
import { computeTrustScore } from '../backend/src/matching/trust.js';
import { MUTUAL_FAMILY_WEIGHT, MUTUAL_JOB_WEIGHT, TRUST } from '../backend/src/matching/config.js';
import { pointAtKm } from '../backend/tests/fixtures.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = readFileSync(resolve(ROOT, 'data/trustcare_controlled_mutual_120.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const results = [];
const latencies = [];

const record = (c, pass, actual, detail) => {
  results.push({
    case_id: c.case_id,
    group: c.group,
    kind: c.kind,
    title: c.title,
    expected: c.expected,
    actual,
    pass,
    detail: detail ?? null,
  });
};

const band = (m) => (m >= 85 ? 'HIGH' : m >= 60 ? 'MODERATE' : 'LOW');

for (const c of cases) {
  const t0 = process.hrtime.bigint();
  try {
    runCase(c);
  } catch (err) {
    record(c, false, 'ERROR', err.message);
  }
  latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

function runCase(c) {
  const ctx = { busy: c.ctx?.busy ?? [] };

  // ── formula-only cases (Group D): assert the published arithmetic directly
  if (c.kind === 'FORMULA') {
    const m = MUTUAL_FAMILY_WEIGHT * c.inputs.base_family_fit + MUTUAL_JOB_WEIGHT * c.inputs.base_job_fit;
    const pass = Math.abs(m - c.expected.mutual) < 1e-9 && band(m) === c.expected.band;
    return record(c, pass, { mutual: Number(m.toFixed(3)), band: band(m) });
  }

  if (c.kind === 'FORMULA_ORDER') {
    const mk = ([f, j]) => MUTUAL_FAMILY_WEIGHT * f + MUTUAL_JOB_WEIGHT * j;
    const lower = mk(c.expected.lower);
    const higher = mk(c.expected.higher);
    return record(c, higher > lower, { lower: +lower.toFixed(3), higher: +higher.toFixed(3) });
  }

  // ── trust cases (Group F)
  if (c.kind === 'TRUST') {
    const input = { completedJobs: 10, reviewCount: 5, meanRating: 4.5, ...c.trust_input };
    const got = computeTrustScore(input);
    const baseline = computeTrustScore({ ...input, incidents: [] });
    let pass;
    switch (c.expected.decision) {
      case 'NO_PENALTY':
        pass = got.penalised_incidents === 0 && got.trust_score === baseline.trust_score;
        break;
      case 'PENALTY':
        pass = got.penalised_incidents > 0 && got.trust_score < baseline.trust_score;
        break;
      case 'SHRUNK':
        pass = got.components.family_review < 100 && got.components.family_review > TRUST.priorRating * 20;
        break;
      case 'HIGH_REVIEW':
        pass = got.components.family_review > 90;
        break;
      case 'COLD_START':
        pass = got.trust_status === 'NEW' && got.cold_start_note != null;
        break;
      case 'ESTABLISHED':
        pass = got.trust_status === 'ESTABLISHED';
        break;
      default:
        pass = false;
    }
    return record(c, pass, {
      trust_score: got.trust_score,
      family_review: +got.components.family_review.toFixed(2),
      penalised_incidents: got.penalised_incidents,
      trust_status: got.trust_status,
    });
  }

  // ── symmetry (Group D): the same pair from both directions
  if (c.kind === 'SYMMETRY') {
    const cr = c.care_request;
    const cg = c.caregivers[0];
    const fromFamily = matchCaregiversForRequest(cr, [cg]).recommended_nearby[0];
    const fromCaregiver = matchJobsForCaregiver(cg, [cr]).recommended_nearby[0];
    const pass =
      fromFamily &&
      fromCaregiver &&
      fromFamily.base_mutual_fit === fromCaregiver.base_mutual_fit &&
      fromFamily.final_mutual_fit === fromCaregiver.final_mutual_fit;
    return record(c, Boolean(pass), {
      family_side: fromFamily?.final_mutual_fit ?? null,
      caregiver_side: fromCaregiver?.final_mutual_fit ?? null,
    });
  }

  // ── stability (Group B): identical inputs must produce identical scores
  if (c.kind === 'STABILITY') {
    const runs = Array.from({ length: 3 }, () =>
      c.caregivers.map((cg) => evaluatePair(c.care_request, cg, ctx).final_mutual_fit),
    );
    const pass = runs.every((r) => JSON.stringify(r) === JSON.stringify(runs[0]));
    return record(c, pass, { runs: runs[0] });
  }

  // ── ranking (Groups B, C, F03)
  if (c.kind === 'RANKING') {
    if (c.expected.winner_job) {
      // Group C: one caregiver, two jobs
      const cg = c.caregivers[0];
      const far = c.ctx?.far_variant_km;
      const [jobA, jobB] = c.jobs;
      const cgFar = far ? { ...cg, ...pointToBase(pointAtKm(far)) } : cg;
      const a = evaluatePair(jobA, cg, ctx);
      const b = evaluatePair(jobB, far ? cgFar : cg, ctx);
      const key = c.expected.score;
      const ok = c.expected.comparison === 'GTE' ? a[key] >= b[key] : a[key] > b[key];
      return record(c, ok, { [`${key}_A`]: a[key], [`${key}_B`]: b[key] });
    }

    // Groups B / F03: two caregivers, one job
    const hist = c.ctx?.pair_history ?? {};
    const scored = c.caregivers.map((cg) =>
      evaluatePair(c.care_request, cg, { ...ctx, pairHistory: hist[cg.id] ?? {} }),
    );
    const byId = Object.fromEntries(scored.map((s) => [s.caregiver_id, s]));
    const key = c.expected.score;
    const w = byId[c.expected.winner]?.[key];
    const l = byId[c.expected.loser]?.[key];
    const ok = c.expected.comparison === 'GTE' ? w >= l : w > l;
    return record(c, ok, { winner: w, loser: l });
  }

  // ── decisions (Groups A, C constraints, E)
  const cr = c.care_request;
  const cg = c.caregivers[0];
  const r = evaluatePair(cr, cg, ctx);

  switch (c.expected.decision) {
    case 'FILTER_OUT': {
      const pass = !r.eligible && !r.exceptional_match && r.failed_filters.includes(c.expected.failed_filter ?? '');
      return record(c, c.expected.failed_filter ? pass : !r.eligible, {
        eligible: r.eligible,
        failed_filters: r.failed_filters,
      });
    }
    case 'ELIGIBLE':
      return record(c, r.eligible, { eligible: r.eligible, failed_filters: r.failed_filters });

    case 'RECOMMENDED': {
      const res = matchJobsForCaregiver(cg, [cr], ctx);
      return record(c, res.recommended_nearby.length === 1, { recommended: res.recommended_nearby.length });
    }
    case 'NOT_RECOMMENDED': {
      const res = matchJobsForCaregiver(cg, [cr], ctx);
      return record(c, res.recommended_nearby.length === 0, {
        recommended: res.recommended_nearby.length,
        failed_filters: r.failed_filters,
      });
    }

    case 'EXCEPTIONAL_MATCH':
      return record(c, r.exceptional_match && r.bucket === 'EXCEPTIONAL' && r.additional_cost_estimate != null, {
        exceptional: r.exceptional_match,
        base_mutual_fit: r.base_mutual_fit,
        cost: r.additional_cost_estimate,
        blockers: r.exceptional_blockers,
      });

    case 'EXCEPTIONAL_WITH_ACCOMMODATION':
      return record(
        c,
        r.exceptional_match && r.additional_cost_estimate?.accommodation_required === true,
        { exceptional: r.exceptional_match, cost: r.additional_cost_estimate },
      );

    case 'NOT_SHOWN':
      return record(c, !r.exceptional_match && !r.eligible, {
        exceptional: r.exceptional_match,
        eligible: r.eligible,
        blockers: r.exceptional_blockers,
      });

    case 'NOT_EXCEPTIONAL':
      return record(c, !r.exceptional_match, {
        exceptional: r.exceptional_match,
        base_mutual_fit: r.base_mutual_fit,
        blockers: r.exceptional_blockers,
      });

    default:
      return record(c, false, 'UNKNOWN_EXPECTATION');
  }
}

function pointToBase(p) {
  return { base_latitude: p.lat, base_longitude: p.lng };
}

// ═══════════════════════════════════════════ metrics (V6 §6–§11)

const of = (g) => results.filter((r) => r.group === g);
const rate = (list) => (list.length === 0 ? null : +((list.filter((r) => r.pass).length / list.length) * 100).toFixed(2));
const pct = (n, d) => (d === 0 ? null : +((n / d) * 100).toFixed(2));

const groupA = of('A');
const groupB = of('B');
const groupC = of('C');
const groupD = of('D');
const groupE = of('E');
const groupF = of('F');

// Group C: an "invalid recommendation" is a caregiver being offered work they cannot legally or
// preferentially take. Any NOT_RECOMMENDED case that came back recommended is one.
const invalidRecommendations = groupC.filter(
  (r) => r.expected.decision === 'NOT_RECOMMENDED' && !r.pass,
).length;

// Group E: safety override accuracy — did a hard filter ever get overridden by the distance
// exception? V5 §25 says it must never happen.
const safetyCases = groupE.filter((r) => r.expected.decision === 'FILTER_OUT');
// Group F: a false positive is a trust penalty applied where none was warranted.
const noPenaltyCases = groupF.filter((r) => r.expected.decision === 'NO_PENALTY');
const trustFalsePositives = noPenaltyCases.filter((r) => !r.pass).length;

const sortedLat = [...latencies].sort((a, b) => a - b);
const p = (q) => +(sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * q))] ?? 0).toFixed(3);

const metrics = {
  label: 'CONTROLLED_TEST',
  source: 'TrustCare Controlled Mutual Matching Benchmark (team-created)',
  disclaimer:
    'Measures rule and ranking conformance against team-authored expectations. NOT matching ' +
    'accuracy: this dataset has no ground truth for which caregiver is genuinely best (V6 §0, §12).',
  total_cases: results.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  overall_conformance_pct: rate(results),

  group_a_hard_filter: {
    cases: groupA.length,
    hard_filter_accuracy_pct: rate(groupA),
    formula: 'correct_filter_decisions / total_hard_filter_cases * 100',
  },
  group_b_family_fit: {
    cases: groupB.length,
    pairwise_ranking_agreement_pct: rate(groupB.filter((r) => r.kind === 'RANKING')),
    score_stability_pct: rate(groupB.filter((r) => r.kind === 'STABILITY')),
  },
  group_c_job_fit: {
    cases: groupC.length,
    job_ranking_agreement_pct: rate(groupC.filter((r) => r.kind === 'RANKING')),
    preference_constraint_pass_pct: rate(groupC.filter((r) => r.kind === 'DECISION')),
    invalid_recommendation_rate_pct: pct(invalidRecommendations, groupC.filter((r) => r.kind === 'DECISION').length),
    invalid_recommendations: invalidRecommendations,
  },
  group_d_mutual_fit: {
    cases: groupD.length,
    mutual_formula_agreement_pct: rate(groupD.filter((r) => r.kind === 'FORMULA')),
    one_sided_bias_test_pct: rate(groupD.filter((r) => r.kind === 'FORMULA_ORDER')),
    two_direction_symmetry_pct: rate(groupD.filter((r) => r.kind === 'SYMMETRY')),
  },
  group_e_exceptional: {
    cases: groupE.length,
    exceptional_match_rule_accuracy_pct: rate(groupE),
    safety_override_accuracy_pct: rate(safetyCases),
    additional_cost_disclosure_pass_pct: rate(
      groupE.filter((r) => String(r.expected.decision).startsWith('EXCEPTIONAL')),
    ),
  },
  group_f_trust: {
    cases: groupF.length,
    trust_penalty_false_positive_rate_pct: pct(trustFalsePositives, noPenaltyCases.length),
    rebook_signal_pass_pct: rate(groupF.filter((r) => r.kind === 'RANKING')),
    cold_start_conformance_pct: rate(
      groupF.filter((r) => ['COLD_START', 'ESTABLISHED', 'SHRUNK', 'HIGH_REVIEW'].includes(r.expected.decision)),
    ),
  },

  latency_ms: { p50: p(0.5), p95: p(0.95), p99: p(0.99), total: +latencies.reduce((a, b) => a + b, 0).toFixed(2) },
  score_version: process.env.MATCHING_SCORE_VERSION ?? 'matching-v4',
  weight_version: process.env.WEIGHT_PROFILE_VERSION ?? 'weights-v4-default',
  tuning_phase: 'PRE_TUNING',
  generated_at: new Date().toISOString(),
};

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(
  resolve(ROOT, 'reports/controlled_mutual_results.json'),
  JSON.stringify({ metrics, results }, null, 2),
);

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(
  resolve(ROOT, 'reports/controlled_mutual_results.csv'),
  ['case_id,group,kind,pass,title,expected,actual']
    .concat(
      results.map((r) =>
        [r.case_id, r.group, r.kind, r.pass, r.title, JSON.stringify(r.expected), JSON.stringify(r.actual)]
          .map(esc)
          .join(','),
      ),
    )
    .join('\n') + '\n',
);

console.log('\n=== TrustCare Controlled Mutual Matching Benchmark (CONTROLLED_TEST) ===\n');
console.log(`Cases           ${metrics.total_cases}`);
console.log(`Passed          ${metrics.passed}`);
console.log(`Failed          ${metrics.failed}`);
console.log(`Conformance     ${metrics.overall_conformance_pct}%\n`);
console.log(`A hard filter accuracy        ${metrics.group_a_hard_filter.hard_filter_accuracy_pct}%`);
console.log(`B pairwise ranking agreement  ${metrics.group_b_family_fit.pairwise_ranking_agreement_pct}%`);
console.log(`B score stability             ${metrics.group_b_family_fit.score_stability_pct}%`);
console.log(`C job ranking agreement       ${metrics.group_c_job_fit.job_ranking_agreement_pct}%`);
console.log(`C preference constraint pass  ${metrics.group_c_job_fit.preference_constraint_pass_pct}%`);
console.log(`C invalid recommendation rate ${metrics.group_c_job_fit.invalid_recommendation_rate_pct}%`);
console.log(`D mutual formula agreement    ${metrics.group_d_mutual_fit.mutual_formula_agreement_pct}%`);
console.log(`D one-sided bias test         ${metrics.group_d_mutual_fit.one_sided_bias_test_pct}%`);
console.log(`D two-direction symmetry      ${metrics.group_d_mutual_fit.two_direction_symmetry_pct}%`);
console.log(`E exceptional rule accuracy   ${metrics.group_e_exceptional.exceptional_match_rule_accuracy_pct}%`);
console.log(`E safety override accuracy    ${metrics.group_e_exceptional.safety_override_accuracy_pct}%`);
console.log(`E cost disclosure pass        ${metrics.group_e_exceptional.additional_cost_disclosure_pass_pct}%`);
console.log(`F trust penalty false pos.    ${metrics.group_f_trust.trust_penalty_false_positive_rate_pct}%`);
console.log(`F rebook signal pass          ${metrics.group_f_trust.rebook_signal_pass_pct}%`);
console.log(`F cold-start conformance      ${metrics.group_f_trust.cold_start_conformance_pct}%`);
console.log(`\nLatency p50/p95/p99 ms        ${metrics.latency_ms.p50} / ${metrics.latency_ms.p95} / ${metrics.latency_ms.p99}`);

const failures = results.filter((r) => !r.pass);
if (failures.length) {
  console.log(`\n--- ${failures.length} failing cases ---`);
  for (const f of failures) console.log(`  ${f.case_id} [${f.group}] ${f.title}\n    actual: ${JSON.stringify(f.actual)}`);
}
console.log('\nWrote reports/controlled_mutual_results.json and .csv');
