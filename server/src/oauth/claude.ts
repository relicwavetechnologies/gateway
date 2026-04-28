import crypto from 'crypto';
import axios from 'axios';

// Claude Code's OAuth app — same client_id the CLI binary uses (no client secret)
// Reverse-engineered from the Claude Code CLI binary and community implementations:
//   https://gist.github.com/ben-vargas/c7c7cbfebbb47278f45feca9cef309d1
//   https://gist.github.com/changjonathanc/9f9d635b2f8692e0520a884eaf098351
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
// Token exchange goes to console.anthropic.com, NOT claude.ai
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
// Redirect to Anthropic's own callback page (shows the code to copy — no local server needed)
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
// 'claude_code' scope requires Max plan — use API inference scopes instead
const SCOPES = 'org:create_api_key user:profile user:inference';

interface PkceSession {
    verifier: string;
    state: string;
    createdAt: number;
}

const sessions = new Map<string, PkceSession>();

function pkce(): { verifier: string; challenge: string } {
    // 32 random bytes → base64url (no padding) for verifier
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

export function createSession(): { sessionId: string; authUrl: string } {
    const sessionId = crypto.randomUUID();
    const { verifier, challenge } = pkce();
    // Anthropic OAuth uses the verifier as the state parameter
    const state = verifier;

    sessions.set(sessionId, { verifier, state, createdAt: Date.now() });
    for (const [id, s] of sessions) {
        if (Date.now() - s.createdAt > 15 * 60_000) sessions.delete(id);
    }

    const params = new URLSearchParams({
        code: 'true',           // copy-paste friendly mode — redirects to Anthropic's page
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

    // Token exchange is JSON, not form-encoded; include state (= verifier) in payload
    const res = await axios.post<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
    }>(TOKEN_URL, {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: session.verifier,
        state: session.state,
    }, { headers: { 'Content-Type': 'application/json' } });

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
    refreshToken: string;
    expiresAt: Date;
}> {
    const res = await axios.post<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
    }>(TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshTok,
    }, { headers: { 'Content-Type': 'application/json' } });

    return {
        accessToken: res.data.access_token,
        // Anthropic rotates the refresh token on every refresh — store the new one
        refreshToken: res.data.refresh_token ?? refreshTok,
        expiresAt: new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000),
    };
}
