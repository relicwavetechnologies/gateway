import crypto from 'crypto';
import sql from './index.js';

export interface ApiKey {
    id: string;
    hashed_key: string;
    key_prefix: string;
    name: string;
    allowed_providers: string; // comma-separated in DB
    rate_limit_rpm: number | null;
    created_at: number;
    created_by: string;
    last_used_at: number | null;
    revoked: number;
}

export interface ApiKeyPublic extends Omit<ApiKey, 'hashed_key' | 'allowed_providers'> {
    allowed_providers: string[];
}

export type ResolvedKey = ApiKeyPublic;

const now = () => Date.now();

export function hashApiKey(rawKey: string): string | null {
    if (!rawKey.startsWith('cnsc_gw_')) return null;
    const secret = rawKey.replace('cnsc_gw_', '');
    return crypto.createHash('sha256').update(secret).digest('hex');
}

function generateKey(): { raw: string; hashed: string; prefix: string } {
    const secret = crypto.randomBytes(24).toString('hex');
    const raw = `cnsc_gw_${secret}`;
    const hashed = crypto.createHash('sha256').update(secret).digest('hex');
    const prefix = `cnsc_gw_${secret.slice(0, 4)}...${secret.slice(-4)}`;
    return { raw, hashed, prefix };
}

export async function createApiKey(params: {
    id: string;
    name: string;
    allowedProviders: string[];
    rateLimitRpm: number | null;
    createdBy: string;
}): Promise<{ raw: string; metadata: ApiKeyPublic }> {
    const { id, name, allowedProviders, rateLimitRpm, createdBy } = params;
    const { raw, hashed, prefix } = generateKey();
    const [row] = await sql<ApiKey[]>`
        INSERT INTO api_keys (id, hashed_key, key_prefix, name, allowed_providers, rate_limit_rpm, created_at, created_by)
        VALUES (${id}, ${hashed}, ${prefix}, ${name}, ${allowedProviders.join(',')}, ${rateLimitRpm}, ${now()}, ${createdBy})
        RETURNING *
    `;
    return { raw, metadata: sanitize(row) };
}

export async function listApiKeys(createdBy: string): Promise<ApiKeyPublic[]> {
    const rows = await sql<ApiKey[]>`SELECT * FROM api_keys WHERE created_by = ${createdBy} ORDER BY created_at DESC`;
    return rows.map(sanitize);
}

export async function resolveKey(rawKey: string): Promise<ResolvedKey | null> {
    const hashed = hashApiKey(rawKey);
    if (!hashed) return null;
    const row = await resolveKeyByHash(hashed);
    if (!row) return null;
    touchApiKey(row.id);
    return row;
}

export async function resolveKeyByHash(hashed: string): Promise<ResolvedKey | null> {
    const [row] = await sql<ApiKey[]>`SELECT * FROM api_keys WHERE hashed_key = ${hashed} AND revoked = 0`;
    if (!row) return null;
    return sanitize(row);
}

export function touchApiKey(id: string): void {
    sql`UPDATE api_keys SET last_used_at = ${now()} WHERE id = ${id}`.catch(() => null);
}

export async function revokeApiKey(id: string, createdBy: string): Promise<void> {
    await sql`UPDATE api_keys SET revoked = 1 WHERE id = ${id} AND created_by = ${createdBy}`;
}

function sanitize(row: ApiKey): ApiKeyPublic {
    const { hashed_key, allowed_providers, ...rest } = row;
    return { ...rest, allowed_providers: allowed_providers.split(',') };
}
