// src/App.tsx
import { useState, useEffect } from 'react';
import { useSurveillance } from './hooks/useSurveillance';
import { useAuthContext } from './auth/AuthContext';
import type { Role } from './hooks/useAuth';
import LiveFeed from './components/views/LiveFeed';
import FamilyDashboard from './components/views/FamilyDashboard';
import AccessControl from './components/views/AccessControl';
import Settings from './components/views/Settings';

type View = 'family' | 'feed' | 'access' | 'settings';

const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

/* ── Inline SVG Icons ── */
function IconShield({ className = '' }: { className?: string }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
    );
}
function IconCamera({ className = '' }: { className?: string }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 7l-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
    );
}
function IconUsers({ className = '' }: { className?: string }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
        </svg>
    );
}
function IconSettings({ className = '' }: { className?: string }) {
    return (
        <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
        </svg>
    );
}

export default function App() {
    const { events, systemState, connected, cameras, config, toggleSystemPower, updateConfig, purgeEvents, sendFamilyAlert } = useSurveillance();
    const { role, member, lock } = useAuthContext();
    const [activeView, setActiveView] = useState<View>('family');
    const [clock, setClock] = useState('');

    const myRank   = ROLE_RANK[role ?? 'viewer'];
    const canManage = myRank >= ROLE_RANK.editor;   // editor/owner can pause + edit settings

    const urgentCount = events.filter(e => e.priority === 'urgent').length;

    // Live clock
    useEffect(() => {
        const tick = () => {
            const now = new Date();
            setClock(now.toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', hour12: true,
            }));
        };
        tick();
        const id = setInterval(tick, 30_000);
        return () => clearInterval(id);
    }, []);

    const navItems: { id: View; label: string; desc: string; icon: typeof IconShield; minRole: Role }[] = [
        { id: 'family',   label: 'Home',       desc: 'Safety at a glance',   icon: IconShield,   minRole: 'viewer' },
        { id: 'feed',     label: 'Camera Log', desc: 'All detections',       icon: IconCamera,   minRole: 'viewer' },
        { id: 'settings', label: 'Settings',   desc: 'Preferences',          icon: IconSettings, minRole: 'editor' },
        { id: 'access',   label: 'Devices',    desc: 'Access control',       icon: IconUsers,    minRole: 'owner'  },
    ];
    const visibleNav = navItems.filter(n => myRank >= ROLE_RANK[n.minRole]);
    const firstAdminId = visibleNav.find(n => n.minRole !== 'viewer')?.id;

    return (
        <div className="h-full flex flex-col md:flex-row bg-luxury font-sans">

            {/* ── Desktop Sidebar ── */}
            <aside className="hidden md:flex w-[260px] flex-col shrink-0 bg-white border-r border-warm-100">

                {/* Brand */}
                <div className="p-6 pb-5">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-lg shadow-gold-400/20">
                            <IconShield className="text-white" />
                        </div>
                        <div>
                            <h1 className="text-[17px] font-serif font-bold text-warm-900 tracking-tight">Guna's Home Cam</h1>
                            <p className="text-[11px] text-warm-400 font-medium tracking-wide">AI SECURITY</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4 px-1">
                        <span className="relative flex h-2 w-2">
                            {connected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-forest opacity-50" />}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${connected ? 'bg-forest' : 'bg-warm-300'}`} />
                        </span>
                        <span className="text-[11px] text-warm-400 font-medium">
                            {connected ? 'System connected' : 'Offline mode'}
                        </span>
                    </div>
                </div>

                <div className="gold-divider mx-5" />

                {/* Nav */}
                <nav className="flex-1 px-3 pt-4 space-y-0.5">
                    {visibleNav.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeView === item.id;
                        return (
                            <div key={item.id}>
                                {item.id === firstAdminId && (
                                    <p className="text-[10px] font-semibold text-warm-300 uppercase tracking-[0.15em] px-3 pt-5 pb-2">
                                        Admin
                                    </p>
                                )}
                                <button
                                    onClick={() => setActiveView(item.id)}
                                    className={`relative w-full text-left px-3 py-2.5 rounded-xl transition-all duration-200 flex items-center gap-3 group ${
                                        isActive
                                            ? 'bg-gold-50 text-warm-900'
                                            : 'text-warm-500 hover:bg-warm-50 hover:text-warm-700'
                                    }`}
                                >
                                    {isActive && <div className="nav-gold-indicator" />}
                                    <Icon className={isActive ? 'text-gold-500' : 'text-warm-400 group-hover:text-warm-500'} />
                                    <div className="min-w-0">
                                        <p className={`text-[13px] font-semibold leading-none ${isActive ? 'text-warm-900' : ''}`}>
                                            {item.label}
                                        </p>
                                        <p className={`text-[10px] mt-0.5 ${isActive ? 'text-gold-500' : 'text-warm-300'}`}>{item.desc}</p>
                                    </div>
                                    {item.id === 'feed' && urgentCount > 0 && (
                                        <span className="ml-auto shrink-0 bg-ruby text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center animate-pulse">
                                            {urgentCount}
                                        </span>
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </nav>

                {/* Identity + power + lock */}
                <div className="p-4 space-y-3">
                    <div className="gold-divider" />
                    {member && (
                        <div className="flex items-center justify-between px-1">
                            <span className="text-[12px] font-semibold text-warm-700 truncate">{member.name}</span>
                            <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full bg-gold-50 text-gold-600 border border-gold-200">{role}</span>
                        </div>
                    )}
                    {canManage && (
                        <button
                            onClick={toggleSystemPower}
                            className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 border ${
                                systemState.status === 'Active'
                                    ? 'bg-ruby-light text-ruby border-ruby-border hover:bg-red-50'
                                    : 'bg-forest-light text-forest border-forest-border hover:bg-emerald-50'
                            }`}
                        >
                            {systemState.status === 'Active' ? '⏸  Pause Monitoring' : '▶  Start Monitoring'}
                        </button>
                    )}
                    <button onClick={lock}
                        className="w-full py-2 rounded-xl text-[12px] font-semibold text-warm-500 hover:text-warm-700 border border-warm-200 hover:bg-warm-50 transition-all">
                        🔒 Lock
                    </button>
                    <p className="text-center text-[10px] text-warm-300 font-mono tracking-wider">{clock}</p>
                </div>
            </aside>

            {/* ── Main Content ── */}
            <main className="flex-1 flex flex-col overflow-hidden h-full">

                {/* Top header */}
                <header className="bg-white/80 backdrop-blur-xl border-b border-warm-100 px-5 md:px-8 h-14 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        {/* Mobile brand */}
                        <div className="md:hidden flex items-center gap-2 mr-1">
                            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center">
                                <IconShield className="text-white w-4 h-4" />
                            </div>
                        </div>
                        <h2 className="text-sm font-bold text-warm-800 tracking-tight">
                            {navItems.find(n => n.id === activeView)?.label}
                        </h2>
                        {urgentCount > 0 && activeView !== 'feed' && (
                            <span className="bg-ruby-light text-ruby text-[11px] font-bold px-2.5 py-1 rounded-full border border-ruby-border animate-pulse">
                                ⚠ {urgentCount} alert{urgentCount > 1 ? 's' : ''}
                            </span>
                        )}
                        {activeView === 'feed' && (
                            <span className={`text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full border ${
                                connected
                                    ? 'bg-forest-light text-forest border-forest-border'
                                    : 'bg-warm-50 text-warm-400 border-warm-200'
                            }`}>
                                {connected ? '● Live' : '○ Offline'}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="hidden md:block text-[11px] text-warm-400 font-mono">{clock}</span>
                        <button
                            onClick={toggleSystemPower}
                            className={`md:hidden px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all ${!canManage ? 'hidden' : ''} ${
                                systemState.status === 'Active'
                                    ? 'bg-ruby-light text-ruby border-ruby-border'
                                    : 'bg-forest-light text-forest border-forest-border'
                            }`}
                        >
                            {systemState.status === 'Active' ? '⏸ Pause' : '▶ Start'}
                        </button>
                    </div>
                </header>

                {/* Page content */}
                <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-luxury">
                    <div className="max-w-3xl mx-auto pb-24 md:pb-10">
                        <div key={activeView} className="animate-fade-in">
                            {activeView === 'family'   && <FamilyDashboard events={events} systemState={systemState} cameras={cameras} connected={connected} onSendAlert={sendFamilyAlert} />}
                            {activeView === 'feed'     && <LiveFeed events={events} connected={connected} />}
                            {activeView === 'access'   && <AccessControl />}
                            {activeView === 'settings' && <Settings config={config} connected={connected} onUpdateConfig={updateConfig} onPurge={purgeEvents} />}
                        </div>
                    </div>
                </div>
            </main>

            {/* ── Mobile Bottom Nav ── */}
            <nav className="md:hidden fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur-2xl border-t border-warm-100 flex items-stretch z-50 shadow-[0_-4px_20px_rgba(139,111,42,0.06)]">
                {visibleNav.map(item => {
                    const Icon = item.icon;
                    const isActive = activeView === item.id;
                    return (
                        <button
                            key={item.id}
                            onClick={() => setActiveView(item.id)}
                            className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 transition-all relative ${
                                isActive ? 'text-gold-500' : 'text-warm-300'
                            }`}
                        >
                            {isActive && (
                                <div className="absolute top-0 inset-x-4 h-[3px] rounded-b-full bg-gradient-to-r from-gold-400 to-gold-600" />
                            )}
                            <Icon className={isActive ? 'text-gold-500' : 'text-warm-300'} />
                            <span className={`text-[10px] font-semibold ${isActive ? 'text-gold-600' : 'text-warm-300'}`}>
                                {item.label}
                            </span>
                            {item.id === 'feed' && urgentCount > 0 && (
                                <span className="absolute top-1.5 right-1/4 bg-ruby text-white text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                                    {urgentCount}
                                </span>
                            )}
                        </button>
                    );
                })}
            </nav>
        </div>
    );
}