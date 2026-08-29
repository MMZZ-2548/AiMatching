/**
 * Supabase smoke test — one full two-sided journey against the real database.
 *
 * Why this exists instead of running the vitest suite with STORE=supabase: that suite resets the
 * whole schema in `beforeEach`, which against a remote project means ~38 DELETE round trips per
 * test. Twenty-eight tests of that exhausts the connection budget — the run fails with
 * `TypeError: fetch failed` partway through, which says nothing about the application.
 *
 * So the suite stays on the in-process store (fast, isolated, the CI path) and Supabase is
 * verified here: seed once, walk the journey once, assert on what actually landed in Postgres.
 *
 *   STORE=supabase node scripts/supabase_smoke.js
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.STORE = process.env.STORE ?? 'supabase';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// A bare absolute path is not a valid ESM specifier on Windows ("protocol 'd:'").
const mod = (rel) => pathToFileURL(resolve(ROOT, rel)).href;
const { store } = await import(mod('backend/src/store/index.js'));
const { seed } = await import(mod('backend/src/seed/seed.js'));
const { runMatchingForRequest, runRecommendedJobs } = await import(mod('backend/src/services/matching.js'));
const wf = await import(mod('backend/src/services/workflow.js'));
const notifications = await import(mod('backend/src/services/notifications.js'));
const { ingestEvent, timeline } = await import(mod('backend/src/services/monitoring.js'));
const { codeToUuid } = await import(mod('backend/src/lib/ids.js'));

const id = codeToUuid;
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

console.log(`\n=== Supabase smoke test — driver: ${store.driver} ===\n`);
if (store.driver !== 'supabase') {
  console.log('Not running against Supabase. Set STORE=supabase.');
  process.exit(2);
}

// ── seed
console.log('· seeding');
await store.reset();
const seeded = await seed({ reset: false });
check('seed counts match V4 §40',
  seeded.families === 5 && seeded.elderly === 5 && seeded.caregivers === 20 && seeded.care_requests === 15,
  JSON.stringify(seeded));

// ── family side
console.log('\n· family runs matching (V4 §22)');
const matching = await runMatchingForRequest(id('CR-01'));
check('matching returns the three V5 §27 buckets',
  Array.isArray(matching.recommended_nearby) && Array.isArray(matching.exceptional_matches) && Array.isArray(matching.filtered_out),
  `${matching.recommended_nearby.length} nearby, ${matching.filtered_out.length} filtered`);

const top = matching.recommended_nearby[0];
check('top candidate carries both base and distance-adjusted scores (V5 §24)',
  typeof top?.base_mutual_fit === 'number' && typeof top?.final_mutual_fit === 'number',
  `base ${top?.base_mutual_fit} / final ${top?.final_mutual_fit}`);

const persistedCandidates = await store.findMany('matching_candidates', { care_request_id: id('CR-01') });
check('candidates persisted with feature values (V4 §20)',
  persistedCandidates.length > 0 && persistedCandidates[0].feature_values != null,
  `${persistedCandidates.length} rows`);

// ── exceptional far match
console.log('\n· exceptional far match (V5 §19-§27)');
const far = await runMatchingForRequest(id('CR-12'));
const farCandidate = far.exceptional_matches.find((c) => c.caregiver_id === id('CG_FAR_PERFECT_01'));
check('far caregiver surfaces in the exceptional bucket, not normal ranking',
  Boolean(farCandidate) && !far.recommended_nearby.some((c) => c.caregiver_id === id('CG_FAR_PERFECT_01')),
  farCandidate ? `base ${farCandidate.base_mutual_fit}, ${farCandidate.distance_km} km` : 'absent');
check('cost estimate is present and not presented as a final price (V5 §21)',
  farCandidate?.additional_cost_estimate?.is_final_price === false,
  farCandidate ? `${farCandidate.additional_cost_estimate.total_extra} THB` : '');
check('far caregiver without opt-in is never shown (V5 §26 case 2)',
  ![...far.recommended_nearby, ...far.exceptional_matches].some((c) => c.caregiver_id === id('CG_FAR_NO_OPTIN')));

// ── caregiver side
console.log('\n· caregiver job discovery (V4 §23, V5 §4)');
const jobs = await runRecommendedJobs(id('CG_NEAR_01'));
const openJob = jobs.recommended_nearby.find((c) => c.care_request_id === id('CR-13'));
check('caregiver sees the open job', Boolean(openJob), `${jobs.recommended_nearby.length} jobs`);
check('job card is the privacy-safe summary only (V4 §23)',
  openJob != null && !('care_location_address' in openJob.job) && !('allergies' in openJob.job) && 'elderly_age' in openJob.job);
check('PRIVATE request stays hidden (V5 §17)',
  !jobs.recommended_nearby.some((c) => c.care_request_id === id('CR-14')));

const fromFamily = matching.recommended_nearby.find((c) => c.caregiver_id === id('CG_NEAR_01'));
const cgView = jobs.recommended_nearby.find((c) => c.care_request_id === id('CR-01'));
if (fromFamily && cgView) {
  check('both directions agree on the same pair (V5 §1)',
    fromFamily.base_mutual_fit === cgView.base_mutual_fit,
    `${fromFamily.base_mutual_fit} == ${cgView.base_mutual_fit}`);
}

// ── mutual match
console.log('\n· two-way interest (V5 §5)');
await wf.recordInterest('FAMILY', { care_request_id: id('CR-01'), caregiver_id: top.caregiver_id });
const mutual = await wf.recordInterest('CAREGIVER', { care_request_id: id('CR-01'), caregiver_id: top.caregiver_id });
check('mutual match requires both sides', mutual.status === 'MUTUAL_MATCH', mutual.status);

// ── care plan gate
console.log('\n· care plan gate (V4 §25)');
const blocked = await wf.sendJobRequest({ care_request_id: id('CR-01'), caregiver_id: top.caregiver_id });
check('job request blocked without a confirmed plan', blocked.error === 'CARE_PLAN_REQUIRED', blocked.message ?? '');

const plan = await wf.createCarePlan({
  care_request_id: id('CR-01'), plan_date: '2026-09-01', shift_start: '08:00', shift_end: '16:00',
});
await wf.addCarePlanTask(plan.id, { task_code: 'MEAL_PREP', critical_task: true, planned_time: '11:30' });
await wf.confirmCarePlan(plan.id);
const jr = await wf.sendJobRequest({ care_request_id: id('CR-01'), caregiver_id: top.caregiver_id });
check('job request accepted once the plan is confirmed', jr.id != null && jr.status === 'PENDING');

// ── acceptance
console.log('\n· acceptance (V5 §7)');
const accepted = await wf.acceptJobRequest(jr.id, { note: 'ยินดีรับงาน' });
check('acceptance creates a job', accepted.job?.id != null);
check('every agreement reason names the feature it came from (V5 §7)',
  accepted.agreement_reasons?.length > 0 && accepted.agreement_reasons.every((r) => r.feature),
  `${accepted.agreement_reasons?.length} reasons`);

// ── chat
console.log('\n· chat both ways (V5 §9)');
await wf.postMessage({ thread_id: accepted.chat_thread_id, sender_role: 'FAMILY', body: 'สวัสดีค่ะ' });
await wf.postMessage({ thread_id: accepted.chat_thread_id, sender_role: 'CAREGIVER', body: 'สวัสดีครับ' });
const msgs = await wf.listMessages(accepted.chat_thread_id);
check('both sides read the same thread', msgs.length === 2 && msgs[0].sender_role === 'FAMILY' && msgs[1].sender_role === 'CAREGIVER');

// ── monitoring
console.log('\n· monitoring rules (V4 §31)');
const jobId = accepted.job.id;
const sos = await ingestEvent(jobId, { event_type: 'SOS' });
check('SOS escalates to HIGH_RISK', sos.state === 'HIGH_RISK', sos.matched_rule);
const gps = await ingestEvent(jobId, { event_type: 'GPS_UPDATE', payload: { accuracy_m: 400 } });
check('a low-accuracy GPS fix never escalates on its own', gps.matched_rule === 'gps_low_accuracy_no_escalation');
const tl = await timeline(jobId);
check('transitions and alerts are persisted', tl.transitions.length > 0 && tl.alerts.length > 0,
  `${tl.transitions.length} transitions, ${tl.alerts.length} alerts`);

// ── report, review, trust
console.log('\n· report, review, trust (V4 §32-§34)');
await ingestEvent(jobId, { event_type: 'CHECK_IN', payload: { minutes_late: 0 } });
await ingestEvent(jobId, { event_type: 'CHECK_OUT' });
const draft = await store.insert('care_reports', { job_id: jobId, source: 'TEXT', confirmed: false, observations: 'ดูแลตามแผน' });
const report = await wf.confirmReport(draft.id);
check('report persisted and confirmed', report?.id != null && report.confirmed === true);

const review = await wf.submitReview({
  job_id: jobId, overall_rating: 5, would_rebook: true, would_recommend: true, care_plan_adherence: 5,
});
check('review updates trust', review.trust?.trust_score > 0, `trust ${review.trust?.trust_score}`);

const incident = await store.insert('incidents', { caregiver_id: top.caregiver_id, status: 'REPORTED', responsibility: 'UNDETERMINED' });
const beforeTrust = await wf.recomputeTrust(top.caregiver_id);
check('an unconfirmed incident carries no penalty (V4 §34)', beforeTrust.penalised_incidents === 0);
const confirmed = await wf.confirmIncident(incident.id, { responsibility: 'CAREGIVER_RESPONSIBLE' });
check('a confirmed caregiver-responsible incident does penalise',
  confirmed.trust.penalised_incidents === 1 && confirmed.trust.trust_score < beforeTrust.trust_score,
  `${beforeTrust.trust_score} -> ${confirmed.trust.trust_score}`);

// ── rebook signal feeds the next run
console.log('\n· feedback loop (V6 F03)');
const rerun = await runMatchingForRequest(id('CR-01'));
const again = rerun.recommended_nearby.find((c) => c.caregiver_id === top.caregiver_id);
check('the next matching run sees the completed history',
  again?.feature_values.family.previous_successful_match === 100,
  `previous_successful_match = ${again?.feature_values.family.previous_successful_match}`);

// ── notifications (V5 §29)
console.log('\n· notifications (V5 §29)');
const cr01 = await store.find('care_requests', id('CR-01'));
const familyInbox = await notifications.listFor('FAMILY', cr01.family_id, { limit: 200 });
const caregiverInbox = await notifications.listFor('CAREGIVER', top.caregiver_id, { limit: 200 });
const seen = new Set([...familyInbox, ...caregiverInbox].map((n) => n.type));

check('the enum accepts every one of the thirteen types',
  [...notifications.NOTIFICATION_TYPES.FAMILY, ...notifications.NOTIFICATION_TYPES.CAREGIVER].length === 13);
check('the journey above raised notifications on both sides',
  familyInbox.length > 0 && caregiverInbox.length > 0,
  `family ${familyInbox.length}, caregiver ${caregiverInbox.length}`);
check('acceptance notified both parties',
  seen.has('CAREGIVER_ACCEPTED') && seen.has('JOB_SCHEDULED'),
  [...seen].join(', '));
check('the confirmed report reached the family', seen.has('DAILY_REPORT_READY'));

const unreadBefore = await notifications.unreadCount('FAMILY', cr01.family_id);
await notifications.markRead(familyInbox[0].id);
const unreadAfter = await notifications.unreadCount('FAMILY', cr01.family_id);
check('marking one as read decrements the unread count',
  unreadAfter === unreadBefore - 1, `${unreadBefore} -> ${unreadAfter}`);

const cleared = await notifications.markAllRead('FAMILY', cr01.family_id);
check('read-all clears the rest',
  (await notifications.unreadCount('FAMILY', cr01.family_id)) === 0, `${cleared} marked`);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
