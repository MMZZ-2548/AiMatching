/**
 * Daily care plan, built from what the family says — V4 §26 (Daily Care Plan) and §27 (STT).
 *
 * A ticked list of task codes tells a caregiver *what* but never *when*. This turns dictated or
 * typed Thai into an ordered day: 08:00 bathe, 11:00 diabetes medication, 12:00 lunch. The plan is
 * confirmed before any caregiver is contacted, so what arrives with the job request is a real
 * schedule rather than checkboxes.
 *
 * Times are not left to the model. It converts Thai speech ("บ่ายโมง", "สองทุ่ม"), and every value
 * it returns is then re-checked against the original sentence by lib/thaiTime.js. Corrections are
 * reported, not applied silently: a wrong hour in a care plan is medication at the wrong time.
 */

import express, { Router } from 'express';
import { store } from '../store/index.js';
import * as wf from '../services/workflow.js';
import * as ai from '../services/aiGateway.js';
import { resolveId } from '../lib/ids.js';
import { reconcile, sortByTime, normaliseTimes, extractTimes } from '../lib/thaiTime.js';

export const carePlanApi = Router();

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error, extra = {}) => res.status(code).json({ ok: false, error, ...extra });

const PLAN_TASKS = new Set([
  'MEAL_PREP', 'MEDICATION_REMINDER', 'BATHING', 'TOILETING', 'DRESSING', 'MOBILITY_SUPPORT',
  'TRANSFER', 'COMPANIONSHIP', 'HOUSEKEEPING', 'HOSPITAL_ESCORT', 'WOUND_CARE',
  'NIGHT_MONITORING', 'OTHER',
]);

const CRITICAL_HINT = /ยา|แผล|โรงพยาบาล|ฉีด|วัดความดัน|วัดน้ำตาล/;

/** Split dictation into one line per instruction, without a model. */
function splitSentences(text) {
  return text
    .split(/[\n,]+|\s{2,}|(?=แล้ว)|(?=จากนั้น)|(?=ต่อมา)|(?=หลังจากนั้น)/)
    .map((l) => l.trim())
    .filter((l) => l.length > 1);
}

/** Dictated or typed Thai in, an ordered daily plan out. */
carePlanApi.post('/draft', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return fail(res, 400, 'EMPTY_TEXT', { message: 'ยังไม่มีข้อความ' });

  const result = await ai.structureCarePlan(text);

  // Without the model the plan is still produced: one line per instruction, times read
  // deterministically. The family is never told to try again because a service was down.
  let items = result.items ?? [];
  let source = 'AI';
  if (!result.ai_available || !items.length) {
    source = 'DETERMINISTIC_FALLBACK';
    items = splitSentences(text).map((line) => {
      const t = extractTimes(line)[0];
      return {
        time: t?.time ?? null,
        raw_time: t?.text ?? null,
        title: normaliseTimes(line),
        task_code: 'OTHER',
        critical: CRITICAL_HINT.test(line),
      };
    });
  }

  const { items: checked, corrections } = reconcile(items, text);
  const clean = sortByTime(
    checked
      .filter((i) => String(i.title ?? '').trim())
      .map((i) => ({
        time: i.time ?? null,
        raw_time: i.raw_time ?? null,
        title: String(i.title).trim().slice(0, 200),
        task_code: PLAN_TASKS.has(i.task_code) ? i.task_code : 'OTHER',
        critical: Boolean(i.critical),
      })),
  );

  ok(res, {
    source,
    transcript: text,
    items: clean,
    notes: result.notes ?? null,
    corrections,
    ai: { available: Boolean(result.ai_available), degraded_reason: result.degraded_reason ?? null },
  });
});

/**
 * Audio in, transcript out.
 * V4 §27 forbids saving a transcript as final data without confirmation, so the response says
 * plainly that it is unconfirmed and the UI shows it for editing.
 */
carePlanApi.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!req.body?.length) return fail(res, 400, 'EMPTY_AUDIO', { message: 'ไม่มีไฟล์เสียง' });
  const result = await ai.transcribe(
    req.body,
    req.headers['x-filename'] || 'audio.webm',
    req.headers['content-type'] || 'audio/webm',
    'CARE_PLAN',
  );
  ok(res, { ...result, confirmed: false });
});

/**
 * Attach a confirmed plan to a care request, before any caregiver is contacted.
 * Replaces any earlier plan for the request so re-editing does not leave orphans behind.
 */
carePlanApi.post('/save', async (req, res) => {
  const care_request_id = resolveId(req.body?.care_request_id);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const cr = await store.find('care_requests', care_request_id);
  if (!cr) return fail(res, 404, 'NOT_FOUND');

  for (const p of await store.findMany('daily_care_plans', { care_request_id })) {
    for (const t of await store.findMany('daily_care_tasks', { care_plan_id: p.id })) {
      await store.remove('daily_care_tasks', t.id);
    }
    await store.remove('daily_care_plans', p.id);
  }

  const plan = await wf.createCarePlan({
    care_request_id,
    plan_date: cr.care_date,
    shift_start: cr.start_time,
    shift_end: cr.end_time,
    notes: req.body?.notes ?? null,
  });

  const saved = [];
  for (const it of sortByTime(items)) {
    saved.push(await wf.addCarePlanTask(plan.id, {
      task_code: PLAN_TASKS.has(it.task_code) ? it.task_code : 'OTHER',
      description: String(it.title ?? '').slice(0, 200),
      planned_time: it.time ?? null,
      critical_task: Boolean(it.critical),
      tolerance_minutes: 30,
    }));
  }
  const confirmed = await wf.confirmCarePlan(plan.id);

  // Keep the request's task list in step with the plan, so matching filters on what the day
  // actually contains rather than on an older set of ticks.
  const codes = [...new Set(saved.map((t) => t.task_code).filter((c) => c !== 'OTHER'))];
  if (codes.length) {
    await store.update('care_requests', care_request_id, {
      tasks: codes.map((code) => ({ task_code: code, must_do: true })),
    });
  }

  ok(res, { care_plan: confirmed, tasks: saved, task_codes: codes });
});

/** The plan as the caregiver reads it: chronological, with the critical entries marked. */
carePlanApi.get('/:careRequestId', async (req, res) => {
  const care_request_id = resolveId(req.params.careRequestId);
  const plan = await wf.confirmedPlanFor(care_request_id);
  if (!plan) return ok(res, { care_plan: null, tasks: [] });
  const tasks = await store.findMany('daily_care_tasks', { care_plan_id: plan.id });
  ok(res, {
    care_plan: plan,
    tasks: sortByTime(tasks.map((t) => ({ ...t, time: t.planned_time ?? null }))),
  });
});
