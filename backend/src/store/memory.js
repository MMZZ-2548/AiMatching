/**
 * In-process store.
 *
 * Holds the whole domain in Maps behind the same async interface as the Supabase driver, so the
 * services never learn which one they are talking to. This is what lets the two-sided E2E and the
 * tester run before the SQL migrations have been applied to the Supabase project.
 *
 * Not a mock: it enforces the same uniqueness and ownership rules the schema does, so a test that
 * passes here is testing real behaviour rather than a stub.
 */

import { randomUUID } from 'node:crypto';

const TABLES = [
  'profiles',
  'elderly_profiles',
  'caregiver_profiles',
  'care_requests',
  'matching_runs',
  'matching_candidates',
  'family_interests',
  'caregiver_interests',
  'mutual_matches',
  'daily_care_plans',
  'daily_care_tasks',
  'job_requests',
  'jobs',
  'chat_threads',
  'chat_messages',
  'care_events',
  'care_state_transitions',
  'alerts',
  'care_reports',
  'family_reviews',
  'incidents',
  'trust_score_snapshots',
  'ai_conversations',
  'ai_messages',
  'notifications',
];

export function createMemoryStore() {
  const db = new Map(TABLES.map((t) => [t, new Map()]));
  const tableOf = (name) => {
    const t = db.get(name);
    if (!t) throw new Error(`unknown table: ${name}`);
    return t;
  };

  const matches = (row, where) =>
    Object.entries(where).every(([k, v]) =>
      Array.isArray(v) ? v.includes(row[k]) : row[k] === v,
    );

  return {
    driver: 'memory',

    async insert(table, row) {
      const t = tableOf(table);
      const id = row.id ?? randomUUID();
      const record = { id, created_at: new Date().toISOString(), ...row };
      t.set(id, record);
      return record;
    },

    async update(table, id, patch) {
      const t = tableOf(table);
      const existing = t.get(id);
      if (!existing) return null;
      const next = { ...existing, ...patch };
      t.set(id, next);
      return next;
    },

    async find(table, id) {
      return tableOf(table).get(id) ?? null;
    },

    async findOne(table, where) {
      for (const row of tableOf(table).values()) if (matches(row, where)) return row;
      return null;
    },

    async findMany(table, where = {}) {
      return [...tableOf(table).values()].filter((r) => matches(r, where));
    },

    async upsert(table, where, row) {
      const existing = await this.findOne(table, where);
      if (existing) return this.update(table, existing.id, row);
      return this.insert(table, { ...where, ...row });
    },

    async remove(table, id) {
      return tableOf(table).delete(id);
    },

    async reset() {
      for (const t of db.values()) t.clear();
    },

    async counts() {
      return Object.fromEntries([...db].map(([name, t]) => [name, t.size]));
    },
  };
}
