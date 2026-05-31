// src/types/index.ts

export type PriorityLevel = 'safe' | 'warning' | 'urgent';

export interface SurveillanceEvent {
    id: number;
    timestamp: string;
    camera: string;
    priority: PriorityLevel;
    message: string;
    hazard: boolean;
    family: string | null;
    snapshot_url?: string;
}

export interface CameraInfo {
    id: string;
    name: string;
    location: string;
    enabled: boolean;
    motion_threshold: number;
    status: 'online' | 'offline' | 'recording';
    lastActivity?: string;
}

export interface SystemState {
    status: 'Active' | 'Off';
    snooze_until: string | null;
}

export interface DashboardConfig {
    cameras: { id: string; name: string; location: string; enabled: boolean; motion_threshold: number }[];
    monitoring: {
        active: boolean;
        scan_interval_sec: number;
        min_alert_gap_sec: number;
        active_hours: [number, number];
        night_mode: boolean;
        event_log_keep_days: number;
    };
    ntfy: {
        enabled: boolean;
        server: string;
        topic: string;
    };
    gemini: {
        model: string;
        temperature: number;
    };
    family_members: string[];
}
