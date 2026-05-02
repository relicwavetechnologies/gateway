import {
    listActiveAccounts,
    updateAccountStatus,
    recordAccountSuccess,
    recordAccountError,
    ActiveAccount,
} from '../db/accounts.js';

// ─── In-memory state ──────────────────────────────────────────────────────────

// Updated the moment an account is SELECTED (not when the request finishes).
// This is the key difference from using DB's last_used_at — if two requests
// arrive concurrently, the second one sees the first account as "just assigned"
// and picks a different one, preventing the thundering-herd double-hit.
const lastAssigned = new Map<string, number>();

// Key: accountId → cooldown-until timestamp (ms). Rate-limit cooldowns live
// here only — never written to DB — so they expire in seconds, not minutes.
const inMemoryCooldown = new Map<string, number>();

// Consecutive failure streak per account — resets on success, drives backoff.
const consecutiveFailures = new Map<string, number>();

// ─── Cooldown helpers ─────────────────────────────────────────────────────────

function isOnCooldown(accountId: string): boolean {
    const until = inMemoryCooldown.get(accountId);
    if (!until) return false;
    if (Date.now() >= until) { inMemoryCooldown.delete(accountId); return false; }
    return true;
}

// Adds ±10% jitter so multiple cooling accounts don't all recover at the same
// instant and create a request burst (thundering-herd prevention).
function setCooldown(accountId: string, seconds: number): void {
    const jitter = (Math.random() * 0.2 - 0.1) * seconds; // ±10%
    inMemoryCooldown.set(accountId, Date.now() + (seconds + jitter) * 1_000);
}

// ─── Error classification ─────────────────────────────────────────────────────

export type ErrorKind =
    | 'rate_limit'    // 429 — short cooldown, try another account
    | 'auth_expired'  // 401 — mark dead in DB, needs admin fix
    | 'server_error'  // 5xx / timeout — transient, try another account
    | 'hard_fail'     // 400 / 403 / 404 / 422 — bad request, don't retry
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

// ─── LRU priority score ───────────────────────────────────────────────────────
// Lower score = picked first.
//
// Core idea: always pick the account that was used (or assigned) furthest in
// the past — Least Recently Used. This naturally spreads quota evenly across
// all accounts without needing a counter or explicit round-robin.
//
// Error penalty biases heavily-failing accounts toward the back of the queue
// without excluding them entirely — they'll still be tried if everything else
// is cooling down.
function accountPriority(account: ActiveAccount): number {
    // Use the more recent of: in-memory assignment time OR DB last_used_at.
    // lastAssigned is more accurate for concurrent requests since it's set
    // before the request even finishes.
    const lastUsed = Math.max(
        lastAssigned.get(account.id) ?? 0,
        account.last_used_at ? Number(account.last_used_at) : 0,
    );

    const idleMs = Date.now() - lastUsed;

    // Only penalise error rate once we have enough samples (avoids punishing
    // brand-new accounts that haven't had a chance to prove themselves).
    const requests = Number(account.request_count ?? 0);
    const errors   = Number(account.error_count   ?? 0);
    const errorPenalty = requests >= 5 ? (errors / requests) * 60_000 : 0;

    // Negative idle: longer idle → more negative → lower score → picked first.
    // Error penalty: more errors → larger positive → higher score → picked last.
    return -idleMs + errorPenalty;
}

// ─── Account selectors ────────────────────────────────────────────────────────

// Returns fresh accounts sorted by LRU priority.
// Marks the top account as assigned RIGHT NOW to prevent two concurrent
// requests from both selecting the same account.
export async function getAllAccounts(provider: string): Promise<ActiveAccount[]> {
    const all = await listActiveAccounts(provider);
    const sorted = all
        .filter(a => !isOnCooldown(a.id))
        .sort((a, b) => accountPriority(a) - accountPriority(b));
    if (sorted.length > 0) lastAssigned.set(sorted[0].id, Date.now());
    return sorted;
}

// Same as getAllAccounts but appends cooling-down accounts at the end as a
// last-resort fallback — better to try a throttled account than fail outright.
export async function getAllAccountsIncludingCooldown(provider: string): Promise<ActiveAccount[]> {
    const all = await listActiveAccounts(provider);
    const fresh  = all.filter(a => !isOnCooldown(a.id)).sort((a, b) => accountPriority(a) - accountPriority(b));
    const cooled = all.filter(a =>  isOnCooldown(a.id)).sort((a, b) => accountPriority(a) - accountPriority(b));

    // Mark the top fresh account as assigned now (concurrency safety).
    if (fresh.length > 0) lastAssigned.set(fresh[0].id, Date.now());

    return [...fresh, ...cooled];
}

// Legacy alias kept for the voice route (single-pick semantics).
export async function pickAccount(provider: string): Promise<ActiveAccount> {
    const candidates = await getAllAccounts(provider);
    if (!candidates.length) throw Object.assign(
        new Error(`No active ${provider} accounts available`), { code: 'NO_ACCOUNTS' },
    );
    return candidates[0]; // getAllAccounts already LRU-sorted and marked assigned
}

// ─── Status mutations ─────────────────────────────────────────────────────────

export async function handleRateLimit(accountId: string): Promise<void> {
    const failures = (consecutiveFailures.get(accountId) ?? 0) + 1;
    consecutiveFailures.set(accountId, failures);

    // Exponential backoff: 10s → 20s → 40s → 80s → 120s cap.
    // Jitter (built into setCooldown) desynchronises concurrent expirations.
    const seconds = Math.min(10 * Math.pow(2, failures - 1), 120);
    setCooldown(accountId, seconds);
    await recordAccountError(accountId, 'rate_limited');
    console.log(`[lb] rate limit: ${accountId} — cooldown ${seconds.toFixed(0)}s (failure #${failures})`);
}

export async function handleAuthError(accountId: string): Promise<void> {
    // Auth failures are permanent — write to DB so the admin panel shows them.
    consecutiveFailures.delete(accountId);
    lastAssigned.delete(accountId);
    await updateAccountStatus(accountId, 'auth_expired', 0);
    await recordAccountError(accountId, 'auth_expired');
}

export async function handleServerError(accountId: string, error: string): Promise<void> {
    const failures = (consecutiveFailures.get(accountId) ?? 0) + 1;
    consecutiveFailures.set(accountId, failures);
    // Short backoff for transient errors: 5s → 10s → 20s → 30s cap.
    const seconds = Math.min(5 * Math.pow(2, failures - 1), 30);
    setCooldown(accountId, seconds);
    await recordAccountError(accountId, error);
}

export async function handleSuccess(accountId: string): Promise<void> {
    consecutiveFailures.delete(accountId);
    inMemoryCooldown.delete(accountId);
    // Keep lastAssigned — it's the LRU anchor and should reflect actual use.
    await recordAccountSuccess(accountId);
}

export async function handleUnknownError(accountId: string, error: string): Promise<void> {
    await recordAccountError(accountId, error);
}
