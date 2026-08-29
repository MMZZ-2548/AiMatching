import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

export const ENV = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.NODE_PORT ?? 3000),
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',

  pythonAiUrl: process.env.PYTHON_AI_URL ?? 'http://localhost:8000',
  pythonAiInternalKey: process.env.PYTHON_AI_INTERNAL_KEY ?? '',

  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',

  /**
   * 'memory' keeps the whole domain in process; 'supabase' persists through PostgREST.
   * Memory is the default so the tester and the E2E suite run before the migrations in
   * db/migrations have been applied — applying them needs a database password or a management
   * token, neither of which the service key provides.
   */
  store: process.env.STORE ?? 'memory',

  devTesterEnabled: (process.env.DEV_TESTER_ENABLED ?? 'true') === 'true',

  scoreVersion: process.env.MATCHING_SCORE_VERSION ?? 'matching-v4',
  trustVersion: process.env.TRUST_SCORE_VERSION ?? 'trust-v4',
  realtimeRuleVersion: process.env.REALTIME_RULE_VERSION ?? 'realtime-v4',
  weightVersion: process.env.WEIGHT_PROFILE_VERSION ?? 'weights-v4-default',

  chatUnlockStage: process.env.CHAT_UNLOCK_STAGE ?? 'MUTUAL_MATCH',
};

/** Never log a secret (V4 §5). This reports only whether each one is present. */
export function envReport() {
  const present = (v) => (v ? 'set' : 'MISSING');
  return {
    node_env: ENV.nodeEnv,
    store: ENV.store,
    dev_tester_enabled: ENV.devTesterEnabled,
    OPENAI_API_KEY: present(process.env.OPENAI_API_KEY),
    SUPABASE_URL: present(ENV.supabaseUrl),
    SUPABASE_PUBLISHABLE_KEY: present(ENV.supabasePublishableKey),
    SUPABASE_SECRET_KEY: present(ENV.supabaseSecretKey),
    PYTHON_AI_INTERNAL_KEY: present(ENV.pythonAiInternalKey),
    score_version: ENV.scoreVersion,
    weight_version: ENV.weightVersion,
    trust_version: ENV.trustVersion,
    realtime_rule_version: ENV.realtimeRuleVersion,
  };
}
