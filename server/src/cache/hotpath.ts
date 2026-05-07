import { listActiveAccounts, ActiveAccount } from '../db/accounts.js';
import { hashApiKey, resolveKeyByHash, ResolvedKey, touchApiKey } from '../db/keys.js';

const API_KEY_TTL_MS = 60_000;
const API_KEY_NEGATIVE_TTL_MS = 5_000;
const ACCOUNT_POOL_TTL_MS = 10_000;
const DEBUG_CACHE = process.env.HOTPATH_CACHE_DEBUG === '1';

type ApiKeyEntry = {
    value: ResolvedKey | null;
    expiresAt: number;
    lastTouchedAt: number;
};

type AccountPoolEntry = {
    value: ActiveAccount[];
    expiresAt: number;
};

const apiKeyCache = new Map<string, ApiKeyEntry>();
const apiKeyIdToHash = new Map<string, string>();
const apiKeyInflight = new Map<string, Promise<ResolvedKey | null>>();

const accountPoolCache = new Map<string, AccountPoolEntry>();
const accountPoolInflight = new Map<string, Promise<ActiveAccount[]>>();

function elapsed(start: number): number {
    return Date.now() - start;
}

function debug(message: string): void {
    if (DEBUG_CACHE) console.log(message);
}

function cloneAccounts(accounts: ActiveAccount[]): ActiveAccount[] {
    return accounts.map(account => ({ ...account }));
}

export async function getCachedApiKey(rawKey: string): Promise<ResolvedKey | null> {
    const start = Date.now();
    const hashed = hashApiKey(rawKey);
    if (!hashed) {
        debug(`[cache] api-key invalid ${elapsed(start)}ms`);
        return null;
    }

    const now = Date.now();
    const cached = apiKeyCache.get(hashed);
    if (cached && cached.expiresAt > now) {
        if (cached.value && now - cached.lastTouchedAt >= API_KEY_TTL_MS) {
            cached.lastTouchedAt = now;
            touchApiKey(cached.value.id);
        }
        debug(`[cache] api-key hit ${elapsed(start)}ms`);
        return cached.value;
    }

    const existing = apiKeyInflight.get(hashed);
    if (existing) {
        const value = await existing;
        debug(`[cache] api-key wait ${elapsed(start)}ms`);
        return value;
    }

    const refresh = (async () => {
        const value = await resolveKeyByHash(hashed);
        const refreshedAt = Date.now();
        if (value) {
            apiKeyIdToHash.set(value.id, hashed);
            touchApiKey(value.id);
        }
        apiKeyCache.set(hashed, {
            value,
            expiresAt: refreshedAt + (value ? API_KEY_TTL_MS : API_KEY_NEGATIVE_TTL_MS),
            lastTouchedAt: value ? refreshedAt : 0,
        });
        return value;
    })().finally(() => {
        apiKeyInflight.delete(hashed);
    });

    apiKeyInflight.set(hashed, refresh);
    const value = await refresh;
    debug(`[cache] api-key miss ${elapsed(start)}ms`);
    return value;
}

export function invalidateApiKey(idOrHash: string): void {
    const hash = apiKeyCache.has(idOrHash) ? idOrHash : apiKeyIdToHash.get(idOrHash);
    if (!hash) return;
    apiKeyCache.delete(hash);
    apiKeyInflight.delete(hash);
    for (const [id, mappedHash] of apiKeyIdToHash) {
        if (id === idOrHash || mappedHash === hash) apiKeyIdToHash.delete(id);
    }
}

export function clearApiKeyCache(): void {
    apiKeyCache.clear();
    apiKeyIdToHash.clear();
    apiKeyInflight.clear();
}

export async function getCachedActiveAccounts(provider: string): Promise<ActiveAccount[]> {
    const start = Date.now();
    const now = Date.now();
    const cached = accountPoolCache.get(provider);
    if (cached && cached.expiresAt > now) {
        debug(`[cache] accounts/${provider} hit ${elapsed(start)}ms`);
        return cloneAccounts(cached.value);
    }

    const existing = accountPoolInflight.get(provider);
    if (existing) {
        const value = await existing;
        debug(`[cache] accounts/${provider} wait ${elapsed(start)}ms`);
        return cloneAccounts(value);
    }

    const refresh = (async () => {
        const value = await listActiveAccounts(provider);
        accountPoolCache.set(provider, {
            value,
            expiresAt: Date.now() + ACCOUNT_POOL_TTL_MS,
        });
        return value;
    })().finally(() => {
        accountPoolInflight.delete(provider);
    });

    accountPoolInflight.set(provider, refresh);
    const value = await refresh;
    debug(`[cache] accounts/${provider} miss ${elapsed(start)}ms`);
    return cloneAccounts(value);
}

export function invalidateAccountPool(provider?: string): void {
    if (!provider) {
        clearAccountCache();
        return;
    }
    accountPoolCache.delete(provider);
    accountPoolInflight.delete(provider);
}

export function clearAccountCache(): void {
    accountPoolCache.clear();
    accountPoolInflight.clear();
}
