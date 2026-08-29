/**
 * Demo seed — V4 §40 (5 families, 5 elderly, 20 caregivers, 15 care requests) plus the four
 * distance-specific caregivers V5 §32 names explicitly.
 *
 * Deterministic: fixed ids, fixed coordinates, no randomness, no clock reads. Re-seeding produces
 * the same world, which is what makes the tester scenarios and the E2E suite repeatable.
 *
 * Geography is Yala province, matching the V4 §40 examples. Coordinates are offset from the city
 * centre by exact distances so "3 km away" in a scenario really is 3 km to the engine.
 */

import { store } from '../store/index.js';
import { codeToUuid } from '../lib/ids.js';

const YALA = { lat: 6.5410, lng: 101.2800 };
const KM_PER_DEG = (6371 * Math.PI) / 180;
const at = (km, bearing = 0) => ({
  latitude: YALA.lat + (km / KM_PER_DEG) * Math.cos(bearing),
  longitude: YALA.lng + (km / KM_PER_DEG) * Math.sin(bearing) / Math.cos((YALA.lat * Math.PI) / 180),
});

const DAYS_ALL = [0, 1, 2, 3, 4, 5, 6];
const avail = (days, start, end) =>
  days.map((weekday) => ({ recurring: true, weekday, start_time: start, end_time: end }));

// ───────────────────────────────────────────── families & elderly (V4 §40)

const FAMILIES = [
  { id: 'FAM-1', email: 'family1@trustcare.test', display_name: 'ครอบครัวอาทิตย์', relation_to_elderly: 'ลูกสาว' },
  { id: 'FAM-2', email: 'family2@trustcare.test', display_name: 'ครอบครัวจันทรา', relation_to_elderly: 'ลูกชาย' },
  { id: 'FAM-3', email: 'family3@trustcare.test', display_name: 'ครอบครัวมณี', relation_to_elderly: 'หลาน' },
  { id: 'FAM-4', email: 'family4@trustcare.test', display_name: 'ครอบครัวพิทักษ์', relation_to_elderly: 'ลูกสาว' },
  { id: 'FAM-5', email: 'family5@trustcare.test', display_name: 'ครอบครัวสายบุรี', relation_to_elderly: 'คู่สมรส' },
];

const ELDERLY = [
  { id: 'ELD-1', family_id: 'FAM-1', display_name: 'คุณยายสมพร', age: 72, gender: 'FEMALE',
    basic_conditions: ['DIABETES'], mobility_level: 'WALKING_ASSIST', preferred_language: ['TH'],
    fall_risk: true, ...at(0) },
  { id: 'ELD-2', family_id: 'FAM-2', display_name: 'คุณตาบุญมี', age: 81, gender: 'MALE',
    basic_conditions: ['STROKE'], mobility_level: 'WHEELCHAIR', preferred_language: ['TH'],
    fall_risk: true, medical_devices: ['WHEELCHAIR'], ...at(4, 1.2) },
  { id: 'ELD-3', family_id: 'FAM-3', display_name: 'คุณยายเพ็ญ', age: 78, gender: 'FEMALE',
    basic_conditions: ['DEMENTIA'], mobility_level: 'SUPERVISION', preferred_language: ['TH', 'MS'],
    fall_risk: true, notes: 'มีความเสี่ยงเดินออกนอกบ้านตอนกลางคืน', ...at(7, 2.4) },
  { id: 'ELD-4', family_id: 'FAM-4', display_name: 'คุณตาวิรัตน์', age: 69, gender: 'MALE',
    basic_conditions: [], mobility_level: 'INDEPENDENT', preferred_language: ['TH'],
    fall_risk: false, ...at(2, 3.5) },
  { id: 'ELD-5', family_id: 'FAM-5', display_name: 'คุณยายรอกีเยาะ', age: 84, gender: 'FEMALE',
    basic_conditions: ['STROKE', 'PRESSURE_ULCER_RISK'], mobility_level: 'BEDBOUND',
    preferred_language: ['MS', 'TH'], fall_risk: false, medical_devices: ['HOSPITAL_BED'], ...at(11, 4.7) },
];

// ───────────────────────────────────────────── caregivers

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const baseCaregiver = {
  verification_status: 'VERIFIED',
  years_experience: 4,
  skills: ['ELDERLY_CARE'],
  skill_levels: { ELDERLY_CARE: 3 },
  certificates: [],
  condition_experience: {},
  languages: ['TH'],
  // Home care runs seven days a week. Seeding most caregivers Mon-Fri made every weekend date
  // return almost nothing, which looked like a broken matcher rather than a staffing pattern.
  availability: avail(DAYS_ALL, '08:00', '18:00'),
  priority_preferences: [],
  service_radius_km: 25,
  max_travel_time_minutes: 60,
  transport_mode: 'MOTORCYCLE',
  minimum_rate: 700,
  expected_rate: 900,
  travel_fee_per_km: 5,
  max_hours_per_shift: 12,
  daytime_ok: true,
  nighttime_ok: false,
  preferred_job_types: [],
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
  accommodation_minimum: 800,
  overnight_ok: false,
  relocation_short_term_ok: false,
  final_trust_score: 70,
  trust_status: 'ESTABLISHED',
  completed_jobs: 6,
  review_count: 4,
  mean_rating: 4.2,
  confirmed_incident_count: 0,
};

const km = (d, b = 0) => {
  const p = at(d, b);
  return { base_latitude: p.latitude, base_longitude: p.longitude };
};

const CAREGIVERS = [
  // — V5 §32 named caregivers, built for the exceptional-distance scenarios
  { id: 'CG_NEAR_01', display_name: 'นารี ใกล้บ้าน', gender: 'FEMALE', ...km(3, 0.5),
    years_experience: 9, skills: ['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5, MEDICATION: 4 },
    condition_experience: { DIABETES: 7 }, final_trust_score: 92, completed_jobs: 40,
    review_count: 22, mean_rating: 4.7, preferred_job_types: ['MEAL_PREP', 'MEDICATION_REMINDER'],
    expected_rate: 900, minimum_rate: 700, availability: avail(DAYS_ALL, '07:00', '19:00') },

  { id: 'CG_NEAR_02', display_name: 'สมชาย กลางเมือง', gender: 'MALE', ...km(8, 1.9),
    years_experience: 4, skills: ['ELDERLY_CARE', 'DIABETES_CARE'],
    skill_levels: { ELDERLY_CARE: 3, DIABETES_CARE: 3 }, condition_experience: { DIABETES: 2 },
    final_trust_score: 74, expected_rate: 1000, minimum_rate: 800 },

  { id: 'CG_FAR_PERFECT_01', display_name: 'ฟาติมา ต่างจังหวัด', gender: 'FEMALE', ...km(145, 0.3),
    years_experience: 14, skills: ['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION', 'WOUND_CARE'],
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5, MEDICATION: 5, WOUND_CARE: 5 },
    condition_experience: { DIABETES: 10, STROKE: 6 }, languages: ['TH', 'MS'],
    final_trust_score: 96, completed_jobs: 80, review_count: 45, mean_rating: 4.9,
    preferred_job_types: ['MEAL_PREP', 'MEDICATION_REMINDER', 'PERSONAL_CARE'],
    expected_rate: 900, minimum_rate: 700, availability: avail(DAYS_ALL, '06:00', '20:00'),
    out_of_area_enabled: true, max_out_of_area_distance_km: 300, overnight_ok: true,
    relocation_short_term_ok: true, accommodation_required_after_km: 120, accommodation_minimum: 800,
    travel_fee_per_km: 6, hospital_escort_ok: true, transport_mode: 'CAR',
    mobility_heavy_job_ok: true, lifting_job_ok: true, long_term_job_ok: true },

  { id: 'CG_FAR_NO_OPTIN', display_name: 'อารีย์ ไม่รับนอกพื้นที่', gender: 'FEMALE', ...km(120, 5.1),
    years_experience: 12, skills: ['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5, MEDICATION: 5 },
    condition_experience: { DIABETES: 9 }, final_trust_score: 94, completed_jobs: 60,
    review_count: 30, mean_rating: 4.8, expected_rate: 900,
    availability: avail(DAYS_ALL, '06:00', '20:00'), out_of_area_enabled: false },

  // — general pool
  { id: 'CG-05', display_name: 'ซูรียา ดูแลสมองเสื่อม', gender: 'FEMALE', ...km(6, 2.2),
    skills: ['ELDERLY_CARE', 'DEMENTIA_CARE'], skill_levels: { ELDERLY_CARE: 4, DEMENTIA_CARE: 5 },
    condition_experience: { DEMENTIA: 6 }, dementia_care_ok: true, nighttime_ok: true,
    languages: ['TH', 'MS'], final_trust_score: 88, years_experience: 8, review_count: 12, mean_rating: 4.6,
    availability: avail(DAYS_ALL, '18:00', '08:00') },

  { id: 'CG-06', display_name: 'ประยุทธ ยกเคลื่อนย้าย', gender: 'MALE', ...km(9, 3.1),
    skills: ['ELDERLY_CARE', 'TRANSFER', 'WOUND_CARE', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 4, TRANSFER: 5, WOUND_CARE: 3 },
    condition_experience: { STROKE: 5 }, mobility_heavy_job_ok: true, lifting_job_ok: true,
    bedbound_care_ok: true, final_trust_score: 82, years_experience: 7, expected_rate: 1100, minimum_rate: 900 },

  { id: 'CG-07', display_name: 'มณีรัตน์ พาไปโรงพยาบาล', gender: 'FEMALE', ...km(5, 4.4),
    skills: ['ELDERLY_CARE', 'ESCORT', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 3, ESCORT: 4, MEDICATION: 3 },
    hospital_escort_ok: true, transport_mode: 'CAR', final_trust_score: 79, years_experience: 5 },

  { id: 'CG-08', display_name: 'ฮาซัน ภาษามลายู', gender: 'MALE', ...km(12, 5.6),
    skills: ['ELDERLY_CARE'], languages: ['MS', 'TH'], final_trust_score: 71, years_experience: 3,
    availability: avail(WEEKDAYS, '08:00', '18:00') },

  { id: 'CG-09', display_name: 'วิภา งานประจำระยะยาว', gender: 'FEMALE', ...km(4, 0.9),
    skills: ['ELDERLY_CARE', 'MEAL_PREP', 'DIABETES_CARE', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 4, MEAL_PREP: 4, DIABETES_CARE: 3, MEDICATION: 4 },
    condition_experience: { DIABETES: 3 },
    long_term_job_ok: true, one_time_job_ok: false, recurring_job_ok: true,
    final_trust_score: 85, years_experience: 6, review_count: 9, mean_rating: 4.5 },

  { id: 'CG-10', display_name: 'อนันต์ กะกลางคืน', gender: 'MALE', ...km(10, 1.5),
    skills: ['ELDERLY_CARE'], nighttime_ok: true, daytime_ok: false,
    availability: avail(DAYS_ALL, '20:00', '06:00'), final_trust_score: 68, years_experience: 4 },

  { id: 'CG-11', display_name: 'กมลา ค่าตอบแทนสูง', gender: 'FEMALE', ...km(3, 2.8),
    skills: ['ELDERLY_CARE', 'DIABETES_CARE'], skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 4 },
    minimum_rate: 1500, expected_rate: 1800, final_trust_score: 90, years_experience: 11,
    review_count: 18, mean_rating: 4.8 },

  { id: 'CG-12', display_name: 'ธนา ทักษะครบแต่ยังไม่ยืนยัน', gender: 'MALE', ...km(4, 3.9),
    skills: ['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION'],
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 5, MEDICATION: 5 },
    verification_status: 'PENDING', final_trust_score: 0, trust_status: 'NEW',
    completed_jobs: 0, review_count: 0, mean_rating: null, years_experience: 10 },

  { id: 'CG-13', display_name: 'ปรียา มือใหม่', gender: 'FEMALE', ...km(6, 5.0),
    skills: ['ELDERLY_CARE'], skill_levels: { ELDERLY_CARE: 2 }, years_experience: 1,
    completed_jobs: 1, review_count: 1, mean_rating: 5, final_trust_score: 62, trust_status: 'NEW',
    availability: avail(WEEKDAYS, '08:00', '18:00') },

  { id: 'CG-14', display_name: 'สุนีย์ เคยมีเหตุการณ์', gender: 'FEMALE', ...km(7, 0.2),
    skills: ['ELDERLY_CARE', 'DIABETES_CARE'], confirmed_incident_count: 1,
    final_trust_score: 55, years_experience: 5, review_count: 7, mean_rating: 3.6 },

  { id: 'CG-15', display_name: 'อับดุล อยู่ประจำบ้าน', gender: 'MALE', ...km(14, 1.1),
    skills: ['ELDERLY_CARE', 'TRANSFER'], live_in_ok: true, long_term_job_ok: true,
    mobility_heavy_job_ok: true, lifting_job_ok: true, languages: ['MS', 'TH'],
    final_trust_score: 80, years_experience: 8 },

  { id: 'CG-16', display_name: 'จันทิมา ไม่รับงานอาบน้ำ', gender: 'FEMALE', ...km(5, 2.0),
    skills: ['ELDERLY_CARE', 'MEAL_PREP'], not_preferred_job_types: ['BATHING', 'TOILETING'],
    final_trust_score: 76, years_experience: 5, availability: avail(WEEKDAYS, '08:00', '18:00') },

  { id: 'CG-17', display_name: 'เสาวลักษณ์ นอกรัศมี', gender: 'FEMALE', ...km(40, 3.3),
    skills: ['ELDERLY_CARE', 'DIABETES_CARE'], service_radius_km: 15,
    final_trust_score: 78, years_experience: 6, availability: avail(WEEKDAYS, '08:00', '18:00') },

  { id: 'CG-18', display_name: 'ไพศาล แผลกดทับ', gender: 'MALE', ...km(8, 4.1),
    skills: ['ELDERLY_CARE', 'WOUND_CARE', 'TRANSFER'],
    skill_levels: { ELDERLY_CARE: 4, WOUND_CARE: 5, TRANSFER: 4 },
    certificates: [{ credential_code: 'NURSE_AIDE', verified: true, expires_at: '2030-12-31' }],
    condition_experience: { STROKE: 4, PRESSURE_ULCER_RISK: 5 },
    bedbound_care_ok: true, mobility_heavy_job_ok: true, lifting_job_ok: true,
    final_trust_score: 89, years_experience: 10, review_count: 15, mean_rating: 4.7 },

  { id: 'CG-19', display_name: 'ยุพิน ครึ่งวัน', gender: 'FEMALE', ...km(2, 5.9),
    skills: ['ELDERLY_CARE'], max_hours_per_shift: 5,
    availability: avail([1, 3, 5], '08:00', '13:00'), final_trust_score: 73, years_experience: 4 },

  { id: 'CG-20', display_name: 'รอฮีมะห์ ครบเครื่อง', gender: 'FEMALE', ...km(6, 1.7),
    skills: ['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION', 'MEAL_PREP', 'ESCORT'],
    skill_levels: { ELDERLY_CARE: 5, DIABETES_CARE: 4, MEDICATION: 4, MEAL_PREP: 5, ESCORT: 4 },
    condition_experience: { DIABETES: 5 }, languages: ['TH', 'MS'],
    hospital_escort_ok: true, transport_mode: 'CAR', long_term_job_ok: true,
    final_trust_score: 91, years_experience: 12, review_count: 26, mean_rating: 4.8,
    availability: avail(DAYS_ALL, '07:00', '19:00') },
];

// ───────────────────────────────────────────── care requests (V4 §40: 15, covering 16 outcomes)

const req = (o) => ({
  status: 'CONFIRMED',
  visibility: 'MATCHED_ONLY',
  care_date: '2026-09-01', // Tuesday → weekday 2
  start_time: '08:00',
  end_time: '16:00',
  budget: 1000,
  conditions_relevant: [],
  mobility_requirement: 'INDEPENDENT',
  tasks: [{ task_code: 'MEAL_PREP', must_do: true }],
  requirements: [{ requirement_type: 'SKILL', requirement_code: 'ELDERLY_CARE', strength: 'MANDATORY' }],
  hospital_visit: false,
  transport_required: false,
  lifting_required: false,
  night_monitoring: false,
  live_in_required: false,
  recurring_job: false,
  continuity_preference: 'ONE_TIME',
  minimum_experience: 2,
  accept_out_of_area: false,
  environment: {},
  ...o,
});

const skillReq = (codes, strength = 'MANDATORY', minimum_level = null) =>
  codes.map((c) => ({ requirement_type: 'SKILL', requirement_code: c, strength, minimum_level }));

const CARE_REQUESTS = [
  req({ id: 'CR-01', family_id: 'FAM-1', elderly_id: 'ELD-1', ...at(0),
    conditions_relevant: ['DIABETES'], mobility_requirement: 'WALKING_ASSIST',
    requirements: [...skillReq(['ELDERLY_CARE', 'DIABETES_CARE']),
      { requirement_type: 'LANGUAGE', requirement_code: 'TH', strength: 'MANDATORY' }],
    tasks: [{ task_code: 'MEAL_PREP', must_do: true }, { task_code: 'MEDICATION_REMINDER', must_do: true }],
    scenario: 'perfect match available' }),

  req({ id: 'CR-02', family_id: 'FAM-1', elderly_id: 'ELD-1', ...at(0),
    requirements: skillReq(['ELDERLY_CARE', 'PALLIATIVE_CARE']),
    scenario: 'no caregiver has the mandatory skill' }),

  req({ id: 'CR-03', family_id: 'FAM-2', elderly_id: 'ELD-2', ...at(4, 1.2),
    conditions_relevant: ['STROKE'], mobility_requirement: 'WHEELCHAIR', lifting_required: true,
    requirements: skillReq(['ELDERLY_CARE', 'TRANSFER']),
    tasks: [{ task_code: 'TRANSFER', must_do: true }, { task_code: 'MEAL_PREP', must_do: true }],
    budget: 1200, scenario: 'heavy lifting and transfer' }),

  req({ id: 'CR-04', family_id: 'FAM-3', elderly_id: 'ELD-3', ...at(7, 2.4),
    conditions_relevant: ['DEMENTIA'], mobility_requirement: 'SUPERVISION', night_monitoring: true,
    start_time: '20:00', end_time: '06:00',
    requirements: [...skillReq(['ELDERLY_CARE', 'DEMENTIA_CARE'])],
    tasks: [{ task_code: 'NIGHT_MONITORING', must_do: true }],
    budget: 1400, scenario: 'night shift, dementia' }),

  req({ id: 'CR-05', family_id: 'FAM-4', elderly_id: 'ELD-4', ...at(2, 3.5),
    hospital_visit: true, transport_required: true,
    requirements: skillReq(['ELDERLY_CARE', 'ESCORT']),
    tasks: [{ task_code: 'HOSPITAL_ESCORT', must_do: true }],
    budget: 1100, scenario: 'hospital escort' }),

  req({ id: 'CR-06', family_id: 'FAM-5', elderly_id: 'ELD-5', ...at(11, 4.7),
    conditions_relevant: ['STROKE', 'PRESSURE_ULCER_RISK'], mobility_requirement: 'BEDBOUND',
    lifting_required: true,
    requirements: [...skillReq(['ELDERLY_CARE', 'WOUND_CARE', 'TRANSFER']),
      { requirement_type: 'CREDENTIAL', requirement_code: 'NURSE_AIDE', strength: 'MANDATORY' },
      { requirement_type: 'LANGUAGE', requirement_code: 'MS', strength: 'IMPORTANT' }],
    tasks: [{ task_code: 'WOUND_CARE', must_do: true }, { task_code: 'TRANSFER', must_do: true }],
    budget: 1600, scenario: 'bedbound, credential required' }),

  req({ id: 'CR-07', family_id: 'FAM-1', elderly_id: 'ELD-1', ...at(0),
    budget: 400, scenario: 'budget below every caregiver minimum' }),

  req({ id: 'CR-08', family_id: 'FAM-3', elderly_id: 'ELD-3', ...at(7, 2.4),
    requirements: [...skillReq(['ELDERLY_CARE']),
      { requirement_type: 'LANGUAGE', requirement_code: 'MS', strength: 'MANDATORY' }],
    scenario: 'mandatory Malay' }),

  req({ id: 'CR-09', family_id: 'FAM-1', elderly_id: 'ELD-1', ...at(0),
    requirements: [...skillReq(['ELDERLY_CARE']),
      { requirement_type: 'GENDER', requirement_code: 'FEMALE', strength: 'MANDATORY' }],
    tasks: [{ task_code: 'BATHING', must_do: true }],
    scenario: 'female caregiver mandatory for personal care' }),

  req({ id: 'CR-10', family_id: 'FAM-4', elderly_id: 'ELD-4', ...at(2, 3.5),
    recurring_job: true, continuity_preference: 'LONG_TERM',
    scenario: 'long-term recurring engagement' }),

  req({ id: 'CR-11', family_id: 'FAM-2', elderly_id: 'ELD-2', ...at(4, 1.2),
    live_in_required: true, continuity_preference: 'LONG_TERM', recurring_job: true,
    start_time: '08:00', end_time: '18:00', budget: 1800,
    requirements: skillReq(['ELDERLY_CARE', 'TRANSFER']),
    scenario: 'live-in' }),

  req({ id: 'CR-12', family_id: 'FAM-5', elderly_id: 'ELD-5', ...at(11, 4.7),
    conditions_relevant: ['STROKE'], mobility_requirement: 'BEDBOUND',
    requirements: skillReq(['ELDERLY_CARE', 'DIABETES_CARE', 'MEDICATION'], 'MANDATORY', 4),
    accept_out_of_area: true, budget: 1500,
    scenario: 'exceptional far match — family opted in' }),

  // Deliberately MATCHED_ONLY: the job board must start empty so a tester posts their own
  // first posting and sees it appear, rather than finding one already there.
  req({ id: 'CR-13', family_id: 'FAM-1', elderly_id: 'ELD-1', ...at(0),
    conditions_relevant: ['DIABETES'],
    requirements: skillReq(['ELDERLY_CARE', 'DIABETES_CARE']),
    scenario: 'งานทั่วไป ยังไม่ได้ประกาศ' }),

  req({ id: 'CR-14', family_id: 'FAM-3', elderly_id: 'ELD-3', ...at(7, 2.4),
    visibility: 'PRIVATE', requirements: skillReq(['ELDERLY_CARE']),
    scenario: 'private request, direct invitation only' }),

  req({ id: 'CR-15', family_id: 'FAM-4', elderly_id: 'ELD-4', ...at(2, 3.5),
    start_time: '08:00', end_time: '13:00',
    requirements: skillReq(['ELDERLY_CARE']),
    budget: 600, scenario: 'short half-day shift' }),
];

// ───────────────────────────────────────────── apply

export async function seed({ reset = true } = {}) {
  if (reset && store.driver === 'memory') await store.reset();

  // Readable codes stay in `code`; the primary key is a uuid derived from the code, so re-seeding
  // is idempotent against Postgres and the scenarios keep referring to "CR-01" (see lib/ids.js).
  const id = codeToUuid;

  for (const f of FAMILIES) {
    const { id: code, ...rest } = f;
    await store.upsert('profiles', { id: id(code) }, { id: id(code), code, ...rest, role: 'FAMILY' });
  }
  for (const e of ELDERLY) {
    const { id: code, family_id, ...rest } = e;
    await store.upsert('elderly_profiles', { id: id(code) },
      { id: id(code), code, family_id: id(family_id), ...rest });
  }
  for (const c of CAREGIVERS) {
    const { id: code, ...rest } = c;
    const profileCode = `PRF-${code}`;
    await store.upsert('profiles', { id: id(profileCode) }, {
      id: id(profileCode),
      code: profileCode,
      role: 'CAREGIVER',
      email: `${code.toLowerCase()}@trustcare.test`,
      display_name: c.display_name,
    });
    await store.upsert('caregiver_profiles', { id: id(code) },
      { ...baseCaregiver, ...rest, id: id(code), code, profile_id: id(profileCode) });
  }
  for (const r of CARE_REQUESTS) {
    const { id: code, family_id, elderly_id, ...rest } = r;
    await store.upsert('care_requests', { id: id(code) },
      { id: id(code), code, family_id: id(family_id), elderly_id: id(elderly_id), ...rest });
  }

  return {
    families: FAMILIES.length,
    elderly: ELDERLY.length,
    caregivers: CAREGIVERS.length,
    care_requests: CARE_REQUESTS.length,
    driver: store.driver,
  };
}

export const SEED_ACCOUNTS = {
  families: FAMILIES.map((f) => ({ id: f.id, email: f.email, display_name: f.display_name })),
  caregivers: CAREGIVERS.map((c) => ({ id: c.id, display_name: c.display_name })),
  care_requests: CARE_REQUESTS.map((r) => ({ id: r.id, scenario: r.scenario, visibility: r.visibility })),
};

export { FAMILIES, ELDERLY, CAREGIVERS, CARE_REQUESTS };
