import '../utils/env.js';
import { getDecryptedTokens, updateAccountTokens, markAccountAuthExpired, getExpiringOpenAIAccounts, getExpiringGeminiAccounts, getExpiringClaudeAccounts, resetExpiredCooldowns } from '../db/accounts.js';
import { getExpiringDedicatedAccounts, getDecryptedDedicatedTokens, updateDedicatedTokens, setDedicatedStatus } from '../db/dedicated-accounts.js';
import { createAlert, markAlertEmailed, getUnEmailedAlerts, autoResolveRecoveredAlerts } from '../db/usage.js';
import { refreshToken as refreshOpenAIToken } from '../oauth/openai.js';
import { refreshGeminiToken } from '../oauth/gemini.js';
import { refreshClaudeToken } from '../oauth/claude.js';
import { sendAlert } from '../utils/email.js';
import { v4 as uuid } from 'uuid';
import { invalidateAccountPool } from '../cache/hotpath.js';

const CHECK_INTERVAL_MS = 5 * 60_000;
const OPENAI_REFRESH_WINDOW_MS = 24 * 60 * 60_000;
const GEMINI_REFRESH_WINDOW_MS = 30 * 60_000;  // Gemini tokens expire in 1h
const CLAUDE_REFRESH_WINDOW_MS = 30 * 60_000;  // Claude tokens expire in 1h
const AUTH_EXPIRED_REPAIR_RETRY_MS = 60 * 60_000;

async function refreshExpiringTokens(): Promise<void> {
    // OpenAI — refresh 24h before expiry
    const openaiThreshold = Date.now() + OPENAI_REFRESH_WINDOW_MS;
    const authExpiredRetryBefore = Date.now() - AUTH_EXPIRED_REPAIR_RETRY_MS;
    const expiringOpenAI = await getExpiringOpenAIAccounts(openaiThreshold, authExpiredRetryBefore);

    for (const account of expiringOpenAI) {
        console.log(`[worker] Refreshing OpenAI token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No refresh token for ${account.label} — marking auth_expired`);
            await markAccountAuthExpired(account.id, 'No refresh token — reconnect required');
            invalidateAccountPool('openai');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, refreshToken: newRefresh, expiresAt } = await refreshOpenAIToken(tokens.refreshToken);
            await updateAccountTokens(account.id, accessToken, newRefresh, expiresAt);
            invalidateAccountPool('openai');
            console.log(`[worker] Refreshed OpenAI token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh OpenAI for ${account.label}:`, msg);
            await markAccountAuthExpired(account.id, `Token refresh failed: ${msg}`);
            invalidateAccountPool('openai');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token refresh failed: ${msg}` });
        }
    }

    // Gemini — refresh 30min before expiry (tokens last only 1h)
    const geminiThreshold = Date.now() + GEMINI_REFRESH_WINDOW_MS;
    const expiringGemini = await getExpiringGeminiAccounts(geminiThreshold, authExpiredRetryBefore);

    for (const account of expiringGemini) {
        console.log(`[worker] Refreshing Gemini token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No Gemini refresh token for ${account.label} — marking auth_expired`);
            await markAccountAuthExpired(account.id, 'No refresh token — reconnect required');
            invalidateAccountPool('gemini');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'gemini', kind: 'auth_expired', message: `${account.label} — Gemini token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, expiresAt } = await refreshGeminiToken(tokens.refreshToken);
            await updateAccountTokens(account.id, accessToken, tokens.refreshToken, expiresAt);
            invalidateAccountPool('gemini');
            console.log(`[worker] Refreshed Gemini token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh Gemini for ${account.label}:`, msg);
            await markAccountAuthExpired(account.id, `Token refresh failed: ${msg}`);
            invalidateAccountPool('gemini');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'gemini', kind: 'auth_expired', message: `${account.label} — Gemini token refresh failed: ${msg}` });
        }
    }

    // Claude — refresh 30min before expiry (tokens last only 1h)
    const claudeThreshold = Date.now() + CLAUDE_REFRESH_WINDOW_MS;
    const expiringClaude = await getExpiringClaudeAccounts(claudeThreshold, authExpiredRetryBefore);

    for (const account of expiringClaude) {
        console.log(`[worker] Refreshing Claude token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No Claude refresh token for ${account.label} — marking auth_expired`);
            await markAccountAuthExpired(account.id, 'No refresh token — reconnect required');
            invalidateAccountPool('claude');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'claude', kind: 'auth_expired', message: `${account.label} — Claude token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, refreshToken: newRefresh, expiresAt } = await refreshClaudeToken(tokens.refreshToken);
            // Anthropic rotates refresh tokens — store the new one
            await updateAccountTokens(account.id, accessToken, newRefresh, expiresAt);
            invalidateAccountPool('claude');
            console.log(`[worker] Refreshed Claude token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh Claude for ${account.label}:`, msg);
            await markAccountAuthExpired(account.id, `Token refresh failed: ${msg}`);
            invalidateAccountPool('claude');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'claude', kind: 'auth_expired', message: `${account.label} — Claude token refresh failed: ${msg}` });
        }
    }
}

async function refreshDedicatedAccounts(): Promise<void> {
    const threshold = Date.now() + OPENAI_REFRESH_WINDOW_MS;
    const authExpiredRetryBefore = Date.now() - AUTH_EXPIRED_REPAIR_RETRY_MS;
    const expiring = await getExpiringDedicatedAccounts(threshold, authExpiredRetryBefore);

    for (const account of expiring) {
        const label = account.label ?? account.owner_app;
        console.log(`[worker] Refreshing dedicated OpenAI token for ${label} (owner: ${account.owner_app})`);
        const tokens = await getDecryptedDedicatedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No refresh token for dedicated account ${label} — marking auth_expired`);
            await setDedicatedStatus(account.id, 'auth_expired', 'No refresh token — reconnect required');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `Dedicated account ${label} (${account.owner_app}) — token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, refreshToken: newRefresh, expiresAt } = await refreshOpenAIToken(tokens.refreshToken);
            await updateDedicatedTokens(account.id, accessToken, newRefresh, expiresAt);
            console.log(`[worker] Refreshed dedicated token for ${label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh dedicated token for ${label}:`, msg);
            await setDedicatedStatus(account.id, 'auth_expired', msg);
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `Dedicated account ${label} (${account.owner_app}) — token refresh failed: ${msg}` });
        }
    }
}

async function fireUnsentAlerts(): Promise<void> {
    const pending = await getUnEmailedAlerts();
    for (const alert of pending) {
        await sendAlert({ subject: `[Gateway] ${alert.kind}`, message: alert.message, kind: alert.kind, accountLabel: alert.account_id });
        await markAlertEmailed(alert.id);
    }
}

async function tick(): Promise<void> {
    try {
        await resetExpiredCooldowns();
        invalidateAccountPool();
        await refreshExpiringTokens();
        await refreshDedicatedAccounts();
        // Clear alerts whose underlying condition has cleared BEFORE emailing,
        // so recovered accounts don't generate another notification.
        const resolved = await autoResolveRecoveredAlerts();
        if (resolved > 0) console.log(`[worker] auto-resolved ${resolved} recovered alert(s)`);
        await fireUnsentAlerts();
    } catch (err: unknown) {
        // Log the full error (some DB/DNS errors have an empty .message)
        const e = err as { message?: string; code?: string; name?: string };
        console.error('[worker] Tick error:', e.message || e.code || e.name || String(err));
    }
}

console.log('[worker] Starting — interval:', CHECK_INTERVAL_MS / 1000, 's');
tick();
setInterval(tick, CHECK_INTERVAL_MS);
