import '../utils/env.js';
import { getDecryptedTokens, updateAccountTokens, updateAccountStatus, getExpiringOpenAIAccounts, getExpiringGeminiAccounts, resetExpiredCooldowns } from '../db/accounts.js';
import { createAlert, markAlertEmailed, getUnEmailedAlerts } from '../db/usage.js';
import { refreshToken as refreshOpenAIToken } from '../oauth/openai.js';
import { refreshGeminiToken } from '../oauth/gemini.js';
import { sendAlert } from '../utils/email.js';
import { v4 as uuid } from 'uuid';

const CHECK_INTERVAL_MS = 5 * 60_000;
const OPENAI_REFRESH_WINDOW_MS = 24 * 60 * 60_000;
const GEMINI_REFRESH_WINDOW_MS = 30 * 60_000; // Gemini tokens expire in 1h — refresh within 30min

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
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, refreshToken: newRefresh, expiresAt } = await refreshOpenAIToken(tokens.refreshToken);
            await updateAccountTokens(account.id, accessToken, newRefresh, expiresAt);
            console.log(`[worker] Refreshed OpenAI token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh OpenAI for ${account.label}:`, msg);
            await updateAccountStatus(account.id, 'auth_expired', 0);
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
            await createAlert({ id: uuid(), accountId: account.id, provider: 'gemini', kind: 'auth_expired', message: `${account.label} — Gemini token expired and no refresh token. Reconnect needed.` });
            continue;
        }
        try {
            const { accessToken, expiresAt } = await refreshGeminiToken(tokens.refreshToken);
            await updateAccountTokens(account.id, accessToken, tokens.refreshToken, expiresAt);
            console.log(`[worker] Refreshed Gemini token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh Gemini for ${account.label}:`, msg);
            await updateAccountStatus(account.id, 'auth_expired', 0);
            await createAlert({ id: uuid(), accountId: account.id, provider: 'gemini', kind: 'auth_expired', message: `${account.label} — Gemini token refresh failed: ${msg}` });
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
        await refreshExpiringTokens();
        await fireUnsentAlerts();
    } catch (err: unknown) {
        console.error('[worker] Tick error:', (err as Error).message);
    }
}

console.log('[worker] Starting — interval:', CHECK_INTERVAL_MS / 1000, 's');
tick();
setInterval(tick, CHECK_INTERVAL_MS);
