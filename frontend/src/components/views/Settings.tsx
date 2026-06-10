// src/components/views/Settings.tsx
import { useState, useEffect } from 'react';
import type { DashboardConfig } from '../../types';

interface Props {
    config: DashboardConfig;
    connected: boolean;
    onUpdateConfig: (updates: Record<string, unknown>) => Promise<{ ok: boolean; message?: string }>;
    onPurge: (days?: number) => Promise<{ ok: boolean; removed?: number; message?: string }>;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
    return (
        <button onClick={() => onChange(!on)} className="toggle-track" data-on={String(on)} aria-pressed={on}>
            <div className="toggle-thumb" />
        </button>
    );
}

function SectionHeader({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
    return (
        <div className="flex items-center gap-3 mb-4 mt-1">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-warm-50 to-parchment flex items-center justify-center text-lg border border-warm-100">{icon}</div>
            <div>
                <h3 className="text-sm font-bold text-warm-800">{title}</h3>
                <p className="text-[10px] text-warm-400">{subtitle}</p>
            </div>
        </div>
    );
}

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
    useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
    return (
        <div className={`fixed bottom-24 md:bottom-8 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-semibold animate-slide-up ${
            type === 'success' ? 'bg-forest-light text-forest border border-forest-border' : 'bg-ruby-light text-ruby border border-ruby-border'}`}>
            {type === 'success' ? '✓' : '✕'} {message}
        </div>
    );
}

export default function Settings({ config, connected, onUpdateConfig, onPurge }: Props) {
    const [nightMode, setNightMode]     = useState(config.monitoring.night_mode);
    const [ntfyEnabled, setNtfyEnabled] = useState(config.ntfy.enabled);
    const [telugu, setTelugu]           = useState((config.notifications?.languages || ['en', 'te']).includes('te'));
    const [diffPerson, setDiffPerson]   = useState(config.monitoring.alert_on_description_change ?? true);
    const [sensitivity, setSensitivity] = useState(() => {
        const avg = config.cameras.reduce((s, c) => s + c.motion_threshold, 0) / Math.max(config.cameras.length, 1);
        return Math.round(Math.max(0, Math.min(100, ((12 - avg) / 7) * 100)));
    });

    const [saving, setSaving]   = useState(false);
    const [purging, setPurging] = useState(false);
    const [toast, setToast]     = useState<{ message: string; type: 'success' | 'error' } | null>(null);

    useEffect(() => {
        setNightMode(config.monitoring.night_mode);
        setNtfyEnabled(config.ntfy.enabled);
        setTelugu((config.notifications?.languages || ['en', 'te']).includes('te'));
        setDiffPerson(config.monitoring.alert_on_description_change ?? true);
    }, [config]);

    const save = async () => {
        setSaving(true);
        const newThreshold = Math.round((12 - (sensitivity / 100) * 7) * 10) / 10;
        const r = await onUpdateConfig({
            monitoring: { night_mode: nightMode, alert_on_description_change: diffPerson },
            ntfy: { enabled: ntfyEnabled },
            notifications: { languages: telugu ? ['en', 'te'] : ['en'] },
            cameras: config.cameras.map(c => ({ id: c.id, motion_threshold: newThreshold })),
        });
        setSaving(false);
        setToast({ message: r.ok ? 'Settings saved' : (r.message || 'Failed to save'), type: r.ok ? 'success' : 'error' });
    };

    const purge = async () => {
        if (!confirm('Delete all events older than 7 days? This cannot be undone.')) return;
        setPurging(true);
        const r = await onPurge(7);
        setPurging(false);
        setToast({ message: r.ok ? 'Old events cleared' : (r.message || 'Failed'), type: r.ok ? 'success' : 'error' });
    };

    const sLabel = sensitivity < 33 ? 'Low' : sensitivity < 66 ? 'Medium' : 'High';
    const sColor = sensitivity < 33 ? 'text-forest' : sensitivity < 66 ? 'text-gold-500' : 'text-ruby';

    return (
        <div className="animate-fade-in space-y-7">
            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-xl font-serif font-bold text-warm-900 tracking-tight">Settings</h2>
                    <p className="text-sm text-warm-400 mt-1">Preferences for your home cameras and alerts</p>
                </div>
                <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${connected ? 'bg-forest' : 'bg-warm-300'}`} />
                    <span className={`text-[11px] font-mono ${connected ? 'text-forest' : 'text-warm-400'}`}>{connected ? 'Synced' : 'Offline'}</span>
                </div>
            </div>

            <div className="lux-card px-4 py-3 text-[11px] text-warm-500 leading-relaxed border-gold-100">
                ℹ️ Changes save to your home settings instantly. Detection behaviour (sensitivity, night mode, alert grouping) takes effect the next time your cameras sync.
            </div>

            {/* Languages */}
            <div>
                <SectionHeader icon="🌐" title="Language" subtitle="Notification & dashboard languages" />
                <div className="lux-card divide-y divide-warm-100 overflow-hidden">
                    <div className="p-5 flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">English</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Always on</p>
                        </div>
                        <span className="text-[10px] font-mono text-warm-300">default</span>
                    </div>
                    <div className="p-5 flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">తెలుగు (Telugu)</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Add a Telugu line to every alert</p>
                        </div>
                        <Toggle on={telugu} onChange={setTelugu} />
                    </div>
                </div>
            </div>

            {/* AI / detection */}
            <div>
                <SectionHeader icon="🤖" title="Detection" subtitle="How alerts are decided" />
                <div className="lux-card p-5 space-y-5">
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <label className="text-xs font-semibold text-warm-700">Motion Sensitivity</label>
                            <span className={`text-xs font-bold ${sColor}`}>{sLabel}</span>
                        </div>
                        <input type="range" min="0" max="100" value={sensitivity} onChange={e => setSensitivity(Number(e.target.value))} className="w-full" />
                        <div className="flex justify-between mt-1.5">
                            <span className="text-[9px] font-mono text-warm-300">Fewer alerts</span>
                            <span className="text-[9px] font-mono text-warm-300">More alerts</span>
                        </div>
                    </div>
                    <div className="gold-divider" />
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">Night Mode</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Extra sensitivity between 10 PM – 6 AM</p>
                        </div>
                        <Toggle on={nightMode} onChange={setNightMode} />
                    </div>
                    <div className="gold-divider" />
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">Alert on a different person</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Re-alert immediately if someone new appears during ongoing activity</p>
                        </div>
                        <Toggle on={diffPerson} onChange={setDiffPerson} />
                    </div>
                </div>
            </div>

            {/* Notifications */}
            <div>
                <SectionHeader icon="🔔" title="Notifications" subtitle="Phone alert delivery" />
                <div className="lux-card divide-y divide-warm-100 overflow-hidden">
                    <div className="p-5 flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-700">Push alerts (ntfy)</p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Send alerts via <span className="font-mono">ntfy.sh/{config.ntfy.topic}</span></p>
                        </div>
                        <Toggle on={ntfyEnabled} onChange={setNtfyEnabled} />
                    </div>
                    <div className="p-5">
                        <div className="flex flex-wrap gap-2 text-[10px] font-mono text-warm-400">
                            <span className="bg-warm-50 px-2 py-1 rounded border border-warm-100">Topic: {config.ntfy.topic || '—'}</span>
                            <span className="bg-warm-50 px-2 py-1 rounded border border-warm-100">AI: {config.gemini.model}</span>
                        </div>
                    </div>
                </div>
            </div>

            <button onClick={save} disabled={saving}
                className="w-full py-3.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white text-sm font-bold transition-all duration-300 shadow-lg shadow-gold-400/20 active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2">
                {saving ? 'Saving…' : 'Save settings'}
            </button>

            {/* Danger zone */}
            <div>
                <SectionHeader icon="⚠️" title="Danger Zone" subtitle="Irreversible actions" />
                <div className="lux-card p-5 !border-ruby-border">
                    <div className="flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs font-semibold text-warm-800 flex items-center gap-2">
                                Clear Old Logs
                                <span className="text-[9px] font-mono bg-ruby-light text-ruby border border-ruby-border px-1.5 py-0.5 rounded">DESTRUCTIVE</span>
                            </p>
                            <p className="text-[10px] text-warm-400 mt-0.5">Delete detections older than 7 days</p>
                        </div>
                        <button onClick={purge} disabled={purging}
                            className="px-4 py-2 rounded-xl border border-ruby-border text-ruby text-xs font-semibold hover:bg-ruby-light transition-all shrink-0 active:scale-[0.97] disabled:opacity-50">
                            {purging ? 'Purging…' : 'Purge Now'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="h-6" />
        </div>
    );
}