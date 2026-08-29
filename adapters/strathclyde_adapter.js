/**
 * Strathclyde adapter — V6 §16.
 *
 * Dataset: "Dataset of Home Care Scheduling and Routing Problems with Synchronized Visits",
 * University of Strathclyde, UK. DOI 10.15129/2d4885e1-bc24-414b-83ce-a846fb5c9689.
 * Temporal coverage 1–14 October 2017, from a private home-care provider in a large UK city.
 * LABEL: PUBLIC_OPERATIONAL_BENCHMARK.
 *
 * What the files actually contain (verified against the CSVs, not assumed from the plan):
 *   carers.csv    CarerId, Date, Begin, End                       138 carers, 1480 rows
 *   visits.csv    VisitId, UserId, Date, Time, Duration, CarerCount  236 users, 6805 rows
 *   distance.csv  a 236 × 236 UserId → UserId travel-time matrix in seconds
 *
 * V6 §16 forbids inventing fields the dataset does not have. Three things the plan expects are
 * genuinely absent, and each is marked NOT_AVAILABLE_IN_DATASET rather than fabricated:
 *
 *   1. TIME WINDOWS. V6 §2 describes "preferred time, time window", but visits.csv carries a
 *      single `Time` plus `Duration`. A window is *assumed* as Time ± TIME_WINDOW_TOLERANCE_MIN.
 *      Every time-window figure in the report is therefore an assumption, not observed data.
 *   2. CARER LOCATIONS. The matrix is user↔user only; carers have no home or start location, so
 *      travel to the first visit of a shift is uncomputable. Only visit-to-visit travel is real.
 *   3. SYNCHRONIZED-VISIT FLAGS. There is no explicit flag. CarerCount = 2 (1493 of 6805 visits)
 *      is *interpreted* as a synchronized visit requiring two carers simultaneously.
 *
 * Skills, language, budget and trust do not exist in this dataset at all, so the operational
 * benchmark exercises availability, scheduling, double-booking and travel only — never matching
 * quality (V6 §2: "ห้ามใช้ทดสอบ ... language_match, budget_rate_fit, trust_history_score").
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const TIME_WINDOW_TOLERANCE_MIN = Number(process.env.STRATHCLYDE_WINDOW_MIN ?? 30);

export const DATASET_META = {
  label: 'PUBLIC_OPERATIONAL_BENCHMARK',
  name: 'Dataset of Home Care Scheduling and Routing Problems with Synchronized Visits',
  institution: 'University of Strathclyde, UK',
  doi: '10.15129/2d4885e1-bc24-414b-83ce-a846fb5c9689',
  url: 'https://pureportal.strath.ac.uk/en/datasets/dataset-of-home-care-scheduling-and-routing-problems-with-synchro/',
  temporal_coverage: '2017-10-01 to 2017-10-14',
  not_available_in_dataset: [
    'skills',
    'skill_levels',
    'language',
    'budget',
    'rate',
    'trust_history',
    'caregiver_preferences',
    'family_preferences',
    'mutual_interest',
    'carer_home_location',
    'explicit_time_windows',
    'explicit_synchronization_flag',
  ],
  assumptions: [
    `time window = scheduled Time ± ${TIME_WINDOW_TOLERANCE_MIN} min (dataset has a single time, not a window)`,
    'CarerCount = 2 interpreted as a synchronized visit requiring two carers simultaneously',
    'travel measured only between consecutive visits; carer start locations are not in the dataset',
  ],
};

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

const hhmmToMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};
const isoTimeToMin = (iso) => {
  const t = String(iso).split('T')[1] ?? '00:00:00';
  return hhmmToMin(t);
};

/**
 * @returns {{carers, visits, matrix, meta}}
 *   carers: Map<carerId, [{date, begin_min, end_min}]>
 *   visits: [{visit_id, user_id, date, start_min, end_min, duration_min, carer_count,
 *             window_start_min, window_end_min}]
 *   matrix: (fromUserId, toUserId) => seconds | null
 */
export function loadStrathclyde(dir) {
  const carersRows = parseCsv(readFileSync(resolve(dir, 'carers.csv'), 'utf8'));
  const visitsRows = parseCsv(readFileSync(resolve(dir, 'visits.csv'), 'utf8'));
  const distanceText = readFileSync(resolve(dir, 'distance.csv'), 'utf8');

  // ── carers: availability shifts, keyed by carer then date
  const carers = new Map();
  for (const r of carersRows) {
    const id = r.CarerId;
    if (!carers.has(id)) carers.set(id, []);
    carers.get(id).push({
      date: r.Date,
      begin_min: isoTimeToMin(r.Begin),
      end_min: isoTimeToMin(r.End),
    });
  }

  // ── visits
  const visits = visitsRows.map((r) => {
    const start = hhmmToMin(r.Time);
    const durationMin = Math.round(Number(r.Duration) / 60);
    return {
      visit_id: r.VisitId,
      user_id: r.UserId,
      date: r.Date,
      start_min: start,
      end_min: start + durationMin,
      duration_min: durationMin,
      carer_count: Number(r.CarerCount),
      // ASSUMPTION — see the module header
      window_start_min: start - TIME_WINDOW_TOLERANCE_MIN,
      window_end_min: start + TIME_WINDOW_TOLERANCE_MIN,
    };
  });

  // ── travel matrix.
  // Header:   "UserId", then 236 destination ids               → 237 fields
  // Data row: row index, source UserId, then 236 travel times  → 238 fields
  // So cells[2 + i] is the travel time from cells[1] to userIds[i].
  const dLines = distanceText.trim().split(/\r?\n/);
  const userIds = dLines[0].split(',').slice(1);
  const matrixMap = new Map();
  for (const line of dLines.slice(1)) {
    const cells = line.split(',');
    const fromId = cells[1];
    const row = new Map();
    for (let i = 0; i < userIds.length; i += 1) {
      const v = Number(cells[i + 2]);
      if (Number.isFinite(v)) row.set(userIds[i], v);
    }
    matrixMap.set(fromId, row);
  }

  const matrix = (from, to) => {
    if (from === to) return 0;
    const v = matrixMap.get(String(from))?.get(String(to));
    return v == null ? null : v;
  };

  return {
    carers,
    visits,
    matrix,
    meta: {
      ...DATASET_META,
      carer_count: carers.size,
      visit_count: visits.length,
      user_count: new Set(visits.map((v) => v.user_id)).size,
      synchronized_visit_count: visits.filter((v) => v.carer_count > 1).length,
      matrix_dimension: matrixMap.size,
      date_range: [
        visits.reduce((a, v) => (v.date < a ? v.date : a), '9999'),
        visits.reduce((a, v) => (v.date > a ? v.date : a), '0000'),
      ],
    },
  };
}

/**
 * Map one carer's shift on one date into the shape the TrustCare engine's availability filter
 * understands (V6 §16: carer Begin/End → caregiver availability).
 */
export function toCaregiver(carerId, shifts) {
  return {
    id: `STRATH-CG-${carerId}`,
    verification_status: 'VERIFIED',
    availability: shifts.map((s) => ({
      recurring: false,
      specific_date: s.date,
      start_time: minToHHMM(s.begin_min),
      end_time: minToHHMM(s.end_min),
    })),
    max_hours_per_shift: 24,
    // Everything below is NOT_AVAILABLE_IN_DATASET and is set to a value that cannot filter.
    skills: [],
    languages: [],
    service_radius_km: Infinity,
    minimum_rate: 0,
    expected_rate: 0,
  };
}

export function minToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
