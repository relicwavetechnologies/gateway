import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { requireApiKey } from '../middleware/auth.js';
import { pickAccount, handleRateLimit, handleAuthError, handleSuccess, handleUnknownError } from '../loadbalancer/index.js';
import { forwardToOpenAI } from '../loadbalancer/openai.js';
import { forwardToClaude } from '../loadbalancer/claude.js';
import { logUsage, createAlert, getUnEmailedAlerts, markAlertEmailed } from '../db/usage.js';
import { sendAlert } from '../utils/email.js';

const router = Router();
router.use(requireApiKey);

async function proxyRequest(provider: 'openai' | 'claude', req: Request, res: Response): Promise<void> {
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

    try {
        if (provider === 'openai') {
            await forwardToOpenAI(account, req.body, res);
        } else {
            await forwardToClaude(account, req.body, res);
        }
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
                if (provider === 'openai') await forwardToOpenAI(fallback, req.body, res);
                else await forwardToClaude(fallback, req.body, res);
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
            model: (req.body as { model?: string }).model ?? 'unknown',
            statusCode,
            latencyMs: Date.now() - start,
            error: errorMsg,
        });
    }
}

router.post('/chat/completions', (req, res) => proxyRequest('openai', req, res));
router.post('/messages', (req, res) => proxyRequest('claude', req, res));

async function fireAlerts(): Promise<void> {
    const pending = await getUnEmailedAlerts();
    for (const alert of pending) {
        await sendAlert({ subject: `[Gateway] ${alert.kind} — ${alert.provider ?? 'unknown'}`, message: alert.message, kind: alert.kind, accountLabel: alert.account_id });
        await markAlertEmailed(alert.id);
    }
}

export default router;
