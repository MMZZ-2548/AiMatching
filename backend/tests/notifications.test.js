/**
 * Notifications — V5 §29.
 *
 * The spec names thirteen event types, seven reaching a family and six reaching a caregiver. The
 * point of this file is that all thirteen are actually raised by the flows that cause them, rather
 * than merely being declared in an enum somewhere.
 *
 * Three properties are checked beyond mere existence:
 *
 *   1. A notification goes to the other side. Acting on something never notifies you about your
 *      own action.
 *   2. A notification tells its recipient no more than the screens would. A caregiver who has not
 *      been accepted must not learn the household's address from a notification body.
 *   3. Re-running matching does not re-announce. A family reloading their results is not an event.
 *
 * The final case walks a whole journey and asserts the complete set of thirteen was produced.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { store } from '../src/store/index.js';
import { seed } from '../src/seed/seed.js';
import { codeToUuid } from '../src/lib/ids.js';
import { NOTIFICATION_TYPES } from '../src/services/notifications.js';

const id = codeToUuid;
const asFamily = (r) => r.set('x-role', 'FAMILY');
const asCaregiver = (r) => r.set('x-role', 'CAREGIVER');

beforeEach(async () => {
  await store.reset();
  await seed({ reset: true });
});

/** Every notification currently addressed to one recipient. */
async function inbox(who, recipientId) {
  const res = await request(app).get(`/api/app/notifications/${who}/${recipientId}`).expect(200);
  return res.body.notifications;
}

const typesIn = (rows) => rows.map((n) => n.type);

/** The family that owns CR-01, which every case below works through. */
async function familyOfCR01() {
  const cr = await store.find('care_requests', id('CR-01'));
  return cr.family_id;
}

describe('Notifications — the catalogue (V5 §29)', () => {
  it('declares exactly the thirteen types the spec names', async () => {
    const res = await request(app).get('/api/app/notification-types').expect(200);
    expect(res.body.types.FAMILY).toHaveLength(7);
    expect(res.body.types.CAREGIVER).toHaveLength(6);
    expect(res.body.types.FAMILY.length + res.body.types.CAREGIVER.length).toBe(13);
  });

  it('addresses every type to exactly one side', () => {
    const overlap = NOTIFICATION_TYPES.FAMILY.filter((t) => NOTIFICATION_TYPES.CAREGIVER.includes(t));
    expect(overlap).toEqual([]);
  });
});

describe('Notifications — interest notifies the other side (V5 §5, §29)', () => {
  it('tells the caregiver when a family shows interest, and does not tell the family', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];

    const before = await inbox('FAMILY', await familyOfCR01());
    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    expect(typesIn(await inbox('CAREGIVER', top.caregiver_id))).toContain('FAMILY_INTERESTED');
    // the family acted; the family learns nothing new about its own click
    const after = await inbox('FAMILY', await familyOfCR01());
    expect(typesIn(after).filter((t) => t === 'FAMILY_INTERESTED')).toEqual([]);
    expect(after.length).toBe(before.length);
  });

  it('tells the family when a caregiver shows interest, with the fit and the experience', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];

    await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    const rows = await inbox('FAMILY', await familyOfCR01());
    const note = rows.find((n) => n.type === 'CAREGIVER_INTERESTED');
    expect(note).toBeTruthy();
    expect(note.caregiver_id).toBe(top.caregiver_id);
    expect(note.body).toMatch(/%/);
  });
});

describe('Notifications — what a caregiver is allowed to be told (V4 §14, V5 §29)', () => {
  it('describes the job by area, never by the household address', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];

    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    const cr = await store.find('care_requests', id('CR-01'));
    const note = (await inbox('CAREGIVER', top.caregiver_id))
      .find((n) => n.type === 'FAMILY_INTERESTED');

    expect(note.body).toBeTruthy();
    if (cr.location_address) expect(note.body).not.toContain(cr.location_address);
    // nor may the exact coordinates leak through the payload
    expect(JSON.stringify(note)).not.toContain(String(cr.latitude));
  });
});

describe('Notifications — the care-plan gate notifies the family it blocked (V4 §25)', () => {
  it('raises CARE_PLAN_REQUIRED when a request is sent without a confirmed plan', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];

    await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(409);

    const rows = await inbox('FAMILY', await familyOfCR01());
    expect(typesIn(rows)).toContain('CARE_PLAN_REQUIRED');
    // and the caregiver hears nothing about a request that never left
    expect(typesIn(await inbox('CAREGIVER', top.caregiver_id))).not.toContain('DIRECT_JOB_REQUEST');
  });
});

describe('Notifications — decline (V5 §29)', () => {
  it('tells the family, and carries the reason when one was given', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];

    const plan = await asFamily(request(app).post('/api/care-plans'))
      .send({
        care_request_id: 'CR-01', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00',
        tasks: [{ task_code: 'MEAL_PREP', critical_task: true, planned_time: '11:30' }],
      }).expect(200);
    await asFamily(request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`)).expect(200);

    const jr = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    await asCaregiver(request(app).post(`/api/job-requests/${jr.body.job_request.id}/decline`))
      .send({ reason: 'ติดงานอื่น' }).expect(200);

    const note = (await inbox('FAMILY', await familyOfCR01()))
      .find((n) => n.type === 'CAREGIVER_DECLINED');
    expect(note).toBeTruthy();
    expect(note.body).toContain('ติดงานอื่น');
  });
});

describe('Notifications — matching runs (V5 §29)', () => {
  it('announces matched candidates once, however many times matching is re-run', async () => {
    const first = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = first.body.matching.recommended_nearby[0];
    const after1 = typesIn(await inbox('CAREGIVER', top.caregiver_id))
      .filter((t) => t === 'NEW_MATCHING_JOB');
    expect(after1).toHaveLength(1);

    await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);

    const after3 = typesIn(await inbox('CAREGIVER', top.caregiver_id))
      .filter((t) => t === 'NEW_MATCHING_JOB');
    expect(after3).toHaveLength(1);
  });

  it('tells the family about an exceptional far candidate, with the cost marked as an estimate', async () => {
    // CR-12 is the request seeded with an out-of-area exceptional candidate (V5 §20.3).
    const res = await asFamily(request(app).post('/api/matching/CR-12/run')).expect(200);
    if (!res.body.matching.exceptional_matches.length) return; // nothing to announce

    const cr = await store.find('care_requests', id('CR-12'));
    const note = (await inbox('FAMILY', cr.family_id))
      .find((n) => n.type === 'NEW_EXCEPTIONAL_CANDIDATE');

    expect(note).toBeTruthy();
    // V5 §21 — an added cost may never be presented as a final price
    expect(note.body).toContain('ยังไม่ใช่ราคาสุดท้าย');
  });
});

describe('Notifications — the inbox itself', () => {
  it('separates the two sides, counts unread, and marks read', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];
    await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    const familyId = await familyOfCR01();
    const before = await request(app).get(`/api/app/notifications/FAMILY/${familyId}`).expect(200);
    expect(before.body.unread_count).toBe(before.body.notifications.length);
    expect(before.body.unread_count).toBeGreaterThan(0);

    // a caregiver id may not be used to read a family inbox
    const wrong = await request(app).get(`/api/app/notifications/FAMILY/${top.caregiver_id}`).expect(200);
    expect(wrong.body.notifications).toEqual([]);

    const one = before.body.notifications[0];
    await request(app).post(`/api/app/notifications/${one.id}/read`).expect(200);
    const mid = await request(app).get(`/api/app/notifications/FAMILY/${familyId}`).expect(200);
    expect(mid.body.unread_count).toBe(before.body.unread_count - 1);

    await request(app).post(`/api/app/notifications/FAMILY/${familyId}/read-all`).expect(200);
    const after = await request(app).get(`/api/app/notifications/FAMILY/${familyId}/unread-count`).expect(200);
    expect(after.body.unread_count).toBe(0);
  });

  it('rejects a recipient type that is neither side', async () => {
    const res = await request(app).get('/api/app/notifications/ADMIN/whoever').expect(400);
    expect(res.body.error).toBe('BAD_RECIPIENT_TYPE');
  });

  it('can return only what is unread', async () => {
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];
    await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    const familyId = await familyOfCR01();
    const all = await request(app).get(`/api/app/notifications/FAMILY/${familyId}`).expect(200);
    await request(app).post(`/api/app/notifications/${all.body.notifications[0].id}/read`).expect(200);

    const unread = await request(app)
      .get(`/api/app/notifications/FAMILY/${familyId}?unread=true`).expect(200);
    expect(unread.body.notifications.length).toBe(all.body.notifications.length - 1);
    expect(unread.body.notifications.every((n) => !n.read_at)).toBe(true);
  });
});

describe('Notifications — a full journey raises every type it should (V5 §15, §29)', () => {
  it('produces all seven family types and all six caregiver types across one flow', async () => {
    // ── the nearby half of the journey, on CR-01
    const matching = await asFamily(request(app).post('/api/matching/CR-01/run')).expect(200);
    const top = matching.body.matching.recommended_nearby[0];
    const familyId = await familyOfCR01();

    // 1. family interest → FAMILY_INTERESTED (caregiver)
    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    // 2. caregiver interest → CAREGIVER_INTERESTED (family)
    await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    // 3. the plan gate → CARE_PLAN_REQUIRED (family)
    await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(409);

    const plan = await asFamily(request(app).post('/api/care-plans'))
      .send({
        care_request_id: 'CR-01', plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00',
        tasks: [{ task_code: 'MEAL_PREP', critical_task: true, planned_time: '11:30' }],
      }).expect(200);
    await asFamily(request(app).post(`/api/care-plans/${plan.body.care_plan.id}/confirm`)).expect(200);

    // 4. the request goes out → DIRECT_JOB_REQUEST (caregiver)
    const jr = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: top.caregiver_id }).expect(200);

    // 5. acceptance → CAREGIVER_ACCEPTED (family) + JOB_SCHEDULED (caregiver)
    const accepted = await asCaregiver(request(app).post(`/api/job-requests/${jr.body.job_request.id}/accept`))
      .send({ note: 'ยินดีรับงาน' }).expect(200);
    const jobId = accepted.body.job.id;
    const threadId = accepted.body.chat_thread_id;

    // 6. chat both ways → CHAT_MESSAGE_FROM_FAMILY + CHAT_MESSAGE_FROM_CAREGIVER
    await asFamily(request(app).post(`/api/chats/${threadId}/messages`)).send({ body: 'สวัสดีค่ะ' }).expect(200);
    await asCaregiver(request(app).post(`/api/chats/${threadId}/messages`)).send({ body: 'สวัสดีครับ' }).expect(200);

    // 7. the shift and its report → DAILY_REPORT_READY (family)
    await asCaregiver(request(app).post(`/api/jobs/${jobId}/events`))
      .send({ event_type: 'CHECK_IN', payload: { minutes_late: 0 } }).expect(200);
    await asCaregiver(request(app).post(`/api/jobs/${jobId}/events`)).send({ event_type: 'CHECK_OUT' }).expect(200);
    const report = await asCaregiver(request(app).post('/api/reports'))
      .send({ job_id: jobId, text: 'ดูแลตามแผน ทานอาหารครบ' }).expect(200);
    await asCaregiver(request(app).post(`/api/reports/${report.body.report.id}/confirm`)).send({}).expect(200);

    // ── the far half, on CR-12, for the two exceptional-distance types
    const far = await asFamily(request(app).post('/api/matching/CR-12/run')).expect(200);
    const cr12 = await store.find('care_requests', id('CR-12'));
    const exceptional = far.body.matching.exceptional_matches[0];
    expect(exceptional).toBeTruthy(); // the seed must keep an out-of-area candidate for this

    // both sides interested, but the caregiver has not accepted the distance → the request for it
    await asFamily(request(app).post('/api/family/interests'))
      .send({ care_request_id: 'CR-12', caregiver_id: exceptional.caregiver_id }).expect(200);
    await asCaregiver(request(app).post('/api/caregiver/interests'))
      .send({ care_request_id: 'CR-12', caregiver_id: exceptional.caregiver_id }).expect(200);

    // 8. a decline, on a second caregiver, so the accepted one above is left intact
    const second = matching.body.matching.recommended_nearby[1];
    const jr2 = await asFamily(request(app).post('/api/job-requests'))
      .send({ care_request_id: 'CR-01', caregiver_id: second.caregiver_id }).expect(200);
    await asCaregiver(request(app).post(`/api/job-requests/${jr2.body.job_request.id}/decline`))
      .send({ reason: 'ติดงานอื่น' }).expect(200);

    // ── every family type must have appeared across the two requests
    const familySeen = new Set([
      ...typesIn(await inbox('FAMILY', familyId)),
      ...typesIn(await inbox('FAMILY', cr12.family_id)),
    ]);
    for (const t of NOTIFICATION_TYPES.FAMILY) expect(familySeen).toContain(t);

    // ── and every caregiver type, across the caregivers involved
    const caregiverSeen = new Set([
      ...typesIn(await inbox('CAREGIVER', top.caregiver_id)),
      ...typesIn(await inbox('CAREGIVER', second.caregiver_id)),
      ...typesIn(await inbox('CAREGIVER', exceptional.caregiver_id)),
    ]);
    for (const t of NOTIFICATION_TYPES.CAREGIVER) expect(caregiverSeen).toContain(t);
  });
});
