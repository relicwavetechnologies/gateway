import {
    listActiveAccounts,
    updateAccountStatus,
    recordAccountSuccess,
    recordAccountError,
    ActiveAccount,
} from '../db/accounts.js';

// ─── Round-robin counters ─────────────────────────────────────────────────────
const counters: Record<string, number> = { openai: 0, claude: 0, gemini: 0 };

// ─── Error classification ─────────────────────────────────────────────────────
export type ErrorKind =
    | 'rate_limit'    // 429 — cooldown, try another account
    | 'auth_expired'  // 401 — mark dead, try another account
    | 'server_error'  // 5xx, timeout, empty response — transient, try another
    | 'hard_fail'     // 400, 403, 422 — bad request, don't retry
    | 'unknown';

export function classifyError(statusCode: number, message?: string): ErrorKind {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401) return 'auth_expired';
    if ([500, 502, 503, 504].includes(statusCode)) return 'server_error';
    if ([400, 403, 404, 422].includes(statusCode)) return 'hard_fail';
    // Treat network/timeout errors as transient
    if (statusCode === 0 || message?.toLowerCase().includes('timeout') || message?.toLowerCase().includes('network')) return 'server_error';
    if (statusCode >= 500) return 'server_error';
    return 'unknown';
}

// ─── Account health score ─────────────────────────────────────────────────────
// Lower score = healthier. Used to sort candidates before picking.
function healthScore(account: ActiveAccount): number {
    const errors = account.error_count ?? 0;
    const requests = account.request_count ?? 0;
    const lastUsed = account.last_used_at ?? 0;
    const idleBonus = Date.now() - lastUsed > 60_000 ? -5 : 0; // prefer idle accounts
    const errorRate = requests > 0 ? (errors / requests) * 10 : 0;
    return errorRate + idleBonus;
}

// ─── Pick next account (round-robin within health-sorted pool) ────────────────
export async function pickAccount(provider: string, excludeIds: string[] = []): Promise<ActiveAccount> {
    const all = await listActiveAccounts(provider);
    const candidates = all
        .filter(a => !excludeIds.includes(a.id))
        .sort((a, b) => healthScore(a) - healthScore(b));

    if (!candidates.length) {
        throw Object.assign(
            new Error(`No active ${provider} accounts available`),
            { code: 'NO_ACCOUNTS' },
        );
    }

    const idx = counters[provider] % candidates.length;
    counters[provider] = (counters[provider] + 1) % Number.MAX_SAFE_INTEGER;
    return candidates[idx];
}

// ─── Pick ALL active accounts (for exhaustive retry) ─────────────────────────
export async function getAllAccounts(provider: string): Promise<ActiveAccount[]> {
    const all = await listActiveAccounts(provider);
    return all.sort((a, b) => healthScore(a) - healthScore(b));
}

// ─── Status mutations ─────────────────────────────────────────────────────────

// Progressive cooldowns: each consecutive error doubles the cooldown (5→15→30→60 min)
export async function handleRateLimit(accountId: string, errorCount: number): Promise<void> {
    const cooldown = Math.min(5 * Math.pow(2, Math.floor((errorCount - 1) / 2)), 60);
    await updateAccountStatus(accountId, 'rate_limited', cooldown);
    await recordAccountError(accountId, 'rate_limited');
}

export async function handleAuthError(accountId: string): Promise<void> {
    await updateAccountStatus(accountId, 'auth_expired', 0);
    await recordAccountError(accountId, 'auth_expired');
}

export async function handleServerError(accountId: string, error: string): Promise<void> {
    // Short cooldown for transient server errors (2 min) so account recovers quickly
    await updateAccountStatus(accountId, 'rate_limited', 2);
    await recordAccountError(accountId, error);
}

export async function handleSuccess(accountId: string): Promise<void> {
    await recordAccountSuccess(accountId);
}

export async function handleUnknownError(accountId: string, error: string): Promise<void> {
    await recordAccountError(accountId, error);
}
