/**
 * Strathclyde operational benchmark — V6 §2, STEP 4–6.
 * LABEL: PUBLIC_OPERATIONAL_BENCHMARK.
 *
 * What this does and does not prove
 * ---------------------------------
 * It schedules 6805 real home-care visits across 138 real carer shifts using TrustCare's own
 * availability and double-booking logic (`coversWindow` and `hasCollision` from the production
 * matching engine — the same functions the live hard filters call), then audits the resulting
 * schedule against the operational constraints.
 *
 * It therefore tests whether TrustCare's constraint logic is CORRECT. It is not an optimisation
 * benchmark: the assignment is a deterministic greedy pass, not a solver, so the feasibility rate
 * says "the engine never produced an invalid assignment and covered X% of visits with this simple
 * policy" — never "TrustCare schedules better than the published solutions".
 *
 * V6 §2 forbids reporting any matching-quality figure from this dataset: it contains no skills,
 * language, budget or trust data. Only availability, scheduling, double-booking, synchronisation
 * and travel are measured.
 *
 *   node scripts/run_strathclyde_benchmark.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStrathclyde, minToHHMM, TIME_WINDOW_TOLERANCE_MIN } from '../adapters/strathclyde_adapter.js';
import { coversWindow, hasCollision } from '../backend/src/matching/hardFilters.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const started = Date.now();

const { carers, visits, matrix, meta } = loadStrathclyde(resolve(ROOT, 'data/strathclyde'));

/** Shifts indexed by date, so each day is scheduled independently. */
const shiftsByDate = new Map();
for (const [carerId, shifts] of carers) {
  for (const s of shifts) {
    if (!shiftsByDate.has(s.date)) shiftsByDate.set(s.date, []);
    shiftsByDate.get(s.date).push({ carer_id: carerId, ...s });
  }
}

const visitsByDate = new Map();
for (const v of visits) {
  if (!visitsByDate.has(v.date)) visitsByDate.set(v.date, []);
  visitsByDate.get(v.date).push(v);
}

const assignments = []; // {visit_id, carer_id, date, start_min, end_min, user_id}
const unscheduled = [];
const latencies = [];

/** Per-carer running state for the day: last visit end and location, plus booked intervals. */
for (const [date, dayVisits] of [...visitsByDate].sort(([a], [b]) => a.localeCompare(b))) {
  const dayShifts = shiftsByDate.get(date) ?? [];
  const state = new Map(); // carer_id -> {last_end_min, last_user_id, booked:[]}
  for (const s of dayShifts) {
    state.set(s.carer_id, { shift: s, last_end_min: null, last_user_id: null, booked: [] });
  }

  // Deterministic order: earliest start first, then longest, then visit id.
  const ordered = [...dayVisits].sort(
    (a, b) =>
      a.start_min - b.start_min ||
      b.duration_min - a.duration_min ||
      a.visit_id.localeCompare(b.visit_id),
  );

  for (const visit of ordered) {
    const t0 = process.hrtime.bigint();
    const need = visit.carer_count;

    /** Which carers could take this visit if it started at `startMin`? */
    const feasibleAt = (startMin) => {
      const endMin = startMin + visit.duration_min;
      const careRequest = {
        care_date: date,
        start_time: minToHHMM(startMin),
        end_time: minToHHMM(endMin),
      };
      const out = [];
      for (const [carerId, st] of state) {
        const caregiver = {
          id: carerId,
          availability: [
            {
              recurring: false,
              specific_date: date,
              start_time: minToHHMM(st.shift.begin_min),
              end_time: minToHHMM(st.shift.end_min),
            },
          ],
        };
        if (!coversWindow(caregiver, careRequest)) continue;
        if (hasCollision({ id: carerId }, careRequest, st.booked)) continue;

        // Travel feasibility from the carer's previous visit. Carer home locations are absent
        // from the dataset (adapter header note 2), so the first visit of a shift has no
        // travel test.
        let travelSec = 0;
        if (st.last_user_id != null) {
          const t = matrix(st.last_user_id, visit.user_id);
          if (t == null) continue; // unknown leg — refuse rather than assume it is reachable
          travelSec = t;
          if (st.last_end_min + travelSec / 60 > startMin) continue;
        }
        out.push({ carerId, travelSec, slack: startMin - (st.last_end_min ?? startMin) });
      }
      // Prefer the carer with the shortest travel leg, then the tightest slack, then id —
      // deterministic, and it keeps travel realistic without becoming an optimiser.
      out.sort((a, b) => a.travelSec - b.travelSec || a.slack - b.slack || a.carerId.localeCompare(b.carerId));
      return { careRequest, endMin, list: out };
    };

    // Home-care demand clusters hard at morning, midday and evening peaks, so holding every visit
    // to its exact scheduled minute leaves carers idle either side of a peak. The assumed window
    // (adapter header note 1) exists precisely to absorb that, so try the scheduled time first and
    // then the nearest offsets inside the window, in 5-minute steps. A synchronized visit takes
    // all its carers at the SAME chosen time, which is what makes it synchronized.
    const offsets = [0];
    for (let d = 5; d <= TIME_WINDOW_TOLERANCE_MIN; d += 5) offsets.push(-d, d);

    let chosen = null;
    let bestShortfall = { available: 0 };
    for (const off of offsets) {
      const startMin = visit.start_min + off;
      if (startMin < visit.window_start_min || startMin > visit.window_end_min) continue;
      const attempt = feasibleAt(startMin);
      if (attempt.list.length >= need) {
        chosen = { ...attempt, startMin, offset: off };
        break;
      }
      if (attempt.list.length > bestShortfall.available) bestShortfall = { available: attempt.list.length };
    }

    if (chosen) {
      for (const f of chosen.list.slice(0, need)) {
        const st = state.get(f.carerId);
        st.booked.push({
          caregiver_id: f.carerId,
          care_date: date,
          start_time: chosen.careRequest.start_time,
          end_time: chosen.careRequest.end_time,
        });
        st.last_end_min = chosen.endMin;
        st.last_user_id = visit.user_id;
        assignments.push({
          visit_id: visit.visit_id,
          carer_id: f.carerId,
          date,
          user_id: visit.user_id,
          start_min: chosen.startMin,
          end_min: chosen.endMin,
          offset_from_scheduled_min: chosen.offset,
          travel_sec_from_previous: f.travelSec,
        });
      }
    } else {
      unscheduled.push({
        visit_id: visit.visit_id,
        date,
        required: need,
        available: bestShortfall.available,
        reason:
          bestShortfall.available === 0
            ? 'no feasible carer anywhere in the window'
            : 'insufficient carers for synchronized visit at any time in the window',
      });
    }

    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

// ═══════════════════════════════════════════ audit the produced schedule

const byVisit = new Map();
for (const a of assignments) {
  if (!byVisit.has(a.visit_id)) byVisit.set(a.visit_id, []);
  byVisit.get(a.visit_id).push(a);
}

// 1 — double bookings: any carer with two overlapping assignments on the same date
const byCarerDate = new Map();
for (const a of assignments) {
  const k = `${a.carer_id}|${a.date}`;
  if (!byCarerDate.has(k)) byCarerDate.set(k, []);
  byCarerDate.get(k).push(a);
}
let doubleBookings = 0;
const doubleBookingExamples = [];
for (const [k, list] of byCarerDate) {
  const sorted = [...list].sort((x, y) => x.start_min - y.start_min);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start_min < sorted[i - 1].end_min) {
      doubleBookings += 1;
      if (doubleBookingExamples.length < 5) doubleBookingExamples.push({ key: k, a: sorted[i - 1], b: sorted[i] });
    }
  }
}

// 2 — time-window violations (against the ASSUMED window, see adapter header note 1)
const visitById = new Map(visits.map((v) => [v.visit_id, v]));
let windowViolations = 0;
for (const a of assignments) {
  const v = visitById.get(a.visit_id);
  if (a.start_min < v.window_start_min || a.start_min > v.window_end_min) windowViolations += 1;
}

// 3 — shift containment: every assignment inside the carer's declared shift
const shiftLookup = new Map();
for (const [carerId, shifts] of carers) for (const s of shifts) shiftLookup.set(`${carerId}|${s.date}`, s);
let shiftViolations = 0;
for (const a of assignments) {
  const s = shiftLookup.get(`${a.carer_id}|${a.date}`);
  if (!s || a.start_min < s.begin_min || a.end_min > s.end_min) shiftViolations += 1;
}

// 4 — synchronisation: a CarerCount=2 visit must have exactly 2 DISTINCT carers, simultaneously
const syncVisits = visits.filter((v) => v.carer_count > 1);
let syncSatisfied = 0;
for (const v of syncVisits) {
  const a = byVisit.get(v.visit_id) ?? [];
  const distinct = new Set(a.map((x) => x.carer_id));
  if (distinct.size === v.carer_count) syncSatisfied += 1;
}

// 5 — travel feasibility across every consecutive pair actually produced
let travelChecked = 0;
let travelViolations = 0;
for (const [, list] of byCarerDate) {
  const sorted = [...list].sort((x, y) => x.start_min - y.start_min);
  for (let i = 1; i < sorted.length; i += 1) {
    const t = matrix(sorted[i - 1].user_id, sorted[i].user_id);
    if (t == null) continue;
    travelChecked += 1;
    if (sorted[i - 1].end_min + t / 60 > sorted[i].start_min) travelViolations += 1;
  }
}

const scheduledVisits = byVisit.size;
const runtimeMs = Date.now() - started;
const sortedLat = [...latencies].sort((a, b) => a - b);
const p = (q) => +(sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * q))] ?? 0).toFixed(3);
const pctOf = (n, d) => (d === 0 ? null : +((n / d) * 100).toFixed(2));

const metrics = {
  ...meta,
  tuning_phase: 'PRE_TUNING',
  what_this_measures:
    'Correctness of TrustCare availability, double-booking, shift-containment, synchronisation ' +
    'and travel constraints on real operational home-care data. Not an optimisation result and ' +
    'not a matching-quality result (V6 §2, §12).',

  total_visits: visits.length,
  scheduled_visits: scheduledVisits,
  unscheduled_visits: visits.length - scheduledVisits,
  total_assignments: assignments.length,

  scheduling_feasibility_rate_pct: pctOf(scheduledVisits, visits.length),
  unscheduled_visit_rate_pct: pctOf(visits.length - scheduledVisits, visits.length),

  double_booking_count: doubleBookings,
  shift_containment_violations: shiftViolations,
  time_window_violation_rate_pct: pctOf(windowViolations, assignments.length),
  time_window_violations: windowViolations,
  time_window_note: `window is ASSUMED as scheduled time ± ${TIME_WINDOW_TOLERANCE_MIN} min; the dataset has no window field`,

  synchronized_visits: syncVisits.length,
  synchronized_visits_satisfied: syncSatisfied,
  synchronized_visit_success_rate_pct: pctOf(syncSatisfied, syncVisits.length),

  travel_legs_checked: travelChecked,
  travel_violations: travelViolations,
  travel_feasibility_pct: pctOf(travelChecked - travelViolations, travelChecked),
  travel_note: 'visit-to-visit legs only; carer start locations are not in the dataset',

  assignment_constraint_pass_rate_pct: pctOf(
    assignments.length - doubleBookings - shiftViolations - windowViolations - travelViolations,
    assignments.length,
  ),

  visits_shifted_within_window: assignments.filter((a) => (a.offset_from_scheduled_min ?? 0) !== 0).length,
  max_shift_used_min: assignments.reduce((m, a) => Math.max(m, Math.abs(a.offset_from_scheduled_min ?? 0)), 0),

  runtime_ms: runtimeMs,
  latency_ms_per_visit: { p50: p(0.5), p95: p(0.95), p99: p(0.99) },
  generated_at: new Date().toISOString(),
};

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(
  resolve(ROOT, 'reports/strathclyde_results.json'),
  JSON.stringify({ metrics, unscheduled_sample: unscheduled.slice(0, 50), double_booking_examples: doubleBookingExamples }, null, 2),
);

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(
  resolve(ROOT, 'reports/strathclyde_results.csv'),
  ['metric,value']
    .concat(
      Object.entries(metrics)
        .filter(([, v]) => typeof v !== 'object' || v === null)
        .map(([k, v]) => `${esc(k)},${esc(v)}`),
    )
    .join('\n') + '\n',
);

console.log('\n=== Strathclyde Operational Benchmark (PUBLIC_OPERATIONAL_BENCHMARK) ===');
console.log(`${meta.name}\n${meta.institution} · DOI ${meta.doi}\n`);
console.log(`Carers / visits / users        ${meta.carer_count} / ${meta.visit_count} / ${meta.user_count}`);
console.log(`Date range                     ${meta.date_range[0]} .. ${meta.date_range[1]}\n`);
console.log(`Scheduling feasibility         ${metrics.scheduling_feasibility_rate_pct}%`);
console.log(`Unscheduled visit rate         ${metrics.unscheduled_visit_rate_pct}%`);
console.log(`Assignment constraint pass     ${metrics.assignment_constraint_pass_rate_pct}%`);
console.log(`Double bookings                ${metrics.double_booking_count}`);
console.log(`Shift containment violations   ${metrics.shift_containment_violations}`);
console.log(`Time-window violations         ${metrics.time_window_violations} (${metrics.time_window_violation_rate_pct}%)  [assumed window]`);
console.log(`Synchronized visit success     ${metrics.synchronized_visits_satisfied}/${metrics.synchronized_visits} = ${metrics.synchronized_visit_success_rate_pct}%`);
console.log(`Travel feasibility             ${metrics.travel_feasibility_pct}% over ${metrics.travel_legs_checked} legs`);
console.log(`Visits shifted within window   ${metrics.visits_shifted_within_window} (max ${metrics.max_shift_used_min} min)`);
console.log(`\nRuntime                        ${metrics.runtime_ms} ms`);
console.log(`Latency p50/p95/p99 per visit  ${metrics.latency_ms_per_visit.p50} / ${metrics.latency_ms_per_visit.p95} / ${metrics.latency_ms_per_visit.p99} ms`);
console.log('\nNOT AVAILABLE IN DATASET: ' + meta.not_available_in_dataset.join(', '));
console.log('\nWrote reports/strathclyde_results.json and .csv');
