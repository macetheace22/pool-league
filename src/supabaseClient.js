import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Surfaces as a visible error in the app rather than a silent failure,
  // since a missing env var here means every dbGet/dbSet will quietly no-op.
  console.error(
    'Missing Supabase env vars. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
    '(in a local .env file for dev, and in your host\'s project settings for deployment).'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
