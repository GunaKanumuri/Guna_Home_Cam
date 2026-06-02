// src/components/views/AccessControl.tsx
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { useAuthContext } from '../../auth/AuthContext';
import type { Role } from '../../hooks/useAuth';

interface MemberRow { id: string; name: string; role: Role; created_at: string; }
interface InviteRow { token: string; name: string; role: Role; created_at: string; expires_at: string; }

const ROLE_CFG: Record<Role, { label: string; desc: string; badge: string; icon: string }> = {
    owner:  { label: 'Owner',  desc: 'Full control + manage people',     badge: 'bg-gold-50 text-gold-700 border-gold-200',       icon: '👑' },
    editor: { label: 'Editor', desc: 'Tune settings & pause monitoring', badge: 'bg-blue-50 text-blue-600 border-blue-200',        icon: '🛠️' },
    viewer: { label: 'Viewer', desc: 'See cameras & detection log only', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: '👁️' },
};

const APP_URL = (import.meta.env.VITE_APP_URL as string) || window.location.origin;
const inviteLink = (token: string) => `${APP_URL.replace(/\/$/, '')}/?invite=${token}`;
const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/* ── Invite modal ─────────────────────────────────────────────── */
function InviteModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
    const [name, setName]   = useState('');
    const [role, setRole]   = useState<Role>('viewer');
    const [link, setLink]   = useState('');
    const [busy, setBusy]   = useState(false);
    const [err, setErr]     = useState('');
    const [copied, setCopied] = useState(false);

    const generate = async () => {
        if (name.trim().length < 2) return;
        setBusy(true); setErr('');
        const { data, error } = await supabase.rpc('create_invite', { p_name: name.trim(), p_role: role });
        setBusy(false);
        if (error) { setErr(error.message); return; }
        setLink(inviteLink(data as string));
        onCreated();
    };

    const copy = () => {
        navigator.clipboard.writeText(link).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); });
    };
    const whatsapp = () => {
        const msg = encodeURIComponent(
            `Hi! Guna invited you to the Home Cam dashboard.\n\nOpen this link and set a 4-digit code:\n${link}\n\nYou'll have ${ROLE_CFG[role].label} access.`);
        window.open(`https://wa.me/?text=${msg}`, '_blank');
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in">
                <div className="px-6 pt-6 pb-4 border-b border-warm-100 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-serif font-bold text-warm-900">Invite Family Member</h3>
                        <p className="text-xs text-warm-400 mt-0.5">They'll set their own 4-digit code on first open</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-warm-50 flex items-center justify-center text-warm-400 hover:bg-warm-100 transition-all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>

                <div className="p-6 space-y-5">
                    {!link ? (
                        <>
                            <div>
                                <label className="text-xs font-semibold text-warm-600 block mb-1.5">Name</label>
                                <input value={name} onChange={e => setName(e.target.value)}
                                    placeholder="e.g. Amma, Nanna, Aunt…"
                                    className="w-full bg-warm-50 border border-warm-200 text-sm text-warm-800 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-300 transition-all placeholder-warm-300" />
                            </div>
                            <div>
                                <label className="text-xs font-semibold text-warm-600 block mb-2">Access Level</label>
                                <div className="space-y-2">
                                    {(['viewer', 'editor'] as Role[]).map(r => {
                                        const cfg = ROLE_CFG[r];
                                        return (
                                            <button key={r} onClick={() => setRole(r)}
                                                className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${role === r ? 'border-gold-400 bg-gold-50' : 'border-warm-100 bg-warm-50 hover:border-warm-200'}`}>
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${role === r ? 'border-gold-500' : 'border-warm-300'}`}>
                                                        {role === r && <div className="w-2 h-2 rounded-full bg-gold-500" />}
                                                    </div>
                                                    <span className="text-sm font-semibold text-warm-800">{cfg.icon} {cfg.label}</span>
                                                </div>
                                                <p className="text-[11px] text-warm-400 mt-1 ml-6">{cfg.desc}</p>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                            {err && <p className="text-[13px] text-ruby font-medium">{err}</p>}
                            <button onClick={generate} disabled={busy || name.trim().length < 2}
                                className="w-full py-3 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white font-bold text-sm transition-all active:scale-[0.98] disabled:opacity-40 shadow-lg shadow-gold-400/20">
                                {busy ? 'Generating…' : 'Generate invite link'}
                            </button>
                        </>
                    ) : (
                        <>
                            <div className="text-center">
                                <p className="text-3xl mb-2">🔗</p>
                                <p className="text-sm font-semibold text-warm-800">Invite ready for {name}</p>
                                <p className="text-xs text-warm-400 mt-1">Valid for 7 days · {ROLE_CFG[role].label} access</p>
                            </div>
                            <div className="bg-warm-50 border border-warm-200 rounded-xl p-3 text-[11px] font-mono text-warm-600 break-all">{link}</div>
                            <div className="flex flex-col gap-2">
                                <button onClick={whatsapp}
                                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-green-500 hover:bg-green-600 text-white font-semibold text-sm transition-all active:scale-[0.98]">
                                    💬 Send via WhatsApp
                                </button>
                                <button onClick={copy}
                                    className="w-full py-3 rounded-xl bg-warm-100 hover:bg-warm-200 text-warm-700 font-semibold text-sm transition-all active:scale-[0.98]">
                                    {copied ? '✓ Copied!' : '🔗 Copy link'}
                                </button>
                                <button onClick={onClose}
                                    className="w-full py-2.5 rounded-xl text-warm-500 hover:text-warm-700 font-semibold text-sm transition-all">Done</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/* ── Main ─────────────────────────────────────────────────────── */
export default function AccessControl() {
    const { member: me } = useAuthContext();
    const [members, setMembers] = useState<MemberRow[]>([]);
    const [invites, setInvites] = useState<InviteRow[]>([]);
    const [showInvite, setShowInvite] = useState(false);
    const [loading, setLoading] = useState(true);
    const [note, setNote] = useState('');

    const loadAll = useCallback(async () => {
        const [m, i] = await Promise.all([
            supabase.from('members').select('id, name, role, created_at').order('created_at'),
            supabase.from('invites').select('token, name, role, created_at, expires_at').is('claimed_by', null).order('created_at', { ascending: false }),
        ]);
        if (m.data) setMembers(m.data as MemberRow[]);
        if (i.data) setInvites(i.data as InviteRow[]);
        setLoading(false);
    }, []);

    useEffect(() => { loadAll(); }, [loadAll]);

    const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 2500); };

    const changeRole = async (id: string, role: Role) => {
        const { error } = await supabase.from('members').update({ role }).eq('id', id);
        if (error) flash(error.message); else { flash('Role updated'); loadAll(); }
    };
    const removeMember = async (id: string, name: string) => {
        if (!confirm(`Remove ${name}'s access? They'll need a new invite to return.`)) return;
        const { error } = await supabase.from('members').delete().eq('id', id);
        if (error) flash(error.message); else { flash('Member removed'); loadAll(); }
    };
    const revokeInvite = async (token: string) => {
        const { error } = await supabase.from('invites').delete().eq('token', token);
        if (error) flash(error.message); else { flash('Invite revoked'); loadAll(); }
    };
    const copyInvite = (token: string) => {
        navigator.clipboard.writeText(inviteLink(token)).then(() => flash('Link copied'));
    };

    return (
        <div className="animate-fade-in space-y-6">
            {showInvite && <InviteModal onClose={() => setShowInvite(false)} onCreated={loadAll} />}

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-serif font-bold text-warm-900 tracking-tight">Access Control</h2>
                    <p className="text-sm text-warm-400 mt-1">Who can see your Home Cam, and what they can do</p>
                </div>
                <button onClick={() => setShowInvite(true)}
                    className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white text-sm font-semibold transition-all shadow-lg shadow-gold-400/20 active:scale-[0.98]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Invite
                </button>
            </div>

            {note && <div className="lux-card px-4 py-2.5 text-sm text-warm-700 border-gold-200">{note}</div>}

            {loading && <div className="lux-card p-8 text-center text-sm text-warm-400">Loading members…</div>}

            {/* Pending invites */}
            {invites.length > 0 && (
                <div className="space-y-3">
                    <p className="text-[11px] font-semibold text-warm-400 uppercase tracking-[0.15em]">Pending invites</p>
                    {invites.map(inv => (
                        <div key={inv.token} className="lux-card p-4 flex items-center gap-3 border-dashed">
                            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-lg border border-amber-100">⏳</div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-warm-800">{inv.name}</p>
                                <p className="text-[11px] text-warm-400">Invited · {ROLE_CFG[inv.role].label} · expires {fmtDate(inv.expires_at)}</p>
                            </div>
                            <button onClick={() => copyInvite(inv.token)} className="text-[11px] font-semibold text-gold-600 hover:text-gold-700 px-2 py-1">Copy</button>
                            <button onClick={() => revokeInvite(inv.token)} className="text-[11px] font-semibold text-ruby hover:underline px-2 py-1">Revoke</button>
                        </div>
                    ))}
                </div>
            )}

            {/* Members */}
            <div className="space-y-3">
                <p className="text-[11px] font-semibold text-warm-400 uppercase tracking-[0.15em]">Members</p>
                {members.map((m, idx) => {
                    const cfg = ROLE_CFG[m.role];
                    const isSelf = me?.id === m.id;
                    return (
                        <div key={m.id} className="lux-card p-5 animate-slide-up" style={{ animationDelay: `${idx * 60}ms` }}>
                            <div className="flex items-start gap-4">
                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-warm-50 to-parchment flex items-center justify-center text-xl border border-warm-100 shrink-0">
                                    {cfg.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-semibold text-warm-800">{m.name}</p>
                                        {isSelf && <span className="text-[9px] font-mono px-2 py-0.5 rounded border bg-warm-50 text-warm-400 border-warm-200">YOU</span>}
                                        <span className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-lg border ${cfg.badge}`}>{cfg.label}</span>
                                    </div>
                                    <p className="text-[11px] text-warm-400 mt-0.5">{cfg.desc}</p>
                                    <p className="text-[11px] font-mono text-warm-300 mt-1">Joined {fmtDate(m.created_at)}</p>
                                </div>

                                {/* Owner manages others (not self, not other owners) */}
                                {me?.role === 'owner' && !isSelf && m.role !== 'owner' && (
                                    <div className="flex flex-col items-end gap-2 shrink-0">
                                        <select value={m.role} onChange={e => changeRole(m.id, e.target.value as Role)}
                                            className="text-[11px] bg-warm-50 border border-warm-200 rounded-lg px-2 py-1 text-warm-700 outline-none focus:ring-2 focus:ring-gold-200">
                                            <option value="viewer">Viewer</option>
                                            <option value="editor">Editor</option>
                                        </select>
                                        <button onClick={() => removeMember(m.id, m.name)}
                                            className="text-[11px] font-semibold text-ruby hover:underline">Remove</button>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {!loading && members.length <= 1 && invites.length === 0 && (
                <div className="lux-card p-8 text-center border-dashed">
                    <p className="text-3xl mb-3">👨‍👩‍👧</p>
                    <p className="text-sm font-semibold text-warm-600">Just you so far</p>
                    <p className="text-xs text-warm-400 mt-1">Tap Invite to send your parents a link to the dashboard</p>
                </div>
            )}
        </div>
    );
}