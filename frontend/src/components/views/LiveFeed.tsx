// src/components/views/LiveFeed.tsx
import { useState, useMemo } from 'react';
import type { SurveillanceEvent } from '../../types';

interface Props { events: SurveillanceEvent[]; connected: boolean; }
type Filter = 'all' | 'alerts' | 'family';

const P = {
    urgent:  { bar: 'bg-ruby',      dot: 'bg-ruby shadow-[0_0_6px_rgba(184,58,46,0.4)]', badge: 'bg-ruby-light text-ruby border-ruby-border',   label: 'URGENT' },
    warning: { bar: 'bg-amber-400', dot: 'bg-amber-400',                                  badge: 'bg-amber-50 text-amber-600 border-amber-200',   label: 'WARN'   },
    safe:    { bar: 'bg-gold-300',  dot: 'bg-gold-400',                                   badge: 'bg-gold-50 text-gold-600 border-gold-200',      label: 'SAFE'   },
};

function exportCSV(events: SurveillanceEvent[]) {
    const header = 'Timestamp,Camera,Priority,Family,Message,Hazard';
    const rows = events.map(e =>
        `"${e.timestamp}","${e.camera}","${e.priority}","${e.family || ''}","${e.message.replace(/"/g, "'")}","${e.hazard}"`
    );
    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `homeguard-logs-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

export default function LiveFeed({ events, connected }: Props) {
    const [filter, setFilter]       = useState<Filter>('all');
    const [search, setSearch]       = useState('');
    const [cameraFilter, setCameraFilter] = useState('all');
    const [expandedId, setExpandedId]     = useState<number | null>(null);

    // Unique camera names for the camera filter dropdown
    const cameras = useMemo(() =>
        ['all', ...Array.from(new Set(events.map(e => e.camera)))],
        [events]
    );

    const filtered = useMemo(() => events.filter(ev => {
        if (filter === 'alerts' && ev.priority === 'safe') return false;
        if (filter === 'family' && !ev.family) return false;
        if (cameraFilter !== 'all' && ev.camera !== cameraFilter) return false;
        if (search.trim()) {
            const q = search.toLowerCase();
            return (
                ev.message.toLowerCase().includes(q) ||
                ev.camera.toLowerCase().includes(q) ||
                (ev.family || '').toLowerCase().includes(q)
            );
        }
        return true;
    }), [events, filter, cameraFilter, search]);

    const urgentCnt  = events.filter(e => e.priority === 'urgent').length;
    const warnCnt    = events.filter(e => e.priority === 'warning').length;
    const familyCnt  = events.filter(e => e.family !== null).length;
    const isFiltered = filter !== 'all' || cameraFilter !== 'all' || search.trim() !== '';

    const clearFilters = () => {
        setFilter('all');
        setCameraFilter('all');
        setSearch('');
    };

    const tabs: { key: Filter; label: string; count: number }[] = [
        { key: 'all',    label: 'All Logs', count: events.length },
        { key: 'alerts', label: '⚠ Alerts', count: urgentCnt + warnCnt },
        { key: 'family', label: '👤 Family', count: familyCnt },
    ];

    return (
        <div className="animate-fade-in space-y-5">

            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-serif font-bold text-warm-900 tracking-tight">Camera Log</h2>
                    <div className="flex items-center gap-2 mt-1.5">
                        <span className="relative flex h-2 w-2">
                            {connected && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-forest opacity-50" />}
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${connected ? 'bg-forest' : 'bg-warm-300'}`} />
                        </span>
                        <span className="text-[11px] text-warm-400 font-mono">
                            {connected ? 'Live · updates every 5s' : 'Offline · showing mock data'}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {urgentCnt > 0 && (
                        <div className="flex items-center gap-1.5 bg-ruby-light border border-ruby-border px-3 py-1.5 rounded-xl">
                            <span className="animate-ping inline-flex h-1.5 w-1.5 rounded-full bg-ruby opacity-60" />
                            <span className="text-ruby text-xs font-bold">{urgentCnt} URGENT</span>
                        </div>
                    )}
                    <button
                        onClick={() => exportCSV(filtered)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-warm-50 hover:bg-warm-100 border border-warm-200 text-warm-600 text-xs font-semibold transition-all active:scale-[0.97]"
                    >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                        Export CSV
                    </button>
                </div>
            </div>

            {/* ── Stats ── */}
            <div className="grid grid-cols-3 gap-3">
                {[
                    { label: 'Total Events', value: events.length,         icon: '📊', g: 'from-slate-50 to-gray-50'    },
                    { label: 'Threats',      value: urgentCnt + warnCnt,   icon: '⚡', g: 'from-amber-50 to-orange-50'  },
                    { label: 'Family Seen',  value: familyCnt,             icon: '👨‍👩‍👧', g: 'from-blue-50 to-indigo-50'  },
                ].map((s, i) => (
                    <div key={s.label} className="lux-card p-4 text-center animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className={`w-10 h-10 mx-auto mb-2 rounded-xl bg-gradient-to-br ${s.g} flex items-center justify-center text-xl`}>{s.icon}</div>
                        <p className="text-xl font-bold text-warm-800">{s.value}</p>
                        <p className="text-[10px] font-mono text-warm-400 uppercase tracking-wider mt-0.5">{s.label}</p>
                    </div>
                ))}
            </div>

            {/* ── Search bar ── */}
            <div className="relative">
                <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 text-warm-300" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search events, cameras, family members..."
                    className="w-full bg-white border border-warm-200 text-sm text-warm-800 pl-10 pr-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-300 transition-all placeholder-warm-300"
                />
                {search && (
                    <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-warm-300 hover:text-warm-500">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                )}
            </div>

            {/* ── Filters row ── */}
            <div className="flex items-center gap-2 flex-wrap">
                {/* Priority tabs */}
                <div className="flex bg-white p-1 rounded-xl border border-warm-100 shadow-sm">
                    {tabs.map(t => (
                        <button key={t.key} onClick={() => setFilter(t.key)}
                            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all flex items-center gap-1.5 ${
                                filter === t.key
                                    ? 'bg-gradient-to-r from-gold-400 to-gold-500 text-white shadow-sm'
                                    : 'text-warm-400 hover:text-warm-600'
                            }`}>
                            {t.label}
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${filter === t.key ? 'bg-white/20 text-white' : 'bg-warm-50 text-warm-400'}`}>
                                {t.count}
                            </span>
                        </button>
                    ))}
                </div>

                {/* Camera dropdown */}
                <select
                    value={cameraFilter}
                    onChange={e => setCameraFilter(e.target.value)}
                    className="bg-white border border-warm-200 text-xs font-semibold text-warm-600 px-3 py-2 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 transition-all"
                >
                    {cameras.map(c => (
                        <option key={c} value={c}>{c === 'all' ? 'All Cameras' : c}</option>
                    ))}
                </select>

                {/* Clear all filters */}
                {isFiltered && (
                    <button onClick={clearFilters}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ruby-light border border-ruby-border text-ruby text-xs font-semibold transition-all hover:bg-red-100 active:scale-[0.97]">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        Clear filters
                    </button>
                )}

                {/* Result count when filtered */}
                {isFiltered && (
                    <span className="text-xs text-warm-400 font-mono ml-auto">
                        {filtered.length} of {events.length} events
                    </span>
                )}
            </div>

            {/* ── Event list ── */}
            <div className="space-y-2">
                {filtered.length === 0 ? (
                    <div className="text-center py-16 lux-card">
                        <p className="text-3xl mb-3">🔍</p>
                        <p className="text-warm-500 text-sm font-semibold">No events match your filters</p>
                        <button onClick={clearFilters} className="mt-3 text-xs text-gold-500 hover:text-gold-600 font-semibold underline underline-offset-2">
                            Clear all filters
                        </button>
                    </div>
                ) : (
                    filtered.map((event, idx) => {
                        const cfg        = P[event.priority];
                        const isExpanded = expandedId === event.id;
                        return (
                            <div key={event.id}
                                onClick={() => setExpandedId(isExpanded ? null : event.id)}
                                className={`group relative lux-card overflow-hidden cursor-pointer transition-all duration-200 animate-slide-up ${
                                    event.priority === 'urgent' ? '!border-ruby-border !bg-ruby-light' :
                                    event.priority === 'warning' ? '!border-amber-200 !bg-amber-50/40' : ''
                                }`}
                                style={{ animationDelay: `${idx * 30}ms` }}
                            >
                                {/* Priority bar */}
                                <div className={`absolute left-0 top-0 bottom-0 w-1 ${cfg.bar}`} />

                                {/* Main row */}
                                <div className="flex items-center gap-4 p-4 pl-5">
                                    <div className="w-28 shrink-0">
                                        <span className="text-[10px] font-mono text-warm-400">{event.timestamp}</span>
                                        <p className="text-xs font-semibold text-warm-700 truncate mt-0.5">{event.camera}</p>
                                    </div>

                                    <div className={`w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />

                                    <p className="flex-1 text-sm text-warm-600 group-hover:text-warm-800 transition-colors leading-snug">
                                        {/* Highlight search term */}
                                        {search.trim()
                                            ? event.message.split(new RegExp(`(${search})`, 'gi')).map((part, i) =>
                                                part.toLowerCase() === search.toLowerCase()
                                                    ? <mark key={i} className="bg-gold-200 text-warm-800 rounded px-0.5">{part}</mark>
                                                    : part
                                              )
                                            : event.message
                                        }
                                    </p>

                                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                                        <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${cfg.badge}`}>
                                            {cfg.label}
                                        </span>
                                        {event.family && (
                                            <span className="text-[9px] font-mono px-2 py-0.5 rounded border bg-blue-50 text-blue-600 border-blue-200">
                                                {event.family.toUpperCase()}
                                            </span>
                                        )}
                                    </div>

                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                        className={`text-warm-300 shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                                        <polyline points="6 9 12 15 18 9"/>
                                    </svg>
                                </div>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div className="px-5 pb-4 border-t border-warm-100 animate-fade-in">
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3">
                                            {[
                                                { label: 'Camera',   value: event.camera },
                                                { label: 'Time',     value: event.timestamp },
                                                { label: 'Priority', value: event.priority.charAt(0).toUpperCase() + event.priority.slice(1),
                                                  color: event.priority === 'urgent' ? 'text-ruby' : event.priority === 'warning' ? 'text-amber-600' : 'text-gold-600' },
                                                { label: 'Hazard',   value: event.hazard ? 'Yes ⚠️' : 'No' },
                                                { label: 'Family',   value: event.family || 'None detected' },
                                                { label: 'Event ID', value: `#${event.id}` },
                                            ].map(f => (
                                                <div key={f.label}>
                                                    <p className="text-[9px] font-mono text-warm-300 uppercase tracking-wider">{f.label}</p>
                                                    <p className={`text-xs font-semibold mt-0.5 ${'color' in f ? f.color : 'text-warm-700'}`}>{f.value}</p>
                                                </div>
                                            ))}
                                        </div>
                                        {/* Full message */}
                                        <div className="mt-3 pt-3 border-t border-warm-100">
                                            <p className="text-[9px] font-mono text-warm-300 uppercase tracking-wider mb-1">Full Description</p>
                                            <p className="text-sm text-warm-700 leading-relaxed">{event.message}</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}