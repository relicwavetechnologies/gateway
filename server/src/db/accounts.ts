import sql from './index.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export interface Account {
    id: string;
    provider: 'openai' | 'claude' | 'gemini';
    label: string;
    status: 'active' | 'rate_limited' | 'auth_expired' | 'error' | 'disabled';
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    oauth_expires_at: number | null;
    cooldown_until: number | null;
    request_count: number;
    error_count: number;
    last_error: string | null;
    last_used_at: number | null;
    created_at: number;
    created_by: string;
}

export interface ActiveAccount extends Omit<Account, 'access_token_enc' | 'refresh_token_enc'> {
    access_token: string | null;
}

export type PublicAccount = Omit<Account, 'access_token_enc' | 'refresh_token_enc'>;

const now = () => Date.now();

export async function getExpiringGeminiAccounts(threshold: number): Promise<Pick<Account, 'id' | 'label'>[]> {
    return sql<Pick<Account, 'id' | 'label'>[]>`
        SELECT id, label FROM accounts
        WHERE provider = 'gemini'
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
}): Promise<PublicAccount> {
    const { id, provider, label, accessToken, refreshToken, expiresAt, createdBy } = params;
    const [row] = await sql<Account[]>`
        INSERT INTO accounts (id, provider, label, access_token_enc, refresh_token_enc, oauth_expires_at, created_at, created_by)
        VALUES (
            ${id}, ${provider}, ${label},
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
          AND status = 'active'
          AND (cooldown_until IS NULL OR cooldown_until < ${now()})
    `;
    return rows.map(row => ({
        ...sanitize(row),
        access_token: row.access_token_enc ? decrypt(row.access_token_enc) : null,
    }));
}

export async function updateAccountStatus(id: string, status: Account['status'], cooldownMinutes = 0): Promise<void> {
    const cooldown_until = cooldownMinutes > 0 ? now() + cooldownMinutes * 60_000 : null;
    await sql`UPDATE accounts SET status = ${status}, cooldown_until = ${cooldown_until} WHERE id = ${id}`;
}

export async function recordAccountSuccess(id: string): Promise<void> {
    await sql`UPDATE accounts SET request_count = request_count + 1, last_used_at = ${now()} WHERE id = ${id}`;
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
            status = 'active'
        WHERE id = ${id}
    `;
}

export async function patchAccount(id: string, fields: Partial<Pick<Account, 'label' | 'status'>>): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (fields.label !== undefined) updates['label'] = fields.label;
    if (fields.status !== undefined) updates['status'] = fields.status;
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
    await sql`
        UPDATE accounts SET status = 'active', cooldown_until = NULL
        WHERE status = 'rate_limited' AND cooldown_until < ${now()}
    `;
}

function sanitize(row: Account): PublicAccount {
    const { access_token_enc, refresh_token_enc, ...safe } = row;
    return safe;
}
