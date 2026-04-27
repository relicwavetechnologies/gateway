import '../utils/env.js';
import { getDecryptedTokens, updateAccountTokens, updateAccountStatus, getExpiringOpenAIAccounts, resetExpiredCooldowns } from '../db/accounts.js';
import { createAlert, markAlertEmailed, getUnEmailedAlerts } from '../db/usage.js';
import { refreshToken } from '../oauth/openai.js';
import { sendAlert } from '../utils/email.js';
import { v4 as uuid } from 'uuid';

const CHECK_INTERVAL_MS = 5 * 60_000;
const REFRESH_WINDOW_MS = 24 * 60 * 60_000;

async function refreshExpiringTokens(): Promise<void> {
    const threshold = Date.now() + REFRESH_WINDOW_MS;
    const expiring = await getExpiringOpenAIAccounts(threshold);

    for (const account of expiring) {
        console.log(`[worker] Refreshing token for ${account.label}`);
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.refreshToken) {
            console.warn(`[worker] No refresh token for ${account.label} — marking auth_expired`);
            await updateAccountStatus(account.id, 'auth_expired', 0);
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token expired and no refresh token. Reconnect needed.` });
            continue;
        }

        try {
            const { accessToken, refreshToken: newRefresh, expiresAt } = await refreshToken(tokens.refreshToken);
            await updateAccountTokens(account.id, accessToken, newRefresh, expiresAt);
            console.log(`[worker] Refreshed token for ${account.label}, expires ${expiresAt}`);
        } catch (err: unknown) {
            const msg = (err as Error).message;
            console.error(`[worker] Failed to refresh for ${account.label}:`, msg);
            await updateAccountStatus(account.id, 'auth_expired', 0);
            await createAlert({ id: uuid(), accountId: account.id, provider: 'openai', kind: 'auth_expired', message: `${account.label} — token refresh failed: ${msg}` });
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
