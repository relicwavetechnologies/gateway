import {
    listActiveAccounts,
    updateAccountStatus,
    recordAccountSuccess,
    recordAccountError,
    ActiveAccount,
} from '../db/accounts.js';

// ─── Round-robin counters ─────────────────────────────────────────────────────
const counters: Record<string, number> = { openai: 0, claude: 0, gemini: 0 };

// ─── In-memory short cooldown ─────────────────────────────────────────────────
// Tracks temporarily hot accounts WITHOUT touching the DB.
// Accounts recover automatically when the timer expires — no admin intervention.
// Key: accountId, Value: cooldown-until timestamp (ms)
const inMemoryCooldown = new Map<string, number>();

// Consecutive failure counter per account (resets on success)
const consecutiveFailures = new Map<string, number>();

function isOnCooldown(accountId: string): boolean {
    const until = inMemoryCooldown.get(accountId);
    if (!until) return false;
    if (Date.now() >= until) {
        inMemoryCooldown.delete(accountId);
        return false;
    }
    return true;
}

function setCooldown(accountId: string, seconds: number) {
    inMemoryCooldown.set(accountId, Date.now() + seconds * 1_000);
}

// ─── Error classification ─────────────────────────────────────────────────────
export type ErrorKind =
    | 'rate_limit'    // 429 — short cooldown, try another account
    | 'auth_expired'  // 401 — mark dead in DB, try another account
    | 'server_error'  // 5xx, timeout — transient, try another
    | 'hard_fail'     // 400, 403, 404, 422 — bad request, don't retry
    | 'unknown';

export function classifyError(statusCode: number, message?: string): ErrorKind {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401) return 'auth_expired';
    if ([500, 502, 503, 504].includes(statusCode)) return 'server_error';
    if ([400, 403, 404, 422].includes(statusCode)) return 'hard_fail';
    if (statusCode === 0 || message?.toLowerCase().includes('timeout') || message?.toLowerCase().includes('econnreset')) return 'server_error';
    if (statusCode >= 500) return 'server_error';
    return 'unknown';
}

// ─── Account health score ─────────────────────────────────────────────────────
function healthScore(account: ActiveAccount): number {
    const errors = account.error_count ?? 0;
    const requests = account.request_count ?? 0;
    const lastUsed = account.last_used_at ?? 0;
    const idleBonus = Date.now() - lastUsed > 60_000 ? -5 : 0;
    const errorRate = requests > 10 ? (errors / requests) * 10 : 0; // ignore error rate on new accounts
    return errorRate + idleBonus;
}

// ─── Legacy single-pick (used by voice route) ────────────────────────────────
export async function pickAccount(provider: string): Promise<ActiveAccount> {
    const candidates = await getAllAccounts(provider);
    if (!candidates.length) throw Object.assign(new Error(`No active ${provider} accounts available`), { code: 'NO_ACCOUNTS' });
    const idx = counters[provider] % candidates.length;
    counters[provider] = (counters[provider] + 1) % Number.MAX_SAFE_INTEGER;
    return candidates[idx];
}

// ─── Get all usable accounts for a provider ───────────────────────────────────
// Returns active DB accounts that are not on in-memory cooldown,
// sorted by health (best first).
export async function getAllAccounts(provider: string): Promise<ActiveAccount[]> {
    const all = await listActiveAccounts(provider);
    return all
        .filter(a => !isOnCooldown(a.id))
        .sort((a, b) => healthScore(a) - healthScore(b));
}

// Also include cooldown accounts as last-resort fallback
export async function getAllAccountsIncludingCooldown(provider: string): Promise<ActiveAccount[]> {
    const all = await listActiveAccounts(provider);
    const fresh = all.filter(a => !isOnCooldown(a.id)).sort((a, b) => healthScore(a) - healthScore(b));
    const cooled = all.filter(a => isOnCooldown(a.id)).sort((a, b) => healthScore(a) - healthScore(b));
    return [...fresh, ...cooled];
}

// ─── Status mutations ─────────────────────────────────────────────────────────

export async function handleRateLimit(accountId: string): Promise<void> {
    const failures = (consecutiveFailures.get(accountId) ?? 0) + 1;
    consecutiveFailures.set(accountId, failures);

    // In-memory only — never write to DB for rate limits.
    // Cooldown scales with consecutive failures: 10s → 30s → 60s → 120s
    // Single account = recovers in seconds, not minutes.
    const seconds = Math.min(10 * Math.pow(2, failures - 1), 120);
    setCooldown(accountId, seconds);
    await recordAccountError(accountId, 'rate_limited');
    console.log(`[lb] rate limit: ${accountId} — cooldown ${seconds}s (failure #${failures})`);
}

export async function handleAuthError(accountId: string): Promise<void> {
    // Auth failures ARE written to DB — they need admin attention to fix
    consecutiveFailures.delete(accountId);
    await updateAccountStatus(accountId, 'auth_expired', 0);
    await recordAccountError(accountId, 'auth_expired');
}

export async function handleServerError(accountId: string, error: string): Promise<void> {
    const failures = (consecutiveFailures.get(accountId) ?? 0) + 1;
    consecutiveFailures.set(accountId, failures);
    // Short in-memory cooldown for transient errors: 5s → 15s → 30s
    const seconds = Math.min(5 * Math.pow(2, failures - 1), 30);
    setCooldown(accountId, seconds);
    await recordAccountError(accountId, error);
}

export async function handleSuccess(accountId: string): Promise<void> {
    // Clear failure streak on success
    consecutiveFailures.delete(accountId);
    inMemoryCooldown.delete(accountId);
    await recordAccountSuccess(accountId);
}

export async function handleUnknownError(accountId: string, error: string): Promise<void> {
    await recordAccountError(accountId, error);
}
