/**
 * The job board — open postings both sides can browse (V5 §17).
 *
 * Matching is one way to find someone; a noticeboard is the other. A family that is not in a hurry
 * posts and waits, and a caregiver who wants to look for themselves reads the board and applies
 * directly, without either side going through a ranking first.
 *
 * The board carries NO scoring of any kind: no fit percentage, no "why this suits you", no
 * eligibility verdict. It lists what is open, newest first, with the facts a person needs to judge
 * for themselves — when, where, how much, and what the day actually looks like. Ranking and
 * explanation belong to the matching screens, which a caregiver enters deliberately; reading a
 * noticeboard is not a moment where anyone asked to be assessed.
 *
 * What is offered instead is filtering, and it is arithmetic on stated facts: date, budget, kind of
 * work. The caregiver narrows the list on their own terms.
 *
 * The safety rule still exists, but it applies when applying rather than while reading:
 * `/market/offer` refuses an application from someone who does not meet a mandatory requirement and
 * names the requirement. That protects the family without turning the board into an assessment of
 * the reader.
 *
 * Location stays at the approximate disclosure level until acceptance (lib/location.js).
 */

import { Router } from 'express';
import { store } from '../store/index.js';
import * as wf from '../services/workflow.js';
import { evaluatePair } from '../matching/engine.js';
import { resolveId } from '../lib/ids.js';
import { locationFor } from '../lib/location.js';

export const boardApi = Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });


async function summarise(cr) {
  const elderly = await store.find('elderly_profiles', cr.elderly_id);
  const family = await store.find('profiles', cr.family_id);
  const interests = await store.findMany('caregiver_interests', {
    care_request_id: cr.id, interested: true,
  });
  const plan = await wf.confirmedPlanFor(cr.id);
  const planTasks = plan ? await store.findMany('daily_care_tasks', { care_plan_id: plan.id }) : [];

  return {
    id: cr.id,
    code: cr.code ?? null,
    posted_by: family?.display_name ?? 'ครอบครัว',
    care_date: cr.care_date,
    start_time: cr.start_time,
    end_time: cr.end_time,
    budget: cr.budget,
    visibility: cr.visibility,
    created_at: cr.created_at,
    // privacy-safe: an area, an age, the conditions relevant to the work — never the record
    area: [elderly?.district, elderly?.province].filter(Boolean).join(', ') || 'ยะลา',
    elderly_age: elderly?.age ?? null,
    elderly_gender: elderly?.gender ?? null,
    mobility: cr.mobility_requirement,
    relevant_conditions: cr.conditions_relevant ?? [],
    must_do_tasks: (cr.tasks ?? []).filter((t) => t.must_do).map((t) => t.task_code),
    required_skills: (cr.requirements ?? [])
      .filter((r) => r.requirement_type === 'SKILL').map((r) => r.requirement_code),
    required_languages: (cr.requirements ?? [])
      .filter((r) => r.requirement_type === 'LANGUAGE').map((r) => r.requirement_code),
    hospital_escort_required: Boolean(cr.hospital_visit),
    lifting_required: Boolean(cr.lifting_required),
    night_monitoring: Boolean(cr.night_monitoring),
    live_in_required: Boolean(cr.live_in_required),
    continuity: cr.continuity_preference,
    minimum_experience: cr.minimum_experience,
    accept_out_of_area: Boolean(cr.accept_out_of_area),
    notes: cr.additional_notes ?? null,
    applicant_count: interests.length,
    plan_items: planTasks.length,
    care_plan: planTasks
      .map((t) => ({
        time: String(t.planned_time ?? '').slice(0, 5) || null,
        title: t.description || t.task_code,
        critical: Boolean(t.critical_task),
      }))
      .sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99')),
  };
}

/**
 * Everything openly posted, newest first — the facts only.
 * `caregiver_id` is used solely to mark which postings this person has already applied to.
 */
boardApi.get('/open', async (req, res) => {
  const caregiverId = req.query.caregiver_id ? resolveId(req.query.caregiver_id) : null;

  const all = await store.findMany('care_requests', {});
  const everything = all.filter(
    (cr) => cr.status === 'CONFIRMED' && cr.visibility === 'OPEN_TO_CAREGIVERS',
  );

  // Plain filters: arithmetic on what the posting states. Nothing here evaluates the reader.
  const q = req.query;
  let open = everything;
  if (q.date) open = open.filter((cr) => cr.care_date === q.date);
  if (q.date_from) open = open.filter((cr) => String(cr.care_date) >= String(q.date_from));
  if (q.date_to) open = open.filter((cr) => String(cr.care_date) <= String(q.date_to));
  if (q.min_budget) open = open.filter((cr) => Number(cr.budget ?? 0) >= Number(q.min_budget));
  if (q.max_budget) open = open.filter((cr) => Number(cr.budget ?? 0) <= Number(q.max_budget));
  if (q.task) open = open.filter((cr) => (cr.tasks ?? []).some((t) => t.task_code === q.task));
  if (q.skill) {
    open = open.filter((cr) => (cr.requirements ?? []).some(
      (r) => r.requirement_type === 'SKILL' && r.requirement_code === q.skill));
  }
  if (q.night === 'true') open = open.filter((cr) => cr.night_monitoring);
  if (q.night === 'false') open = open.filter((cr) => !cr.night_monitoring);
  if (q.no_lifting === 'true') open = open.filter((cr) => !cr.lifting_required);
  if (q.no_escort === 'true') open = open.filter((cr) => !cr.hospital_visit);

  const applied = new Set();
  if (caregiverId) {
    for (const i of await store.findMany('caregiver_interests', { caregiver_id: caregiverId })) {
      if (i.interested) applied.add(i.care_request_id);
    }
  }

  const postings = [];
  for (const cr of open) {
    postings.push({
      ...(await summarise(cr)),
      location: locationFor(cr, 'CAREGIVER', false),
      already_applied: applied.has(cr.id),
    });
  }

  postings.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  ok(res, {
    postings,
    total: postings.length,
    total_open: everything.length,
    scored: false,
  });
});

/** A family's own postings, with who has applied to each. */
boardApi.get('/mine/:familyId', async (req, res) => {
  const familyId = resolveId(req.params.familyId);
  const requests = (await store.findMany('care_requests', { family_id: familyId }))
    .filter((cr) => cr.status === 'CONFIRMED');

  const postings = [];
  for (const cr of requests) {
    const base = await summarise(cr);
    const interests = await store.findMany('caregiver_interests', {
      care_request_id: cr.id, interested: true,
    });

    const applicants = [];
    for (const i of interests) {
      const cg = await store.find('caregiver_profiles', i.caregiver_id);
      if (!cg) continue;
      const scored = evaluatePair(cr, cg);
      const famInterest = await store.findOne('family_interests', {
        care_request_id: cr.id, caregiver_id: cg.id,
      });
      applicants.push({
        caregiver: {
          id: cg.id, code: cg.code, display_name: cg.display_name,
          years_experience: cg.years_experience, skills: cg.skills,
          expected_rate: cg.expected_rate, final_trust_score: cg.final_trust_score,
          verification_status: cg.verification_status,
        },
        message: i.message ?? null,
        final_mutual_fit: scored.final_mutual_fit,
        final_family_fit: scored.final_family_fit,
        final_job_fit: scored.final_job_fit,
        distance_km: scored.distance_km,
        why: wf.agreementReasons(scored),
        matched: Boolean(famInterest?.interested),
      });
    }
    applicants.sort((a, b) => b.final_mutual_fit - a.final_mutual_fit);

    postings.push({ ...base, location: locationFor(cr, 'FAMILY'), applicants });
  }

  postings.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  ok(res, { postings, total: postings.length });
});

/** Open or close a posting to discovery, without touching anything else about it. */
boardApi.post('/:careRequestId/visibility', async (req, res) => {
  const id = resolveId(req.params.careRequestId);
  const wanted = req.body?.visibility;
  if (!['PRIVATE', 'MATCHED_ONLY', 'OPEN_TO_CAREGIVERS'].includes(wanted)) {
    return fail(res, 400, 'BAD_VISIBILITY');
  }
  const cr = await store.update('care_requests', id, { visibility: wanted });
  if (!cr) return fail(res, 404, 'NOT_FOUND');
  ok(res, { care_request: cr });
});

/**
 * Delete a posting.
 *
 * Refused once anyone has been hired for it: an accepted job request means a caregiver has
 * arranged their day around this, and deleting the record out from under them would leave the job
 * pointing at nothing. Close it to discovery instead.
 */
boardApi.delete('/:careRequestId', async (req, res) => {
  const id = resolveId(req.params.careRequestId);
  const cr = await store.find('care_requests', id);
  if (!cr) return fail(res, 404, 'NOT_FOUND');

  const requests = await store.findMany('job_requests', { care_request_id: id });
  const accepted = requests.filter((r) => r.status === 'ACCEPTED');
  if (accepted.length) {
    return fail(res, 409, 'HAS_ACCEPTED_JOB', {
      message: 'ลบไม่ได้ เพราะมีผู้ดูแลตอบรับงานนี้แล้ว',
      hint: 'ปิดประกาศแทนได้ หรือยกเลิกงานกับผู้ดูแลก่อน',
    });
  }

  // Children first, so nothing is left pointing at a row that no longer exists.
  for (const table of ['caregiver_interests', 'family_interests', 'mutual_matches',
    'matching_candidates', 'matching_runs']) {
    for (const row of await store.findMany(table, { care_request_id: id })) {
      await store.remove(table, row.id);
    }
  }
  for (const jr of requests) await store.remove('job_requests', jr.id);
  for (const plan of await store.findMany('daily_care_plans', { care_request_id: id })) {
    for (const t of await store.findMany('daily_care_tasks', { care_plan_id: plan.id })) {
      await store.remove('daily_care_tasks', t.id);
    }
    await store.remove('daily_care_plans', plan.id);
  }
  for (const th of await store.findMany('chat_threads', { care_request_id: id })) {
    for (const m of await store.findMany('chat_messages', { thread_id: th.id })) {
      await store.remove('chat_messages', m.id);
    }
    await store.remove('chat_threads', th.id);
  }
  await store.remove('care_requests', id);

  ok(res, { deleted: true, care_request_id: id });
});

/** One posting in full, for the detail view either side opens from the board. */
boardApi.get('/:careRequestId', async (req, res) => {
  const id = resolveId(req.params.careRequestId);
  const cr = await store.find('care_requests', id);
  if (!cr) return fail(res, 404, 'NOT_FOUND');

  const viewerIsFamily = req.query.viewer === 'FAMILY';
  const caregiverId = req.query.caregiver_id ? resolveId(req.query.caregiver_id) : null;
  const cg = caregiverId ? await store.find('caregiver_profiles', caregiverId) : null;
  const accepted = cg
    ? Boolean(await store.findOne('job_requests', {
        care_request_id: id, caregiver_id: cg.id, status: 'ACCEPTED',
      }))
    : false;

  const base = await summarise(cr);
  const out = {
    posting: base,
    location: locationFor(cr, viewerIsFamily ? 'FAMILY' : 'CAREGIVER', accepted),
  };

  if (cg) {
    // Still no score. The one figure worth having before writing an application is how far the
    // trip is, which is a measurement rather than an assessment of the person reading.
    out.distance_km = evaluatePair(cr, cg).distance_km;
    const interest = await store.findOne('caregiver_interests', {
      care_request_id: id, caregiver_id: cg.id,
    });
    out.already_applied = Boolean(interest?.interested);
  }

  ok(res, out);
});
