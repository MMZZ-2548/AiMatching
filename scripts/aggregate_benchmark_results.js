/**
 * Aggregate every benchmark into the report structure V6 §18 prescribes.
 *
 *   SECTION A  System internal tests   (unit / API / E2E)
 *   SECTION B  Public operational      (Strathclyde)        PUBLIC_OPERATIONAL_BENCHMARK
 *   SECTION C  Public academic         (HHCRSP)             PUBLIC_ACADEMIC_BENCHMARK
 *   SECTION D  TrustCare controlled    (120 scenarios)      CONTROLLED_TEST
 *   SECTION E  Limitations
 *
 * V6 §0 and §12 govern the wording: evidence types stay separated, and no controlled-test number
 * is ever described as matching accuracy.
 *
 *   node scripts/aggregate_benchmark_results.js
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => resolve(ROOT, 'reports', p);

const read = (f) => (existsSync(R(f)) ? JSON.parse(readFileSync(R(f), 'utf8')) : null);

const strath = read('strathclyde_results.json')?.metrics ?? null;
const hhcrsp = read('hhcrsp_results.json')?.metrics ?? null;
const controlled = read('controlled_mutual_results.json')?.metrics ?? null;
const validator = read('hhcrsp_validator_results.json')?.summary ?? null;

// ── Section A: run the test suites for real rather than quoting a remembered number.
let tests = { ran: false };
try {
  const out = execSync('npx vitest run --reporter=json --outputFile=../reports/vitest.json', {
    cwd: resolve(ROOT, 'backend'),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  void out;
} catch {
  // vitest exits non-zero when tests fail; the JSON file is still written and is the source of truth
}
if (existsSync(R('vitest.json'))) {
  const v = JSON.parse(readFileSync(R('vitest.json'), 'utf8'));
  tests = {
    ran: true,
    total: v.numTotalTests,
    passed: v.numPassedTests,
    failed: v.numFailedTests,
    suites: v.numTotalTestSuites,
    pass_rate_pct: +((v.numPassedTests / v.numTotalTests) * 100).toFixed(2),
    duration_ms: v.testResults?.reduce((s, r) => s + ((r.endTime ?? 0) - (r.startTime ?? 0)), 0) ?? null,
  };
}

const summary = {
  generated_at: new Date().toISOString(),
  report_structure: 'V6 §18',
  evidence_separation_note:
    'Public benchmarks evidence constraint correctness only. The controlled dataset evidences ' +
    'rule and ranking conformance against team-authored expectations. Neither is matching ' +
    'accuracy, and no figure here may be presented as such (V6 §0, §12).',

  section_a_system_tests: tests,
  section_b_public_operational: strath,
  section_c_public_academic: hhcrsp,
  section_c_independent_validator: validator,
  section_d_controlled: controlled,

  section_e_limitations: [
    'No dataset used here has ground truth for which caregiver is genuinely the best match, so no accuracy figure is claimed (V6 §0).',
    'Strathclyde has no time-window field; windows are assumed as the scheduled time ±30 min and every time-window figure depends on that assumption.',
    'Strathclyde has no carer home locations, so travel is measured between consecutive visits only.',
    'Strathclyde has no explicit synchronization flag; CarerCount = 2 is interpreted as a synchronized visit.',
    'Strathclyde and HHCRSP contain no skills-with-levels, language, budget, trust or preference data, so Family Fit, Job Fit and Mutual Fit are NOT evidenced by either.',
    'HHCRSP service codes s1..sN are compatibility proxies with no clinical meaning (V6 §3).',
    'The upstream HHCRSP validator requires every patient in an instance to be served, so it could only judge the instances the greedy policy covered completely; the rest are reported as skipped, not as passes.',
    'Scheduling feasibility and service coverage figures reflect a deterministic greedy assignment policy, not an optimiser; they are not comparable to published optimal solutions.',
    'The controlled 120 cases were authored by the team. They test conformance to the specification, not real-world outcomes or user satisfaction.',
    'The Supabase schema is applied (42 tables, 32 RLS policies) and the two-sided flow was exercised end to end against it. The benchmark figures in this report were produced against the in-process store, which enforces the same rules and drives the same pure matching engine.',
    'Smart Intake, the Care Advisor and report structuring depend on an external model; their output is not deterministic and is excluded from every conformance figure.',
  ],
};

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(R('final_matching_validation_summary.json'), JSON.stringify(summary, null, 2));

// ── human-readable summary
const pct = (v) => (v == null ? 'n/a' : `${v}%`);
const md = `# TrustCare — Final Matching Validation Summary

Generated ${summary.generated_at}
Report structure follows Testing & Benchmark Plan V6 §18.

> ${summary.evidence_separation_note}

## Section A — System internal tests

| | |
|---|---|
| Test files | ${tests.suites ?? 'n/a'} |
| Tests total | ${tests.total ?? 'n/a'} |
| Passed | ${tests.passed ?? 'n/a'} |
| Failed | ${tests.failed ?? 'n/a'} |
| Pass rate | ${pct(tests.pass_rate_pct)} |

## Section B — Public operational benchmark · \`PUBLIC_OPERATIONAL_BENCHMARK\`

${strath ? `${strath.name}
${strath.institution} · DOI ${strath.doi}
Coverage ${strath.temporal_coverage} · ${strath.carer_count} carers · ${strath.visit_count} visits · ${strath.user_count} service users

| Metric | Value |
|---|---|
| Scheduling feasibility | ${pct(strath.scheduling_feasibility_rate_pct)} |
| Unscheduled visit rate | ${pct(strath.unscheduled_visit_rate_pct)} |
| Assignment constraint pass rate | ${pct(strath.assignment_constraint_pass_rate_pct)} |
| Double bookings | ${strath.double_booking_count} |
| Shift containment violations | ${strath.shift_containment_violations} |
| Time-window violations | ${strath.time_window_violations} (${pct(strath.time_window_violation_rate_pct)}) |
| Synchronized visit success | ${strath.synchronized_visits_satisfied}/${strath.synchronized_visits} (${pct(strath.synchronized_visit_success_rate_pct)}) |
| Travel feasibility | ${pct(strath.travel_feasibility_pct)} over ${strath.travel_legs_checked} legs |
| Runtime | ${strath.runtime_ms} ms |
| Latency p50/p95/p99 | ${strath.latency_ms_per_visit.p50} / ${strath.latency_ms_per_visit.p95} / ${strath.latency_ms_per_visit.p99} ms |

Not available in this dataset: ${strath.not_available_in_dataset.join(', ')}` : '_not run_'}

## Section C — Public academic constraint benchmark · \`PUBLIC_ACADEMIC_BENCHMARK\`

${hhcrsp ? `${hhcrsp.name}
${hhcrsp.institution}
${hhcrsp.repository} · Paper DOI ${hhcrsp.paper_doi} · ${hhcrsp.license}
Families ${hhcrsp.instance_families?.join(', ')} · ${hhcrsp.instances_run} instances · ${hhcrsp.total_tasks} tasks

| Metric | Value |
|---|---|
| Invalid skill/service assignments | ${hhcrsp.invalid_skill_service_assignments} (${pct(hhcrsp.invalid_skill_service_assignment_rate_pct)}) |
| Constraint satisfaction rate | ${pct(hhcrsp.constraint_satisfaction_rate_pct)} |
| Time-window pass rate | ${pct(hhcrsp.time_window_pass_rate_pct)} |
| Synchronization pass rate | ${hhcrsp.synchronized_satisfied}/${hhcrsp.synchronized_patients_staffed} staffed (${pct(hhcrsp.synchronization_pass_rate_pct)}) |
| Route validity | ${pct(hhcrsp.route_validity_pct)} over ${hhcrsp.route_legs_checked} legs |
| Caregiver overlaps | ${hhcrsp.caregiver_overlaps} |
| Mandatory service coverage | ${pct(hhcrsp.mandatory_service_coverage_rate_pct)} |
| Failures by rule | ${JSON.stringify(hhcrsp.failure_cases_by_rule)} |
| Runtime | ${hhcrsp.runtime_ms} ms |

### Independent verification

${validator ? `The repository ships its own Python validator (MIT, written by the dataset authors).
Running it over the solutions our engine produced is stronger evidence than our own audit, because
it shares no code with the system under test.

| | |
|---|---|
| Solutions submitted | ${validator.solutions_submitted} |
| Judged | ${validator.judged} |
| **VALID** | **${validator.valid}** |
| INVALID | ${validator.invalid} |
| Skipped (partial coverage) | ${validator.skipped_incomplete_coverage} |
| **Validator pass rate** | **${pct(validator.validator_pass_rate_pct)}** |

${validator.note}` : '_validator not run_'}

${hhcrsp.service_code_note}` : '_not run_'}

## Section D — TrustCare controlled mutual matching · \`CONTROLLED_TEST\`

${controlled ? `${controlled.source}
${controlled.total_cases} scenarios · ${controlled.passed} passed · ${controlled.failed} failed · phase ${controlled.tuning_phase}

| Metric | Value |
|---|---|
| Overall rule conformance | ${pct(controlled.overall_conformance_pct)} |
| A · Hard filter accuracy | ${pct(controlled.group_a_hard_filter.hard_filter_accuracy_pct)} |
| B · Pairwise ranking agreement | ${pct(controlled.group_b_family_fit.pairwise_ranking_agreement_pct)} |
| B · Score stability | ${pct(controlled.group_b_family_fit.score_stability_pct)} |
| C · Job ranking agreement | ${pct(controlled.group_c_job_fit.job_ranking_agreement_pct)} |
| C · Preference constraint pass | ${pct(controlled.group_c_job_fit.preference_constraint_pass_pct)} |
| C · Invalid recommendation rate | ${pct(controlled.group_c_job_fit.invalid_recommendation_rate_pct)} |
| D · Mutual formula agreement | ${pct(controlled.group_d_mutual_fit.mutual_formula_agreement_pct)} |
| D · One-sided bias test | ${pct(controlled.group_d_mutual_fit.one_sided_bias_test_pct)} |
| D · Two-direction symmetry | ${pct(controlled.group_d_mutual_fit.two_direction_symmetry_pct)} |
| E · Exceptional match rule accuracy | ${pct(controlled.group_e_exceptional.exceptional_match_rule_accuracy_pct)} |
| E · Safety override accuracy | ${pct(controlled.group_e_exceptional.safety_override_accuracy_pct)} |
| E · Additional cost disclosure pass | ${pct(controlled.group_e_exceptional.additional_cost_disclosure_pass_pct)} |
| F · Trust penalty false positive rate | ${pct(controlled.group_f_trust.trust_penalty_false_positive_rate_pct)} |
| F · Rebook signal pass | ${pct(controlled.group_f_trust.rebook_signal_pass_pct)} |
| F · Cold-start conformance | ${pct(controlled.group_f_trust.cold_start_conformance_pct)} |
| Latency p50/p95/p99 | ${controlled.latency_ms.p50} / ${controlled.latency_ms.p95} / ${controlled.latency_ms.p99} ms |

${controlled.disclaimer}` : '_not run_'}

## Section E — Limitations

${summary.section_e_limitations.map((l) => `- ${l}`).join('\n')}
`;

writeFileSync(R('final_matching_validation_summary.md'), md);
writeFileSync(R('benchmark_summary.md'), md);

console.log('Section A  tests   ', tests.passed ?? '?', '/', tests.total ?? '?');
console.log('Section B  Strath  ', strath ? `${strath.scheduling_feasibility_rate_pct}% feasible, ${strath.double_booking_count} double bookings` : 'not run');
console.log('Section C  HHCRSP  ', hhcrsp ? `${hhcrsp.invalid_skill_service_assignments} invalid assignments, ${hhcrsp.constraint_satisfaction_rate_pct}% constraint satisfaction` : 'not run');
console.log('  independent validator', validator ? `${validator.valid}/${validator.judged} valid = ${validator.validator_pass_rate_pct}%` : 'not run');
console.log('Section D  Controlled', controlled ? `${controlled.passed}/${controlled.total_cases} = ${controlled.overall_conformance_pct}%` : 'not run');
console.log('\nWrote reports/final_matching_validation_summary.{json,md} and reports/benchmark_summary.md');
