# TrustCare — Final Matching Validation Summary

Generated 2026-08-29T13:58:17.574Z
Report structure follows Testing & Benchmark Plan V6 §18.

> Public benchmarks evidence constraint correctness only. The controlled dataset evidences rule and ranking conformance against team-authored expectations. Neither is matching accuracy, and no figure here may be presented as such (V6 §0, §12).

## Section A — System internal tests

| | |
|---|---|
| Test files | 41 |
| Tests total | 138 |
| Passed | 138 |
| Failed | 0 |
| Pass rate | 100% |

## Section B — Public operational benchmark · `PUBLIC_OPERATIONAL_BENCHMARK`

Dataset of Home Care Scheduling and Routing Problems with Synchronized Visits
University of Strathclyde, UK · DOI 10.15129/2d4885e1-bc24-414b-83ce-a846fb5c9689
Coverage 2017-10-01 to 2017-10-14 · 138 carers · 6805 visits · 236 service users

| Metric | Value |
|---|---|
| Scheduling feasibility | 60.5% |
| Unscheduled visit rate | 39.5% |
| Assignment constraint pass rate | 100% |
| Double bookings | 0 |
| Shift containment violations | 0 |
| Time-window violations | 0 (0%) |
| Synchronized visit success | 906/1493 (60.68%) |
| Travel feasibility | 100% over 4213 legs |
| Runtime | 24943 ms |
| Latency p50/p95/p99 | 1.734 / 12.446 / 23.892 ms |

Not available in this dataset: skills, skill_levels, language, budget, rate, trust_history, caregiver_preferences, family_preferences, mutual_interest, carer_home_location, explicit_time_windows, explicit_synchronization_flag

## Section C — Public academic constraint benchmark · `PUBLIC_ACADEMIC_BENCHMARK`

Data and Toolbox Repository for the Home Healthcare Routing and Scheduling Problem
Intelligent Optimization Laboratory, Università degli Studi di Udine, Italy
https://github.com/iolab-uniud/hhcrsp · Paper DOI 10.1111/itor.13585 · MIT
Families mankowska, kummer, Italian · 341 instances · 66952 tasks

| Metric | Value |
|---|---|
| Invalid skill/service assignments | 0 (0%) |
| Constraint satisfaction rate | 100% |
| Time-window pass rate | 100% |
| Synchronization pass rate | 13833/13833 staffed (100%) |
| Route validity | 100% over 63589 legs |
| Caregiver overlaps | 0 |
| Mandatory service coverage | 94.98% |
| Failures by rule | {} |
| Runtime | 51108 ms |

### Independent verification

The repository ships its own Python validator (MIT, written by the dataset authors).
Running it over the solutions our engine produced is stronger evidence than our own audit, because
it shares no code with the system under test.

| | |
|---|---|
| Solutions submitted | 341 |
| Judged | 125 |
| **VALID** | **125** |
| INVALID | 0 |
| Skipped (partial coverage) | 216 |
| **Validator pass rate** | **100%** |

The upstream validator requires every patient in an instance to be served before it will assess constraints, so instances our greedy policy left partially covered cannot be judged. Coverage is a property of that policy; this figure is about whether the assignments actually made satisfy the published constraints.

service codes s1..sN are compatibility proxies with no clinical meaning in this dataset (V6 §3)

## Section D — TrustCare controlled mutual matching · `CONTROLLED_TEST`

TrustCare Controlled Mutual Matching Benchmark (team-created)
120 scenarios · 120 passed · 0 failed · phase PRE_TUNING

| Metric | Value |
|---|---|
| Overall rule conformance | 100% |
| A · Hard filter accuracy | 100% |
| B · Pairwise ranking agreement | 100% |
| B · Score stability | 100% |
| C · Job ranking agreement | 100% |
| C · Preference constraint pass | 100% |
| C · Invalid recommendation rate | 0% |
| D · Mutual formula agreement | 100% |
| D · One-sided bias test | 100% |
| D · Two-direction symmetry | 100% |
| E · Exceptional match rule accuracy | 100% |
| E · Safety override accuracy | 100% |
| E · Additional cost disclosure pass | 100% |
| F · Trust penalty false positive rate | 0% |
| F · Rebook signal pass | 100% |
| F · Cold-start conformance | 100% |
| Latency p50/p95/p99 | 0.06 / 0.204 / 0.513 ms |

Measures rule and ranking conformance against team-authored expectations. NOT matching accuracy: this dataset has no ground truth for which caregiver is genuinely best (V6 §0, §12).

## Section E — Limitations

- No dataset used here has ground truth for which caregiver is genuinely the best match, so no accuracy figure is claimed (V6 §0).
- Strathclyde has no time-window field; windows are assumed as the scheduled time ±30 min and every time-window figure depends on that assumption.
- Strathclyde has no carer home locations, so travel is measured between consecutive visits only.
- Strathclyde has no explicit synchronization flag; CarerCount = 2 is interpreted as a synchronized visit.
- Strathclyde and HHCRSP contain no skills-with-levels, language, budget, trust or preference data, so Family Fit, Job Fit and Mutual Fit are NOT evidenced by either.
- HHCRSP service codes s1..sN are compatibility proxies with no clinical meaning (V6 §3).
- The upstream HHCRSP validator requires every patient in an instance to be served, so it could only judge the instances the greedy policy covered completely; the rest are reported as skipped, not as passes.
- Scheduling feasibility and service coverage figures reflect a deterministic greedy assignment policy, not an optimiser; they are not comparable to published optimal solutions.
- The controlled 120 cases were authored by the team. They test conformance to the specification, not real-world outcomes or user satisfaction.
- The Supabase schema is applied (42 tables, 32 RLS policies) and the two-sided flow was exercised end to end against it. The benchmark figures in this report were produced against the in-process store, which enforces the same rules and drives the same pure matching engine.
- Smart Intake, the Care Advisor and report structuring depend on an external model; their output is not deterministic and is excluded from every conformance figure.
