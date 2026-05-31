import { useState, useEffect, useCallback } from 'react';
import type { SurveillanceEvent, SystemState, CameraInfo, DashboardConfig } from '../types';

const API_BASE_URL = "http://192.168.0.108:5000/api";

const DEFAULT_CAMERAS: CameraInfo[] = [
    { id: 'cam1', name: 'Main Gate',    location: 'Ground floor main gate & street entrance',     enabled: true, motion_threshold: 8.5, status: 'online', lastActivity: '—' },
    { id: 'cam2', name: 'Ground Floor', location: 'Front door & staircase to first floor',        enabled: true, motion_threshold: 7.0, status: 'online', lastActivity: '—' },
    { id: 'cam3', name: 'First Floor',  location: 'Main door, balcony & staircase to 2nd floor', enabled: true, motion_threshold: 7.0, status: 'online', lastActivity: '—' },
];

const DEFAULT_CONFIG: DashboardConfig = {
    cameras: DEFAULT_CAMERAS.map(c => ({ id: c.id, name: c.name, location: c.location, enabled: c.enabled, motion_threshold: c.motion_threshold })),
    monitoring: { active: true, scan_interval_sec: 15, min_alert_gap_sec: 60, active_hours: [6, 23], night_mode: false, event_log_keep_days: 90 },
    ntfy:   { enabled: true, server: 'https://ntfy.sh', topic: 'guna-home-cams' },
    gemini: { model: 'gemini-2.5-flash', temperature: 0.4 },
    family_members: [],
};

export function useSurveillance() {
    const [events, setEvents]           = useState<SurveillanceEvent[]>([]);
    const [systemState, setSystemState] = useState<SystemState>({ status: 'Active', snooze_until: null });
    const [loading, setLoading]         = useState(true);
    const [connected, setConnected]     = useState(false);
    const [cameras, setCameras]         = useState<CameraInfo[]>(DEFAULT_CAMERAS);
    const [config, setConfig]           = useState<DashboardConfig>(DEFAULT_CONFIG);

    const fetchSystemData = useCallback(async () => {
        try {
            const [eventsRes, statusRes, configRes] = await Promise.all([
                fetch(`${API_BASE_URL}/events`),
                fetch(`${API_BASE_URL}/status`),
                fetch(`${API_BASE_URL}/config`),
            ]);

            if (eventsRes.ok) setEvents(await eventsRes.json());
            if (statusRes.ok) setSystemState(await statusRes.json());

            if (configRes.ok) {
                const cfg: DashboardConfig = await configRes.json();
                setConfig(cfg);
                setCameras(cfg.cameras.map(c => ({
                    ...c,
                    status: c.enabled ? 'online' as const : 'offline' as const,
                    lastActivity: '—',
                })));
            }

            setConnected(true);
        } catch {
            setConnected(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchSystemData();
        const iv = setInterval(fetchSystemData, 5000);
        return () => clearInterval(iv);
    }, [fetchSystemData]);

    const toggleSystemPower = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/toggle`, { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                setSystemState(prev => ({ ...prev, status: data.status }));
            }
        } catch {
            setSystemState(prev => ({ ...prev, status: prev.status === 'Active' ? 'Off' : 'Active' }));
        }
    };

    const updateConfig = async (updates: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> => {
        try {
            const res = await fetch(`${API_BASE_URL}/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            const data = await res.json();
            if (res.ok) { await fetchSystemData(); return { ok: true, message: data.message }; }
            return { ok: false, message: data.error };
        } catch {
            return { ok: false, message: 'Failed to reach server' };
        }
    };

    const purgeEvents = async (days = 7): Promise<{ ok: boolean; removed?: number; message?: string }> => {
        try {
            const res = await fetch(`${API_BASE_URL}/events/purge`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days }),
            });
            const data = await res.json();
            if (res.ok) { await fetchSystemData(); return { ok: true, removed: data.removed }; }
            return { ok: false, message: data.error };
        } catch {
            return { ok: false, message: 'Failed to reach server' };
        }
    };

    const sendFamilyAlert = async (message?: string): Promise<{ ok: boolean; message?: string }> => {
        try {
            const res = await fetch(`${API_BASE_URL}/alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: 'Home Guard Family Alert',
                    message: message || '🚨 Manual alert from Home Guard dashboard',
                }),
            });
            const data = await res.json();
            return { ok: res.ok, message: data.message || data.error };
        } catch {
            return { ok: false, message: 'Failed to reach server' };
        }
    };

    return {
        events, systemState, loading, connected, cameras, config,
        toggleSystemPower, updateConfig, purgeEvents, sendFamilyAlert,
    };
}