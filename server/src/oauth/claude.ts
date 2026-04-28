import crypto from 'crypto';
import axios from 'axios';

// Claude Code's OAuth app — same client_id the CLI binary uses (no client secret)
// platform.claude.com/oauth/authorize works (200); claude.ai/oauth/authorize returns 403
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://claude.ai/v1/oauth/token';
const REDIRECT_URI = 'http://localhost:9475/callback';
const SCOPES = 'openid profile email claude_code';

interface PkceSession {
    verifier: string;
    state: string;
    createdAt: number;
}

const sessions = new Map<string, PkceSession>();

function pkce(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(64).toString('base64url');
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
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
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

    const res = await axios.post<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
    }>(TOKEN_URL, new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: session.verifier,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = res.data;
    if (!refresh_token) throw new Error('No refresh token received — please re-authenticate');

    return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(Date.now() + (expires_in ?? 3600) * 1000),
    };
}

export async function refreshClaudeToken(refreshTok: string): Promise<{
    accessToken: string;
    expiresAt: Date;
}> {
    const res = await axios.post<{
        access_token: string;
        expires_in?: number;
    }>(TOKEN_URL, new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshTok,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    return {
        accessToken: res.data.access_token,
        expiresAt: new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000),
    };
}
