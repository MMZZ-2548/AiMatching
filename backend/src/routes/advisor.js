/**
 * AI Care Advisor — the floating helper the user can open on any screen (V4 §28–§30).
 *
 * The point of the widget is questions like "ทำไมคนนี้เหมาะที่สุด". Answering that honestly means
 * the advisor must be handed the *computed* breakdown for the candidates on screen, not asked to
 * imagine one: V4 §29 rule 5 says separate fact from assumption, and rule 11 forbids inventing
 * health information. So this endpoint assembles a context block from stored matching results and
 * sends it along; the model explains, it never scores.
 *
 * V4 §30 also limits what may be sent: basic elderly info, the active request, a matching summary
 * and the care plan — never the full record. `buildContext` is deliberately narrow for that reason.
 */

import { Router } from 'express';
import { store } from '../store/index.js';
import * as ai from '../services/aiGateway.js';
import * as wf from '../services/workflow.js';
import { resolveId } from '../lib/ids.js';

export const advisorApi = Router();

const ok = (res, data) => res.json({ ok: true, ...data });

const TASK_TH = {
  MEAL_PREP: 'เตรียมอาหาร', MEDICATION_REMINDER: 'เตือนยา/ให้ยา', BATHING: 'อาบน้ำ',
  TOILETING: 'ช่วยเข้าห้องน้ำ', DRESSING: 'แต่งตัว', MOBILITY_SUPPORT: 'พาเดิน',
  TRANSFER: 'ยก/เคลื่อนย้าย', COMPANIONSHIP: 'อยู่เป็นเพื่อน', HOUSEKEEPING: 'งานบ้าน',
  HOSPITAL_ESCORT: 'พาไปโรงพยาบาล', WOUND_CARE: 'ทำแผล', NIGHT_MONITORING: 'เฝ้ากลางคืน',
};

/**
 * What the advisor is allowed to know about the screen the user is on.
 * Everything here comes from stored, deterministic results.
 */
async function buildContext(ctx = {}) {
  const out = {};

  if (ctx.care_request_id) {
    const cr = await store.find('care_requests', resolveId(ctx.care_request_id));
    if (cr) {
      const elderly = await store.find('elderly_profiles', cr.elderly_id);
      out.care_request = {
        วันที่: cr.care_date,
        เวลา: `${cr.start_time}–${cr.end_time}`,
        งบประมาณ: cr.budget,
        ภาวะที่เกี่ยวข้อง: cr.conditions_relevant,
        การเคลื่อนไหว: cr.mobility_requirement,
        งานที่ต้องทำ: (cr.tasks ?? []).map((t) => TASK_TH[t.task_code] ?? t.task_code),
        ทักษะที่บังคับ: (cr.requirements ?? [])
          .filter((r) => r.requirement_type === 'SKILL')
          .map((r) => r.requirement_code),
        รับผู้ดูแลนอกพื้นที่: Boolean(cr.accept_out_of_area),
      };
      if (elderly) {
        out.elderly = { อายุ: elderly.age, เพศ: elderly.gender, การเคลื่อนไหว: elderly.mobility_level };
      }

      const plan = await wf.confirmedPlanFor(cr.id);
      if (plan) {
        const tasks = await store.findMany('daily_care_tasks', { care_plan_id: plan.id });
        out.care_plan = tasks.map((t) => ({
          เวลา: String(t.planned_time ?? '').slice(0, 5) || null,
          งาน: t.description || TASK_TH[t.task_code] || t.task_code,
          สำคัญ: Boolean(t.critical_task),
        }));
      }
    }
  }

  // The candidates the user is looking at, with the numbers that produced the ranking.
  if (Array.isArray(ctx.candidates) && ctx.candidates.length) {
    out.ผู้ดูแลที่ระบบเสนอ = ctx.candidates.slice(0, 6).map((c, i) => ({
      อันดับ: i + 1,
      ชื่อ: c.name,
      ความเหมาะสมรวม: c.mutual,
      เหมาะกับครอบครัว: c.family,
      เหมาะกับผู้ดูแล: c.job,
      ระยะทางกม: c.distance,
      ประสบการณ์ปี: c.experience,
      คะแนนความน่าเชื่อถือ: c.trust,
      ค่าบริการ: c.rate,
      เหตุผลที่ระบบให้: c.reasons,
      ข้อควรพิจารณา: c.concerns,
      นอกพื้นที่ปกติ: Boolean(c.exceptional),
    }));
  }

  if (ctx.filtered_out_reasons?.length) {
    out.คนที่ถูกคัดออก = ctx.filtered_out_reasons.map((r) => `${r.label} ${r.count} คน`);
  }

  if (ctx.caregiver_id) {
    const cg = await store.find('caregiver_profiles', resolveId(ctx.caregiver_id));
    if (cg) {
      out.ผู้ดูแลที่กำลังดู = {
        ชื่อ: cg.display_name, ประสบการณ์ปี: cg.years_experience,
        ทักษะ: cg.skills, ภาษา: cg.languages,
        คะแนนความน่าเชื่อถือ: cg.final_trust_score, สถานะความน่าเชื่อถือ: cg.trust_status,
        งานที่ทำเสร็จ: cg.completed_jobs, จำนวนรีวิว: cg.review_count,
        ค่าบริการที่ตั้งไว้: cg.expected_rate, รัศมีให้บริการกม: cg.service_radius_km,
      };
    }
  }

  out.หมายเหตุสำหรับผู้ช่วย =
    'ตัวเลขทุกตัวข้างบนคำนวณโดยระบบแล้ว ห้ามคำนวณใหม่ ห้ามเดาตัวเลขที่ไม่มี ' +
    'ถ้าผู้ใช้ถามสิ่งที่ไม่มีในข้อมูลนี้ ให้ตอบว่าไม่ทราบ';

  return out;
}

/**
 * One turn of advisor conversation. History is kept per conversation so follow-up questions
 * ("แล้วคนที่สองล่ะ") work without the browser resending everything.
 */
advisorApi.post('/message', async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) return res.status(400).json({ ok: false, error: 'EMPTY_MESSAGE' });

  const conv = req.body?.conversation_id
    ? await store.find('ai_conversations', req.body.conversation_id)
    : await store.insert('ai_conversations', {
        kind: 'ADVISOR',
        profile_id: req.body?.profile_id ? resolveId(req.body.profile_id) : null,
      });

  await store.insert('ai_messages', { conversation_id: conv.id, role: 'user', content: message });
  const history = await store.findMany('ai_messages', { conversation_id: conv.id });

  const context = await buildContext(req.body?.context ?? {});
  const reply = await ai.advisorChat(
    history
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content })),
    context,
  );

  if (reply.reply) {
    await store.insert('ai_messages', {
      conversation_id: conv.id, role: 'assistant', content: reply.reply,
    });
  }

  ok(res, {
    conversation_id: conv.id,
    reply: reply.reply,
    ai_available: reply.ai_available,
    degraded_reason: reply.degraded_reason ?? null,
    // what the advisor was allowed to see, so the answer can be audited
    context_keys: Object.keys(context),
  });
});

/** Suggested questions, tuned to whatever the user is currently looking at. */
advisorApi.get('/suggestions', (req, res) => {
  const where = String(req.query.screen ?? '');
  const byScreen = {
    results: [
      'ทำไมคนอันดับหนึ่งถึงเหมาะที่สุด',
      'อันดับ 1 กับอันดับ 2 ต่างกันตรงไหน',
      'ทำไมถึงคัดคนอื่นออกไปเยอะ',
      'ถ้าอยากได้คนที่ถูกกว่านี้ควรปรับอะไร',
    ],
    caregiver: [
      'คนนี้เหมาะกับแม่ที่เป็นเบาหวานไหม',
      'คะแนนความน่าเชื่อถือนี้หมายความว่าอะไร',
      'ควรถามอะไรผู้ดูแลคนนี้ก่อนตัดสินใจ',
    ],
    plan: [
      'ตารางแบบนี้ครบไหม ควรเพิ่มอะไรอีก',
      'งานไหนควรทำเป็นงานสำคัญ',
    ],
    form: [
      'ควรระบุทักษะอะไรบ้างสำหรับผู้สูงอายุติดเตียง',
      'งบเท่าไหร่ถึงจะพอสำหรับดูแลทั้งวัน',
      'ควรเลือกงานอะไรบ้างถ้าแม่เดินไม่ค่อยไหว',
    ],
    job: [
      'ระหว่างทำงานควรบันทึกอะไรบ้าง',
      'สถานะการติดตามแต่ละแบบหมายความว่าอะไร',
    ],
  };
  res.json({ ok: true, suggestions: byScreen[where] ?? byScreen.form });
});
