// src/components/views/Settings.tsx
import { useState, useEffect } from 'react';
import type { DashboardConfig } from '../../types';

interface Props {
    config: DashboardConfig;
    connected: boolean;
    onUpdateConfig: (updates: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
    onPurge: (days?: number) => Promise<{ ok: boolean; removed?: number; message?: string }>;
}

/* ── Toggle Switch ── */
function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            onClick={() => onChange(!on)}
            className="toggle-track"
            data-on={String(on)}
            aria-pressed={on}
        >
            <div className="toggle-thumb" />
        </button>
    );
}

/* ── Section Header ── */
function SectionHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
    return (
        <div className="flex items-center gap-3 mb-4 mt-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-warm-50 to-parchment flex items-center justify-center text-lg border border-warm-100">
                {icon}
            </div>
            <div>
                <h3 className="text-sm font-bold text-warm-800">{title}</h3>
                <p className="text-[10px] text-warm-400">{subtitle}</p>
            </div>
        </div>
    );
}

/* ── Toast Feedback ── */
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
    useEffect(() => {
        const timer = setTimeout(onClose, 3500);
        return () => clearTimeout(timer);
    }, [onClose]);

    return (
        <div className={`fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-semibold animate-slide-up ${
            type === 'success'
                ? 'bg-forest-light text-forest border border-forest-border'
                : 'bg-ruby-light text-ruby border border-ruby-border'
        }`}>
            {type === 'success' ? '✓' : '✕'} {message}
        </div>
    );
}

export default function Settings({ config, connected, onUpdateConfig, onPurge }: Props) {
    // ── Local state initialised from real config ──
    const [nightMode, setNightMode] = useState(config.monitoring.night_mode);
    const [ntfyEnabled, setNtfyEnabled] = useState(config.ntfy.enabled);
    const [sensitivity, setSensitivity] = useState(() => {
        // Map average motion_threshold to 0-100 slider
        // Lower threshold = more sensitive = higher slider value
        const avgThresh = config.cameras.reduce((sum, c) => sum + c.motion_threshold, 0) / Math.max(config.cameras.length, 1);
        // Threshold range: ~5 (very sensitive) to ~12 (not sensitive)
        // Map to slider: 5→100, 12→0
        return Math.round(Math.max(0, Math.min(100, ((12 - avgThresh) / 7) * 100)));
    });

    const [serverUrl, setServerUrl] = useState(() => {
        // Derive from the API base URL
        return "http://192.168.0.108:5000/api";
    });

    const [testingConnection, setTestingConnection] = useState(false);
    const [connectionResult, setConnectionResult] = useState<'success' | 'error' | null>(null);
    const [saving, setSaving] = useState(false);
    const [purging, setPurging] = useState(false);
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    // Sync from config prop when it changes (e.g. after a save)
    useEffect(() => {
        setNightMode(config.monitoring.night_mode);
        setNtfyEnabled(config.ntfy.enabled);
    }, [config]);

    const testConnection = async () => {
        setTestingConnection(true);
        setConnectionResult(null);
        try {
            const res = await fetch(`${serverUrl.replace(/\/api$/, '')}/api/status`, { signal: AbortSignal.timeout(5000) });
            setConnectionResult(res.ok ? 'success' : 'error');
        } catch {
            setConnectionResult('error');
        } finally {
            setTestingConnection(false);
        }
    };

    const handleSaveSettings = async () => {
        setSaving(true);
        // Convert slider (0-100) back to motion threshold (12→5)
        const newThreshold = 12 - (sensitivity / 100) * 7;

        const result = await onUpdateConfig({
            monitoring: {
                night_mode: nightMode,
            },
            ntfy: {
                enabled: ntfyEnabled,
            },
            cameras: config.cameras.map(c => ({
                id: c.id,
                motion_threshold: Math.round(newThreshold * 10) / 10,
            })),
        });

        setSaving(false);
        setToast({
            message: result.ok ? 'Settings saved to Termux ✓' : (result.message || 'Failed to save'),
            type: result.ok ? 'success' : 'error',
        });
    };

    const handlePurge = async () => {
        if (!confirm('Delete all events older than 7 days? This cannot be undone.')) return;
        setPurging(true);
        const result = await onPurge(7);
        setPurging(false);
        setToast({
            message: result.ok ? `Purged ${result.removed} old events` : (result.message || 'Failed to purge'),
            type: result.ok ? 'success' : 'error',
        });
    };

    const sensitivityLabel = sensitivity < 33 ? 'Low' : sensitivity < 66 ? 'Medium' : 'High';
    const sensitivityColor = sensitivity < 33 ? 'text-forest' : sensitivity < 66 ? 'text-gold-500' : 'text-ruby';

    return (
        <div className="animate-fade-in space-y-7">
            {/* Toast notification */}
            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-xl font-serif font-bold text-warm-900 tracking-tight">Settings</h2>
                    <p className="text-sm text-warm-400 mt-1">
                        Changes are saved to <span className="font-mono text-warm-500">config.json</span> on Termux
                    </p>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${connected ? 'bg-forest' : 'bg-warm-300'}`} />
                    <span className={`text-[11px] font-mono ${connected ? 'text-forest' : 'text-warm-400'}`}>
                        {connected ? 'Connected' : 'Offline'}
                    </span>
                </div>
            </div>

            {/* ── Connection ── */}
            <div>
                <SectionHeader icon="🔗" title="Connection" subtitle="Server and network settings" />
                <div className="lux-card p-5 space-y-4">
                    <div>
                        <label className="text-xs font-semibold text-warm-700 block mb-2">Termux Server URL</label>
                        <div className="flex items-center gap-2">
                            <input
                                value={serverUrl}
                                onChange={e => setServerUrl(e.target.value)}
                                className="flex-1 bg-cream border border-warm-200 text-xs font-mono text-warm-700 px-4 py-2.5 rounded-xl outline-none focus:border-gold-300 focus:ring-2 focus:ring-gold-100 transition-all placeholder-warm-300"
                                placeholder="http://192.168.0.108:5000/api"
                            />
                            <button
                                onClick={testConnection}
                                disabled={testingConnection}
                                className="px-4 py-2.5 bg-gold-50 hover:bg-gold-100 border border-gold-200 text-gold-600 text-xs font-semibold rounded-xl transition-all shrink-0 disabled:opacity-50 flex items-center gap-2"
                            >
                                {testingConnection ? (
                                    <>
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin-slow">
                                            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                                        </svg>
                                        Testing...
                                    </>
                                ) : 'Test'}
                            </button>
                        </div>
                        {connectionResult && (
                            <p className={`text-[11px] font-mono mt-2.5 flex items-center gap-1.5 ${
                                connectionResult === 'success' ? 'text-forest' : 'text-ruby'
                            }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${connectionResult === 'success' ? 'bg-forest' : 'bg-ruby'}`} />
                                {connectionResult === 'success' ? 'Connection successful ✓' : 'Connection failed — check URL and server'}
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* ── AI Configuration ── */}
            <div>
                <SectionHeader icon="🤖" title="AI Configuration" subtitle="Threat detection behaviour" />
                <div className="lux-card p-5 space-y-5">
                    {/* Sensitivity slider */}
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <label className="text-xs font-semibold text-warm-700">Threat Sensitivity</label>
                            <span className={`text-xs font-bold ${sensitivityColor}`}>{sensitivityLabel}</span>
                        </div>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={sensitivity}
                            onChange={e => setSensitivity(Number(e.target.value))}
                            className="w-full"
                        />
                        <div className="flex justify-between mt-1.5">
                            <span className="text-[9px] font-mono text-warm-300">Fewer alerts</span>
                            <span className="text-[9px] font-mono text-warm-300">More alerts</span>
                        </div>
                        <p className="text-[10px] text-warm-400 mt-2">
                            Maps to <span className="font-mono text-warm-500">motion_threshold</span> for all cameras
                        </p>
                    </div>

                    <div className="gold-divider" />

                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">Night Mode Detection</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Extra sensitivity between 10 PM – 6 AM</p>
                        </div>
                        <Toggle on={nightMode} onChange={setNightMode} />
                    </div>
                </div>
            </div>

            {/* ── Notifications ── */}
            <div>
                <SectionHeader icon="🔔" title="Notifications" subtitle="Alert delivery preferences" />
                <div className="lux-card divide-y divide-warm-100 overflow-hidden">
                    <div className="p-5 flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">Family Notifications (ntfy)</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">
                                Send alerts via <span className="font-mono">ntfy.sh/{config.ntfy.topic}</span>
                            </p>
                        </div>
                        <Toggle on={ntfyEnabled} onChange={setNtfyEnabled} />
                    </div>
                    <div className="p-5">
                        <div className="flex flex-wrap gap-2 text-[10px] font-mono text-warm-400">
                            <span className="bg-warm-50 px-2 py-1 rounded border border-warm-100">
                                Server: {config.ntfy.server}
                            </span>
                            <span className="bg-warm-50 px-2 py-1 rounded border border-warm-100">
                                Topic: {config.ntfy.topic}
                            </span>
                            <span className="bg-warm-50 px-2 py-1 rounded border border-warm-100">
                                AI Model: {config.gemini.model}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── Save Button ── */}
            <button
                onClick={handleSaveSettings}
                disabled={saving || !connected}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white text-sm font-bold transition-all duration-300 shadow-lg shadow-gold-400/20 hover:shadow-gold-500/25 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                {saving ? (
                    <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin-slow"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" /></svg>
                        Saving to Termux...
                    </>
                ) : (
                    <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
                        Save All Settings to Termux
                    </>
                )}
            </button>
            {!connected && (
                <p className="text-[11px] text-ruby text-center -mt-4">
                    ⚠ Cannot save — not connected to Termux server
                </p>
            )}

            {/* ── Danger Zone ── */}
            <div>
                <SectionHeader icon="⚠️" title="Danger Zone" subtitle="Irreversible actions" />
                <div className="lux-card p-5 !border-ruby-border">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-800 flex items-center gap-2">
                                Clear Old Logs
                                <span className="text-[9px] font-mono bg-ruby-light text-ruby border border-ruby-border px-1.5 py-0.5 rounded">DESTRUCTIVE</span>
                            </p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Delete events older than 7 days from Termux</p>
                        </div>
                        <button
                            onClick={handlePurge}
                            disabled={purging || !connected}
                            className="px-4 py-2 rounded-xl border border-ruby-border text-ruby text-xs font-semibold hover:bg-ruby-light transition-all shrink-0 active:scale-[0.97] disabled:opacity-50 flex items-center gap-2"
                        >
                            {purging ? (
                                <>
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="animate-spin-slow"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" /></svg>
                                    Purging...
                                </>
                            ) : 'Purge Now'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Spacer for mobile bottom nav */}
            <div className="h-6" />
        </div>
    );
}
