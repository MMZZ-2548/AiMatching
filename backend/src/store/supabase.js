/**
 * Supabase (PostgREST) store — same interface as the memory driver.
 *
 * Uses SUPABASE_SECRET_KEY, which bypasses RLS. That is correct for a server-side service role and
 * is why the key must never reach the browser (V4 §5): the RLS policies in db/migrations/002_rls.sql
 * exist to protect anything reached with the publishable key, not this path.
 */

import { ENV } from '../lib/env.js';

const headers = () => ({
  apikey: ENV.supabaseSecretKey,
  Authorization: `Bearer ${ENV.supabaseSecretKey}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
});

const qs = (where) =>
  Object.entries(where)
    .map(([k, v]) => (Array.isArray(v) ? `${k}=in.(${v.join(',')})` : `${k}=eq.${encodeURIComponent(v)}`))
    .join('&');

async function call(path, init = {}) {
  const res = await fetch(`${ENV.supabaseUrl}/rest/v1/${path}`, { ...init, headers: headers() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`supabase ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Deletion order for reset(): children first, so no foreign key is ever left dangling.
 * `profiles` and `caregiver_profiles` come last because almost everything references them.
 */
const RESET_ORDER = [
  'notifications',
  'chat_messages', 'chat_threads',
  'care_state_transitions', 'alerts', 'care_events',
  'report_attachments', 'care_reports',
  'family_reviews', 'trust_score_snapshots', 'incidents',
  'jobs', 'job_requests',
  'daily_care_tasks', 'daily_care_plans',
  'mutual_matches', 'caregiver_interests', 'family_interests',
  'matching_feature_snapshots', 'matching_candidates', 'matching_runs',
  'ai_messages', 'ai_extraction_logs', 'ai_conversations', 'transcription_logs',
  'care_request_task_expectations', 'care_request_requirements', 'care_request_tasks',
  'care_requests',
  'caregiver_priority_preferences', 'caregiver_job_preferences', 'caregiver_availability',
  'caregiver_languages', 'caregiver_condition_experience', 'caregiver_certificates',
  'caregiver_skill_levels', 'caregiver_skills',
  'family_matching_preferences',
  'caregiver_profiles', 'elderly_profiles', 'profiles',
];

export function createSupabaseStore() {
  return {
    driver: 'supabase',

    async insert(table, row) {
      const [created] = await call(table, { method: 'POST', body: JSON.stringify(row) });
      return created;
    },

    async update(table, id, patch) {
      const rows = await call(`${table}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return rows?.[0] ?? null;
    },

    async find(table, id) {
      const rows = await call(`${table}?id=eq.${id}&limit=1`);
      return rows?.[0] ?? null;
    },

    async findOne(table, where) {
      const rows = await call(`${table}?${qs(where)}&limit=1`);
      return rows?.[0] ?? null;
    },

    async findMany(table, where = {}) {
      const query = Object.keys(where).length ? `?${qs(where)}` : '';
      return (await call(`${table}${query}`)) ?? [];
    },

    async upsert(table, where, row) {
      const existing = await this.findOne(table, where);
      if (existing) return this.update(table, existing.id, row);
      return this.insert(table, { ...where, ...row });
    },

    async remove(table, id) {
      await call(`${table}?id=eq.${id}`, { method: 'DELETE' });
      return true;
    },

    /**
     * Clear every domain table, children before parents so foreign keys stay satisfied.
     *
     * Guarded by DEV_TESTER_ENABLED: this wipes real rows, and the only legitimate caller is the
     * dev tester or the test suite against a scratch project.
     *
     * The test suite calls this in `beforeEach`. Pointed at a shared project it will delete data
     * out from under anyone else using it — run the suite against the in-process store, or give it
     * its own project.
     */
    async reset() {
      if (!ENV.devTesterEnabled) {
        throw new Error('reset refused: DEV_TESTER_ENABLED is false');
      }
      for (const table of RESET_ORDER) {
        try {
          await call(`${table}?id=not.is.null`, { method: 'DELETE' });
        } catch (err) {
          // A table absent from this project is not a reason to abort the whole reset.
          if (!/PGRST205|does not exist/i.test(err.message)) throw err;
        }
      }
    },

    async counts() {
      const out = {};
      for (const t of ['profiles', 'caregiver_profiles', 'care_requests', 'job_requests', 'jobs']) {
        try {
          out[t] = (await call(`${t}?select=id`))?.length ?? 0;
        } catch {
          out[t] = 'unavailable';
        }
      }
      return out;
    },
  };
}

/** Are the migrations applied? Used by the health endpoint so the answer is observed, not assumed. */
export async function supabaseSchemaReady() {
  try {
    await call('profiles?select=id&limit=1');
    return true;
  } catch {
    return false;
  }
}
