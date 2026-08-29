import { ENV } from '../lib/env.js';
import { createMemoryStore } from './memory.js';
import { createSupabaseStore, supabaseSchemaReady } from './supabase.js';

export const store = ENV.store === 'supabase' ? createSupabaseStore() : createMemoryStore();
export { supabaseSchemaReady };
