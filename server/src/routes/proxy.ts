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
import type { ActiveAccount } from '../db/accounts.js';

const router = Router();
router.use(requireApiKey);

function detectProvider(model: string): 'openai' | 'claude' | 'gemini' {
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('claude-')) return 'claude';
    return 'openai';
}

type ForwardResult = { replyText: string; promptTokens?: number; completionTokens?: number };

async function callProvider(
    provider: 'openai' | 'claude' | 'gemini',
    account: ActiveAccount,
    body: unknown,
    res: Response,
): Promise<ForwardResult> {
    if (provider === 'openai') return forwardToOpenAI(account, body as any, res);
    if (provider === 'gemini') return forwardToGemini(account, body as any, res);
    return forwardToClaude(account, body as any, res);
}

async function proxyRequest(
    forcedProvider: 'openai' | 'claude' | 'gemini' | null,
    req: Request,
    res: Response,
): Promise<void> {
    const model = (req.body as { model?: string }).model ?? 'unknown';
    const provider = forcedProvider ?? detectProvider(model);
    const apiKey = req.apiKey;

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
            const result = await callProvider(provider, account, req.body, res);
            promptTokens = result.promptTokens;
            completionTokens = result.completionTokens;

            await handleSuccess(account.id);
            succeeded = true;
            finalStatusCode = 200;
            finalError = null;
            break;
        } catch (err: unknown) {
            const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string; code?: string };
            const statusCode = axiosErr.response?.status ?? 0;
            const message = axiosErr.message ?? 'Unknown error';
            const kind = classifyError(statusCode, message);

            console.error(`[proxy] ${provider}/${account.label} failed — ${statusCode} ${kind}: ${message}`);

            finalStatusCode = statusCode || 500;
            finalError = message;

            // If response is already sent (streaming started), stop here
            if (res.headersSent) break;

            if (kind === 'rate_limit') {
                await handleRateLimit(account.id);
                await createAlert({ id: uuid(), accountId: account.id, provider, kind: 'rate_limit', message: `Account ${account.label} hit rate limit` });
                console.log(`[proxy] rate limited ${account.label}, trying next account...`);
                continue; // try next account

            } else if (kind === 'auth_expired') {
                await handleAuthError(account.id);
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
        const allRateLimited = finalError === 'rate_limited' || finalStatusCode === 429;
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

// OpenAI-compatible — auto-routes by model prefix (gemini-* → Gemini, claude-* → Claude, else → OpenAI)
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
