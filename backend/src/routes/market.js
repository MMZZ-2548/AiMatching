/**
 * The other half of the two-sided marketplace (V5 §1, §4, §16, §17).
 *
 * Two things live here that the family wizard does not cover:
 *
 *  1. Posting a job WITHOUT matching. A family may not want to pick anyone yet — they want the
 *     job visible so caregivers come to them. That is `visibility = OPEN_TO_CAREGIVERS` in V5 §17,
 *     and it needs its own entry point, because running matching and publishing a post are
 *     different intents.
 *
 *  2. A caregiver applying to a family. V5 §1 is explicit that the caregiver is not merely
 *     matched *to*; they search and choose too. So a caregiver can send an offer — "I fit your
 *     job, will you take me?" — and the family accepts or declines it, the mirror image of the
 *     family's job request.
 *
 * Also here: the full caregiver profile behind the "ดูรายละเอียด" button, so a family can see the
 * skills, experience and credentials a score was built from rather than trusting a percentage.
 */

import { Router } from 'express';
import { store } from '../store/index.js';
import * as wf from '../services/workflow.js';
import { runRecommendedJobs } from '../services/matching.js';
import { evaluatePair } from '../matching/engine.js';
import { resolveId } from '../lib/ids.js';
import { locationFor } from '../lib/location.js';
import { caregiverDistanceNote } from '../services/distanceOptions.js';

export const marketApi = Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });

// ───────────────────────────────────────────── publish a job without matching (V5 §17)

marketApi.post('/publish-job', async (req, res) => {
  const b = req.body ?? {};
  const familyId = resolveId(b.family_id ?? 'FAM-1');

  let elderlyId = b.elderly_id ? resolveId(b.elderly_id) : null;
  if (!elderlyId) {
    const elderly = await store.insert('elderly_profiles', {
      family_id: familyId,
      display_name: b.elderly_name || 'ผู้สูงอายุ',
      age: b.elderly_age ?? null,
      gender: b.elderly_gender ?? null,
      basic_conditions: b.conditions ?? [],
      mobility_level: b.mobility ?? 'INDEPENDENT',
      preferred_language: b.languages ?? ['TH'],
      latitude: b.latitude ?? 6.541,
      longitude: b.longitude ?? 101.28,
      province: b.province ?? 'ยะลา',
    });
    elderlyId = elderly.id;
  }

  const careRequest = await store.insert('care_requests', {
    family_id: familyId,
    elderly_id: elderlyId,
    status: 'CONFIRMED',
    // the whole point: open to discovery rather than matched-only
    visibility: 'OPEN_TO_CAREGIVERS',
    care_date: b.care_date,
    start_time: b.start_time,
    end_time: b.end_time,
    budget: b.budget ?? null,
    conditions_relevant: b.conditions ?? [],
    mobility_requirement: b.mobility ?? 'INDEPENDENT',
    latitude: b.latitude ?? 6.541,
    longitude: b.longitude ?? 101.28,
    tasks: (b.tasks ?? []).map((t) => ({ task_code: t, must_do: true })),
    requirements: [
      ...(b.required_skills ?? []).map((code) => ({
        requirement_type: 'SKILL', requirement_code: code, strength: 'MANDATORY', minimum_level: null,
      })),
      ...(b.required_languages ?? []).map((code) => ({
        requirement_type: 'LANGUAGE', requirement_code: code, strength: 'MANDATORY', minimum_level: null,
      })),
      ...(b.gender_preference
        ? [{ requirement_type: 'GENDER', requirement_code: b.gender_preference, strength: 'MANDATORY', minimum_level: null }]
        : []),
    ],
    hospital_visit: Boolean(b.hospital_visit),
    transport_required: Boolean(b.transport_required),
    lifting_required: Boolean(b.lifting_required),
    night_monitoring: Boolean(b.night_monitoring),
    live_in_required: Boolean(b.live_in_required),
    recurring_job: Boolean(b.recurring_job),
    continuity_preference: b.continuity_preference ?? 'ONE_TIME',
    minimum_experience: b.minimum_experience ?? null,
    accept_out_of_area: Boolean(b.accept_out_of_area),
    additional_notes: b.notes ?? null,
    environment: b.environment ?? {},
    scenario: 'ประกาศหาผู้ดูแล ยังไม่ค้นหาเอง',
  });

  ok(res, {
    care_request: careRequest,
    location: locationFor(careRequest, 'FAMILY'),
    published: true,
  });
});

// ───────────────────────────────────────────── caregiver applies to a family (V5 §1)

/**
 * A caregiver offering themselves for a job. Recorded as caregiver interest — the same signal the
 * family reciprocates to form a mutual match — plus the message they wrote.
 */
/** Why an application was refused, in words the caregiver can act on. */
const OFFER_REFUSAL = {
  verification_status: 'บัญชีของคุณยังไม่ผ่านการยืนยันตัวตน',
  mandatory_required_skill: 'งานนี้กำหนดทักษะที่คุณยังไม่ได้ระบุไว้ในโปรไฟล์',
  mandatory_credential: 'งานนี้ต้องมีใบรับรองที่คุณยังไม่มี',
  minimum_skill_level: 'ระดับทักษะของคุณยังไม่ถึงเกณฑ์ที่งานนี้กำหนด',
  availability: 'คุณไม่ว่างในวันและเวลาของงานนี้',
  service_radius: 'งานนี้อยู่นอกรัศมีที่คุณตั้งไว้',
  shift_length: 'ชั่วโมงงานยาวกว่าที่คุณรับได้',
  mandatory_language: 'งานนี้ต้องใช้ภาษาที่คุณไม่ได้ระบุไว้',
  mandatory_gender: 'ครอบครัวระบุเพศผู้ดูแลที่ไม่ตรงกับคุณ',
  caregiver_task_exclusion: 'งานนี้มีงานที่คุณระบุว่าไม่รับ',
  hospital_escort: 'งานนี้ต้องพาไปโรงพยาบาล ซึ่งคุณไม่ได้เปิดรับ',
  heavy_lifting: 'งานนี้ต้องยกเคลื่อนย้าย ซึ่งคุณไม่ได้เปิดรับ',
  budget_below_minimum: 'ค่าตอบแทนต่ำกว่าค่าบริการขั้นต่ำของคุณ',
  live_in: 'งานนี้เป็นงานอยู่ประจำ ซึ่งคุณไม่ได้เปิดรับ',
};

marketApi.post('/offer', async (req, res) => {
  const care_request_id = resolveId(req.body?.care_request_id);
  const caregiver_id = resolveId(req.body?.caregiver_id);
  const message = String(req.body?.message ?? '').trim() || null;

  const cr = await store.find('care_requests', care_request_id);
  const cg = await store.find('caregiver_profiles', caregiver_id);
  if (!cr || !cg) return fail(res, 404, 'NOT_FOUND');

  // The safety rule lands here rather than while browsing: a caregiver may not take work whose
  // mandatory requirements they do not meet. Naming the requirement, in plain words, is the
  // difference between a rule and a rejection.
  const scored = evaluatePair(cr, cg);
  if (!scored.eligible && !scored.exceptional_match) {
    return fail(res, 409, 'NOT_ELIGIBLE', {
      failed_filters: scored.failed_filters,
      reasons: (scored.failed_filters ?? []).map((f) => OFFER_REFUSAL[f] ?? f),
      message: 'ยังสมัครงานนี้ไม่ได้',
      hint: 'ปรับเงื่อนไขของคุณในแท็บ "ค้นหางานที่ต้องการ" แล้วลองอีกครั้ง',
    });
  }

  const result = await wf.recordInterest('CAREGIVER', {
    care_request_id,
    caregiver_id,
    interested: true,
    accept_exceptional_distance: true,
  });

  await store.upsert('caregiver_interests', { care_request_id, caregiver_id }, { message });

  ok(res, {
    ...result,
    scores: {
      base_mutual_fit: scored.base_mutual_fit,
      final_mutual_fit: scored.final_mutual_fit,
      final_job_fit: scored.final_job_fit,
      final_family_fit: scored.final_family_fit,
    },
    why: wf.agreementReasons(scored),
  });
});

/**
 * The caregiver's own search: fill in what you want, see the jobs that fit, apply.
 * Ranked by how well the job suits the caregiver, which is the mirror of the family's ranking.
 */
marketApi.post('/caregiver-search', async (req, res) => {
  const caregiverId = resolveId(req.body?.caregiver_id);
  const cg = await store.find('caregiver_profiles', caregiverId);
  if (!cg) return fail(res, 404, 'NOT_FOUND');

  // Preferences typed into the caregiver wizard apply to this search only; they are saved to the
  // profile so the ranking the caregiver sees matches the one families see for them.
  const patch = {};
  for (const k of ['minimum_rate', 'expected_rate', 'service_radius_km', 'max_hours_per_shift',
    'nighttime_ok', 'daytime_ok', 'hospital_escort_ok', 'lifting_job_ok', 'live_in_ok',
    'out_of_area_enabled', 'max_out_of_area_distance_km', 'one_time_job_ok', 'recurring_job_ok',
    'long_term_job_ok', 'preferred_job_types', 'not_preferred_job_types']) {
    if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  }
  // Re-read after the update: returning the row fetched before it would report the old radius
  // back to a caregiver who just changed it.
  const current = Object.keys(patch).length
    ? await store.update('caregiver_profiles', caregiverId, patch)
    : cg;

  const result = await runRecommendedJobs(caregiverId);
  const interests = await store.findMany('caregiver_interests', { caregiver_id: caregiverId });
  const applied = new Set(interests.filter((i) => i.interested).map((i) => i.care_request_id));

  const decorate = (c) => ({
    ...c,
    why: wf.agreementReasons(c),
    already_applied: applied.has(c.care_request_id),
    // A far job pays the same base rate, so the caregiver has to weigh the trip and agree the
    // extra with the family before committing (V5 §23).
    distance_note: caregiverDistanceNote(c, current),
  });

  ok(res, {
    caregiver_id: caregiverId,
    recommended_nearby: result.recommended_nearby.map(decorate),
    exceptional_matches: result.exceptional_matches.map(decorate),
    candidate_count: result.candidate_count,
    runtime_ms: result.runtime_ms,
    profile: {
      minimum_rate: current.minimum_rate, expected_rate: current.expected_rate,
      service_radius_km: current.service_radius_km, nighttime_ok: current.nighttime_ok,
      lifting_job_ok: current.lifting_job_ok, hospital_escort_ok: current.hospital_escort_ok,
      out_of_area_enabled: current.out_of_area_enabled, skills: current.skills,
    },
  });
});

// ───────────────────────────────────────────── caregiver profile detail (transparency)

/**
 * Everything behind a caregiver's score, for the "ดูรายละเอียด" button.
 * A percentage the family cannot inspect is not transparency.
 */
marketApi.get('/caregiver/:caregiverId/detail', async (req, res) => {
  const id = resolveId(req.params.caregiverId);
  const cg = await store.find('caregiver_profiles', id);
  if (!cg) return fail(res, 404, 'NOT_FOUND');

  const reviews = await store.findMany('family_reviews', { caregiver_id: id });
  const incidents = await store.findMany('incidents', { caregiver_id: id });
  // A read must not change the data it reports. Recomputing here rewrote the caregiver's stored
  // trust score simply because someone opened their profile, so the number on the detail page
  // disagreed with the number on the card that led to it. Use the latest snapshot, else the
  // stored value.
  const snapshots = await store.findMany('trust_score_snapshots', { caregiver_id: id });
  const latest = snapshots.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  const trust = latest ?? {
    trust_score: cg.final_trust_score,
    trust_status: cg.trust_status,
    components: null,
  };

  const ratings = reviews.map((r) => r.overall_rating).filter(Number.isFinite);
  const careRequestId = req.query.care_request_id ? resolveId(req.query.care_request_id) : null;
  const cr = careRequestId ? await store.find('care_requests', careRequestId) : null;
  const scored = cr ? evaluatePair(cr, cg) : null;

  ok(res, {
    caregiver: {
      id: cg.id, code: cg.code, display_name: cg.display_name, gender: cg.gender,
      age: cg.age, years_experience: cg.years_experience,
      work_history_summary: cg.work_history_summary,
      verification_status: cg.verification_status,
      skills: cg.skills ?? [], skill_levels: cg.skill_levels ?? {},
      condition_experience: cg.condition_experience ?? {},
      languages: cg.languages ?? [], care_styles: cg.care_styles ?? [],
      certificates: (cg.certificates ?? []).map((c) => ({
        credential_code: c.credential_code, issuer: c.issuer ?? null,
        verified: Boolean(c.verified), expires_at: c.expires_at ?? null,
      })),
      availability: cg.availability ?? [],
      service_radius_km: cg.service_radius_km, max_travel_time_minutes: cg.max_travel_time_minutes,
      transport_mode: cg.transport_mode,
      minimum_rate: cg.minimum_rate, expected_rate: cg.expected_rate,
      travel_fee_per_km: cg.travel_fee_per_km,
      out_of_area_enabled: cg.out_of_area_enabled,
      max_out_of_area_distance_km: cg.max_out_of_area_distance_km,
      accepts: {
        กะกลางคืน: Boolean(cg.nighttime_ok), กะกลางวัน: Boolean(cg.daytime_ok),
        พาไปโรงพยาบาล: Boolean(cg.hospital_escort_ok), ยกเคลื่อนย้าย: Boolean(cg.lifting_job_ok),
        ดูแลผู้ป่วยติดเตียง: Boolean(cg.bedbound_care_ok), ดูแลผู้ป่วยสมองเสื่อม: Boolean(cg.dementia_care_ok),
        อยู่ประจำ: Boolean(cg.live_in_ok), งานระยะยาว: Boolean(cg.long_term_job_ok),
        งานนอกพื้นที่: Boolean(cg.out_of_area_enabled),
      },
      not_preferred_job_types: cg.not_preferred_job_types ?? [],
    },
    trust: {
      score: trust?.trust_score ?? cg.final_trust_score,
      status: trust?.trust_status ?? cg.trust_status,
      components: trust?.components ?? null,
      completed_jobs: cg.completed_jobs, review_count: reviews.length || cg.review_count,
      mean_rating: ratings.length
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : cg.mean_rating ?? null,
      confirmed_incidents: incidents.filter(
        (i) => i.status === 'CONFIRMED' && i.responsibility === 'CAREGIVER_RESPONSIBLE',
      ).length,
      // V4 §34: unconfirmed reports exist but must not be read as fault
      unconfirmed_reports: incidents.filter((i) => i.status !== 'CONFIRMED').length,
    },
    reviews: reviews.slice(-5).map((r) => ({
      overall_rating: r.overall_rating, would_rebook: r.would_rebook,
      review_text: r.review_text ?? null, created_at: r.created_at,
    })),
    // when a care request is supplied, show how this person scores against that specific job
    match: scored && {
      eligible: scored.eligible,
      failed_filters: scored.failed_filters,
      hard_filter_results: scored.hard_filter_results,
      base_family_fit: scored.base_family_fit, base_job_fit: scored.base_job_fit,
      base_mutual_fit: scored.base_mutual_fit, final_mutual_fit: scored.final_mutual_fit,
      final_family_fit: scored.final_family_fit, final_job_fit: scored.final_job_fit,
      distance_km: scored.distance_km, bucket_values: scored.bucket_values,
      feature_values: scored.feature_values,
      exceptional_match: scored.exceptional_match,
      additional_cost_estimate: scored.additional_cost_estimate,
      why: wf.agreementReasons(scored),
    },
  });
});
