import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { requireApiKey } from '../middleware/auth.js';
import { pickAccount, handleRateLimit, handleAuthError, handleSuccess, handleUnknownError } from '../loadbalancer/index.js';
import { forwardToOpenAI } from '../loadbalancer/openai.js';
import { forwardToClaude } from '../loadbalancer/claude.js';
import { forwardToGemini } from '../loadbalancer/gemini.js';
import { logUsage, createAlert, getUnEmailedAlerts, markAlertEmailed } from '../db/usage.js';
import { sendAlert } from '../utils/email.js';

const router = Router();
router.use(requireApiKey);

function detectProvider(model: string): 'openai' | 'claude' | 'gemini' {
    if (model.startsWith('gemini-')) return 'gemini';
    if (model.startsWith('claude-')) return 'claude';
    return 'openai';
}

async function proxyRequest(forcedProvider: 'openai' | 'claude' | 'gemini' | null, req: Request, res: Response): Promise<void> {
    const model = (req.body as { model?: string }).model ?? 'unknown';
    const provider = forcedProvider ?? detectProvider(model);
    const apiKey = req.apiKey;
    if (!apiKey.allowed_providers.includes(provider)) {
        res.status(403).json({ error: `This API key is not allowed to use ${provider}` });
        return;
    }

    let account;
    try {
        account = await pickAccount(provider);
    } catch {
        await createAlert({ id: uuid(), accountId: null, provider, kind: 'all_down', message: `All ${provider} accounts unavailable` });
        await fireAlerts();
        res.status(503).json({ error: `No ${provider} accounts available. Admin has been notified.` });
        return;
    }

    const start = Date.now();
    let statusCode = 200;
    let errorMsg: string | null = null;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    const forward = async (acct: typeof account) => {
        const result = await (provider === 'openai' ? forwardToOpenAI(acct, req.body, res)
            : provider === 'gemini' ? forwardToGemini(acct, req.body, res)
            : forwardToClaude(acct, req.body, res));
        if (result && 'promptTokens' in result) {
            promptTokens = (result as any).promptTokens;
            completionTokens = (result as any).completionTokens;
        }
    };

    try {
        await forward(account);
        await handleSuccess(account.id);
    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number }; message?: string };
        statusCode = axiosErr.response?.status ?? 500;
        errorMsg = axiosErr.message ?? 'Unknown error';

        if (statusCode === 429) {
            await handleRateLimit(account.id);
            await createAlert({ id: uuid(), accountId: account.id, provider, kind: 'rate_limit', message: `Account ${account.label} hit rate limit` });
            try {
                const fallback = await pickAccount(provider);
                await forward(fallback);
                await handleSuccess(fallback.id);
                statusCode = 200;
                errorMsg = null;
            } catch {
                if (!res.headersSent) res.status(503).json({ error: 'All accounts rate limited. Please try again later.' });
            }
        } else if (statusCode === 401) {
            await handleAuthError(account.id);
            await createAlert({ id: uuid(), accountId: account.id, provider, kind: 'auth_expired', message: `Account ${account.label} auth expired — reconnect needed` });
            if (!res.headersSent) res.status(401).json({ error: 'Account auth expired. Admin has been notified.' });
        } else {
            await handleUnknownError(account.id, errorMsg);
            if (!res.headersSent) res.status(500).json({ error: errorMsg });
        }

        await fireAlerts();
    } finally {
        await logUsage({
            id: uuid(),
            apiKeyId: apiKey.id,
            accountId: account.id,
            provider,
            model,
            statusCode,
            latencyMs: Date.now() - start,
            error: errorMsg,
            promptTokens,
            completionTokens,
        });
    }
}

// OpenAI-compatible — auto-routes by model name prefix (gemini-* → Gemini, gpt-* → OpenAI)
router.post('/chat/completions', (req, res) => proxyRequest(null, req, res));
// Anthropic-compatible
router.post('/messages', (req, res) => proxyRequest('claude', req, res));

async function fireAlerts(): Promise<void> {
    const pending = await getUnEmailedAlerts();
    for (const alert of pending) {
        await sendAlert({ subject: `[Gateway] ${alert.kind} — ${alert.provider ?? 'unknown'}`, message: alert.message, kind: alert.kind, accountLabel: alert.account_id });
        await markAlertEmailed(alert.id);
    }
}

export default router;
