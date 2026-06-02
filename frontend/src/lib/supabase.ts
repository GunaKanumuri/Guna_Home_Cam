import { createClient } from '@supabase/supabase-js';

const url     = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
    // Loud, clear error in dev instead of a cryptic runtime crash later
    console.error(
        'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
        'Copy .env.example to .env and fill in your project values.'
    );
}

export const supabase = createClient(url, anonKey, {
    auth: {
        persistSession: true,      // keep the (anonymous) session on this device
        autoRefreshToken: true,
        detectSessionInUrl: false,
    },
});