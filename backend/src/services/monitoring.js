/**
 * Real-time Care Monitoring & Alert System — V4 §31.
 *
 * Rule-based, not AI. V4 §0 forbids calling this AI and forbids letting GPT decide a realtime
 * state; V4 §44 requires it to keep working when OpenAI is down. Nothing in this file makes a
 * network call.
 *
 * States: NORMAL → OBSERVE → VERIFY → ATTENTION → HIGH_RISK
 */

import { store } from '../store/index.js';
import { ENV } from '../lib/env.js';

const RANK = { NORMAL: 0, OBSERVE: 1, VERIFY: 2, ATTENTION: 3, HIGH_RISK: 4 };

/** Below this accuracy a GPS fix cannot on its own raise the state (V4 §31). */
const GPS_ACCURACY_FLOOR_M = 100;
const LATE_CHECK_IN_MIN = 15;

/**
 * @returns {{state, matched_rule, reason, escalated}} for a single event.
 * Pure — takes the current state and the event, returns the next state.
 */
export function applyRule(currentState, event, context = {}) {
  const t = event.event_type;
  const p = event.payload ?? {};
  const keep = (rule, reason) => ({ state: currentState, matched_rule: rule, reason });
  const to = (state, rule, reason) => ({ state, matched_rule: rule, reason });

  switch (t) {
    case 'SOS':
      return to('HIGH_RISK', 'sos_immediate', 'SOS raised by the caregiver');

    case 'GEOFENCE_EXIT':
      // A planned hospital trip is an expected exit, not an anomaly (V4 §31).
      if (p.planned || context.hospital_visit_planned) {
        return keep('planned_geofence_exit', 'exit matches a planned hospital visit');
      }
      return to('VERIFY', 'unexpected_geofence_exit', 'left the care location unexpectedly');

    case 'GEOFENCE_ENTER':
      return currentState === 'VERIFY'
        ? to('OBSERVE', 'geofence_return', 'returned to the care location')
        : keep('geofence_enter', 'inside the care location');

    case 'GPS_UPDATE':
      // Poor accuracy must never escalate on its own (V4 §31, §44).
      if ((p.accuracy_m ?? 0) > GPS_ACCURACY_FLOOR_M) {
        return keep('gps_low_accuracy_no_escalation', `accuracy ${p.accuracy_m}m is too coarse to act on`);
      }
      return keep('gps_update', 'position recorded');

    case 'CHECK_IN': {
      const late = p.minutes_late ?? 0;
      if (late > LATE_CHECK_IN_MIN) {
        return to('VERIFY', 'late_check_in', `checked in ${late} min late`);
      }
      return to('NORMAL', 'check_in', 'checked in on time');
    }

    case 'TASK_DELAYED':
      return p.critical_task
        ? to('ATTENTION', 'critical_task_delayed', 'a critical task is running late')
        : to('OBSERVE', 'task_delayed', 'a task is running late');

    case 'ALERT_TIMEOUT':
      // An unanswered alert on a critical task is the escalation path in V4 §31.
      return context.critical_pending
        ? to('HIGH_RISK', 'critical_task_missed_no_response', 'critical task missed with no response')
        : to('ATTENTION', 'alert_timeout', 'alert not acknowledged in time');

    case 'ALERT_ACK':
      return to('OBSERVE', 'alert_acknowledged', 'alert acknowledged');

    case 'TASK_COMPLETED':
      return currentState === 'OBSERVE'
        ? to('NORMAL', 'task_completed_recovery', 'outstanding task completed')
        : keep('task_completed', 'task completed');

    case 'CHECK_OUT':
      return to('NORMAL', 'check_out', 'shift ended');

    default:
      return keep('no_rule', `no rule applies to ${t}`);
  }
}

/**
 * Ingest one event. Duplicates are rejected by dedupe key and out-of-order events are recorded but
 * cannot lower the state below what a later event already established (V4 §44).
 */
export async function ingestEvent(job_id, event) {
  const job = await store.find('jobs', job_id);
  if (!job) return { error: 'NOT_FOUND' };

  if (event.dedupe_key) {
    const dup = await store.findOne('care_events', { job_id, dedupe_key: event.dedupe_key });
    if (dup) return { duplicate: true, event: dup, state: job.current_state };
  }

  const careRequest = await store.find('care_requests', job.care_request_id);
  const pendingCritical = await hasPendingCriticalTask(job);

  const stored = await store.insert('care_events', {
    job_id,
    event_type: event.event_type,
    payload: event.payload ?? {},
    event_seq: event.event_seq ?? null,
    dedupe_key: event.dedupe_key ?? null,
    occurred_at: event.occurred_at ?? new Date().toISOString(),
  });

  const decision = applyRule(job.current_state, stored, {
    hospital_visit_planned: careRequest?.hospital_visit ?? false,
    critical_pending: pendingCritical,
  });

  // An out-of-order arrival may not pull the state back down; a later event already saw more.
  const outOfOrder =
    event.event_seq != null && job.last_event_seq != null && event.event_seq < job.last_event_seq;
  const nextState =
    outOfOrder && RANK[decision.state] < RANK[job.current_state] ? job.current_state : decision.state;

  if (nextState !== job.current_state) {
    await store.insert('care_state_transitions', {
      job_id,
      from_state: job.current_state,
      to_state: nextState,
      matched_rule: decision.matched_rule,
      reason: decision.reason,
      rule_version: ENV.realtimeRuleVersion,
    });
  }

  const patch = { current_state: nextState };
  if (event.event_seq != null) patch.last_event_seq = Math.max(event.event_seq, job.last_event_seq ?? 0);
  if (stored.event_type === 'CHECK_IN') { patch.check_in_at = stored.occurred_at; patch.status = 'IN_PROGRESS'; }
  if (stored.event_type === 'CHECK_OUT') { patch.check_out_at = stored.occurred_at; patch.status = 'COMPLETED'; }
  await store.update('jobs', job_id, patch);

  if (RANK[nextState] >= RANK.ATTENTION) {
    await store.insert('alerts', {
      job_id,
      alert_type: decision.matched_rule,
      severity: nextState,
      message: decision.reason,
    });
  }

  return {
    event: stored,
    state: nextState,
    previous_state: job.current_state,
    matched_rule: decision.matched_rule,
    reason: decision.reason,
    out_of_order: outOfOrder,
    rule_version: ENV.realtimeRuleVersion,
  };
}

async function hasPendingCriticalTask(job) {
  const plans = await store.findMany('daily_care_plans', { care_request_id: job.care_request_id });
  for (const plan of plans) {
    const tasks = await store.findMany('daily_care_tasks', { care_plan_id: plan.id });
    if (tasks.some((t) => t.critical_task)) {
      const events = await store.findMany('care_events', { job_id: job.id });
      const completed = events.filter((e) => e.event_type === 'TASK_COMPLETED').length;
      if (completed < tasks.filter((t) => t.critical_task).length) return true;
    }
  }
  return false;
}

export async function timeline(job_id) {
  const job = await store.find('jobs', job_id);
  const events = (await store.findMany('care_events', { job_id })).sort((a, b) =>
    String(a.occurred_at).localeCompare(String(b.occurred_at)),
  );
  const transitions = await store.findMany('care_state_transitions', { job_id });
  const alerts = await store.findMany('alerts', { job_id });
  return { job, events, transitions, alerts, rule_version: ENV.realtimeRuleVersion };
}
