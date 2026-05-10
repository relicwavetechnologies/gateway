import { v4 as uuid } from 'uuid';
import sql from './index.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import type { CodexHeaders } from './accounts.js';

export interface DedicatedAccount {
    id: string;
    owner_app: string;
    label: string | null;
    provider: string;
    tier: 'free' | 'pro';
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    oauth_expires_at: number | null;
    status: 'pending' | 'active' | 'auth_expired' | 'disabled';
    cooldown_until: number | null;
    last_error: string | null;
    last_used_at: number | null;
    request_count: number;
    primary_used_percent: number | null;
    primary_reset_at: number | null;
    secondary_used_percent: number | null;
    secondary_reset_at: number | null;
    plan_type: string | null;
    credits_balance: number | null;
    api_key_id: string | null;
    created_at: number;
    updated_at: number;
}

export type PublicDedicatedAccount = Omit<DedicatedAccount, 'access_token_enc' | 'refresh_token_enc'>;

const now = () => Date.now();

function sanitize(row: DedicatedAccount): PublicDedicatedAccount {
    const { access_token_enc, refresh_token_enc, ...safe } = row;
    return safe;
}

export async function createDedicatedAccount(params: {
    ownerApp: string;
    label?: string;
    tier?: 'free' | 'pro';
}): Promise<PublicDedicatedAccount> {
    const id = uuid();
    const ts = now();
    const [row] = await sql<DedicatedAccount[]>`
        INSERT INTO dedicated_accounts (id, owner_app, label, tier, created_at, updated_at)
        VALUES (${id}, ${params.ownerApp}, ${params.label ?? null}, ${params.tier ?? 'pro'}, ${ts}, ${ts})
        RETURNING *
    `;
    return sanitize(row);
}

export async function getDedicatedAccount(id: string): Promise<DedicatedAccount | undefined> {
    const [row] = await sql<DedicatedAccount[]>`SELECT * FROM dedicated_accounts WHERE id = ${id}`;
    return row;
}

export async function getDedicatedAccountByApiKeyId(apiKeyId: string): Promise<DedicatedAccount | undefined> {
    const [row] = await sql<DedicatedAccount[]>`SELECT * FROM dedicated_accounts WHERE api_key_id = ${apiKeyId}`;
    return row;
}

export async function listDedicatedAccounts(): Promise<PublicDedicatedAccount[]> {
    const rows = await sql<DedicatedAccount[]>`SELECT * FROM dedicated_accounts ORDER BY created_at DESC`;
    return rows.map(sanitize);
}

export async function activateDedicatedAccount(
    id: string,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: Date | null,
    apiKeyId: string,
): Promise<void> {
    const ts = now();
    await sql`
        UPDATE dedicated_accounts SET
            access_token_enc = ${encrypt(accessToken)},
            refresh_token_enc = ${refreshToken ? encrypt(refreshToken) : null},
            oauth_expires_at = ${expiresAt ? expiresAt.getTime() : null},
            status = 'active',
            api_key_id = ${apiKeyId},
            updated_at = ${ts}
        WHERE id = ${id}
    `;
}

export async function updateDedicatedTokens(
    id: string,
    accessToken: string,
    refreshToken: string | null,
    expiresAt: Date | null,
): Promise<void> {
    const ts = now();
    await sql`
        UPDATE dedicated_accounts SET
            access_token_enc = ${encrypt(accessToken)},
            refresh_token_enc = ${refreshToken ? encrypt(refreshToken) : null},
            oauth_expires_at = ${expiresAt ? expiresAt.getTime() : null},
            status = 'active',
            updated_at = ${ts}
        WHERE id = ${id}
    `;
}

export async function updateDedicatedRateLimits(id: string, h: CodexHeaders): Promise<void> {
    const ts = now();
    const updates: Record<string, unknown> = { updated_at: ts };

    if (h.primaryPct !== undefined) updates['primary_used_percent'] = h.primaryPct;
    if (h.primaryResetSeconds !== undefined) updates['primary_reset_at'] = ts + Math.max(0, h.primaryResetSeconds) * 1_000;
    if (h.secondaryPct !== undefined) updates['secondary_used_percent'] = h.secondaryPct;
    if (h.secondaryResetSeconds !== undefined) updates['secondary_reset_at'] = ts + Math.max(0, h.secondaryResetSeconds) * 1_000;
    if (h.planType) updates['plan_type'] = h.planType.trim().toLowerCase();
    if (h.credits !== undefined) updates['credits_balance'] = h.credits;

    if (Object.keys(updates).length > 1) {
        await sql`UPDATE dedicated_accounts SET ${sql(updates)} WHERE id = ${id}`;
    }
}

export async function recordDedicatedUsage(id: string): Promise<void> {
    const ts = now();
    await sql`
        UPDATE dedicated_accounts SET
            request_count = request_count + 1,
            last_used_at = ${ts},
            updated_at = ${ts}
        WHERE id = ${id}
    `;
}

export async function setDedicatedStatus(
    id: string,
    status: DedicatedAccount['status'],
    lastError?: string,
): Promise<void> {
    const ts = now();
    await sql`
        UPDATE dedicated_accounts SET
            status = ${status},
            last_error = ${lastError ?? null},
            updated_at = ${ts}
        WHERE id = ${id}
    `;
}

export async function disconnectDedicatedAccount(id: string): Promise<{ apiKeyId: string | null }> {
    const ts = now();
    const [row] = await sql<Pick<DedicatedAccount, 'api_key_id'>[]>`
        UPDATE dedicated_accounts SET
            access_token_enc = NULL,
            refresh_token_enc = NULL,
            oauth_expires_at = NULL,
            status = 'disabled',
            updated_at = ${ts}
        WHERE id = ${id}
        RETURNING api_key_id
    `;
    return { apiKeyId: row?.api_key_id ?? null };
}

export async function getExpiringDedicatedAccounts(threshold: number): Promise<Pick<DedicatedAccount, 'id' | 'label' | 'owner_app'>[]> {
    return sql<Pick<DedicatedAccount, 'id' | 'label' | 'owner_app'>[]>`
        SELECT id, label, owner_app FROM dedicated_accounts
        WHERE status = 'active'
          AND oauth_expires_at IS NOT NULL
          AND oauth_expires_at < ${threshold}
    `;
}

export async function getDecryptedDedicatedTokens(id: string): Promise<{ accessToken: string | null; refreshToken: string | null } | null> {
    const [row] = await sql<Pick<DedicatedAccount, 'access_token_enc' | 'refresh_token_enc'>[]>`
        SELECT access_token_enc, refresh_token_enc FROM dedicated_accounts WHERE id = ${id}
    `;
    if (!row) return null;
    return {
        accessToken: row.access_token_enc ? decrypt(row.access_token_enc) : null,
        refreshToken: row.refresh_token_enc ? decrypt(row.refresh_token_enc) : null,
    };
}
