/**
 * Fixture builders for engine tests and the controlled benchmark.
 *
 * Everything is explicit and deterministic — no randomness, no clock dependence — so a test that
 * passes today passes identically in the benchmark run (V6 §23.5 requires a deterministic seed).
 */

/** Bangkok-ish origin; offsets below are computed to give exact target distances. */
export const ORIGIN = { lat: 13.7563, lng: 100.5018 };

/** Return a point `km` north of ORIGIN — lets a test say "put this caregiver 145 km away". */
/** Must match geo.js's earth radius, or a fixture's "145 km" lands somewhere else. */
const KM_PER_DEGREE_LAT = (6371 * Math.PI) / 180;

export function pointAtKm(km) {
  return { lat: ORIGIN.lat + km / KM_PER_DEGREE_LAT, lng: ORIGIN.lng };
}

export function makeCareRequest(overrides = {}) {
  const { distanceKm, ...rest } = overrides;
  return {
    id: 'CR-1',
    family_id: 'FAM-1',
    elderly_id: 'ELD-1',
    status: 'CONFIRMED',
    visibility: 'MATCHED_ONLY',
    care_date: '2026-09-01', // a Tuesday → weekday 2
    start_time: '08:00',
    end_time: '16:00',
    latitude: ORIGIN.lat,
    longitude: ORIGIN.lng,
    budget: 1000,
    conditions_relevant: ['DIABETES'],
    mobility_requirement: 'WALKING_ASSIST',
    tasks: [
      { task_code: 'MEAL_PREP', must_do: true },
      { task_code: 'MEDICATION_REMINDER', must_do: true },
    ],
    requirements: [
      { requirement_type: 'SKILL', requirement_code: 'ELDERLY_CARE', strength: 'MANDATORY' },
      { requirement_type: 'SKILL', requirement_code: 'DIABETES_CARE', strength: 'MANDATORY' },
      { requirement_type: 'LANGUAGE', requirement_code: 'TH', strength: 'MANDATORY' },
    ],
    hospital_visit: false,
    transport_required: false,
    lifting_required: false,
    medical_device_support: false,
    night_monitoring: false,
    live_in_required: false,
    recurring_job: false,
    continuity_preference: 'ONE_TIME',
    minimum_experience: 2,
    accept_out_of_area: false,
    environment: {},
    ...rest,
  };
}

export function makeCaregiver(overrides = {}) {
  const { distanceKm, ...rest } = overrides;
  const base = distanceKm != null ? pointAtKm(distanceKm) : ORIGIN;
  return {
    id: 'CG-1',
    verification_status: 'VERIFIED',
    gender: 'FEMALE',
    years_experience: 5,
    skills: ['ELDERLY_CARE', 'DIABETES_CARE'],
    skill_levels: { ELDERLY_CARE: 4, DIABETES_CARE: 4 },
    certificates: [],
    condition_experience: { DIABETES: 3 },
    languages: ['TH'],
    availability: [{ recurring: true, weekday: 2, start_time: '07:00', end_time: '18:00' }],
    priority_preferences: [],

    base_latitude: base.lat,
    base_longitude: base.lng,
    service_radius_km: 25,
    max_travel_time_minutes: 60,
    transport_mode: 'MOTORCYCLE',

    minimum_rate: 700,
    expected_rate: 900,
    travel_fee_per_km: 5,
    overtime_rate: null,

    max_hours_per_shift: 12,
    daytime_ok: true,
    nighttime_ok: false,

    preferred_job_types: ['MEAL_PREP', 'MEDICATION_REMINDER'],
    not_preferred_job_types: [],
    general_care_ok: true,
    dementia_care_ok: false,
    bedbound_care_ok: false,
    hospital_escort_ok: false,
    mobility_heavy_job_ok: false,
    lifting_job_ok: false,
    live_in_ok: false,
    one_time_job_ok: true,
    recurring_job_ok: true,
    long_term_job_ok: false,

    care_styles: [],
    communication_styles: [],
    pet_home_ok: true,
    smoking_environment_ok: false,

    out_of_area_enabled: false,
    max_out_of_area_distance_km: 0,
    accommodation_required_after_km: 150,
    accommodation_minimum: 700,
    overnight_ok: false,
    relocation_short_term_ok: false,

    final_trust_score: 80,
    trust_status: 'ESTABLISHED',
    completed_jobs: 10,
    review_count: 8,
    confirmed_incident_count: 0,
    ...rest,
  };
}

/**
 * A caregiver who fits everything perfectly, used as the base for the far-match cases —
 * so that when a test moves them 145 km away, distance is provably the only thing that changed.
 */
export function makePerfectCaregiver(overrides = {}) {
  return makeCaregiver({
    years_experience: 12,
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5 },
    condition_experience: { DIABETES: 8 },
    expected_rate: 900,
    minimum_rate: 600,
    final_trust_score: 95,
    availability: [{ recurring: true, weekday: 2, start_time: '06:00', end_time: '20:00' }],
    ...overrides,
  });
}
