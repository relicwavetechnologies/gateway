import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { requireApiKey } from '../middleware/auth.js';
import {
    getAllAccounts,
    getAllAccountsIncludingCooldown,
    handleRateLimit,
    handleAuthError,
    handleServerError,
    handleSuccess,
    handleUnknownError,
    classifyError,
} from '../loadbalancer/index.js';
import { forwardToOpenAI } from '../loadbalancer/openai.js';
import { forwardToClaude } from '../loadbalancer/claude.js';
import { forwardToGemini, isProModel, MIN_PRO_ACCOUNTS, LITE_MODELS } from '../loadbalancer/gemini.js';
import { logUsage, createAlert, getUnEmailedAlerts, markAlertEmailed } from '../db/usage.js';
import { sendAlert } from '../utils/email.js';
import { updateAccountCodexHeaders, type ActiveAccount, type CodexHeaders } from '../db/accounts.js';
import { getDedicatedAccountByApiKeyId, recordDedicatedUsage, updateDedicatedRateLimits } from '../db/dedicated-accounts.js';
import { decrypt } from '../utils/crypto.js';
import { logLatency } from '../utils/timing.js';

const router = Router();
router.use(requireApiKey);

type Provider = 'openai' | 'claude' | 'gemini';

const AVAILABLE_MODEL_FAMILIES = [
    'OpenAI/Codex: gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.3-codex, plus common gpt-4/o-series aliases',
    'Gemini: model names starting with gemini-',
    'Claude: model names starting with claude-',
];

function unavailableModelMessage(model: string): string {
    return `Model "${model}" is not available through Gateway. Available model families: ${AVAILABLE_MODEL_FAMILIES.join('; ')}.`;
}

function isExternalProviderModel(model: string): boolean {
    return model.includes('/');
}

function detectProvider(model: string): Provider | null {
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('claude-')) return 'claude';
    if (isExternalProviderModel(model)) return null;
    return 'openai';
}

type ForwardResult = { replyText: string; promptTokens?: number; completionTokens?: number; codexHeaders?: CodexHeaders };

let rescuedCount = 0;
let totalProxied = 0;

export function getProxyStats(): { rescued: number; total: number } {
    return { rescued: rescuedCount, total: totalProxied };
}

function providerErrorMessage(err: { response?: { data?: unknown }; message?: string; code?: string }): string {
    const data = err.response?.data;

    if (Buffer.isBuffer(data)) return data.toString('utf8').slice(0, 800);
    if (typeof data === 'string' && data.trim()) return data.slice(0, 800);

    if (data && typeof data === 'object') {
        const body = data as {
            error?: string | { message?: string; type?: string; code?: string };
            message?: string;
            detail?: string;
        };

        if (typeof body.error === 'string') return body.error.slice(0, 800);
        if (body.error && typeof body.error === 'object') {
            const pieces = [body.error.code, body.error.type, body.error.message].filter(Boolean);
            if (pieces.length) return pieces.join(': ').slice(0, 800);
        }
        if (body.message) return body.message.slice(0, 800);
        if (body.detail) return body.detail.slice(0, 800);

        try {
            return JSON.stringify(data).slice(0, 800);
        } catch { /* fall through */ }
    }

    return (err.message || err.code || 'Unknown error').slice(0, 800);
}

async function callProvider(
    provider: Provider,
    account: ActiveAccount,
    body: unknown,
    res: Response,
): Promise<ForwardResult> {
    if (provider === 'openai') return forwardToOpenAI(account, body as any, res);
    if (provider === 'gemini') return forwardToGemini(account, body as any, res);
    return forwardToClaude(account, body as any, res);
}

async function handleDedicatedRequest(req: Request, res: Response): Promise<void> {
    const apiKey = req.apiKey;
    const dedicatedAccount = await getDedicatedAccountByApiKeyId(apiKey.id);

    if (!dedicatedAccount) {
        res.status(503).json({ error: 'Dedicated account not found for this key' });
        return;
    }
    if (dedicatedAccount.status !== 'active') {
        res.status(503).json({ error: 'Dedicated account is not active', status: dedicatedAccount.status });
        return;
    }
    if (dedicatedAccount.cooldown_until && dedicatedAccount.cooldown_until > Date.now()) {
        res.status(429).json({
            error: 'Dedicated account is cooling down',
            retry_after: new Date(Number(dedicatedAccount.cooldown_until)).toISOString(),
        });
        return;
    }

    let accessToken: string;
    try {
        if (!dedicatedAccount.access_token_enc) throw new Error('No access token stored');
        accessToken = decrypt(dedicatedAccount.access_token_enc);
    } catch {
        res.status(503).json({ error: 'Dedicated account token unavailable — reconnect the account' });
        return;
    }

    const fakeAccount: ActiveAccount = {
        id: dedicatedAccount.id,
        access_token: accessToken,
        label: dedicatedAccount.label ?? dedicatedAccount.owner_app,
        provider: 'openai',
        account_tier: dedicatedAccount.tier,
        status: 'active',
        cooldown_until: null,
        request_count: Number(dedicatedAccount.request_count),
        error_count: 0,
        last_error: null,
        last_used_at: dedicatedAccount.last_used_at,
        codex_plan_type: dedicatedAccount.plan_type,
        codex_primary_pct: dedicatedAccount.primary_used_percent,
        codex_primary_reset: dedicatedAccount.primary_reset_at,
        codex_secondary_pct: dedicatedAccount.secondary_used_percent,
        codex_secondary_reset: dedicatedAccount.secondary_reset_at,
        codex_credits: dedicatedAccount.credits_balance,
        codex_updated_at: null,
        recovered_at: null,
        created_at: dedicatedAccount.created_at,
        created_by: dedicatedAccount.owner_app,
        oauth_expires_at: dedicatedAccount.oauth_expires_at,
    };

    const model = (req.body as { model?: string }).model ?? 'gpt-5.4';
    const start = Date.now();

    try {
        const result = await forwardToOpenAI(fakeAccount, req.body as Parameters<typeof forwardToOpenAI>[1], res);

        recordDedicatedUsage(dedicatedAccount.id).catch(() => null);
        if (result.codexHeaders) {
            updateDedicatedRateLimits(dedicatedAccount.id, result.codexHeaders).catch(() => null);
        }

        await logUsage({
            id: uuid(), apiKeyId: apiKey.id, accountId: dedicatedAccount.id,
            provider: 'openai', model, statusCode: 200, latencyMs: Date.now() - start,
            error: null, promptTokens: undefined, completionTokens: undefined,
        });
    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string; code?: string };
        const statusCode = axiosErr.response?.status ?? 500;
        const message = providerErrorMessage(axiosErr);

        await logUsage({
            id: uuid(), apiKeyId: apiKey.id, accountId: dedicatedAccount.id,
            provider: 'openai', model, statusCode, latencyMs: Date.now() - start,
            error: message, promptTokens: undefined, completionTokens: undefined,
        });

        if (!res.headersSent) {
            res.status(statusCode === 429 ? 429 : 502).json({ error: message });
        }
    }
}

async function proxyRequest(
    forcedProvider: Provider | null,
    req: Request,
    res: Response,
): Promise<void> {
    const model = (req.body as { model?: string }).model ?? 'unknown';
    const provider = forcedProvider ?? detectProvider(model);
    const apiKey = req.apiKey;

    if (!provider) {
        res.status(400).json({
            error: unavailableModelMessage(model),
            code: 'model_not_available',
            model,
            available_model_families: AVAILABLE_MODEL_FAMILIES,
        });
        return;
    }

    // Dedicated keys bypass the pool entirely and route to a single fixed account
    if (apiKey.is_dedicated) {
        await handleDedicatedRequest(req, res);
        return;
    }

    if (!apiKey.allowed_providers.includes(provider)) {
        res.status(403).json({ error: `This API key is not allowed to use ${provider}` });
        return;
    }

    // ── Load all healthy accounts upfront ────────────────────────────────────
    // First try fresh (not on cooldown). If none available, fall back to
    // cooldown accounts too — better to try a slightly throttled account
    // than to fail immediately.
    let accounts: ActiveAccount[];
    try {
        accounts = await getAllAccountsIncludingCooldown(provider);
    } catch {
        accounts = [];
    }

    if (!accounts.length) {
        await createAlert({ id: uuid(), accountId: null, provider, kind: 'all_down', message: `All ${provider} accounts unavailable` });
        await fireAlerts();
        res.status(503).json({ error: `No ${provider} accounts available. Admin has been notified.` });
        return;
    }

    // ── Gemini pro-model gate ─────────────────────────────────────────────────
    // Pro models burn through free-tier quota instantly with a small account pool.
    // Require MIN_PRO_ACCOUNTS active accounts before serving them.
    if (provider === 'gemini' && isProModel(model) && accounts.length < MIN_PRO_ACCOUNTS) {
        res.status(503).json({
            error: `This model requires ${MIN_PRO_ACCOUNTS}+ active Gemini accounts (currently ${accounts.length}). `
                 + `Available models: ${LITE_MODELS.join(', ')}`,
        });
        return;
    }

    const start = Date.now();
    let finalStatusCode = 200;
    let finalError: string | null = null;
    let finalErrorKind: ReturnType<typeof classifyError> | null = null;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let lastUsedAccountId = accounts[0].id;

    // ── Exhaustive retry across all accounts ──────────────────────────────────
    const triedIds = new Set<string>();
    let succeeded = false;

    for (const account of accounts) {
        if (triedIds.has(account.id)) continue;
        triedIds.add(account.id);
        lastUsedAccountId = account.id;

        try {
            const providerStart = Date.now();
            const result = await callProvider(provider, account, req.body, res);
            logLatency('proxy', 'provider_complete', providerStart, `provider=${provider} account=${account.id}`);
            promptTokens = result.promptTokens;
            completionTokens = result.completionTokens;

            await handleSuccess(account.id);
            if (provider === 'openai' && result.codexHeaders) {
                updateAccountCodexHeaders(account.id, result.codexHeaders)
                    .catch(err => console.error(`[proxy] failed to persist codex headers for ${account.id}:`, err));
            }
            succeeded = true;
            finalStatusCode = 200;
            finalError = null;
            totalProxied += 1;
            if (triedIds.size > 1) rescuedCount += 1;
            break;
        } catch (err: unknown) {
            const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string; code?: string };
            const statusCode = axiosErr.response?.status ?? 0;
            const message = providerErrorMessage(axiosErr);
            const kind = classifyError(statusCode, message);

            console.error(`[proxy] ${provider}/${account.label} failed — ${statusCode} ${kind}: ${message}`);

            finalStatusCode = statusCode || 500;
            finalError = message;
            finalErrorKind = kind;

            // If response is already sent (streaming started), stop here
            if (res.headersSent) break;

            if (kind === 'rate_limit') {
                const cooldownUntil = await handleRateLimit(account, message);
                const cooldownText = cooldownUntil ? ` until ${new Date(cooldownUntil).toISOString()}` : '';
                await createAlert({ id: uuid(), accountId: account.id, provider, kind: 'rate_limit', message: `Account ${account.label} hit rate limit${cooldownText}: ${message}` });
                console.log(`[proxy] rate limited ${account.label}, trying next account...`);
                continue; // try next account

            } else if (kind === 'auth_expired') {
                await handleAuthError(account.id, provider);
                await createAlert({ id: uuid(), accountId: account.id, provider, kind: 'auth_expired', message: `Account ${account.label} auth expired — reconnect needed` });
                console.log(`[proxy] auth expired ${account.label}, trying next account...`);
                continue; // try next account

            } else if (kind === 'server_error') {
                await handleServerError(account.id, message);
                console.log(`[proxy] server error on ${account.label}, trying next account...`);
                continue; // try next account

            } else if (kind === 'hard_fail') {
                // Bad request / model not found — no point retrying on other accounts
                await handleUnknownError(account.id, message);
                if (!res.headersSent) res.status(statusCode || 400).json({ error: message });
                finalStatusCode = statusCode || 400;
                await fireAlerts();
                await logUsage({ id: uuid(), apiKeyId: apiKey.id, accountId: lastUsedAccountId, provider, model, statusCode: finalStatusCode, latencyMs: Date.now() - start, error: finalError, promptTokens, completionTokens });
                return;

            } else {
                await handleUnknownError(account.id, message);
                console.log(`[proxy] unknown error on ${account.label}, trying next account...`);
                continue; // still try next
            }
        }
    }

    // ── All accounts exhausted ────────────────────────────────────────────────
    if (!succeeded && !res.headersSent) {
        const allRateLimited = finalErrorKind === 'rate_limit' || finalStatusCode === 429;
        const allAuthExpired = finalStatusCode === 401;

        if (allRateLimited) {
            await createAlert({ id: uuid(), accountId: null, provider, kind: 'all_down', message: `All ${provider} accounts rate limited` });
            res.status(503).json({ error: `All ${provider} accounts are rate limited. Try again shortly.` });
        } else if (allAuthExpired) {
            res.status(503).json({ error: `All ${provider} accounts have expired tokens. Admin has been notified.` });
        } else {
            await createAlert({ id: uuid(), accountId: null, provider, kind: 'all_down', message: `All ${provider} accounts failed: ${finalError}` });
            res.status(503).json({ error: `All ${provider} accounts failed. Try again shortly.` });
        }

        finalStatusCode = 503;
    }

    await fireAlerts();
    await logUsage({
        id: uuid(),
        apiKeyId: apiKey.id,
        accountId: lastUsedAccountId,
        provider,
        model,
        statusCode: finalStatusCode,
        latencyMs: Date.now() - start,
        error: finalError,
        promptTokens,
        completionTokens,
    });
}

// OpenAI-compatible — auto-routes by model prefix (gemini-* → Gemini, claude-* → Claude, OpenAI-ish names → OpenAI)
router.post('/chat/completions', (req, res) => proxyRequest(null, req, res));
// Anthropic-compatible
router.post('/messages', (req, res) => proxyRequest('claude', req, res));

async function fireAlerts(): Promise<void> {
    try {
        const pending = await getUnEmailedAlerts();
        for (const alert of pending) {
            await sendAlert({
                subject: `[Gateway] ${alert.kind} — ${alert.provider ?? 'unknown'}`,
                message: alert.message,
                kind: alert.kind,
                accountLabel: alert.account_id,
            });
            await markAlertEmailed(alert.id);
        }
    } catch { /* don't let alert failures crash the request */ }
}

export default router;
