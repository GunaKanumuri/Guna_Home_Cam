import { useMemo, useState } from 'react';
import type { SurveillanceEvent, SystemState, CameraInfo } from '../../types';

interface Props {
    events: SurveillanceEvent[];
    systemState: SystemState;
    cameras: CameraInfo[];
    connected: boolean;
    onSendAlert: (message?: string) => Promise<{ ok: boolean; message?: string }>;
}

function eventIcon(event: SurveillanceEvent) {
    if (event.family)                 return '👋';
    if (event.priority === 'urgent')  return '🚨';
    if (event.priority === 'warning') return '👀';
    return '✅';
}

const camStyle: Record<string, { gradient: string; icon: string; dot: string }> = {
    cam1: { gradient: 'from-amber-50 to-orange-50',  icon: '🚪', dot: 'bg-gold-400'    },
    cam2: { gradient: 'from-blue-50 to-indigo-50',   icon: '🏠', dot: 'bg-blue-400'    },
    cam3: { gradient: 'from-emerald-50 to-teal-50',  icon: '🪜', dot: 'bg-emerald-500' },
};

export default function FamilyDashboard({ events, systemState, cameras, connected, onSendAlert }: Props) {
    const recent     = useMemo(() => events.slice(0, 6), [events]);
    const hasUrgent  = recent.some(e => e.priority === 'urgent');
    const isOff      = systemState.status !== 'Active';
    const isSafe     = !isOff && !hasUrgent;
    const onlineCams = cameras.filter(c => c.status !== 'offline').length;
    const [alertStatus, setAlertStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

    return (
        <div className="space-y-7 animate-fade-in">

            {/* Hero Status */}
            <div className={`relative rounded-3xl overflow-hidden p-8 md:p-10 text-center transition-all duration-700 border-2 ${
                isOff  ? 'border-warm-200 bg-warm-50' :
                isSafe ? 'border-gold-200 lux-card-gold' :
                         'border-ruby-border bg-ruby-light'
            }`}>
                {!isOff && isSafe && (
                    <>
                        <div className="absolute top-0 left-0 w-20 h-20 bg-gradient-to-br from-gold-300/10 to-transparent rounded-br-full" />
                        <div className="absolute bottom-0 right-0 w-24 h-24 bg-gradient-to-tl from-gold-300/10 to-transparent rounded-tl-full" />
                    </>
                )}
                <div className="relative z-10">
                    <div className={`w-24 h-24 md:w-28 md:h-28 mx-auto mb-6 rounded-full flex items-center justify-center text-5xl md:text-6xl ${
                        isOff  ? 'bg-warm-100' :
                        isSafe ? 'bg-gradient-to-br from-gold-100 to-amber-100' :
                                 'bg-gradient-to-br from-red-100 to-rose-100 animate-pulse'
                    }`}>
                        <span className={!isOff ? 'animate-float' : ''}>
                            {isOff ? '💤' : isSafe ? '🛡️' : '⚠️'}
                        </span>
                    </div>
                    <h1 className={`text-3xl md:text-4xl font-serif font-bold tracking-tight ${
                        isOff ? 'text-warm-400' : isSafe ? 'text-warm-900' : 'text-ruby'
                    }`}>
                        {isOff ? 'Monitoring is paused' : isSafe ? 'Your Home is Safe' : 'Something needs attention'}
                    </h1>
                    <p className={`mt-3 text-[15px] font-medium ${
                        isOff ? 'text-warm-400' : isSafe ? 'text-warm-500' : 'text-ruby/70'
                    }`}>
                        {isOff    ? 'Tap Start Monitoring to turn on cameras' :
                         isSafe   ? `All ${onlineCams} cameras watching · ${connected ? 'Live feed active' : 'Reconnecting...'}` :
                                    'Check the alerts below for details'}
                    </p>
                </div>
            </div>

            {/* Cameras */}
            <div>
                <div className="flex items-center gap-2 mb-4">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gold-500">
                        <path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>
                    </svg>
                    <h2 className="text-sm font-bold text-warm-800">Cameras</h2>
                    <span className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                        connected ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-warm-50 text-warm-400 border-warm-200'
                    }`}>
                        {connected ? 'LIVE' : 'OFFLINE'}
                    </span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                    {cameras.map((cam, idx) => {
                        const style    = camStyle[cam.id] || camStyle['cam1'];
                        const isOnline = cam.status !== 'offline';
                        return (
                            <div key={cam.id} className={`lux-card p-4 text-center animate-slide-up ${!isOnline ? 'opacity-50' : ''}`}
                                style={{ animationDelay: `${idx * 80}ms` }}>
                                <div className={`w-12 h-12 rounded-2xl mx-auto mb-3 flex items-center justify-center text-2xl bg-gradient-to-br ${style.gradient}`}>
                                    {style.icon}
                                </div>
                                <p className="text-[13px] font-semibold text-warm-800 truncate">{cam.name}</p>
                                <div className="flex items-center justify-center gap-1.5 mt-2">
                                    <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? style.dot : 'bg-warm-300'}`} />
                                    <span className={`text-[10px] font-medium ${isOnline ? 'text-warm-500' : 'text-warm-300'}`}>
                                        {isOnline ? 'Online' : 'Offline'}
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Recent Activity */}
            <div>
                <div className="flex items-center gap-2 mb-4">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gold-500">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    <h2 className="text-sm font-bold text-warm-800">Recent Activity</h2>
                    {events.length > 0 && (
                        <span className="ml-auto text-[10px] font-mono text-warm-400">{events.length} total events</span>
                    )}
                </div>

                <div className="space-y-2.5">
                    {!connected && events.length === 0 ? (
                        <div className="lux-card p-10 text-center">
                            <p className="text-4xl mb-3">📡</p>
                            <p className="text-base font-semibold text-warm-600">Camera phone not connected</p>
                            <p className="text-xs text-warm-400 mt-2 font-mono">
                                Run <span className="bg-warm-100 px-1.5 py-0.5 rounded">python dashboard_api.py</span> on Termux
                            </p>
                        </div>
                    ) : connected && events.length === 0 ? (
                        <div className="lux-card p-10 text-center">
                            <p className="text-4xl mb-3">😴</p>
                            <p className="text-base font-semibold text-warm-600">All quiet, no activity yet</p>
                            <p className="text-xs text-warm-400 mt-1">Events appear here as cameras detect motion</p>
                        </div>
                    ) : (
                        recent.map((event, idx) => (
                            <div key={event.id}
                                className={`lux-card p-4 flex items-start gap-4 relative overflow-hidden animate-slide-up ${
                                    event.priority === 'urgent'  ? '!border-ruby-border !bg-ruby-light' :
                                    event.priority === 'warning' ? '!border-amber-200 !bg-amber-50/50' : ''
                                }`}
                                style={{ animationDelay: `${idx * 50}ms` }}
                            >
                                <div className={`absolute left-0 top-0 bottom-0 w-1 ${
                                    event.priority === 'urgent'  ? 'bg-ruby' :
                                    event.priority === 'warning' ? 'bg-amber-400' : 'bg-gold-300'
                                }`} />
                                <span className="text-2xl shrink-0 ml-1">{eventIcon(event)}</span>
                                <div className="flex-1 min-w-0">
                                    <p className="text-[13px] font-semibold text-warm-800 leading-snug">{event.message}</p>
                                    <p className="text-[11px] text-warm-400 mt-1 font-mono">{event.camera} · {event.timestamp}</p>
                                </div>
                                {event.family && (
                                    <span className="shrink-0 bg-gold-50 text-gold-600 text-[10px] font-bold px-2.5 py-1 rounded-full border border-gold-200">
                                        {event.family}
                                    </span>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* Action Buttons */}
            <div className="space-y-3 pt-1">
                <a href="tel:+917032538448"
                    className="flex items-center justify-center gap-3 w-full rounded-2xl p-5 text-lg font-bold bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white shadow-lg shadow-gold-400/25 active:scale-[0.98] transition-all">
                    📞 Call Guna
                </a>
                <button
                    onClick={async () => {
                        setAlertStatus('sending');
                        const result = await onSendAlert();
                        setAlertStatus(result.ok ? 'sent' : 'error');
                        setTimeout(() => setAlertStatus('idle'), 3000);
                    }}
                    disabled={alertStatus === 'sending' || !connected}
                    className={`w-full lux-card p-4 text-[15px] font-semibold transition-all flex items-center justify-center gap-3 active:scale-[0.98] disabled:opacity-50 ${
                        alertStatus === 'sent'  ? '!border-forest-border !bg-forest-light text-forest' :
                        alertStatus === 'error' ? '!border-ruby-border !bg-ruby-light text-ruby' :
                        'text-warm-600 hover:text-warm-800 hover:border-gold-200'
                    }`}
                >
                    {alertStatus === 'sending' ? '⏳ Sending...' :
                     alertStatus === 'sent'    ? '✓ Alert sent to all family!' :
                     alertStatus === 'error'   ? '✕ Failed, check connection' :
                     !connected               ? '📡 Connect phone to send alerts' :
                                                '🔔 Send alert to family'}
                </button>
            </div>
        </div>
    );
}