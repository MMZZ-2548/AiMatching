/**
 * Notifications — V5 §29.
 *
 * Thirteen event types: seven that reach a family, six that reach a caregiver. They are raised by
 * the workflow at the moment the thing actually happens, so a notification is a record of an event
 * rather than a guess about one.
 *
 * Two rules shape this file.
 *
 * A notification never says more than its recipient is allowed to know. A caregiver who has not
 * been accepted yet must not learn the household's address from a push message, so the bodies here
 * stay at the same disclosure level as the screens (lib/location.js) — an area, a date, a rate.
 *
 * And raising one must never break the action that caused it. A family accepting a caregiver is
 * the important part; failing to write the notification about it is not a reason to fail the
 * accept. Every raise is therefore best-effort and logged rather than thrown.
 */

import { store } from '../store/index.js';

/** The thirteen types V5 §29 enumerates, grouped by who receives them. */
export const NOTIFICATION_TYPES = {
  FAMILY: [
    'CAREGIVER_INTERESTED',
    'CAREGIVER_ACCEPTED',
    'CAREGIVER_DECLINED',
    'NEW_EXCEPTIONAL_CANDIDATE',
    'CHAT_MESSAGE_FROM_CAREGIVER',
    'CARE_PLAN_REQUIRED',
    'DAILY_REPORT_READY',
  ],
  CAREGIVER: [
    'NEW_MATCHING_JOB',
    'FAMILY_INTERESTED',
    'DIRECT_JOB_REQUEST',
    'EXCEPTIONAL_DISTANCE_REQUEST',
    'CHAT_MESSAGE_FROM_FAMILY',
    'JOB_SCHEDULED',
  ],
};

const ALL_TYPES = new Set([...NOTIFICATION_TYPES.FAMILY, ...NOTIFICATION_TYPES.CAREGIVER]);

/** Which side each type is addressed to — used to reject a notification sent to the wrong party. */
const RECIPIENT_OF = Object.fromEntries([
  ...NOTIFICATION_TYPES.FAMILY.map((t) => [t, 'FAMILY']),
  ...NOTIFICATION_TYPES.CAREGIVER.map((t) => [t, 'CAREGIVER']),
]);

const money = (n) => (n == null ? '' : Number(n).toLocaleString('th-TH'));
const hm = (t) => (t ? String(t).slice(0, 5) : '');

/**
 * Wording for each type.
 * Kept in one place so the phrasing stays consistent and so it is easy to see, in one screen,
 * exactly what every notification tells its recipient.
 */
const TEMPLATES = {
  // ── to the family
  CAREGIVER_INTERESTED: (d) => ({
    title: `${d.caregiver_name} สนใจงานของคุณ`,
    body: `ความเหมาะสม ${Math.round(d.mutual_fit ?? 0)}% · ประสบการณ์ ${d.years_experience ?? '-'} ปี`
      + `${d.message ? ` · "${d.message}"` : ''}`,
  }),
  CAREGIVER_ACCEPTED: (d) => ({
    title: `${d.caregiver_name} ตอบรับงานแล้ว`,
    body: `${d.care_date} · ${hm(d.start_time)}–${hm(d.end_time)} · เปิดแชทคุยรายละเอียดได้แล้ว`,
  }),
  CAREGIVER_DECLINED: (d) => ({
    title: `${d.caregiver_name} ปฏิเสธงาน`,
    body: d.reason ? `เหตุผล: ${d.reason} · เลือกผู้ดูแลคนถัดไปได้เลย` : 'เลือกผู้ดูแลคนถัดไปได้เลย',
  }),
  NEW_EXCEPTIONAL_CANDIDATE: (d) => ({
    title: `พบผู้ดูแลที่เหมาะมาก แต่อยู่นอกพื้นที่`,
    body: `${d.caregiver_name} · ความเข้ากัน ${Math.round(d.base_mutual_fit ?? 0)}% · `
      + `ห่าง ${d.distance_km} กม. · ค่าใช้จ่ายเพิ่มประมาณ ${money(d.extra_cost)} บาท (ยังไม่ใช่ราคาสุดท้าย)`,
  }),
  CHAT_MESSAGE_FROM_CAREGIVER: (d) => ({
    title: `ข้อความใหม่จาก ${d.caregiver_name}`,
    body: d.preview,
  }),
  CARE_PLAN_REQUIRED: (d) => ({
    title: 'ต้องยืนยันรายการงานดูแลก่อน',
    body: `ยังส่งคำขอไปยัง ${d.caregiver_name} ไม่ได้ `
      + 'กรุณาสร้างและยืนยันรายการงานดูแล แล้วส่งคำขออีกครั้ง',
  }),
  DAILY_REPORT_READY: (d) => ({
    title: `${d.caregiver_name} ส่งรายงานประจำวันแล้ว`,
    body: `${d.care_date}${d.completed_count != null ? ` · ทำเสร็จ ${d.completed_count} รายการ` : ''}`,
  }),

  // ── to the caregiver
  NEW_MATCHING_JOB: (d) => ({
    title: 'มีงานใหม่ที่ตรงกับโปรไฟล์ของคุณ',
    body: `${d.area} · ${d.care_date} · ${hm(d.start_time)}–${hm(d.end_time)} · ${money(d.budget)} บาท`,
  }),
  FAMILY_INTERESTED: (d) => ({
    title: 'ครอบครัวสนใจโปรไฟล์ของคุณ',
    body: `${d.area} · ${d.care_date} · ${money(d.budget)} บาท · `
      + 'กดสนใจกลับเพื่อให้เกิดการจับคู่',
  }),
  DIRECT_JOB_REQUEST: (d) => ({
    title: 'คุณได้รับคำขอรับงาน',
    body: `${d.area} · ${d.care_date} · ${hm(d.start_time)}–${hm(d.end_time)} · ${money(d.budget)} บาท`,
  }),
  EXCEPTIONAL_DISTANCE_REQUEST: (d) => ({
    title: 'คำขอรับงานนอกพื้นที่',
    body: `ห่าง ${d.distance_km} กม. · ค่าเดินทางและที่พักประมาณ ${money(d.extra_cost)} บาท · `
      + 'ต้องตกลงเรื่องค่าใช้จ่ายกับครอบครัวก่อนจึงจะรับงานได้',
  }),
  CHAT_MESSAGE_FROM_FAMILY: (d) => ({
    title: 'ข้อความใหม่จากครอบครัว',
    body: d.preview,
  }),
  JOB_SCHEDULED: (d) => ({
    title: 'งานของคุณถูกนัดหมายแล้ว',
    body: `${d.care_date} · ${hm(d.start_time)}–${hm(d.end_time)} · ${d.area}`
      + `${d.plan_items ? ` · มีตารางงาน ${d.plan_items} รายการ` : ''}`,
  }),
};

/**
 * Raise one notification.
 *
 * Returns the stored row, or null when it could not be written. Never throws: the caller is in the
 * middle of an action that matters more than the notification about it.
 */
export async function notify(type, recipientId, data = {}, refs = {}) {
  try {
    if (!ALL_TYPES.has(type)) {
      console.warn('[notify] unknown type', type);
      return null;
    }
    if (!recipientId) return null;

    const template = TEMPLATES[type];
    const { title, body } = template(data);

    return await store.insert('notifications', {
      recipient_type: RECIPIENT_OF[type],
      recipient_id: recipientId,
      type,
      title,
      body: body || null,
      care_request_id: refs.care_request_id ?? null,
      caregiver_id: refs.caregiver_id ?? null,
      job_request_id: refs.job_request_id ?? null,
      job_id: refs.job_id ?? null,
      chat_thread_id: refs.chat_thread_id ?? null,
      data,
      read_at: null,
    });
  } catch (err) {
    // A failed notification must not fail the action that triggered it.
    console.warn('[notify] failed', type, err.message);
    return null;
  }
}

/**
 * Raise a notification only if the same one is not already there.
 *
 * Matching is re-run whenever a family reloads their results, so the same candidate would otherwise
 * be announced again every time. A notification should mark the first time something happened, not
 * every time it was recomputed. Sameness is judged on recipient, type, and the ids it refers to.
 */
export async function notifyOnce(type, recipientId, data = {}, refs = {}) {
  try {
    if (!recipientId) return null;
    const existing = await store.findMany('notifications', {
      recipient_type: RECIPIENT_OF[type],
      recipient_id: recipientId,
      type,
    });
    const duplicate = existing.some((n) =>
      (n.care_request_id ?? null) === (refs.care_request_id ?? null)
      && (n.caregiver_id ?? null) === (refs.caregiver_id ?? null));
    if (duplicate) return null;
  } catch {
    // If the check itself fails, fall through and raise — a repeat is better than a silence.
  }
  return notify(type, recipientId, data, refs);
}

/** Everything addressed to one recipient, newest first. */
export async function listFor(recipientType, recipientId, { unreadOnly = false, limit = 50 } = {}) {
  const rows = await store.findMany('notifications', {
    recipient_type: recipientType,
    recipient_id: recipientId,
  });
  const sorted = rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const filtered = unreadOnly ? sorted.filter((n) => !n.read_at) : sorted;
  return filtered.slice(0, limit);
}

export async function unreadCount(recipientType, recipientId) {
  const rows = await store.findMany('notifications', {
    recipient_type: recipientType,
    recipient_id: recipientId,
  });
  return rows.filter((n) => !n.read_at).length;
}

export async function markRead(id) {
  return store.update('notifications', id, { read_at: new Date().toISOString() });
}

export async function markAllRead(recipientType, recipientId) {
  const rows = await store.findMany('notifications', {
    recipient_type: recipientType,
    recipient_id: recipientId,
  });
  const now = new Date().toISOString();
  let n = 0;
  for (const row of rows) {
    if (row.read_at) continue;
    await store.update('notifications', row.id, { read_at: now });
    n += 1;
  }
  return n;
}

/**
 * The privacy-safe description of a care request, as it appears inside a notification to a
 * caregiver. Deliberately the same shape the job cards use: an area, never an address.
 */
export async function jobBlurb(careRequest) {
  if (!careRequest) return {};
  const elderly = await store.find('elderly_profiles', careRequest.elderly_id);
  return {
    area: [elderly?.district, elderly?.province].filter(Boolean).join(', ') || 'ยะลา',
    care_date: careRequest.care_date,
    start_time: careRequest.start_time,
    end_time: careRequest.end_time,
    budget: careRequest.budget,
  };
}

/**
 * Tell the family a confirmed end-of-shift report is waiting (V5 §29, type 7).
 *
 * Raised when the report is confirmed rather than when it is drafted, because an unconfirmed
 * report is still the caregiver's working copy. Both the console route and the app route end up
 * here so the two cannot drift apart.
 */
export async function notifyReportReady(report) {
  if (!report?.job_id) return null;
  const job = await store.find('jobs', report.job_id);
  if (!job) return null;
  const cr = await store.find('care_requests', job.care_request_id);
  return notify(
    'DAILY_REPORT_READY',
    cr?.family_id,
    {
      caregiver_name: await caregiverName(job.caregiver_id),
      care_date: cr?.care_date,
      completed_count: report.completed_tasks?.length ?? 0,
    },
    { care_request_id: job.care_request_id, caregiver_id: job.caregiver_id, job_id: job.id },
  );
}

/** The profile id that owns a care request — the recipient of every FAMILY notification. */
export async function familyOf(careRequest) {
  if (!careRequest) return null;
  return careRequest.family_id ?? null;
}

/** A caregiver's display name, which lives on the linked profile rather than the caregiver row. */
export async function caregiverName(caregiverId) {
  const cg = await store.find('caregiver_profiles', caregiverId);
  if (!cg) return 'ผู้ดูแล';
  const profile = cg.profile_id ? await store.find('profiles', cg.profile_id) : null;
  return profile?.display_name ?? cg.display_name ?? 'ผู้ดูแล';
}
