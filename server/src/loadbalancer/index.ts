import { listActiveAccounts, updateAccountStatus, recordAccountSuccess, recordAccountError, ActiveAccount } from '../db/accounts.js';

const counters: Record<string, number> = { openai: 0, claude: 0, gemini: 0 };

export async function pickAccount(provider: string): Promise<ActiveAccount> {
    const candidates = await listActiveAccounts(provider);
    if (!candidates.length) {
        throw Object.assign(new Error(`No active ${provider} accounts available`), { code: 'NO_ACCOUNTS' });
    }
    const idx = counters[provider] % candidates.length;
    counters[provider] = (counters[provider] + 1) % Number.MAX_SAFE_INTEGER;
    return candidates[idx];
}

export async function handleRateLimit(accountId: string): Promise<void> {
    await updateAccountStatus(accountId, 'rate_limited', 15);
    await recordAccountError(accountId, 'rate_limited');
}

export async function handleAuthError(accountId: string): Promise<void> {
    await updateAccountStatus(accountId, 'auth_expired', 0);
    await recordAccountError(accountId, 'auth_expired');
}

export async function handleSuccess(accountId: string): Promise<void> {
    await recordAccountSuccess(accountId);
}

export async function handleUnknownError(accountId: string, error: string): Promise<void> {
    await recordAccountError(accountId, error);
}
