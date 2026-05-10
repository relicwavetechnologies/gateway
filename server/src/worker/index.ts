import '../utils/env.js';
import { getDecryptedTokens, updateAccountTokens, updateAccountStatus, getExpiringOpenAIAccounts, getExpiringGeminiAccounts, getExpiringClaudeAccounts, resetExpiredCooldowns } from '../db/accounts.js';
import { getExpiringDedicatedAccounts, getDecryptedDedicatedTokens, updateDedicatedTokens, setDedicatedStatus } from '../db/dedicated-accounts.js';
import { createAlert, markAlertEmailed, getUnEmailedAlerts } from '../db/usage.js';
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

async function refreshExpiringTokens(): Promise<void> {
    // OpenAI — refresh 24h before expiry
    const openaiThreshold = Date.now() + OPENAI_REFRESH_WINDOW_MS;
    const expiringOpenAI = await getExpiringOpenAIAccounts(openaiThreshold);

    for (const account of expiringOpenAI) {
        console.log(`[worker] Refreshing OpenAI token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No refresh token for ${account.label} — marking auth_expired`);
            await updateAccountStatus(account.id, 'auth_expired', 0);
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
            await updateAccountStatus(account.id, 'auth_expired', 0);
            invalidateAccountPool('openai');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token refresh failed: ${msg}` });
        }
    }

    // Gemini — refresh 30min before expiry (tokens last only 1h)
    const geminiThreshold = Date.now() + GEMINI_REFRESH_WINDOW_MS;
    const expiringGemini = await getExpiringGeminiAccounts(geminiThreshold);

    for (const account of expiringGemini) {
        console.log(`[worker] Refreshing Gemini token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No Gemini refresh token for ${account.label} — marking auth_expired`);
            await updateAccountStatus(account.id, 'auth_expired', 0);
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
            await updateAccountStatus(account.id, 'auth_expired', 0);
            invalidateAccountPool('gemini');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'gemini', kind: 'auth_expired', message: `${account.label} — Gemini token refresh failed: ${msg}` });
        }
    }

    // Claude — refresh 30min before expiry (tokens last only 1h)
    const claudeThreshold = Date.now() + CLAUDE_REFRESH_WINDOW_MS;
    const expiringClaude = await getExpiringClaudeAccounts(claudeThreshold);

    for (const account of expiringClaude) {
        console.log(`[worker] Refreshing Claude token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No Claude refresh token for ${account.label} — marking auth_expired`);
            await updateAccountStatus(account.id, 'auth_expired', 0);
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
            await updateAccountStatus(account.id, 'auth_expired', 0);
            invalidateAccountPool('claude');
            await createAlert({ id: uuid(), accountId: account.id, provider: 'claude', kind: 'auth_expired', message: `${account.label} — Claude token refresh failed: ${msg}` });
        }
    }
}

async function refreshDedicatedAccounts(): Promise<void> {
    const threshold = Date.now() + OPENAI_REFRESH_WINDOW_MS;
    const expiring = await getExpiringDedicatedAccounts(threshold);

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
        await fireUnsentAlerts();
    } catch (err: unknown) {
        console.error('[worker] Tick error:', (err as Error).message);
    }
}

console.log('[worker] Starting — interval:', CHECK_INTERVAL_MS / 1000, 's');
tick();
setInterval(tick, CHECK_INTERVAL_MS);
