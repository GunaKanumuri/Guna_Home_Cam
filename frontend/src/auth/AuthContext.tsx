import { createContext, useContext, type ReactNode } from 'react';
import { useAuth, type AuthApi } from '../hooks/useAuth';

const AuthContext = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const auth = useAuth();
    return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthApi {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuthContext must be used within <AuthProvider>');
    return ctx;
}