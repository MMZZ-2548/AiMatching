/**
 * HHCRSP adapter — V6 §17.
 *
 * Dataset: "Data and Toolbox Repository for the Home Healthcare Routing and Scheduling Problem",
 * Intelligent Optimization Laboratory, Università degli Studi di Udine. MIT licensed.
 * Repository https://github.com/iolab-uniud/hhcrsp · Paper DOI 10.1111/itor.13585.
 * LABEL: PUBLIC_ACADEMIC_BENCHMARK.
 *
 * Instance shape (verified against the cloned files):
 *   patients[]        id, location [x,y], time_window [start,end],
 *                     required_caregivers[] {service, duration},
 *                     synchronization {type, distance:[min,max]}                (optional)
 *   services[]        id, default_duration
 *   caregivers[]      id, abilities[]        ← service ids they can perform
 *   central_offices[] id, location
 *   distances[][]     square matrix over [office, patients...] — office is index 0
 *
 * V6 §17 mapping into TrustCare:
 *   patient.id                        → care_request_id
 *   patient.location                  → care_location
 *   patient.time_window               → allowed_time_window
 *   required_caregivers[].service     → required_service_code, strength MANDATORY
 *   service duration                  → task duration
 *   caregiver.abilities               → caregiver.skills
 *   synchronization                   → simultaneous / sequential constraint
 *
 * IMPORTANT (V6 §3): s1…s6 carry no clinical meaning in this dataset. They are treated purely as
 * service-compatibility proxies, and no report may claim any of them denotes a specific condition
 * or real-world skill.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

export const DATASET_META = {
  label: 'PUBLIC_ACADEMIC_BENCHMARK',
  name: 'Data and Toolbox Repository for the Home Healthcare Routing and Scheduling Problem',
  institution: 'Intelligent Optimization Laboratory, Università degli Studi di Udine, Italy',
  repository: 'https://github.com/iolab-uniud/hhcrsp',
  paper_doi: '10.1111/itor.13585',
  license: 'MIT',
  service_code_note:
    'service codes s1..sN are compatibility proxies with no clinical meaning in this dataset (V6 §3)',
  not_available_in_dataset: [
    'language', 'budget', 'rate', 'trust_history', 'family_preference',
    'caregiver_job_preference', 'mutual_interest', 'care_style', 'continuity',
  ],
};

export function listInstances(root, family = 'mankowska') {
  const dir = resolve(root, 'instances', family);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => resolve(dir, f));
}

export function loadInstance(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const patients = raw.patients ?? [];
  const office = raw.central_offices?.[0] ?? null;

  // Distance matrix indexing: the central office is row/column 0 and the patients follow in
  // declaration order at 1..N. Verified against the upstream validator — reading it the other way
  // round (office last) yields plausible but wrong numbers, e.g. on InstanzVNS_HCSRP_100_10 the
  // p94→p2 leg reads 30.0 instead of the true 63.702.
  const index = new Map(patients.map((p, i) => [p.id, i + 1]));
  if (office) index.set(office.id, 0);

  const distanceBetween = (aId, bId) => {
    const i = index.get(aId);
    const j = index.get(bId);
    if (i == null || j == null) return null;
    return raw.distances?.[i]?.[j] ?? null;
  };

  const serviceDuration = new Map((raw.services ?? []).map((s) => [s.id, s.default_duration]));

  /** One (patient, service) pair is one unit of work to be assigned. */
  const tasks = [];
  for (const p of patients) {
    const reqs = p.required_caregivers ?? [];
    reqs.forEach((r, slot) => {
      tasks.push({
        task_id: `${p.id}#${r.service}`,
        patient_id: p.id,
        service: r.service,
        duration: r.duration ?? serviceDuration.get(r.service) ?? 0,
        window_start: p.time_window?.[0] ?? 0,
        window_end: p.time_window?.[1] ?? Infinity,
        slot,
        sibling_count: reqs.length,
        synchronization: reqs.length > 1 ? (p.synchronization?.type ?? 'simultaneous') : null,
        // A `sequential` patient constrains the GAP BETWEEN SERVICE START TIMES to lie in
        // [min, max] — not merely "one after the other". Dropping this window is how an earlier
        // run produced schedules the upstream validator rejected.
        sync_distance: reqs.length > 1 ? (p.synchronization?.distance ?? null) : null,
      });
    });
  }

  return {
    name: basename(path, '.json'),
    patients,
    services: raw.services ?? [],
    caregivers: (raw.caregivers ?? []).map((c) => ({
      id: c.id,
      skills: c.abilities ?? [],
      // Everything below is NOT_AVAILABLE_IN_DATASET; set so it cannot filter anything out.
      verification_status: 'VERIFIED',
      languages: [],
      service_radius_km: Infinity,
      minimum_rate: 0,
      expected_rate: 0,
      max_hours_per_shift: 24,
    })),
    office,
    tasks,
    distanceBetween,
    patient_count: patients.length,
    task_count: tasks.length,
    synchronized_patient_count: patients.filter((p) => (p.required_caregivers ?? []).length > 1).length,
  };
}

/**
 * A TrustCare care request for one unit of work, so the engine's own mandatory-skill filter is
 * what decides service compatibility rather than a benchmark-only reimplementation.
 */
export function toCareRequest(task) {
  return {
    id: task.task_id,
    care_date: '2017-01-01', // the dataset is time-of-day only; a fixed date keeps windows comparable
    start_time: minutesToHHMM(task.window_start),
    end_time: minutesToHHMM(task.window_start + task.duration),
    requirements: [
      { requirement_type: 'SKILL', requirement_code: task.service, strength: 'MANDATORY' },
    ],
    tasks: [{ task_code: task.service, must_do: true }],
  };
}

export function minutesToHHMM(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
