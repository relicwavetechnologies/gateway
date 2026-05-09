import sql from './index.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export interface Account {
    id: string;
    provider: 'openai' | 'claude' | 'gemini';
    label: string;
    account_tier: 'free' | 'pro';
    status: 'active' | 'rate_limited' | 'auth_expired' | 'error' | 'disabled';
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    oauth_expires_at: number | null;
    cooldown_until: number | null;
    request_count: number;
    error_count: number;
    last_error: string | null;
    last_used_at: number | null;
    codex_plan_type: string | null;
    codex_primary_pct: number | null;
    codex_primary_reset: number | null;
    codex_secondary_pct: number | null;
    codex_secondary_reset: number | null;
    codex_credits: number | null;
    codex_updated_at: number | null;
    recovered_at: number | null;
    created_at: number;
    created_by: string;
}

export interface ActiveAccount extends Omit<Account, 'access_token_enc' | 'refresh_token_enc'> {
    access_token: string | null;
}

export type PublicAccount = Omit<Account, 'access_token_enc' | 'refresh_token_enc'>;

const now = () => Date.now();

export interface CodexHeaders {
    planType?: string;
    primaryPct?: number;
    primaryResetSeconds?: number;
    secondaryPct?: number;
    secondaryResetSeconds?: number;
    credits?: number;
}

function finiteNumber(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export async function getExpiringGeminiAccounts(threshold: number): Promise<Pick<Account, 'id' | 'label'>[]> {
    return sql<Pick<Account, 'id' | 'label'>[]>`
        SELECT id, label FROM accounts
        WHERE provider = 'gemini'
          AND status IN ('active', 'rate_limited')
          AND oauth_expires_at IS NOT NULL
          AND oauth_expires_at < ${threshold}
    `;
}

export async function getExpiringClaudeAccounts(threshold: number): Promise<Pick<Account, 'id' | 'label'>[]> {
    return sql<Pick<Account, 'id' | 'label'>[]>`
        SELECT id, label FROM accounts
        WHERE provider = 'claude'
          AND status IN ('active', 'rate_limited')
          AND oauth_expires_at IS NOT NULL
          AND oauth_expires_at < ${threshold}
    `;
}

export async function createAccount(params: {
    id: string;
    provider: 'openai' | 'claude' | 'gemini';
    label: string;
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: Date | null;
    createdBy: string;
    accountTier?: 'free' | 'pro';
}): Promise<PublicAccount> {
    const { id, provider, label, accessToken, refreshToken, expiresAt, createdBy, accountTier = 'free' } = params;
    const [row] = await sql<Account[]>`
        INSERT INTO accounts (id, provider, label, account_tier, access_token_enc, refresh_token_enc, oauth_expires_at, created_at, created_by)
        VALUES (
            ${id}, ${provider}, ${label}, ${accountTier},
            ${accessToken ? encrypt(accessToken) : null},
            ${refreshToken ? encrypt(refreshToken) : null},
            ${expiresAt ? expiresAt.getTime() : null},
            ${now()}, ${createdBy}
        )
        RETURNING *
    `;
    return sanitize(row);
}

export async function getAccount(id: string): Promise<Account | undefined> {
    const [row] = await sql<Account[]>`SELECT * FROM accounts WHERE id = ${id}`;
    return row;
}

export async function listAccounts(): Promise<PublicAccount[]> {
    const rows = await sql<Account[]>`SELECT * FROM accounts ORDER BY created_at DESC`;
    return rows.map(sanitize);
}

export async function listActiveAccounts(provider: string): Promise<ActiveAccount[]> {
    const rows = await sql<Account[]>`
        SELECT * FROM accounts
        WHERE provider = ${provider}
          AND (
              status = 'active'
              OR (status = 'rate_limited' AND cooldown_until IS NOT NULL AND cooldown_until < ${now()})
          )
          AND (cooldown_until IS NULL OR cooldown_until < ${now()})
    `;
    const results: ActiveAccount[] = [];
    for (const row of rows) {
        try {
            results.push({
                ...sanitize(row),
                access_token: row.access_token_enc ? decrypt(row.access_token_enc) : null,
            });
        } catch {
            console.error(`[accounts] decrypt failed for account ${row.id} (${row.label}) — skipping. Re-add this account.`);
        }
    }
    return results;
}

export async function updateAccountStatus(id: string, status: Account['status'], cooldownMinutes = 0): Promise<void> {
    const cooldown_until = cooldownMinutes > 0 ? now() + cooldownMinutes * 60_000 : null;
    await sql`UPDATE accounts SET status = ${status}, cooldown_until = ${cooldown_until} WHERE id = ${id}`;
}

export async function markAccountRateLimited(id: string, cooldownUntil: number, error: string): Promise<void> {
    await sql`
        UPDATE accounts
        SET status = 'rate_limited',
            cooldown_until = ${cooldownUntil},
            error_count = error_count + 1,
            last_error = ${error},
            last_used_at = ${now()}
        WHERE id = ${id}
    `;
}

export async function recordAccountSuccess(id: string): Promise<void> {
    const ts = now();
    await sql`
        UPDATE accounts
        SET request_count = request_count + 1,
            last_used_at = ${ts},
            recovered_at = CASE WHEN status = 'rate_limited' THEN ${ts} ELSE recovered_at END,
            status = CASE WHEN status = 'rate_limited' THEN 'active' ELSE status END,
            cooldown_until = CASE WHEN status = 'rate_limited' THEN NULL ELSE cooldown_until END
        WHERE id = ${id}
    `;
}

export async function updateAccountCodexHeaders(id: string, h: CodexHeaders): Promise<void> {
    const ts = now();
    const updates: Record<string, unknown> = { codex_updated_at: ts };
    const planType = h.planType?.trim().toLowerCase();
    const primaryPct = finiteNumber(h.primaryPct);
    const primaryResetSeconds = finiteNumber(h.primaryResetSeconds);
    const secondaryPct = finiteNumber(h.secondaryPct);
    const secondaryResetSeconds = finiteNumber(h.secondaryResetSeconds);
    const credits = finiteNumber(h.credits);

    if (planType) updates['codex_plan_type'] = planType;
    if (primaryPct !== undefined) updates['codex_primary_pct'] = primaryPct;
    if (primaryResetSeconds !== undefined) updates['codex_primary_reset'] = ts + Math.max(0, primaryResetSeconds) * 1_000;
    if (secondaryPct !== undefined) updates['codex_secondary_pct'] = secondaryPct;
    if (secondaryResetSeconds !== undefined) updates['codex_secondary_reset'] = ts + Math.max(0, secondaryResetSeconds) * 1_000;
    if (credits !== undefined) updates['codex_credits'] = credits;
    if (planType === 'plus' || planType === 'premium') updates['account_tier'] = 'pro';

    await sql`UPDATE accounts SET ${sql(updates)} WHERE id = ${id}`;
}

export async function recordAccountError(id: string, error: string): Promise<void> {
    await sql`
        UPDATE accounts
        SET error_count = error_count + 1, last_error = ${error}, last_used_at = ${now()}
        WHERE id = ${id}
    `;
}

export async function updateAccountTokens(id: string, accessToken: string, refreshToken: string | null, expiresAt: Date | null): Promise<void> {
    await sql`
        UPDATE accounts
        SET access_token_enc = ${encrypt(accessToken)},
            refresh_token_enc = ${refreshToken ? encrypt(refreshToken) : null},
            oauth_expires_at = ${expiresAt ? expiresAt.getTime() : null},
            status = 'active',
            cooldown_until = NULL
        WHERE id = ${id}
    `;
}

export async function patchAccount(id: string, fields: Partial<Pick<Account, 'label' | 'status' | 'account_tier'>>): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (fields.label !== undefined) updates['label'] = fields.label;
    if (fields.account_tier !== undefined) updates['account_tier'] = fields.account_tier;
    if (fields.status !== undefined) {
        updates['status'] = fields.status;
        // Clear cooldown when manually reactivating an account
        if (fields.status === 'active') updates['cooldown_until'] = null;
    }
    if (!Object.keys(updates).length) return;
    await sql`UPDATE accounts SET ${sql(updates)} WHERE id = ${id}`;
}

export async function deleteAccount(id: string): Promise<void> {
    await sql`DELETE FROM accounts WHERE id = ${id}`;
}

export async function getDecryptedTokens(id: string): Promise<{ accessToken: string | null; refreshToken: string | null; expiresAt: Date | null } | null> {
    const [row] = await sql<Pick<Account, 'access_token_enc' | 'refresh_token_enc' | 'oauth_expires_at'>[]>`
        SELECT access_token_enc, refresh_token_enc, oauth_expires_at FROM accounts WHERE id = ${id}
    `;
    if (!row) return null;
    return {
        accessToken: row.access_token_enc ? decrypt(row.access_token_enc) : null,
        refreshToken: row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null,
        expiresAt: row.oauth_expires_at ? new Date(Number(row.oauth_expires_at)) : null,
    };
}

export async function getExpiringOpenAIAccounts(threshold: number): Promise<Pick<Account, 'id' | 'label'>[]> {
    return sql<Pick<Account, 'id' | 'label'>[]>`
        SELECT id, label FROM accounts
        WHERE provider = 'openai'
          AND status IN ('active', 'rate_limited')
          AND oauth_expires_at IS NOT NULL
          AND oauth_expires_at < ${threshold}
    `;
}

export async function resetExpiredCooldowns(): Promise<void> {
    const ts = now();
    await sql`
        UPDATE accounts
        SET status = 'active',
            cooldown_until = NULL,
            recovered_at = ${ts}
        WHERE status = 'rate_limited' AND cooldown_until < ${ts}
    `;
}

function sanitize(row: Account): PublicAccount {
    const { access_token_enc, refresh_token_enc, ...safe } = row;
    return safe;
}
