import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export type Role = 'owner' | 'editor' | 'viewer';

export interface Member {
    id: string;
    name: string;
    role: Role;
}

export interface AuthApi {
    loading: boolean;
    member: Member | null;
    role: Role | null;
    unlocked: boolean;
    inviteToken: string | null;
    error: string | null;
    bootstrapOwner: (name: string, pin: string) => Promise<{ ok: boolean; message?: string }>;
    claimInvite:    (pin: string)                => Promise<{ ok: boolean; message?: string }>;
    unlock:         (pin: string)                => Promise<{ ok: boolean; message?: string }>;
    lock:           ()                           => void;
}

function readInviteToken(): string | null {
    return new URLSearchParams(window.location.search).get('invite');
}

export function useAuth(): AuthApi {
    const [loading, setLoading]   = useState(true);
    const [member, setMember]     = useState<Member | null>(null);
    const [unlocked, setUnlocked] = useState(false);
    const [inviteToken, setInvite] = useState<string | null>(readInviteToken());
    const [error, setError]       = useState<string | null>(null);

    const loadMember = useCallback(async (): Promise<Member | null> => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;
        const { data, error } = await supabase
            .from('members')
            .select('id, name, role')
            .eq('user_id', user.id)
            .maybeSingle();
        if (error) { console.error('member load error', error); return null; }
        return (data as Member) ?? null;
    }, []);

    // On mount: ensure a session (anonymous if needed), then look up membership.
    useEffect(() => {
        let active = true;
        (async () => {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) {
                const { error: signErr } = await supabase.auth.signInAnonymously();
                if (signErr) {
                    if (active) {
                        setError('Could not connect. Check your internet or the invite link.');
                        setLoading(false);
                    }
                    return;
                }
            }
            const m = await loadMember();
            if (active) { setMember(m); setUnlocked(false); setLoading(false); }
        })();
        return () => { active = false; };
    }, [loadMember]);

    const bootstrapOwner = useCallback(async (name: string, pin: string) => {
        const { error } = await supabase.rpc('bootstrap_owner', { p_name: name, p_pin: pin });
        if (error) return { ok: false, message: error.message };
        setMember(await loadMember()); setUnlocked(true); setError(null);
        return { ok: true };
    }, [loadMember]);

    const claimInvite = useCallback(async (pin: string) => {
        if (!inviteToken) return { ok: false, message: 'No invite link found.' };
        const { error } = await supabase.rpc('claim_invite', { p_token: inviteToken, p_pin: pin });
        if (error) return { ok: false, message: error.message };
        setMember(await loadMember()); setUnlocked(true); setInvite(null); setError(null);
        window.history.replaceState({}, '', window.location.pathname); // drop ?invite=… from URL
        return { ok: true };
    }, [inviteToken, loadMember]);

    const unlock = useCallback(async (pin: string) => {
        const { data, error } = await supabase.rpc('verify_pin', { p_pin: pin });
        if (error) return { ok: false, message: error.message };
        if (data === true) { setUnlocked(true); return { ok: true }; }
        return { ok: false, message: 'Wrong PIN. Try again.' };
    }, []);

    const lock = useCallback(() => setUnlocked(false), []);

    return {
        loading, member, role: member?.role ?? null, unlocked, inviteToken, error,
        bootstrapOwner, claimInvite, unlock, lock,
    };
}  