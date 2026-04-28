import crypto from 'crypto';
import axios from 'axios';

const CLIENT_ID = process.env.GEMINI_CLIENT_ID ?? '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GEMINI_CLIENT_SECRET ?? '';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REDIRECT_URI = 'http://localhost:9475/oauth/callback';
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

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
        access_type: 'offline',
        prompt: 'consent',
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
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        code_verifier: session.verifier,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = res.data;
    if (!refresh_token) throw new Error('No refresh token — please re-authenticate');
    return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(Date.now() + (expires_in ?? 3600) * 1000),
    };
}

export async function refreshGeminiToken(refreshTok: string): Promise<{
    accessToken: string;
    expiresAt: Date;
}> {
    const res = await axios.post<{
        access_token: string;
        expires_in?: number;
    }>(TOKEN_URL, new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshTok,
        grant_type: 'refresh_token',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    return {
        accessToken: res.data.access_token,
        expiresAt: new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000),
    };
}
