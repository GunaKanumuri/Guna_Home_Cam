import { useState, type ReactNode } from 'react';
import { useAuthContext } from './AuthContext';

/* ── Brand shell ─────────────────────────────────────────────── */
function Shell({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-luxury p-6 font-sans">
            <div className="w-full max-w-sm">
                <div className="flex flex-col items-center mb-7">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-gold-400 to-gold-600 flex items-center justify-center shadow-lg shadow-gold-400/20 mb-3">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        </svg>
                    </div>
                    <h1 className="text-xl font-serif font-bold text-warm-900">Guna's Home Cam</h1>
                    <p className="text-[11px] text-warm-400 tracking-[0.15em]">AI SECURITY</p>
                </div>
                <div className="lux-card p-6 animate-fade-in">{children}</div>
            </div>
        </div>
    );
}

/* ── Numeric keypad ──────────────────────────────────────────── */
function Keypad({ value, onChange, max = 4 }: { value: string; onChange: (v: string) => void; max?: number }) {
    const press = (d: string) => { if (value.length < max) onChange(value + d); };
    const del   = () => onChange(value.slice(0, -1));
    return (
        <div>
            <div className="flex justify-center gap-3 mb-6">
                {Array.from({ length: max }).map((_, i) => (
                    <div key={i} className={`w-3.5 h-3.5 rounded-full transition-all ${i < value.length ? 'bg-gold-500 scale-110' : 'bg-warm-200'}`} />
                ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
                {['1','2','3','4','5','6','7','8','9'].map(d => (
                    <button key={d} onClick={() => press(d)}
                        className="h-14 rounded-2xl bg-warm-50 hover:bg-warm-100 text-xl font-semibold text-warm-800 active:scale-95 transition-all">
                        {d}
                    </button>
                ))}
                <div />
                <button onClick={() => press('0')}
                    className="h-14 rounded-2xl bg-warm-50 hover:bg-warm-100 text-xl font-semibold text-warm-800 active:scale-95 transition-all">0</button>
                <button onClick={del}
                    className="h-14 rounded-2xl bg-warm-50 hover:bg-warm-100 text-warm-500 active:scale-95 transition-all flex items-center justify-center text-lg">⌫</button>
            </div>
        </div>
    );
}

function ErrorNote({ msg }: { msg: string }) {
    return <p className="mt-4 text-center text-[13px] text-ruby font-medium">{msg}</p>;
}

/* ── Owner first-time setup ──────────────────────────────────── */
function OwnerSetup() {
    const { bootstrapOwner } = useAuthContext();
    const [name, setName] = useState('');
    const [pin, setPin]   = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr]   = useState('');
    const [denied, setDenied] = useState(false);

    const submit = async () => {
        if (name.trim().length < 2 || pin.length !== 4) return;
        setBusy(true); setErr('');
        const r = await bootstrapOwner(name.trim(), pin);
        setBusy(false);
        if (!r.ok) {
            if ((r.message || '').toLowerCase().includes('owner already')) setDenied(true);
            else setErr(r.message || 'Setup failed.');
            setPin('');
        }
    };

    if (denied) {
        return (
            <Shell>
                <div className="text-center">
                    <p className="text-3xl mb-3">🔒</p>
                    <h2 className="text-lg font-bold text-warm-900">This home is already set up</h2>
                    <p className="text-sm text-warm-500 mt-2">Ask Guna to send you an invite link to get access.</p>
                </div>
            </Shell>
        );
    }

    return (
        <Shell>
            <h2 className="text-lg font-bold text-warm-900 text-center">Welcome — first-time setup</h2>
            <p className="text-sm text-warm-500 text-center mt-1 mb-5">Create the owner account for this home.</p>

            <label className="text-xs font-semibold text-warm-600 block mb-1.5">Your name</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Guna"
                className="w-full bg-warm-50 border border-warm-200 text-sm text-warm-800 px-4 py-2.5 rounded-xl outline-none focus:ring-2 focus:ring-gold-200 focus:border-gold-300 transition-all mb-5 placeholder-warm-300" />

            <label className="text-xs font-semibold text-warm-600 block mb-3 text-center">Choose a 4-digit code</label>
            <Keypad value={pin} onChange={setPin} />

            {err && <ErrorNote msg={err} />}

            <button onClick={submit} disabled={busy || name.trim().length < 2 || pin.length !== 4}
                className="w-full mt-6 py-3 rounded-xl bg-gradient-to-r from-gold-400 to-gold-600 hover:from-gold-500 hover:to-gold-700 text-white font-bold text-sm transition-all active:scale-[0.98] disabled:opacity-40 shadow-lg shadow-gold-400/20">
                {busy ? 'Setting up…' : 'Create owner account'}
            </button>
        </Shell>
    );
}

/* ── Invite accept (parent / editor) ─────────────────────────── */
function InviteAccept() {
    const { claimInvite } = useAuthContext();
    const [pin, setPin]       = useState('');
    const [confirm, setConfirm] = useState('');
    const [step, setStep]     = useState<'set' | 'confirm'>('set');
    const [busy, setBusy]     = useState(false);
    const [err, setErr]       = useState('');

    const onSet = (v: string) => {
        setPin(v);
        if (v.length === 4) setStep('confirm');
    };

    const onConfirm = async (v: string) => {
        setConfirm(v);
        if (v.length !== 4) return;
        if (v !== pin) { setErr('Codes did not match. Try again.'); setPin(''); setConfirm(''); setStep('set'); return; }
        setBusy(true); setErr('');
        const r = await claimInvite(pin);
        setBusy(false);
        if (!r.ok) { setErr(r.message || 'This invite is invalid or expired.'); setPin(''); setConfirm(''); setStep('set'); }
    };

    return (
        <Shell>
            <div className="text-center mb-5">
                <p className="text-3xl mb-2">👋</p>
                <h2 className="text-lg font-bold text-warm-900">You've been invited</h2>
                <p className="text-sm text-warm-500 mt-1">
                    {step === 'set' ? 'Set a 4-digit code to access the dashboard.' : 'Re-enter your code to confirm.'}
                </p>
            </div>

            {step === 'set'
                ? <Keypad value={pin} onChange={onSet} />
                : <Keypad value={confirm} onChange={onConfirm} />}

            {busy && <p className="mt-4 text-center text-[13px] text-warm-400">Joining…</p>}
            {err && <ErrorNote msg={err} />}
        </Shell>
    );
}

/* ── Returning user unlock ───────────────────────────────────── */
function Unlock() {
    const { unlock, member } = useAuthContext();
    const [pin, setPin]   = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr]   = useState('');

    const onChange = async (v: string) => {
        setPin(v);
        if (v.length !== 4) return;
        setBusy(true); setErr('');
        const r = await unlock(v);
        setBusy(false);
        if (!r.ok) { setErr(r.message || 'Wrong code.'); setPin(''); }
    };

    return (
        <Shell>
            <div className="text-center mb-5">
                <h2 className="text-lg font-bold text-warm-900">Welcome back{member ? `, ${member.name}` : ''}</h2>
                <p className="text-sm text-warm-500 mt-1">Enter your 4-digit code to unlock.</p>
            </div>
            <Keypad value={pin} onChange={onChange} />
            {busy && <p className="mt-4 text-center text-[13px] text-warm-400">Checking…</p>}
            {err && <ErrorNote msg={err} />}
        </Shell>
    );
}

/* ── Gate ────────────────────────────────────────────────────── */
export default function AuthGate({ children }: { children: ReactNode }) {
    const { loading, member, unlocked, inviteToken, error } = useAuthContext();

    if (loading) {
        return (
            <Shell>
                <div className="text-center py-4">
                    <div className="w-8 h-8 mx-auto border-2 border-gold-300 border-t-gold-600 rounded-full animate-spin" />
                    <p className="text-sm text-warm-400 mt-4">Connecting…</p>
                </div>
            </Shell>
        );
    }

    if (error && !member) {
        return <Shell><div className="text-center py-2"><p className="text-3xl mb-3">📡</p><p className="text-sm text-warm-600 font-semibold">{error}</p></div></Shell>;
    }

    if (!member) {
        return inviteToken ? <InviteAccept /> : <OwnerSetup />;
    }

    if (!unlocked) return <Unlock />;

    return <>{children}</>;
}