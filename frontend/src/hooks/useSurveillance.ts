import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type {
    SurveillanceEvent, SystemState, CameraInfo, DashboardConfig, PriorityLevel,
} from '../types';

/* ── Supabase row shape (table: public.events) ── */
interface DbEvent {
    id: number;
    event_id: string | null;
    camera_id: string | null;
    camera: string | null;
    event: string | null;
    priority: string | null;
    message_en: string | null;
    message_te: string | null;
    person_en: string | null;
    person_te: string | null;
    confidence: number | null;
    snapshot_url: string | null;
    night: boolean | null;
    created_at: string;
}

const DEFAULT_CONFIG: DashboardConfig = {
    cameras: [],
    monitoring: { active: true, scan_interval_sec: 15, min_alert_gap_sec: 60, active_hours: [0, 23], night_mode: false, event_log_keep_days: 90 },
    ntfy:   { enabled: true, server: 'https://ntfy.sh', topic: '' },
    gemini: { model: 'gemini-2.5-flash', temperature: 0.4 },
    family_members: [],
};

function fmtTime(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

function mapEvent(r: DbEvent): SurveillanceEvent {
    const pr = (['safe', 'warning', 'urgent'].includes(r.priority || '') ? r.priority : 'safe') as PriorityLevel;
    return {
        id: r.id,
        timestamp: fmtTime(r.created_at),
        camera: r.camera || r.camera_id || 'Camera',
        priority: pr,
        message: r.message_en || r.event || 'Activity detected',
        message_te: r.message_te || undefined,
        person: r.person_en || undefined,
        confidence: r.confidence ?? undefined,
        hazard: pr === 'urgent',
        family: null,
        snapshot_url: r.snapshot_url || undefined,
    };
}

export function useSurveillance() {
    const [events, setEvents]           = useState<SurveillanceEvent[]>([]);
    const [config, setConfig]           = useState<DashboardConfig>(DEFAULT_CONFIG);
    const [cameras, setCameras]         = useState<CameraInfo[]>([]);
    const [systemState, setSystemState] = useState<SystemState>({ status: 'Active', snooze_until: null });
    const [loading, setLoading]         = useState(true);
    const [connected, setConnected]     = useState(false);
    const cfgRef = useRef<DashboardConfig>(DEFAULT_CONFIG);

    const applyConfig = useCallback((cfg: DashboardConfig) => {
        cfgRef.current = cfg;
        setConfig(cfg);
        setCameras((cfg.cameras || []).map(c => ({
            ...c,
            status: c.enabled ? 'online' as const : 'offline' as const,
            lastActivity: '—',
        })));
        setSystemState({ status: cfg.monitoring?.active === false ? 'Off' : 'Active', snooze_until: null });
    }, []);

    const loadConfig = useCallback(async () => {
        const { data, error } = await supabase.from('config').select('data').eq('id', 1).maybeSingle();
        if (!error && data?.data) applyConfig({ ...DEFAULT_CONFIG, ...(data.data as DashboardConfig) });
    }, [applyConfig]);

    const loadEvents = useCallback(async () => {
        const { data, error } = await supabase
            .from('events').select('*').order('created_at', { ascending: false }).limit(500);
        if (!error && data) setEvents((data as DbEvent[]).map(mapEvent));
    }, []);

    // Initial load + realtime subscription (+ polling fallback)
    useEffect(() => {
        let active = true;
        (async () => {
            await Promise.all([loadEvents(), loadConfig()]);
            if (active) { setConnected(true); setLoading(false); }
            // Realtime evaluates RLS with the socket's token — make sure it's ours,
            // otherwise is_member() is false and no rows are delivered.
            const { data: { session } } = await supabase.auth.getSession();
            if (session) supabase.realtime.setAuth(session.access_token);
        })();

        // Unique channel name avoids a StrictMode double-mount collision in dev.
        const channel = supabase
            .channel(`events-stream-${Math.random().toString(36).slice(2)}`)
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' },
                payload => setEvents(prev => {
                    const ev = mapEvent(payload.new as DbEvent);
                    if (prev.some(e => e.id === ev.id)) return prev;
                    return [ev, ...prev].slice(0, 500);
                }))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'config' },
                () => loadConfig())
            .subscribe(status => console.log('[realtime]', status));

        // Safety net: refetch every 10s so the log updates even if the socket is blocked.
        const poll = setInterval(() => { loadEvents(); }, 10000);

        return () => { active = false; clearInterval(poll); supabase.removeChannel(channel); };
    }, [loadEvents, loadConfig]);

    const writeConfig = useCallback(async (next: DashboardConfig) => {
        const { error } = await supabase.from('config')
            .update({ data: next, updated_at: new Date().toISOString() }).eq('id', 1);
        if (error) return { ok: false, message: error.message };
        applyConfig(next);
        return { ok: true };
    }, [applyConfig]);

    const toggleSystemPower = async () => {
        const cur = cfgRef.current;
        const next: DashboardConfig = {
            ...cur, monitoring: { ...cur.monitoring, active: cur.monitoring?.active === false },
        };
        await writeConfig(next);
    };

    const updateConfig = async (updates: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> => {
        const cur = cfgRef.current;
        const u = updates as Partial<DashboardConfig>;
        const next: DashboardConfig = {
            ...cur,
            monitoring: { ...cur.monitoring, ...(u.monitoring || {}) },
            ntfy:       { ...cur.ntfy,       ...(u.ntfy || {}) },
            notifications: {
                languages: ['en', 'te'], attach_snapshot: true,
                ...(cur.notifications || {}), ...(u.notifications || {}),
            },
            cameras:    u.cameras
                ? cur.cameras.map(c => {
                    const upd = (u.cameras as DashboardConfig['cameras']).find(x => x.id === c.id);
                    return upd ? { ...c, ...upd } : c;
                })
                : cur.cameras,
        };
        const r = await writeConfig(next);
        return r.ok ? { ok: true, message: 'Settings saved.' } : r;
    };

    const purgeEvents = async (days = 7): Promise<{ ok: boolean; removed?: number; message?: string }> => {
        const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
        const { error } = await supabase.from('events').delete().lt('created_at', cutoff);
        if (error) return { ok: false, message: error.message };
        await loadEvents();
        return { ok: true };
    };

    const sendFamilyAlert = async (message?: string): Promise<{ ok: boolean; message?: string }> => {
        const { error } = await supabase.rpc('raise_alert', {
            p_message: message || '🚨 Manual alert from the family dashboard',
        });
        if (error) return { ok: false, message: error.message };
        return { ok: true, message: 'Alert raised for everyone.' };
    };

    return {
        events, systemState, loading, connected, cameras, config,
        toggleSystemPower, updateConfig, purgeEvents, sendFamilyAlert,
    };
}