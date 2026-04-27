import crypto from 'crypto';
import axios from 'axios';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = process.env.OPENAI_REDIRECT_URI ?? 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

interface PkceSession {
    verifier: string;
    state: string;
    createdAt: number;
}

const sessions = new Map<string, PkceSession>();

function pkce(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

export function createSession(): { sessionId: string; authUrl: string } {
    const sessionId = crypto.randomUUID();
    const state = crypto.randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkce();

    sessions.set(sessionId, { verifier, state, createdAt: Date.now() });

    for (const [id, s] of sessions) {
        if (Date.now() - s.createdAt > 15 * 60_000) sessions.delete(id);
    }

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
    });

    return { sessionId, authUrl: `${AUTH_URL}?${params}` };
}

export async function exchangeCode(sessionId: string, code: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
}> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found or expired');
    sessions.delete(sessionId);

    const res = await axios.post<{ access_token: string; refresh_token: string; expires_in?: number }>(TOKEN_URL, {
        client_id: CLIENT_ID,
        code,
        code_verifier: session.verifier,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = res.data;
    const expiresAt = new Date(Date.now() + (expires_in ?? 864_000) * 1000);
    return { accessToken: access_token, refreshToken: refresh_token, expiresAt };
}

export async function refreshToken(refreshTok: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
}> {
    const res = await axios.post<{ access_token: string; refresh_token?: string; expires_in?: number }>(TOKEN_URL, {
        client_id: CLIENT_ID,
        refresh_token: refreshTok,
        grant_type: 'refresh_token',
    });
    const { access_token, refresh_token, expires_in } = res.data;
    const expiresAt = new Date(Date.now() + (expires_in ?? 864_000) * 1000);
    return { accessToken: access_token, refreshToken: refresh_token ?? refreshTok, expiresAt };
}
