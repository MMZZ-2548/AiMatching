/**
 * HHCRSP constraint benchmark — V6 §3, STEP 7–9.
 * LABEL: PUBLIC_ACADEMIC_BENCHMARK.
 *
 * What this proves (V6 §3): that TrustCare never assigns a caregiver to work whose service/skill
 * requirement they do not meet, and never violates a time-window or synchronization constraint.
 * The mandatory-skill decision is made by the production hard filter — `runHardFilters` from
 * backend/src/matching — not by anything written for this benchmark.
 *
 * What it does not prove: solution quality. The assignment is a deterministic greedy pass, so
 * coverage is a property of that policy. V6 §3 asks for constraint correctness, and that is what
 * the invalid-assignment, time-window and synchronization figures measure.
 *
 * Service codes s1..sN carry no clinical meaning (V6 §3) and are treated as compatibility proxies.
 *
 *   node scripts/run_hhcrsp_benchmark.js [family] [limit]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listInstances, loadInstance, toCareRequest, DATASET_META, minutesToHHMM } from '../adapters/hhcrsp_adapter.js';
import { runHardFilters } from '../backend/src/matching/hardFilters.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HHCRSP_ROOT = resolve(ROOT, 'data/hhcrsp2');
// `all` runs every family with published instances; otherwise a comma-separated list.
const FAMILY_ARG = process.argv[2] ?? 'all';
const FAMILIES = FAMILY_ARG === 'all' ? ['mankowska', 'kummer', 'Italian'] : FAMILY_ARG.split(',');
const LIMIT = Number(process.argv[3] ?? 1000);

const round3 = (n) => Math.round(n * 1000) / 1000;
const started = Date.now();
const files = FAMILIES.flatMap((fam) => listInstances(HHCRSP_ROOT, fam).slice(0, LIMIT));

const perInstance = [];
const failureByRule = {};
const latencies = [];
const solutionsOut = [];

for (const file of files) {
  const inst = loadInstance(file);
  const t0 = process.hrtime.bigint();

  // Caregiver state: when and where they are free next.
  const state = new Map(
    inst.caregivers.map((c) => [c.id, { at: inst.office?.id ?? null, freeAt: 0, route: [] }]),
  );

  // Earliest window first, then the harder (synchronized) work, then id — deterministic.
  const ordered = [...inst.tasks].sort(
    (a, b) =>
      a.window_start - b.window_start ||
      b.sibling_count - a.sibling_count ||
      a.task_id.localeCompare(b.task_id),
  );

  const assigned = new Map(); // task_id -> {caregiver_id, start, end}
  const unassigned = [];
  const done = new Set();

  for (const task of ordered) {
    if (done.has(task.task_id)) continue;

    // A synchronized patient's services are placed together, so the constraint is satisfied by
    // construction rather than checked afterwards and hoped for.
    const group = task.sibling_count > 1
      ? inst.tasks.filter((t) => t.patient_id === task.patient_id)
      : [task];

    const placement = placeGroup(group, inst, state);
    if (placement) {
      for (const p of placement) {
        assigned.set(p.task.task_id, p);
        done.add(p.task.task_id);
        const st = state.get(p.caregiver_id);
        st.at = p.task.patient_id;
        st.freeAt = p.end;
        st.route.push({
          arrival_time: round3(p.start),
          departure_time: round3(p.end),
          patient: p.task.patient_id,
          service: p.task.service,
        });
      }
    } else {
      for (const g of group) {
        if (!done.has(g.task_id)) {
          unassigned.push({ task_id: g.task_id, reason: 'no feasible caregiver in window' });
          done.add(g.task_id);
        }
      }
    }
  }

  latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);

  const audit = auditInstance(inst, assigned);
  for (const [rule, n] of Object.entries(audit.failures_by_rule)) {
    failureByRule[rule] = (failureByRule[rule] ?? 0) + n;
  }

  perInstance.push({
    instance: inst.name,
    patients: inst.patient_count,
    caregivers: inst.caregivers.length,
    tasks: inst.task_count,
    assigned: assigned.size,
    unassigned: unassigned.length,
    ...audit,
  });

  solutionsOut.push({
    instance: inst.name,
    solution: {
      global_ordering: inst.patients.map((p) => p.id),
      routes: [...state].map(([caregiver_id, st]) => ({ caregiver_id, locations: st.route })),
    },
  });
}

/**
 * Place one group of tasks (a single task, or all services of a synchronized patient).
 * Returns null if no assignment satisfies every constraint.
 */
function placeGroup(group, inst, state) {
  const patientId = group[0].patient_id;
  const windowStart = group[0].window_start;
  const windowEnd = group[0].window_end;
  const sync = group[0].synchronization;

  // Candidate caregivers per task, decided by the production mandatory-skill filter.
  const candidatesFor = (task) =>
    inst.caregivers.filter((cg) => {
      const filters = runHardFilters(toCareRequest(task), { ...cg, availability: [] }, {});
      // availability and radius are not modelled by this dataset; only the service/skill gate is.
      return !filters.failed.includes('mandatory_required_skill');
    });

  // A missing matrix entry is a data problem, not a free trip. Returning null makes the caller
  // refuse the placement rather than schedule an impossible one.
  const arrival = (cgId, from, to, readyAt) => {
    const travel = inst.distanceBetween(from ?? to, to);
    if (travel == null) return null;
    return Math.max(readyAt + travel, windowStart);
  };

  if (group.length === 1) {
    const task = group[0];
    let best = null;
    for (const cg of candidatesFor(task)) {
      const st = state.get(cg.id);
      const start = arrival(cg.id, st.at, patientId, st.freeAt);
      if (start == null) continue;
      const end = start + task.duration;
      if (end > windowEnd) continue;
      if (!best || start < best.start || (start === best.start && cg.id < best.caregiver_id)) {
        best = { task, caregiver_id: cg.id, start, end };
      }
    }
    return best ? [best] : null;
  }

  // Synchronized patient: every service needs a distinct caregiver.
  // "simultaneous" means identical start times; "sequential" means each starts after the previous
  // one finishes (V6 §3 lists both as separate constraints to satisfy).
  const options = group.map((t) => ({ task: t, candidates: candidatesFor(t) }));
  if (options.some((o) => o.candidates.length === 0)) return null;

  const chosen = [];
  const used = new Set();
  for (const opt of options) {
    const pick = opt.candidates
      .filter((c) => !used.has(c.id))
      .sort((a, b) => {
        const sa = state.get(a.id);
        const sb = state.get(b.id);
        const ta = arrival(a.id, sa.at, patientId, sa.freeAt) ?? Infinity;
        const tb = arrival(b.id, sb.at, patientId, sb.freeAt) ?? Infinity;
        return ta - tb || a.id.localeCompare(b.id);
      })[0];
    if (!pick) return null;
    used.add(pick.id);
    chosen.push({ task: opt.task, caregiver_id: pick.id });
  }

  if (sync === 'simultaneous') {
    // All start together, at the latest time any of them can actually arrive.
    const arrivals = chosen.map((c) => {
      const st = state.get(c.caregiver_id);
      return arrival(c.caregiver_id, st.at, patientId, st.freeAt);
    });
    if (arrivals.some((a) => a == null)) return null;
    const start = Math.max(...arrivals);
    const placed = chosen.map((c) => ({ ...c, start, end: start + c.task.duration }));
    return placed.every((p) => p.end <= windowEnd) ? placed : null;
  }

  // Sequential with a distance window: the gap between the START of each service and the START
  // of the first must fall inside [min, max]. `[16, 17]` therefore means the second service must
  // begin 16 to 17 time units after the first — not simply after it has finished.
  const [gapMin, gapMax] = group[0].sync_distance ?? [0, Infinity];

  const firstArrival = (() => {
    const st = state.get(chosen[0].caregiver_id);
    return arrival(chosen[0].caregiver_id, st.at, patientId, st.freeAt);
  })();
  if (firstArrival == null) return null;

  // The first service may have to wait so that the others can still land inside the window.
  let base = firstArrival;
  const placed = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    placed.length = 0;
    let feasible = true;
    let needBase = base;

    for (let i = 0; i < chosen.length; i += 1) {
      const c = chosen[i];
      const st = state.get(c.caregiver_id);
      const a = arrival(c.caregiver_id, st.at, patientId, st.freeAt);
      if (a == null) return null;

      const start = i === 0 ? base : Math.max(base + gapMin, a);
      if (i > 0 && start > base + gapMax) {
        // this caregiver cannot reach the patient inside the required gap; try a later base once
        needBase = Math.max(needBase, a - gapMin);
        feasible = false;
        break;
      }
      const end = start + c.task.duration;
      if (end > windowEnd) return null;
      placed.push({ ...c, start, end });
    }

    if (feasible) return placed;
    if (needBase <= base) return null;
    base = needBase;
  }
  return null;
}

/** Audit a produced assignment against every constraint V6 §3 names. */
function auditInstance(inst, assigned) {
  const failures = {};
  const bump = (k, n = 1) => (failures[k] = (failures[k] ?? 0) + n);

  const abilities = new Map(inst.caregivers.map((c) => [c.id, new Set(c.skills)]));

  // 1 — invalid skill/service assignment
  let invalidService = 0;
  for (const [, a] of assigned) {
    if (!abilities.get(a.caregiver_id)?.has(a.task.service)) {
      invalidService += 1;
      bump('invalid_service_assignment');
    }
  }

  // 2 — time windows
  let windowViolations = 0;
  for (const [, a] of assigned) {
    if (a.start < a.task.window_start - 1e-6 || a.end > a.task.window_end + 1e-6) {
      windowViolations += 1;
      bump('time_window_violation');
    }
  }

  // 3 — one caregiver in two places at once
  const byCaregiver = new Map();
  for (const [, a] of assigned) {
    if (!byCaregiver.has(a.caregiver_id)) byCaregiver.set(a.caregiver_id, []);
    byCaregiver.get(a.caregiver_id).push(a);
  }
  let overlaps = 0;
  for (const [, list] of byCaregiver) {
    const s = [...list].sort((x, y) => x.start - y.start);
    for (let i = 1; i < s.length; i += 1) {
      if (s[i].start < s[i - 1].end - 1e-6) {
        overlaps += 1;
        bump('caregiver_overlap');
      }
    }
  }

  // 4 — route validity: travel time between consecutive visits must be respected
  let routeChecked = 0;
  let routeViolations = 0;
  for (const [, list] of byCaregiver) {
    const s = [...list].sort((x, y) => x.start - y.start);
    // The first leg leaves the central office. Skipping it is how a depot-travel violation used
    // to escape this audit while the upstream validator caught it.
    if (s.length && inst.office) {
      const d0 = inst.distanceBetween(inst.office.id, s[0].task.patient_id);
      if (d0 != null) {
        routeChecked += 1;
        if (d0 > s[0].start + 1e-6) { routeViolations += 1; bump('depot_travel_violation'); }
      }
    }
    for (let i = 1; i < s.length; i += 1) {
      const d = inst.distanceBetween(s[i - 1].task.patient_id, s[i].task.patient_id);
      if (d == null) continue;
      routeChecked += 1;
      if (s[i - 1].end + d > s[i].start + 1e-6) {
        routeViolations += 1;
        bump('route_travel_violation');
      }
    }
  }

  // 5 — synchronization
  const syncPatients = inst.patients.filter((p) => (p.required_caregivers ?? []).length > 1);
  let syncSatisfied = 0;
  let syncUnassigned = 0;
  for (const p of syncPatients) {
    const parts = inst.tasks.filter((t) => t.patient_id === p.id).map((t) => assigned.get(t.task_id));
    // A synchronized patient the greedy could not staff is a coverage shortfall, NOT a broken
    // synchronization constraint. Conflating the two would understate constraint correctness.
    if (parts.some((x) => !x)) { syncUnassigned += 1; continue; }
    const distinct = new Set(parts.map((x) => x.caregiver_id));
    if (distinct.size !== parts.length) { bump('sync_same_caregiver'); continue; }
    const type = p.synchronization?.type ?? 'simultaneous';
    if (type === 'simultaneous') {
      const t0 = parts[0].start;
      if (parts.every((x) => Math.abs(x.start - t0) < 1e-6)) syncSatisfied += 1;
      else bump('sync_not_simultaneous');
    } else {
      const s = [...parts].sort((a, b) => a.start - b.start);
      const task = inst.tasks.find((t) => t.patient_id === p.id);
      const [gapMin, gapMax] = task?.sync_distance ?? [0, Infinity];
      const gapsOk = s.every((x, i) => {
        if (i === 0) return true;
        const gap = x.start - s[0].start;
        return gap >= gapMin - 1e-6 && gap <= gapMax + 1e-6;
      });
      if (gapsOk) syncSatisfied += 1;
      else bump('sync_distance_window_violation');
    }
  }

  const coveredMandatory = assigned.size;
  return {
    mandatory_service_coverage: coveredMandatory,
    invalid_service_assignments: invalidService,
    time_window_violations: windowViolations,
    caregiver_overlaps: overlaps,
    route_legs_checked: routeChecked,
    route_violations: routeViolations,
    synchronized_patients: syncPatients.length,
    synchronized_satisfied: syncSatisfied,
    synchronized_unassigned: syncUnassigned,
    synchronized_assigned: syncPatients.length - syncUnassigned,
    failures_by_rule: failures,
  };
}

// ═══════════════════════════════════════════ aggregate

const sum = (k) => perInstance.reduce((s, r) => s + (r[k] ?? 0), 0);
const pctOf = (n, d) => (d === 0 ? null : +((n / d) * 100).toFixed(2));

const totalTasks = sum('tasks');
const totalAssigned = sum('assigned');
const totalInvalid = sum('invalid_service_assignments');
const totalWindow = sum('time_window_violations');
const totalOverlap = sum('caregiver_overlaps');
const totalRouteChecked = sum('route_legs_checked');
const totalRouteViol = sum('route_violations');
const totalSync = sum('synchronized_patients');
const totalSyncOk = sum('synchronized_satisfied');
const totalSyncAssigned = sum('synchronized_assigned');
const totalSyncUnassigned = sum('synchronized_unassigned');

const sortedLat = [...latencies].sort((a, b) => a - b);
const p = (q) => +(sortedLat[Math.min(sortedLat.length - 1, Math.floor(sortedLat.length * q))] ?? 0).toFixed(3);

const metrics = {
  ...DATASET_META,
  tuning_phase: 'PRE_TUNING',
  instance_families: FAMILIES,
  instances_run: perInstance.length,
  what_this_measures:
    'Whether TrustCare ever assigns work whose mandatory service/skill requirement the caregiver ' +
    'does not meet, and whether time-window, synchronization and route constraints hold. ' +
    'Not a solution-quality or optimisation result (V6 §3, §12).',

  total_tasks: totalTasks,
  assigned_tasks: totalAssigned,
  mandatory_service_coverage_rate_pct: pctOf(totalAssigned, totalTasks),

  invalid_skill_service_assignments: totalInvalid,
  invalid_skill_service_assignment_rate_pct: pctOf(totalInvalid, totalAssigned),

  time_window_violations: totalWindow,
  time_window_pass_rate_pct: pctOf(totalAssigned - totalWindow, totalAssigned),

  caregiver_overlaps: totalOverlap,

  synchronized_patients: totalSync,
  synchronized_patients_staffed: totalSyncAssigned,
  synchronized_patients_unstaffed: totalSyncUnassigned,
  synchronized_satisfied: totalSyncOk,
  // Pass rate over the synchronized patients that were actually staffed — an unstaffed one is a
  // coverage shortfall of the greedy policy, not a violated constraint.
  synchronization_pass_rate_pct: pctOf(totalSyncOk, totalSyncAssigned),
  synchronization_coverage_pct: pctOf(totalSyncAssigned, totalSync),

  route_legs_checked: totalRouteChecked,
  route_violations: totalRouteViol,
  route_validity_pct: pctOf(totalRouteChecked - totalRouteViol, totalRouteChecked),

  constraint_satisfaction_rate_pct: pctOf(
    totalAssigned - totalInvalid - totalWindow - totalOverlap - totalRouteViol,
    totalAssigned,
  ),

  failure_cases_by_rule: failureByRule,
  runtime_ms: Date.now() - started,
  latency_ms_per_instance: { p50: p(0.5), p95: p(0.95), p99: p(0.99) },
  generated_at: new Date().toISOString(),
};

mkdirSync(resolve(ROOT, 'reports'), { recursive: true });
writeFileSync(resolve(ROOT, 'reports/hhcrsp_results.json'), JSON.stringify({ metrics, per_instance: perInstance }, null, 2));
mkdirSync(resolve(ROOT, 'reports/hhcrsp_solutions'), { recursive: true });
for (const s of solutionsOut) {
  writeFileSync(resolve(ROOT, `reports/hhcrsp_solutions/${s.instance}.json`), JSON.stringify(s.solution, null, 1));
}

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
writeFileSync(
  resolve(ROOT, 'reports/hhcrsp_results.csv'),
  ['instance,patients,caregivers,tasks,assigned,invalid_service,window_violations,overlaps,route_violations,sync_total,sync_ok']
    .concat(
      perInstance.map((r) =>
        [r.instance, r.patients, r.caregivers, r.tasks, r.assigned, r.invalid_service_assignments,
         r.time_window_violations, r.caregiver_overlaps, r.route_violations,
         r.synchronized_patients, r.synchronized_satisfied].map(esc).join(','),
      ),
    )
    .join('\n') + '\n',
);

console.log('\n=== HHCRSP Constraint Benchmark (PUBLIC_ACADEMIC_BENCHMARK) ===');
console.log(`${DATASET_META.institution}\nRepo ${DATASET_META.repository} · Paper DOI ${DATASET_META.paper_doi} · ${DATASET_META.license}\n`);
console.log(`Instance families              ${FAMILIES.join(', ')}`);
console.log(`Instances run                  ${perInstance.length}`);
console.log(`Tasks (patient × service)      ${totalTasks}`);
console.log(`Assigned                       ${totalAssigned}\n`);
console.log(`Mandatory service coverage     ${metrics.mandatory_service_coverage_rate_pct}%`);
console.log(`Invalid skill/service assign.  ${totalInvalid} (${metrics.invalid_skill_service_assignment_rate_pct}%)`);
console.log(`Time-window pass rate          ${metrics.time_window_pass_rate_pct}%`);
console.log(`Caregiver overlaps             ${totalOverlap}`);
console.log(`Synchronization pass rate      ${totalSyncOk}/${totalSyncAssigned} staffed = ${metrics.synchronization_pass_rate_pct}%`);
console.log(`  (of ${totalSync} synchronized patients, ${totalSyncUnassigned} were left unstaffed by the greedy policy)`);
console.log(`Route validity                 ${metrics.route_validity_pct}% over ${totalRouteChecked} legs`);
console.log(`Constraint satisfaction rate   ${metrics.constraint_satisfaction_rate_pct}%`);
console.log(`\nFailures by rule               ${JSON.stringify(failureByRule)}`);
console.log(`Runtime                        ${metrics.runtime_ms} ms`);
console.log(`Latency p50/p95/p99 per inst.  ${metrics.latency_ms_per_instance.p50} / ${metrics.latency_ms_per_instance.p95} / ${metrics.latency_ms_per_instance.p99} ms`);
console.log(`\nNOTE: ${DATASET_META.service_code_note}`);
console.log('Wrote reports/hhcrsp_results.json, .csv and reports/hhcrsp_solutions/');
