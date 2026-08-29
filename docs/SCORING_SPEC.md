# TrustCare — Scoring Specification (SCORING_SPEC v1)

Normative source for every number the matching engine produces.

**Derived from:** Master System Spec V4 (§14–§20, §34), Ecosystem Addendum V5 (§18–§27),
Testing & Benchmark Plan V6 (§6–§11).

**Rule:** V4 is normative for weights and formulas. V5 is normative for the two-sided flow,
the base/final score split, and exceptional-distance policy. Where V5 shows an *example number*
that V4's weights cannot reproduce, V4's weights win and the deviation is recorded in §9.

**Determinism:** every function here is pure and deterministic. No LLM participates in any
number on this page (V4 §0, §4). GPT is used only to phrase explanations from a completed
score breakdown (V4 §21).

---

## 1. Score pipeline

```
                 ┌──────────────────┐
care_request ───▶│  1. HARD FILTERS │──▶ eligible = false ──▶ filtered_out[]
caregiver    ───▶└──────────────────┘
                          │ eligible
                          ▼
        ┌─────────────────────────────────────┐
        │ 2. FEATURE EXTRACTION (0–100 each)  │
        └─────────────────────────────────────┘
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
   base_family_fit (§4)          base_job_fit (§5)
   distance EXCLUDED             travel EXCLUDED
            └─────────────┬──────────────┘
                          ▼
              base_mutual_fit = 0.60·F + 0.40·J        (§6)
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │ 3. DISTANCE REINTEGRATION (§7)      │
        └─────────────────────────────────────┘
                          ▼
              final_mutual_fit (distance-adjusted)
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │ 4. BUCKETING (§8)                   │
        │  recommended_nearby | exceptional   │
        └─────────────────────────────────────┘
```

Both `base_*` and `final_*` are persisted on every candidate (V5 §24 requires the UI to show
"Compatibility 95 / Distance-adjusted 78" as two distinct numbers).

---

## 2. Hard filters

All 14 filters from V4 §14. Any failure ⇒ `eligible = false`, candidate goes to `filtered_out[]`
with `failed_filters[]`. GPT may never override (V4 §14). Distance is the **only** soft exception
(V5 §25) — it is filter 6 and is re-admitted by §8, everything else is absolute.

| # | id | Fails when |
|---|----|-----------|
| 1 | `verification_status` | caregiver `verification_status != VERIFIED` |
| 2 | `mandatory_required_skill` | any `required_skills[]` with strength `MANDATORY` not in caregiver `skills[]` |
| 3 | `mandatory_credential` | request demands a credential the caregiver has no valid certificate/license for |
| 4 | `minimum_skill_level` | caregiver's level for a mandatory skill < requested minimum |
| 5 | `availability` | request date/time not covered by caregiver availability, or collides with an accepted job |
| 6 | `service_radius` | `distance_km > service_radius_km` — **soft**, see §8 |
| 7 | `shift_length` | shift hours > `max_hours_per_shift` |
| 8 | `mandatory_language` | a `MANDATORY` language not in caregiver `languages[]` |
| 9 | `mandatory_gender` | gender preference present **and** strength `MANDATORY` **and** mismatch |
| 10 | `caregiver_task_exclusion` | a `MUST_DO` task is in caregiver `not_preferred_job_types[]` as a hard exclusion |
| 11 | `hospital_escort` | request requires escort **and** `hospital_escort_ok = false` |
| 12 | `heavy_lifting` | request requires lifting **and** `lifting_job_ok = false` |
| 13 | `budget_below_minimum` | `budget < minimum_rate` **and** `BUDGET_BELOW_MINIMUM_POLICY = FILTER` |
| 14 | `live_in` | request is live-in **and** `live_in_ok = false` |

### Config decisions locked here

V4/V5/V6 all left these "ตาม config". Fixed values for the build and for every benchmark run:

| Setting | Value | Resolves |
|---|---|---|
| `BUDGET_BELOW_MINIMUM_POLICY` | `FILTER` | V4 §14.13 / V4 test 6 / V6 A10 |
| verification `PENDING` | `FILTER_OUT` (not HOLD) | V6 A09 |
| `CHAT_UNLOCK_STAGE` | `MUTUAL_MATCH` | V4 §24 / V5 §9 |
| night job vs `nighttime_ok=false` | filter 5 (availability) | V4 test 7 |

---

## 3. Feature → bucket mapping

V4 §15 names **20** Family Fit features but §18 gives only **11** weight buckets; V4 §16 names
**20** Job Fit features against **9** buckets in §19; V6 §7 gives a third, shorter list. This table
is the single reconciliation. Every feature listed in any of the three documents lands in exactly
one bucket. A bucket's value is the **mean of its member features that are applicable** to the
request (non-applicable features are dropped, not scored 0 — V4 §41.20: unknown optional field is
neutral).

### 3.1 Family Fit buckets

| Bucket (V4 §18) | V4 §18 weight | Member features (V4 §15 numbering) |
|---|---|---|
| `skill_match` | 20 | 1 skill_match_score, 3 skill_level_fit |
| `experience_condition_fit` | 15 | 2 experience_match, 4 condition_experience_fit |
| `schedule_fit` | 12 | 9 schedule_fit |
| `distance_travel_fit` | 10 | 7 distance_fit, 8 travel_time_fit — **removed, see §4** |
| `trust_history` | 10 | 18 trust_history_score, 19 previous_successful_match |
| `task_expectation_fit` | 8 | 6 task_expectation_fit, 15 personal_care_compatibility |
| `mobility_physical_fit` | 7 | 5 mobility_support_fit, 16 physical_workload_fit, 17 transport_fit |
| `budget_rate_fit` | 5 | 10 budget_rate_fit |
| `language_communication_fit` | 5 | 11 language_match, 13 communication_style_fit |
| `continuity_fit` | 4 | 14 continuity_fit |
| `care_style_preference_fit` | 4 | 12 care_style_fit, 20 caregiver_preference_fit |
| | **100** | all 20 features placed |

### 3.2 Caregiver Job Fit buckets

| Bucket (V4 §19) | V4 §19 weight | Member features (V4 §16 numbering) |
|---|---|---|
| `rate_fit` | 20 | 1 rate_fit, 20 minimum_rate_fit |
| `schedule_preference_fit` | 18 | 4 schedule_preference_fit, 6 day_night_preference_fit, 19 recurring_schedule_fit |
| `travel_burden_fit` | 15 | 2 travel_burden_fit, 3 travel_compensation_fit, 13 location_preference_fit — **removed, see §5** |
| `job_type_preference_fit` | 15 | 7 job_type_preference_fit, 15 caregiver_task_preference_fit, 16 caregiver_condition_preference_fit, 17 caregiver_priority_fit |
| `physical_workload_fit` | 12 | 8 physical_workload_fit, 9 lifting_transfer_fit |
| `continuity_preference_fit` | 8 | 12 continuity_preference_fit, 18 work_duration_fit |
| `shift_length_fit` | 5 | 5 shift_length_fit |
| `transport_hospital_fit` | 4 | 10 hospital_escort_fit, 11 transport_fit |
| `environment_fit` | 3 | 14 environment_fit |
| | **100** | all 20 features placed |

---

## 4. `base_family_fit` — distance excluded, renormalised

Per the decision recorded in §9-B, `distance_travel_fit` (weight 10) is **removed** from Family Fit
and the remaining 90 points are renormalised to 100 by factor `100/90`.

| Bucket | V4 weight | base weight (×100/90) |
|---|---|---|
| skill_match | 20 | **22.222** |
| experience_condition_fit | 15 | **16.667** |
| schedule_fit | 12 | **13.333** |
| trust_history | 10 | **11.111** |
| task_expectation_fit | 8 | **8.889** |
| mobility_physical_fit | 7 | **7.778** |
| budget_rate_fit | 5 | **5.556** |
| language_communication_fit | 5 | **5.556** |
| continuity_fit | 4 | **4.444** |
| care_style_preference_fit | 4 | **4.444** |
| **TOTAL** | 90 | **100.000** |

```
base_family_fit = Σ (bucket_value × base_weight) / 100        → 0..100
```

Weights are stored in `matching_weight_profiles`, versioned by `WEIGHT_PROFILE_VERSION`, and are
configurable (V4 §18: "ต้อง configurable ไม่เรียก learned weights").

## 5. `base_job_fit` — travel excluded, renormalised

`travel_burden_fit` (weight 15) is removed; remaining 85 renormalised by `100/85`.

| Bucket | V4 weight | base weight (×100/85) |
|---|---|---|
| rate_fit | 20 | **23.529** |
| schedule_preference_fit | 18 | **21.176** |
| job_type_preference_fit | 15 | **17.647** |
| physical_workload_fit | 12 | **14.118** |
| continuity_preference_fit | 8 | **9.412** |
| shift_length_fit | 5 | **5.882** |
| transport_hospital_fit | 4 | **4.706** |
| environment_fit | 3 | **3.529** |
| **TOTAL** | 85 | **100.000** |

---

## 6. `base_mutual_fit`

V4 §20, normative:

```
base_mutual_fit = 0.60 × base_family_fit + 0.40 × base_job_fit
```

`MUTUAL_WEIGHT_FAMILY = 0.60`, `MUTUAL_WEIGHT_JOB = 0.40`, configurable; V4 §20 offers 0.50/0.50 as
an option. Verified against every worked example in the source documents:

| Case | family | job | base_mutual | Expected | ✓ |
|---|---|---|---|---|---|
| V5 §24 | 96 | 94 | 95.2 | 95 | ✓ |
| V6 D01 | 95 | 45 | 75.0 | moderate | ✓ |
| V6 D02 | 88 | 90 | 88.8 | high | ✓ |
| V6 D03 | 92 | 93 | 92.4 | top | ✓ |
| V6 D04a | 98 | 40 | 74.8 | ranks below D04b | ✓ |
| V6 D04b | 90 | 90 | 90.0 | ranks above D04a | ✓ |

> **Known property.** 0.60/0.40 is deliberately family-biased, so a one-sided pair can still score
> respectably (D01 = 75). V6 §9 "One-sided Bias Test" must therefore assert *relative* ordering
> (D04b > D04a), never an absolute ceiling on one-sided pairs. Recorded so the benchmark does not
> mistake the spec's intent for a defect.

---

## 7. Distance reintegration → `final_*`

Distance re-enters at its original V4 weight, applied to the renormalised base scores. This keeps
V4's weights intact *and* produces the two distinct numbers V5 §24 requires.

```
final_family_fit = 0.90 × base_family_fit + 0.10 × distance_travel_fit
final_job_fit    = 0.85 × base_job_fit    + 0.15 × travel_burden_fit
final_mutual_fit = 0.60 × final_family_fit + 0.40 × final_job_fit
```

Component functions (`d` = road distance km, `r` = `service_radius_km`, `t` = travel minutes,
`t_max` = `max_travel_time_minutes`):

```
distance_fit(d, r)      = 100                        if d ≤ 0.5r
                        = 100 − 60·(d − 0.5r)/(0.5r)  if 0.5r < d ≤ r      → 100 down to 40
                        = max(0, 40 − 40·(d − r)/(2r)) if d > r            → 40 down to 0
travel_time_fit(t,t_max)= clamp(0, 100·(1 − t/t_max), 100)
distance_travel_fit     = 0.6·distance_fit + 0.4·travel_time_fit
travel_burden_fit       = distance_travel_fit adjusted by travel_fee_policy coverage (§3.2)
```

The curve is continuous, hits exactly 40 at the radius boundary, and reaches 0 at 3× radius — so a
145 km candidate against a 25 km radius scores 0 on distance, which is the intended outcome.

---

## 8. Exceptional far match (V5 §19–§27)

Filter 6 (`service_radius`) is the only soft filter. A candidate that fails **only** filter 6 is
re-examined:

```
exceptional_match = EXCEPTIONAL_MATCH_ENABLED
  AND all hard filters except #6 pass
  AND all MANDATORY skills present            (EXCEPTIONAL_MANDATORY_SKILLS_REQUIRED)
  AND base_mutual_fit >= 90                   (EXCEPTIONAL_BASE_FIT_THRESHOLD)
  AND distance_km <= 300                      (EXCEPTIONAL_MAX_DISTANCE_KM)
  AND caregiver.out_of_area_enabled           (EXCEPTIONAL_REQUIRE_CAREGIVER_OPT_IN)
  AND care_request.accept_out_of_area         (EXCEPTIONAL_REQUIRE_FAMILY_OPT_IN)
  AND distance_km <= caregiver.max_out_of_area_distance_km
  AND travel/logistics feasible AND schedule still satisfied
```

Note the threshold is tested against **`base_mutual_fit`** ("ก่อน distance penalty", V5 §20.3) —
this is precisely why §4/§5 strip distance out. Testing it against `final_mutual_fit` would make the
rule unsatisfiable at long range.

Result buckets (V5 §27):

```json
{ "recommended_nearby": [...], "exceptional_matches": [...], "filtered_out": [...] }
```

`exceptional_matches` is ranked separately and **never merged into normal ranking** (V5 §19: must
not become normal rank #1). Each carries `additional_cost_estimate` (V5 §21):

```
travel        = distance_km × 2 × travel_fee_per_km
accommodation = accommodation_minimum   if distance_km ≥ accommodation_required_after_km else 0
total_extra   = travel + accommodation
```
Labelled "Estimated additional cost", never a final price (V5 §21).

Verified against all published cases:

| Case | base_mutual | dist | CG opt-in | Fam opt-in | mandatory skills | Expected | ✓ |
|---|---|---|---|---|---|---|---|
| V5 C1 / V6 E01 | 96 | 145 | ✓ | ✓ | ✓ | EXCEPTIONAL | ✓ |
| V5 C2 / V6 E02 | 96 | 145 | ✗ | ✓ | ✓ | NOT_SHOWN | ✓ |
| V5 C3 / V6 E03 | 96 | 145 | ✓ | ✗ | ✓ | NOT_SHOWN | ✓ |
| V5 C4 / V6 E05 | 96 | 145 | ✓ | ✓ | ✗ | FILTER_OUT | ✓ |
| V5 C5 | 91 | 45 | ✓ | ✓ | ✓ | EXCEPTIONAL | ✓ |
| V5 C6 / V6 E04 | 82 / 80 | 145 | ✓ | ✓ | ✓ | NOT_EXCEPTIONAL | ✓ |

---

## 9. Deviations from the source documents

Each deviation is deliberate, and each is reported in the final benchmark report under Limitations.

**A — Feature/bucket reconciliation (§3).** V4 §15/§16 list 20 features each but §18/§19 weight only
11 and 9 buckets; nine Job Fit features had no bucket at all. §3 assigns every feature to exactly
one bucket by mean aggregation. This is an addition, not a contradiction — no V4 weight changed.

**B — Distance removed from the fit scores (§4, §5).** V4 §18 scores distance *inside* Family Fit;
V5 §24 requires a `base_fit_without_distance`. Both cannot hold. Decision (confirmed by the project
owner): strip distance, renormalise, reintegrate at §7 with V4's original weight. V4's weights are
preserved exactly; only the order of operations changes.

**C — V5 §24's "78" is not reproducible.** V5's worked example goes base 95 → distance-adjusted 78,
a 17-point drop, while distance carries only 10 of 100 points in V4 §18. Under §7 the same inputs
(base_family 96, base_job 94, distance_travel_fit 0 at 145 km vs 25 km radius) give:

```
final_family = 0.90 × 96 + 0.10 × 0 = 86.4
final_job    = 0.85 × 94 + 0.15 × 0 = 79.9
final_mutual = 0.60 × 86.4 + 0.40 × 79.9 = 83.8
```

**83.8, not 78.** V4's weights are normative, so 83.8 stands and V5's 78 is treated as illustrative.
Reproducing 78 would require silently inflating distance's weight to roughly 18/100, contradicting
V4 §18. Flagged rather than fudged.

**D — Greenfield, no migration.** V4 §49/§52 mandate a repo audit, backup and KEEP/REWRITE/REMOVE
inventory before changing an existing system. `D:\T-Ai\AiMatching` was empty, so there is nothing to
audit or back up; `docs/migration-audit.md` records that finding instead.

---

## 10. Trust Score (V4 §34)

```
trust_score = 0.50·behavior_reliability + 0.30·family_review
            + 0.10·credential + 0.10·incident_component
```

| Component | Definition |
|---|---|
| `behavior_reliability` | on-time check-ins, care-plan adherence, completion rate over confirmed jobs |
| `family_review` | shrunk mean of `overall_rating` (see below) |
| `credential` | 100 if verified certificates cover all claimed skills, else proportional |
| `incident_component` | `100 − 25 × confirmed_caregiver_responsible_incidents`, floored at 0 |

**Penalty gate (V4 §34, V6 F01/F02):** an incident lowers trust only when
`incident.status = CONFIRMED` **and** `responsibility = CAREGIVER_RESPONSIBLE`. Unconfirmed alerts,
GPS events and geofence exits never affect trust.

**Cold-start shrinkage** — V4 §34 mandates a `NEW` state but gives no formula; V6 F04 requires
shrinkage to be observable. Defined here (Bayesian shrink toward the platform prior):

```
family_review = (n·mean_rating + k·prior) / (n + k) × 20      # ratings are 1–5 → ×20 to reach 0–100
  n     = review_count
  k     = 5           # SHRINKAGE_K
  prior = 3.5         # PRIOR_RATING, platform mean
```

So one 5-star review yields `(1·5 + 5·3.5)/6 × 20 = 75.0`, not 100 — which is exactly the V6 F04
expectation. `trust_status = NEW` and the UI string "ข้อมูลยังไม่เพียงพอ" apply while
`completed_jobs < 3`; the score is still computed and used, only labelled.

**`previous_successful_match`** (V4 §41.17, V6 F03): 100 when this family/caregiver pair has ≥1
completed job with `would_rebook = true`, 70 when ≥1 completed job without a rebook signal, else 50
(neutral). It sits in the `trust_history` bucket (§3.1), so a rebook bonus is capped at its share of
those 11.111 points and can never overturn a mandatory-skill filter.

---

## 11. Versioning

Every `matching_runs` row stores `score_version` (`MATCHING_SCORE_VERSION`), `weight_version`
(`WEIGHT_PROFILE_VERSION`), the full `feature_values` snapshot and all `hard_filter_results`
(V4 §20). V6 §14 forbids tuning weights against expected labels and then calling the result
independent: any retune bumps `weight_version` and the benchmark report must present
`PRE_TUNING` and `POST_TUNING_REGRESSION` as separate sections.

---

## 12. Feature scoring functions

§3 places every feature in a bucket but does not say how each feature reaches 0–100. Those
definitions live in `backend/src/matching/features.js`; the non-obvious ones are recorded here
because two of them were rewritten during the first benchmark run (see §13).

| Feature | 0–100 mapping |
|---|---|
| `skill_match_score` | weighted coverage of requested skills; MANDATORY counts 3, IMPORTANT 2, NICE_TO_HAVE 1 |
| `skill_level_fit` | per skill: `80·(have/required)` below the bar; `80 + 20·min(1,(have−required)/required)` at or above it |
| `experience_match` | `80·(years/min)` below the stated minimum; `80 + 20·min(1,(years−min)/(2·min))` at or above it. With no stated minimum, linear credit to 100 at 5 years |
| `condition_experience_fit` | share of the request's relevant conditions the caregiver has any experience with |
| `distance_fit` | the piecewise curve in §7 |
| `travel_time_fit` | `100·(1 − travel/max_travel)`, clamped |
| `schedule_fit` | 60 once the window is covered, rising to 100 with up to two hours of slack around it |
| `budget_rate_fit` | 100 when the budget meets the expected rate, else `100·budget/expected` |
| `trust_history_score` | the caregiver's current Trust Score (§10) |
| `previous_successful_match` | 100 with a rebook signal, 70 for a prior job without one, 50 (neutral) for a new pair |
| `physical_workload_fit` | 100 for a light job; for a heavy one 100 / 60 / 20 by how many of the two heavy-work opt-ins the caregiver holds |
| `environment_fit` | mean of the pet and smoking checks that the request actually states |

**Design rule behind two of these:** a feature must stay informative above the requirement, not
saturate at it. Both `skill_level_fit` and `experience_match` originally clamped to 100 the moment
the stated minimum was met, which made a level-5 caregiver score identically to a level-2 one on a
level-2 request, and a twelve-year veteran identical to a two-year one. The 80-at-the-bar shape
keeps the requirement meaningful while letting depth differentiate.

## 13. Change log

| # | Change | Why | Phase |
|---|---|---|---|
| 1 | `skill_level_fit` and `experience_match` reshaped (§12) | The first controlled run showed both saturating at the requirement, so two ranking cases tied that should have separated. These are feature *definitions* the spec had not previously pinned down — no bucket, weight or threshold changed. | Spec authoring, before the first recorded benchmark |
| 2 | Exceptional evaluation now runs whenever the distance filter fails, not only when it is the sole failure | A candidate failing distance *and* another filter returned no explanation, leaving the Matching Debug page (V5 §28) blank. The outcome was already correct; only the reasoning was missing. | Bug fix |

**On V6 §14.** That clause forbids adjusting weights to fit expected labels and then presenting the
result as independent validation. Neither change above touches a weight, a threshold or the mutual
formula — §4, §5, §6, §7 and §8 are exactly as first written and are all derived from V4/V5 rather
than from any run. Change 1 defined feature functions the spec had left unspecified; change 2 fixed
a reporting bug. The benchmark report labels the current figures `PRE_TUNING` on that basis. Should
a weight ever be changed in response to a failing case, the run must be reported as
`POST_TUNING_REGRESSION` and must not be called independent.
