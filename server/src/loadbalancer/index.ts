import {
    updateAccountStatus,
    recordAccountSuccess,
    recordAccountError,
    markAccountRateLimited,
    ActiveAccount,
} from '../db/accounts.js';
import { getCachedActiveAccounts, invalidateAccountPool } from '../cache/hotpath.js';

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

// ─── Scoring weights (all in "ms of effective recency") ────────────────────────
// Everything is expressed on the same idle-time scale so the terms compose
// predictably. No giant tier bonus — quota headroom does the favouring instead.
const QUOTA_PRESSURE_MS    = 60 * 60_000;       // 100% quota used ≈ +1h penalty
const NEAR_LIMIT_PCT       = 90;                // at/above this, avoid pre-emptively
const NEAR_LIMIT_PENALTY_MS = 6 * 60 * 60_000;  // shove near-exhausted accounts to the back
const ERROR_PENALTY_MS     = 60_000;            // small bias off flaky accounts

// When a 429 arrives but we have no reset header to derive a real cooldown from,
// bench the account for this long (optimistic — quota windows reset in hours).
const OPENAI_RATE_LIMIT_FALLBACK_MS = 30 * 60_000;

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

// ─── Quota helper ───────────────────────────────────────────────────────────
// Highest used-% across the codex windows we track (5h primary + weekly
// secondary), or null when we have no telemetry for this account. A window
// whose reset timestamp has already passed is treated as fresh (0%) — the
// stored % is stale the instant the window rolls over.
export function quotaUsedPercent(account: ActiveAccount): number | null {
    const nowMs = Date.now();
    const primary = account.codex_primary_reset && Number(account.codex_primary_reset) < nowMs
        ? 0 : account.codex_primary_pct;
    const secondary = account.codex_secondary_reset && Number(account.codex_secondary_reset) < nowMs
        ? 0 : account.codex_secondary_pct;
    const vals = [primary, secondary].map(v => Number(v)).filter(v => Number.isFinite(v));
    return vals.length ? Math.max(...vals) : null;
}

// ─── Priority score ───────────────────────────────────────────────────────────
// Lower score = picked first.
//
// Base = Least-Recently-Used: always pick the account used (or assigned)
// furthest in the past, which spreads load evenly without an explicit counter.
//
// Quota pressure is layered on top: the more of its quota an account has burned,
// the further back it goes. This is what makes balancing SMART — it favours
// accounts with real headroom, so higher-limit (pro/team) accounts naturally
// absorb more traffic (their used-% climbs slower) WITHOUT a brittle hard-coded
// tier bonus, and an account approaching its limit is avoided *before* it 429s.
//
// Nothing here EXCLUDES an account — a maxed/flaky account just sinks to the
// back and is still used as a last resort if everything else is busy.
export function accountPriority(account: ActiveAccount): number {
    // Use the more recent of: in-memory assignment time OR DB last_used_at.
    // lastAssigned is more accurate for concurrent requests since it's set
    // before the request even finishes.
    const lastUsed = Math.max(
        lastAssigned.get(account.id) ?? 0,
        account.last_used_at ? Number(account.last_used_at) : 0,
    );

    // Negative idle: longer idle → more negative → lower score → picked first.
    let score = -(Date.now() - lastUsed);

    // Quota pressure: proportional push-back as quota fills, plus a hard shove
    // once an account is near its limit so we steer away from it pre-emptively.
    const quota = quotaUsedPercent(account);
    if (quota !== null) {
        score += (quota / 100) * QUOTA_PRESSURE_MS;
        if (quota >= NEAR_LIMIT_PCT) score += NEAR_LIMIT_PENALTY_MS;
    }

    // Error penalty: bias away from flaky accounts, but only once we have enough
    // samples (avoids punishing brand-new accounts that haven't proven themselves).
    const requests = Number(account.request_count ?? 0);
    const errors   = Number(account.error_count   ?? 0);
    if (requests >= 5) score += (errors / requests) * ERROR_PENALTY_MS;

    return score;
}

// ─── Account selectors ────────────────────────────────────────────────────────

// Returns fresh accounts sorted by LRU priority.
// Marks the top account as assigned RIGHT NOW to prevent two concurrent
// requests from both selecting the same account.
export async function getAllAccounts(provider: string): Promise<ActiveAccount[]> {
    const all = await getCachedActiveAccounts(provider);
    const sorted = all
        .filter(a => !isOnCooldown(a.id))
        .sort((a, b) => accountPriority(a) - accountPriority(b));
    if (sorted.length > 0) lastAssigned.set(sorted[0].id, Date.now());
    return sorted;
}

// Same as getAllAccounts but appends cooling-down accounts at the end as a
// last-resort fallback — better to try a throttled account than fail outright.
export async function getAllAccountsIncludingCooldown(provider: string): Promise<ActiveAccount[]> {
    const all = await getCachedActiveAccounts(provider);
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

export async function handleRateLimit(account: ActiveAccount, error: string): Promise<number | null> {
    const accountId = account.id;

    if (account.provider === 'openai') {
        // Bench only until the quota actually resets. Prefer the soonest future
        // reset reported by the codex headers; fall back to a short window when
        // we have no telemetry. This is the "optimistic" part — we don't sideline
        // an account for hours/days when its 5h window resets shortly.
        const nowMs = Date.now();
        const resets = [account.codex_primary_reset, account.codex_secondary_reset]
            .map(r => Number(r))
            .filter(r => Number.isFinite(r) && r > nowMs);
        const cooldownUntil = resets.length
            ? Math.min(...resets)
            : nowMs + OPENAI_RATE_LIMIT_FALLBACK_MS;

        consecutiveFailures.delete(accountId);
        lastAssigned.delete(accountId);
        inMemoryCooldown.delete(accountId);
        await markAccountRateLimited(accountId, cooldownUntil, error);
        invalidateAccountPool(account.provider);

        console.log(
            `[lb] openai rate limit: ${accountId} (${account.account_tier}) — cooldown until ${new Date(cooldownUntil).toISOString()} (reset-derived=${resets.length > 0})`,
        );
        return cooldownUntil;
    }

    // Exponential backoff: 10s → 20s → 40s → 80s → 120s cap.
    // Jitter (built into setCooldown) desynchronises concurrent expirations.
    const failures = (consecutiveFailures.get(accountId) ?? 0) + 1;
    consecutiveFailures.set(accountId, failures);
    const seconds = Math.min(10 * Math.pow(2, failures - 1), 120);
    setCooldown(accountId, seconds);
    await recordAccountError(accountId, error);
    console.log(`[lb] rate limit: ${accountId} — cooldown ${seconds.toFixed(0)}s (failure #${failures})`);
    return Date.now() + seconds * 1_000;
}

export async function handleAuthError(accountId: string, provider?: string): Promise<void> {
    // Auth failures are permanent — write to DB so the admin panel shows them.
    consecutiveFailures.delete(accountId);
    lastAssigned.delete(accountId);
    await updateAccountStatus(accountId, 'auth_expired', 0);
    await recordAccountError(accountId, 'auth_expired');
    invalidateAccountPool(provider);
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
