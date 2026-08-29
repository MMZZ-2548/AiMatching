/**
 * API integration + two-sided E2E — V6 STEP 2 and STEP 3, V5 §15 and §16.
 *
 * Runs the real Express app through supertest against the real services. Nothing is stubbed except
 * the OpenAI-backed routes, which are asserted to degrade honestly rather than to succeed.
 *
 * The E2E cases mirror V5's two journeys step by step, including the role switch: the caregiver
 * half of each flow is executed with `x-role: CAREGIVER`, and the assertions check that state
 * survives the switch (V5 §14: "Role Switcher ต้องไม่ reset test state").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { store } from '../src/store/index.js';
import { seed } from '../src/seed/seed.js';
import { codeToUuid } from '../src/lib/ids.js';

/**
 * Seeded rows key on a uuid derived from their readable code (src/lib/ids.js). Requests may use
 * either form, but a response always carries the uuid — so assertions compare through this.
 */
const id = codeToUuid;

const asFamily = (r) => r.set('x-role', 'FAMILY');
const asCaregiver = (r) => r.set('x-role', 'CAREGIVER');
const asAdmin = (r) => r.set('x-role', 'ADMIN');

beforeEach(async () => {
  await store.reset();
  await seed({ reset: true });
});

describe('API — health and seed (V4 §40, §50)', () => {
  it('reports env presence without ever exposing a secret', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.env.OPENAI_API_KEY).toMatch(/^(set|MISSING)$/);
    expect(res.body.env.SUPABASE_SECRET_KEY).toMatch(/^(set|MISSING)$/);
    // no field anywhere in the payload may look like a key
    expect(JSON.stringify(res.body)).not.toMatch(/sk-proj|sb_secret/);
  });

  it('seeds exactly the counts V4 §40 requires', async () => {
    const res = await request(app).post('/api/dev/seed').expect(200);
    expect(res.body.seeded).toMatchObject({
      families: 5, elderly: 5, caregivers: 20, care_requests: 15,
    });
  });
});

describe('API — matching (V4 §22, V5 §3)', () => {
  it('returns the three V5 §27 buckets', async () => {
    const res = await request(app).post('/api/matching/CR-01/run').expect(200);
    const m = res.body.matching;
    expect(m).toHaveProperty('recommended_nearby');
    expect(m).toHaveProperty('exceptional_matches');
    expect(m).toHaveProperty('filtered_out');
    expect(m.recommended_nearby.length).toBeGreaterThan(0);
  });

  it('every candidate carries both the base and the distance-adjusted score (V5 §24)', async () => {
    const res = await request(app).post('/api/matching/CR-01/run').expect(200);
    for (const c of res.body.matching.recommended_nearby) {
      expect(typeof c.base_mutual_fit).toBe('number');
      expect(typeof c.final_mutual_fit).toBe('number');
    }
  });

  it('persists the run with feature values and versions (V4 §20)', async () => {
    await request(app).post('/api/matching/CR-01/run').expect(200);
    const res = await request(app).get('/api/matching/CR-01/candidates').expect(200);
    expect(res.body.matching_run.score_version).toBeTruthy();
    expect(res.body.matching_run.weight_version).toBeTruthy();
    expect(res.body.candidates[0].feature_values).toBeTruthy();
    expect(res.body.candidates[0].hard_filter_results).toBeTruthy();
  });

  it('surfaces the exceptional far match separately, never as normal rank 1 (V5 §19)', async () => {
    const res = await request(app).post('/api/matching/CR-12/run').expect(200);
    const m = res.body.matching;
    const far = m.exceptional_matches.find((c) => c.caregiver_id === id('CG_FAR_PERFECT_01'));
    expect(far).toBeTruthy();
    expect(far.base_mutual_fit).toBeGreaterThanOrEqual(90);
    expect(far.additional_cost_estimate.is_final_price).toBe(false);
    expect(m.recommended_nearby.map((c) => c.caregiver_id)).not.toContain(id('CG_FAR_PERFECT_01'));
  });

  it('a far caregiver who has not opted in is never shown (V5 §26 case 2)', async () => {
    const res = await request(app).post('/api/matching/CR-12/run').expect(200);
    const ids = [
      ...res.body.matching.recommended_nearby,
      ...res.body.matching.exceptional_matches,
    ].map((c) => c.caregiver_id);
    expect(ids).not.toContain(id('CG_FAR_NO_OPTIN'));
  });

  it('the debug endpoint explains every filter and bucket (V5 §28)', async () => {
    const res = await request(app).get('/api/matching/debug/CR-01/CG_NEAR_01').expect(200);
    expect(Object.keys(res.body.debug.hard_filter_results).length).toBe(14);
    expect(res.body.debug.bucket_values.family).toBeTruthy();
  });
});

describe('API — caregiver job discovery (V4 §23, V5 §4, §17)', () => {
  it('returns ranked jobs with a privacy-safe summary only', async () => {
    const res = await request(app).get('/api/caregiver/CG_NEAR_01/recommended-jobs').expect(200);
    const job = res.body.recommendations.recommended_nearby[0].job;
    expect(job).toBeTruthy();
    // permitted
    expect(job).toHaveProperty('elderly_age');
    expect(job).toHaveProperty('relevant_conditions');
    // forbidden before any relationship exists (V4 §23, V5 §4)
    expect(job).not.toHaveProperty('care_location_address');
    expect(job).not.toHaveProperty('allergies');
    expect(job).not.toHaveProperty('medical_devices');
    expect(job).not.toHaveProperty('emergency_contact');
    expect(job).not.toHaveProperty('notes');
    expect(job).not.toHaveProperty('latitude');
  });

  it('hides a PRIVATE request until a direct invitation exists (V5 §17)', async () => {
    const res = await request(app).get('/api/caregiver/CG_NEAR_01/recommended-jobs').expect(200);
    const ids = res.body.recommendations.recommended_nearby.map((c) => c.care_request_id);
    expect(ids).not.toContain(id('CR-14'));
  });

  it('scores a pair identically from both directions (V5 §1)', async () => {
    const fam = await request(app).post('/api/matching/CR-13/run').expect(200);
    const fromFamily = fam.body.matching.recommended_nearby.find((c) => c.caregiver_id === id('CG_NEAR_01'));
    const cg = await request(app).get('/api/caregiver/CG_NEAR_01/recommended-jobs').expect(200);
    const fromCaregiver = cg.body.recommendations.recommended_nearby.find((c) => c.care_request_id === id('CR-13'));
    expect(fromCaregiver.base_mutual_fit).toBe(fromFamily.base_mutual_fit);
    expect(fromCaregiver.final_mutual_fit).toBe(fromFamily.final_mutual_fit);
  });
});

describe('API — care plan gate (V4 §25)', () => {
  it('blocks a job request until a care plan is confirmed, with the specified message', async () => {
    const res = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: 'CG_NEAR_01' })
      .expect(409);
    expect(res.body.error).toBe('CARE_PLAN_REQUIRED');
    expect(res.body.message).toBe('กรุณาสร้างและยืนยันรายการงานดูแลก่อนส่งคำขอไปยังผู้ดูแล');
    // the selected caregiver is preserved, not discarded (V4 §25)
    expect(res.body.caregiver_id).toBe(id('CG_NEAR_01'));
  });

  it('a DRAFT plan does not open the gate; only CONFIRMED does', async () => {
    const plan = await request(app).post('/api/care-plans')
      .send({ care_request_id: 'CR-01', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00' })
      .expect(200);
    await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: 'CG_NEAR_01' })
      .expect(409);

    await request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`).expect(200);
    await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: 'CG_NEAR_01' })
      .expect(200);
  });
});

describe('API — chat gate (V4 §24)', () => {
  it('a thread cannot be posted to before a mutual match', async () => {
    const thread = await store.insert('chat_threads', {
      care_request_id: id('CR-01'), caregiver_id: id('CG_NEAR_01'), unlocked_by: 'MANUAL',
    });
    const res = await asFamily(request(app).post(`/api/chats/${thread.id}/messages`))
      .send({ body: 'hello' })
      .expect(403);
    expect(res.body.error).toBe('CHAT_LOCKED');
  });
});

describe('API — trust (V4 §34, V6 F01/F02)', () => {
  it('an unconfirmed incident leaves the score untouched', async () => {
    const before = await request(app).get('/api/caregivers/CG_NEAR_01/trust').expect(200);
    await asAdmin(request(app).post('/api/admin/incidents'))
      .send({ caregiver_id: 'CG_NEAR_01', description: 'reported by family' })
      .expect(200);
    const after = await request(app).get('/api/caregivers/CG_NEAR_01/trust').expect(200);
    expect(after.body.trust.trust_score).toBe(before.body.trust.trust_score);
    expect(after.body.trust.penalised_incidents).toBe(0);
  });

  it('confirming an incident against the caregiver does lower the score', async () => {
    const before = await request(app).get('/api/caregivers/CG_NEAR_01/trust').expect(200);
    const inc = await asAdmin(request(app).post('/api/admin/incidents'))
      .send({ caregiver_id: 'CG_NEAR_01' }).expect(200);
    const res = await asAdmin(request(app).post(`/api/admin/incidents/${inc.body.incident.id}/confirm`))
      .send({ responsibility: 'CAREGIVER_RESPONSIBLE' })
      .expect(200);
    expect(res.body.trust.penalised_incidents).toBe(1);
    expect(res.body.trust.trust_score).toBeLessThan(before.body.trust.trust_score);
  });

  it('confirming an incident that is not the caregiver\'s fault does not', async () => {
    const before = await request(app).get('/api/caregivers/CG_NEAR_01/trust').expect(200);
    const inc = await asAdmin(request(app).post('/api/admin/incidents'))
      .send({ caregiver_id: 'CG_NEAR_01' }).expect(200);
    const res = await asAdmin(request(app).post(`/api/admin/incidents/${inc.body.incident.id}/confirm`))
      .send({ responsibility: 'EXTERNAL' })
      .expect(200);
    expect(res.body.trust.penalised_incidents).toBe(0);
    expect(res.body.trust.trust_score).toBe(before.body.trust.trust_score);
  });
});

describe('API — AI routes degrade honestly when the model is unavailable (V4 §52)', () => {
  it('never reports success for a call it could not make', async () => {
    const res = await request(app).post('/api/matching/explain/CR-01/CG_NEAR_01').expect(200);
    // scores are always present and always come from the deterministic engine
    expect(typeof res.body.scores.base_mutual_fit).toBe('number');
    expect(res.body.deterministic_reasons.length).toBeGreaterThan(0);
    const e = res.body.explanation;
    if (!e.ai_available) {
      expect(e.degraded).toBe(true);
      expect(e.degraded_reason).toBeTruthy();
      expect(e.source).toBe('DETERMINISTIC_FALLBACK');
    } else {
      expect(e.source).toBe('AI');
    }
  });
});

// ═══════════════════════════════════════════ E2E

describe('E2E — family-initiated journey (V5 §15, 30 steps)', () => {
  it('runs matching → mutual match → plan gate → request → accept → chat → service → report → review → trust', async () => {
    // 1-5 family runs matching
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];
    expect(top).toBeTruthy();

    // 6 family shows interest
    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    // 10 SWITCH ROLE → caregiver, who sees the job and is interested
    const jobs = await asCaregiver(request(app).get(`/api/caregiver/${top.caregiver_id}/recommended-jobs`)).expect(200);
    expect(jobs.body.recommendations.recommended_nearby.map((c) => c.care_request_id)).toContain(id('CR-01'));

    const mutual = await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);
    expect(mutual.body.status).toBe('MUTUAL_MATCH');

    // 7 care plan gate blocks, then opens
    await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(409);

    const plan = await asFamily(request(app).post('/api/care-plans'))
      .send({
        care_request_id: 'CR-01', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00',
        tasks: [{ task_code: 'MEAL_PREP', critical_task: true, planned_time: '11:30' }],
      }).expect(200);
    await asFamily(request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`)).expect(200);

    // 8-9 request sent
    const jr = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);
    expect(jr.body.job_request.status).toBe('PENDING');

    // 11-14 SWITCH ROLE → caregiver accepts, with reasons drawn from the score breakdown
    const inbox = await asCaregiver(request(app).get(`/api/job-requests?caregiver_id=${top.caregiver_id}`)).expect(200);
    expect(inbox.body.job_requests.length).toBe(1);

    const accepted = await asCaregiver(request(app).post(`/api/job-requests/${jr.body.job_request.id}/accept`))
      .send({ note: 'ยินดีรับงาน' }).expect(200);
    expect(accepted.body.job_request.status).toBe('ACCEPTED');
    expect(accepted.body.agreement_reasons.length).toBeGreaterThan(0);
    // V5 §7 — every reason must name the feature it came from
    for (const r of accepted.body.agreement_reasons) expect(r.feature).toBeTruthy();

    const jobId = accepted.body.job.id;
    const threadId = accepted.body.chat_thread_id;

    // 15-16 SWITCH ROLE → family sees ACCEPTED
    const status = await asFamily(request(app).get('/api/job-requests?care_request_id=CR-01')).expect(200);
    expect(status.body.job_requests[0].status).toBe('ACCEPTED');

    // 17-20 chat both ways, state surviving the role switch (V5 §14)
    await asFamily(request(app).post(`/api/chats/${threadId}/messages`)).send({ body: 'สวัสดีค่ะ' }).expect(200);
    await asCaregiver(request(app).post(`/api/chats/${threadId}/messages`)).send({ body: 'สวัสดีครับ' }).expect(200);
    const msgs = await asFamily(request(app).get(`/api/chats/${threadId}/messages`)).expect(200);
    expect(msgs.body.messages.map((m) => m.sender_role)).toEqual(['FAMILY', 'CAREGIVER']);
    expect(msgs.body.messages[1].body).toBe('สวัสดีครับ');

    // 21-24 service events
    await asCaregiver(request(app).post(`/api/jobs/${jobId}/events`))
      .send({ event_type: 'CHECK_IN', payload: { minutes_late: 0 } }).expect(200);
    await asCaregiver(request(app).post(`/api/jobs/${jobId}/events`))
      .send({ event_type: 'TASK_COMPLETED' }).expect(200);
    const out = await asCaregiver(request(app).post(`/api/jobs/${jobId}/events`))
      .send({ event_type: 'CHECK_OUT' }).expect(200);
    expect(out.body.state).toBe('NORMAL');

    // 25-27 report, read by the family
    const report = await asCaregiver(request(app).post('/api/reports'))
      .send({ job_id: jobId, text: 'ดูแลตามแผน ทานอาหารครบ ให้ยาตรงเวลา' }).expect(200);
    await asCaregiver(request(app).post(`/api/reports/${report.body.report.id}/confirm`)).send({}).expect(200);
    const read = await asFamily(request(app).get(`/api/jobs/${jobId}/reports`)).expect(200);
    expect(read.body.reports[0].confirmed).toBe(true);

    // 28-30 review updates trust, and the next matching run sees the history
    const review = await asFamily(request(app).post(`/api/jobs/${jobId}/review`))
      .send({ overall_rating: 5, would_rebook: true, would_recommend: true, care_plan_adherence: 5 })
      .expect(200);
    expect(review.body.trust.trust_score).toBeGreaterThan(0);

    const rerun = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const again = rerun.body.matching.recommended_nearby.find((c) => c.caregiver_id === top.caregiver_id);
    expect(again.feature_values.family.previous_successful_match).toBe(100);
  });
});

describe('E2E — caregiver-initiated journey (V5 §16)', () => {
  it('caregiver discovers an open job, family reciprocates, mutual match follows', async () => {
    const cgId = 'CG_NEAR_01';

    // 3-5 caregiver opens recommended jobs and sees the open request
    const jobs = await asCaregiver(request(app).get(`/api/caregiver/${cgId}/recommended-jobs`)).expect(200);
    const open = jobs.body.recommendations.recommended_nearby.find((c) => c.care_request_id === id('CR-13'));
    expect(open).toBeTruthy();
    expect(typeof open.final_job_fit).toBe('number');

    // 6-7 caregiver is interested first
    const one = await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-13', caregiver_id: cgId }).expect(200);
    expect(one.body.status).toBe('CAREGIVER_INTERESTED');

    // 8-11 SWITCH ROLE → family sees who is interested, with both fit scores
    const interested = await asFamily(request(app).get('/api/care-requests/CR-13/interested-caregivers')).expect(200);
    expect(interested.body.interested.length).toBe(1);
    expect(interested.body.interested[0].scores.base_mutual_fit).toBeGreaterThan(0);

    // 12-13 family reciprocates → mutual match
    const two = await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-13', caregiver_id: cgId }).expect(200);
    expect(two.body.status).toBe('MUTUAL_MATCH');

    const list = await request(app).get('/api/mutual-matches?care_request_id=CR-13').expect(200);
    expect(list.body.mutual_matches.length).toBe(1);
  });
});

describe('E2E — exceptional far match requires consent on both sides (V5 §23, §26)', () => {
  it('a far caregiver must accept the distance before the match is valid', async () => {
    await asFamily(request(app).post('/api/matching/CR-12/run')).expect(200);
    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-12', caregiver_id: 'CG_FAR_PERFECT_01' }).expect(200);

    // interested, but has not accepted the extra distance yet
    const withoutConsent = await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-12', caregiver_id: 'CG_FAR_PERFECT_01', accept_exceptional_distance: false })
      .expect(200);
    expect(withoutConsent.body.status).toBe('CAREGIVER_MUST_ACCEPT_DISTANCE');
    expect(withoutConsent.body.additional_cost_estimate.total_extra).toBeGreaterThan(0);

    // with consent, the mutual match forms
    const withConsent = await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-12', caregiver_id: 'CG_FAR_PERFECT_01', accept_exceptional_distance: true })
      .expect(200);
    expect(withConsent.body.status).toBe('MUTUAL_MATCH');
  });

  it('accommodation must be agreed before an exceptional booking completes (V5 §26 case 8)', async () => {
    const plan = await asFamily(request(app).post('/api/care-plans'))
      .send({ care_request_id: 'CR-12', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00' })
      .expect(200);
    await asFamily(request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`)).expect(200);

    const jr = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-12', caregiver_id: 'CG_FAR_PERFECT_01' }).expect(200);
    expect(jr.body.job_request.is_exceptional_distance).toBe(true);
    expect(jr.body.job_request.additional_cost_estimate.accommodation_required).toBe(true);

    const blocked = await asCaregiver(request(app).post(`/api/job-requests/${jr.body.job_request.id}/accept`))
      .send({ accommodation_agreed: false }).expect(409);
    expect(blocked.body.error).toBe('ACCOMMODATION_AGREEMENT_REQUIRED');

    const okAccept = await asCaregiver(request(app).post(`/api/job-requests/${jr.body.job_request.id}/accept`))
      .send({ accommodation_agreed: true }).expect(200);
    expect(okAccept.body.job_request.status).toBe('ACCEPTED');
  });
});

describe('E2E — monitoring rules are deterministic and AI-free (V4 §31, §44)', () => {
  let jobId;
  beforeEach(async () => {
    const plan = await request(app).post('/api/care-plans')
      .send({ care_request_id: 'CR-01', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00' })
      .expect(200);
    await request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`).expect(200);
    const jr = await request(app).post('/api/job-requests')
      .send({ care_request_id: 'CR-01', caregiver_id: 'CG_NEAR_01' }).expect(200);
    const acc = await request(app).post(`/api/job-requests/${jr.body.job_request.id}/accept`).send({}).expect(200);
    jobId = acc.body.job.id;
  });

  it('SOS escalates straight to HIGH_RISK', async () => {
    const res = await request(app).post(`/api/jobs/${jobId}/events`).send({ event_type: 'SOS' }).expect(200);
    expect(res.body.state).toBe('HIGH_RISK');
    expect(res.body.matched_rule).toBe('sos_immediate');
  });

  it('an unexpected geofence exit raises VERIFY, a planned one does not', async () => {
    const unexpected = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'GEOFENCE_EXIT', payload: { planned: false } }).expect(200);
    expect(unexpected.body.state).toBe('VERIFY');

    const planned = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'GEOFENCE_EXIT', payload: { planned: true } }).expect(200);
    expect(planned.body.matched_rule).toBe('planned_geofence_exit');
  });

  it('a low-accuracy GPS fix never escalates on its own', async () => {
    const res = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'GPS_UPDATE', payload: { accuracy_m: 400 } }).expect(200);
    expect(res.body.state).toBe('NORMAL');
    expect(res.body.matched_rule).toBe('gps_low_accuracy_no_escalation');
  });

  it('a duplicate event is rejected by its dedupe key', async () => {
    const first = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'CHECK_IN', dedupe_key: 'ci-1' }).expect(200);
    expect(first.body.duplicate).toBeUndefined();
    const second = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'CHECK_IN', dedupe_key: 'ci-1' }).expect(200);
    expect(second.body.duplicate).toBe(true);
  });

  it('an out-of-order event cannot pull the state back down', async () => {
    await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'SOS', event_seq: 10 }).expect(200);
    const late = await request(app).post(`/api/jobs/${jobId}/events`)
      .send({ event_type: 'CHECK_IN', event_seq: 2, payload: { minutes_late: 0 } }).expect(200);
    expect(late.body.out_of_order).toBe(true);
    expect(late.body.state).toBe('HIGH_RISK');
  });

  it('the timeline records every transition with its rule version', async () => {
    await request(app).post(`/api/jobs/${jobId}/events`).send({ event_type: 'SOS' }).expect(200);
    const t = await request(app).get(`/api/jobs/${jobId}/timeline`).expect(200);
    expect(t.body.transitions.length).toBeGreaterThan(0);
    expect(t.body.transitions[0].rule_version).toBeTruthy();
    expect(t.body.alerts.length).toBeGreaterThan(0);
  });
});
