// src/components/views/AccessControl.tsx
import { useState } from 'react';

type AccessLevel = 'full' | 'view_only' | 'alerts_only';
type DeviceStatus = 'online' | 'serving' | 'offline' | 'pending';

interface FamilyMember {
    id: string;
    name: string;
    phone: string;
    icon: string;
    status: DeviceStatus;
    access: AccessLevel;
    ip: string;
    lastSeen: string;
    isSystem?: boolean;
}

const ACCESS_LABELS: Record<AccessLevel, { label: string; desc: string; color: string }> = {
    full:        { label: 'Full Access',   desc: 'Can view cameras, toggle monitoring, change settings', color: 'bg-gold-50 text-gold-700 border-gold-200'     },
    view_only:   { label: 'View Only',     desc: 'Can see Home tab and Camera Log, nothing else',        color: 'bg-blue-50 text-blue-600 border-blue-200'      },
    alerts_only: { label: 'Alerts Only',   desc: 'Only receives ntfy push notifications',                color: 'bg-purple-50 text-purple-600 border-purple-200' },
};

const STATUS_CFG: Record<DeviceStatus, { label: string; dot: string; badge: string }> = {
    online:  { label: 'ONLINE',  dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    serving: { label: 'SERVING', dot: 'bg-blue-500',    badge: 'bg-blue-50 text-blue-600 border-blue-200'          },
    offline: { label: 'OFFLINE', dot: 'bg-warm-300',    badge: 'bg-warm-50 text-warm-400 border-warm-200'          },
    pending: { label: 'PENDING', dot: 'bg-amber-400',   badge: 'bg-amber-50 text-amber-600 border-amber-200'       },
};

const SYSTEM_DEVICES: FamilyMember[] = [
    {
        id: 'guna',
        name: "Guna's Laptop",
        phone: '192.168.0.107',
        icon: '💻',
        status: 'online',
        access: 'full',
        ip: '192.168.0.107',
        lastSeen: 'Now',
        isSystem: true,
    },
    {
        id: 'termux',
        name: 'Camera Phone (Termux)',
        phone: '192.168.0.108',
        icon: '📱',
        status: 'serving',
        access: 'full',
        ip: '192.168.0.108',
        lastSeen: 'Now',
        isSystem: true,
    },
];

const STORAGE_KEY = 'homeguard_family_members';

function loadFamilyMembers(): FamilyMember[] {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
    } catch {
        return [];
    }
}

function saveFamilyMembers(members: FamilyMember[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(members));
    } catch {}
}

// ── Invite Modal ──────────────────────────────────────────────────
function InviteModal({ onClose, onAdd }: {
    onClose: () => void;
    onAdd: (m: FamilyMember) => void;
}) {
    const [name, setName]             = useState('');
    const [phone, setPhone]           = useState('');
    const [icon, setIcon]             = useState('👤');
    const [access, setAccess]         = useState<AccessLevel>('view_only');
    const [linkCopied, setLinkCopied] = useState(false);

    const icons = ['👤', '👩', '👨', '👴', '👵', '👧', '👦', '🧑'];

    const generateLink = () => {
        const token = Math.random().toString(36).slice(2, 10).toUpperCase();
        return `http://192.168.0.107:5173/invite?token=${token}&access=${access}`;
    };

    const handleCopyLink = () => {
        navigator.clipboard.writeText(generateLink()).then(() => {
            setLinkCopied(true);
            setTimeout(() => setLinkCopied(false), 2500);
        });
    };

    const handleWhatsApp = () => {
        const link = generateLink();
        const msg = encodeURIComponent(
            `Hi! Guna has invited you to view the Home Guard security dashboard.\n\nTap to open: ${link}\n\nThis gives you ${ACCESS_LABELS[access].label} access.`
        );
        window.open(`https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`, '_blank');
    };

    const handleAdd = () => {
        if (!name.trim()) return;
        onAdd({
            id: Date.now().toString(),
            name: name.trim(),
            phone: phone.trim(),
            icon,
            status: 'pending',
            access,
            ip: '—',
            lastSeen: 'Never',
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in">
                <div className="px-6 pt-6 pb-4 border-b border-warm-100 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-serif font-bold text-warm-900">Invite Family Member</h3>
                        <p className="text-xs text-warm-400 mt-0.5">They'll get a link to open the dashboard</p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-warm-50 flex items-center justify-center text-warm-400 hover:bg-warm-100 transition-all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>

                <div className="p-6 space-y-5">
                    {/* Icon picker */}
                    <div>
                        <label className="text-xs font-semibold text-warm-600 block mb-2">Pick an icon</label>
                        <div className="flex gap-2 flex-wrap">
                            {icons.map(i => (
                                <button key={i} onClick={() => setIcon(i)}
                                    className={`w-10 h-10 rounded-xl text-xl transition-all ${icon === i ? 'bg-gold-100 ring-2 ring-gold-400 scale-110' : 'bg-warm-50 hover:bg-warm-100'}`}>
                                    {i}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Name */}
                    <div>
                        <label className="text-xs font-semibold text-warm-600 block mb-1.5">Name</label>
                        <input value={name} onChange={e => setName(e.target.value)}
                            placeholder="e.g. Brother, Mother, Aunt..."
                            className="w-full bg-warm-50 border border-warm-200 text-sm text-warm-800 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-300 transition-all placeholder-warm-300"
                        />
                    </div>

                    {/* Phone */}
                    <div>
                        <label className="text-xs font-semibold text-warm-600 block mb-1.5">
                            WhatsApp number <span className="text-warm-300 font-normal">(optional)</span>
                        </label>
                        <input value={phone} onChange={e => setPhone(e.target.value)}
                            placeholder="+91 98765 43210"
                            className="w-full bg-warm-50 border border-warm-200 text-sm text-warm-800 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-300 transition-all placeholder-warm-300"
                        />
                    </div>

                    {/* Access level */}
                    <div>
                        <label className="text-xs font-semibold text-warm-600 block mb-2">Access Level</label>
                        <div className="space-y-2">
                            {(Object.keys(ACCESS_LABELS) as AccessLevel[]).map(level => {
                                const cfg = ACCESS_LABELS[level];
                                return (
                                    <button key={level} onClick={() => setAccess(level)}
                                        className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                                            access === level ? 'border-gold-400 bg-gold-50' : 'border-warm-100 bg-warm-50 hover:border-warm-200'
                                        }`}>
                                        <div className="flex items-center gap-2">
                                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${access === level ? 'border-gold-500' : 'border-warm-300'}`}>
                                                {access === level && <div className="w-2 h-2 rounded-full bg-gold-500" />}
                                            </div>
                                            <span className="text-sm font-semibold text-warm-800">{cfg.label}</span>
                                        </div>
                                        <p className="text-[11px] text-warm-400 mt-1 ml-6">{cfg.desc}</p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-2 pt-1">
                        {phone && (
                            <button onClick={handleWhatsApp}
                                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-green-500 hover:bg-green-600 text-white font-semibold text-sm transition-all active:scale-[0.98]">
                                💬 Send via WhatsApp
                            </button>
                        )}
                        <button onClick={handleCopyLink}
                            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-warm-100 hover:bg-warm-200 text-warm-700 font-semibold text-sm transition-all active:scale-[0.98]">
                            {linkCopied ? '✓ Link Copied!' : '🔗 Copy Invite Link'}
                        </button>
                        <button onClick={handleAdd} disabled={!name.trim()}
                            className="w-full py-3 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white font-bold text-sm transition-all active:scale-[0.98] disabled:opacity-40 shadow-lg shadow-gold-400/20">
                            Add to Access List
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Edit Modal ────────────────────────────────────────────────────
function EditModal({ member, onClose, onSave, onRemove }: {
    member: FamilyMember;
    onClose: () => void;
    onSave: (id: string, access: AccessLevel) => void;
    onRemove: (id: string) => void;
}) {
    const [access, setAccess] = useState<AccessLevel>(member.access);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden animate-fade-in">
                <div className="px-6 pt-6 pb-4 border-b border-warm-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="text-2xl">{member.icon}</span>
                        <div>
                            <h3 className="text-base font-bold text-warm-900">{member.name}</h3>
                            <p className="text-xs text-warm-400">Edit access permissions</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-warm-50 flex items-center justify-center text-warm-400 hover:bg-warm-100 transition-all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    <label className="text-xs font-semibold text-warm-600 block">Access Level</label>
                    <div className="space-y-2">
                        {(Object.keys(ACCESS_LABELS) as AccessLevel[]).map(level => {
                            const cfg = ACCESS_LABELS[level];
                            return (
                                <button key={level} onClick={() => setAccess(level)}
                                    className={`w-full text-left px-4 py-3 rounded-xl border-2 transition-all ${
                                        access === level ? 'border-gold-400 bg-gold-50' : 'border-warm-100 bg-warm-50 hover:border-warm-200'
                                    }`}>
                                    <div className="flex items-center gap-2">
                                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${access === level ? 'border-gold-500' : 'border-warm-300'}`}>
                                            {access === level && <div className="w-2 h-2 rounded-full bg-gold-500" />}
                                        </div>
                                        <span className="text-sm font-semibold text-warm-800">{cfg.label}</span>
                                    </div>
                                    <p className="text-[11px] text-warm-400 mt-1 ml-6">{cfg.desc}</p>
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex gap-2 pt-1">
                        <button onClick={() => { onSave(member.id, access); onClose(); }}
                            className="flex-1 py-3 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 text-white font-bold text-sm active:scale-[0.98] shadow-lg shadow-gold-400/20">
                            Save Changes
                        </button>
                        <button onClick={() => { onRemove(member.id); onClose(); }}
                            className="px-4 py-3 rounded-xl border border-ruby-border text-ruby bg-ruby-light hover:bg-red-100 font-semibold text-sm active:scale-[0.98]">
                            Remove
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Main ─────────────────────────────────────────────────────────
export default function AccessControl() {
    // Family members persisted to localStorage — system devices always shown separately
    const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>(loadFamilyMembers);
    const [showInvite, setShowInvite]       = useState(false);
    const [editMember, setEditMember]       = useState<FamilyMember | null>(null);

    const allMembers = [...SYSTEM_DEVICES, ...familyMembers];
    const onlineCnt  = allMembers.filter(m => m.status === 'online' || m.status === 'serving').length;
    const offlineCnt = allMembers.filter(m => m.status === 'offline' || m.status === 'pending').length;

    const handleAdd = (m: FamilyMember) => {
        const updated = [...familyMembers, m];
        setFamilyMembers(updated);
        saveFamilyMembers(updated);          // ← persist
    };

    const handleSave = (id: string, access: AccessLevel) => {
        const updated = familyMembers.map(m => m.id === id ? { ...m, access } : m);
        setFamilyMembers(updated);
        saveFamilyMembers(updated);          // ← persist
    };

    const handleRemove = (id: string) => {
        const updated = familyMembers.filter(m => m.id !== id);
        setFamilyMembers(updated);
        saveFamilyMembers(updated);          // ← persist
    };

    return (
        <div className="animate-fade-in space-y-6">

            {showInvite && <InviteModal onClose={() => setShowInvite(false)} onAdd={handleAdd} />}
            {editMember && (
                <EditModal
                    member={editMember}
                    onClose={() => setEditMember(null)}
                    onSave={handleSave}
                    onRemove={handleRemove}
                />
            )}

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-xl font-serif font-bold text-warm-900 tracking-tight">Access Control</h2>
                    <p className="text-sm text-warm-400 mt-1">Manage who can see your Home Guard dashboard</p>
                </div>
                <button onClick={() => setShowInvite(true)}
                    className="shrink-0 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white text-sm font-semibold transition-all shadow-lg shadow-gold-400/20 active:scale-[0.98]">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Invite
                </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-3">
                {[
                    { label: 'Total',   value: allMembers.length, icon: '📡', g: 'from-slate-50 to-gray-50'   },
                    { label: 'Online',  value: onlineCnt,         icon: '🟢', g: 'from-emerald-50 to-teal-50' },
                    { label: 'Offline', value: offlineCnt,        icon: '⭕', g: 'from-warm-50 to-stone-100'  },
                ].map((s, i) => (
                    <div key={s.label} className="lux-card p-4 text-center animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className={`w-10 h-10 mx-auto mb-2 rounded-xl bg-gradient-to-br ${s.g} flex items-center justify-center text-xl`}>{s.icon}</div>
                        <p className="text-lg font-bold text-warm-800">{s.value}</p>
                        <p className="text-[10px] font-mono text-warm-400 uppercase tracking-wider mt-0.5">{s.label}</p>
                    </div>
                ))}
            </div>

            {/* Device list */}
            <div className="space-y-3">
                {allMembers.map((member, idx) => {
                    const sc  = STATUS_CFG[member.status];
                    const acc = ACCESS_LABELS[member.access];
                    return (
                        <div key={member.id}
                            className={`lux-card p-5 animate-slide-up transition-all ${member.status === 'offline' || member.status === 'pending' ? 'opacity-75' : ''}`}
                            style={{ animationDelay: `${idx * 70}ms` }}
                        >
                            <div className="flex items-start gap-4">
                                <div className="relative shrink-0">
                                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-warm-50 to-parchment flex items-center justify-center text-2xl border border-warm-100">
                                        {member.icon}
                                    </div>
                                    <span className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${sc.dot}`} />
                                </div>

                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-semibold text-warm-800">{member.name}</p>
                                        <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${sc.badge}`}>{sc.label}</span>
                                        {member.isSystem && (
                                            <span className="text-[9px] font-mono px-2 py-0.5 rounded border bg-warm-50 text-warm-400 border-warm-200">SYSTEM</span>
                                        )}
                                    </div>
                                    <p className="text-[11px] font-mono text-warm-400 mt-0.5">
                                        {member.ip} · Last seen: {member.lastSeen}
                                    </p>
                                    <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                                        <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg border ${acc.color}`}>
                                            {acc.label}
                                        </span>
                                        <span className="text-[10px] text-warm-300">{acc.desc}</span>
                                    </div>
                                </div>

                                {!member.isSystem && (
                                    <button onClick={() => setEditMember(member)}
                                        className="shrink-0 w-8 h-8 rounded-xl bg-warm-50 hover:bg-warm-100 border border-warm-100 flex items-center justify-center text-warm-400 hover:text-warm-600 transition-all">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                                        </svg>
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            {familyMembers.length === 0 && (
                <div className="lux-card p-8 text-center border-dashed">
                    <p className="text-3xl mb-3">👨‍👩‍👧</p>
                    <p className="text-sm font-semibold text-warm-600">No family members added yet</p>
                    <p className="text-xs text-warm-400 mt-1">Tap Invite to share access with your family</p>
                </div>
            )}
        </div>
    );
}