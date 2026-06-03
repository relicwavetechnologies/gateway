import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { createSession, exchangeCode } from '../oauth/openai.js';
import { createSession as createGeminiSession, exchangeCode as exchangeGeminiCode } from '../oauth/gemini.js';
import { createSession as createClaudeSession, exchangeCode as exchangeClaudeCode } from '../oauth/claude.js';
import { createAccount, listAccounts, getAccount, patchAccount, deleteAccount, resetExpiredCooldowns, Account } from '../db/accounts.js';
import { invalidateAccountPool } from '../cache/hotpath.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (_req, res) => {
    await resetExpiredCooldowns();
    invalidateAccountPool();
    res.json(await listAccounts());
});

router.post('/initiate', (req, res) => {
    const { provider } = req.body as { provider?: string };
    if (!provider || !['openai', 'claude', 'gemini'].includes(provider)) {
        res.status(400).json({ error: 'provider must be openai, claude, or gemini' });
        return;
    }

    if (provider === 'openai') {
        const { sessionId, authUrl } = createSession();
        res.json({ session_id: sessionId, provider, auth_url: authUrl, instructions: 'Click the link to authenticate with your ChatGPT account. After login, copy the full URL from your browser address bar and paste it below.' });
        return;
    }

    if (provider === 'gemini') {
        const { sessionId, authUrl } = createGeminiSession();
        res.json({ session_id: sessionId, provider, auth_url: authUrl, instructions: 'Click the link to sign in with your Google account. After login, the browser will redirect to localhost — copy the full URL from the address bar and paste it below.' });
        return;
    }

    if (provider === 'claude') {
        const { sessionId, authUrl } = createClaudeSession();
        res.json({ session_id: sessionId, provider, auth_url: authUrl, instructions: 'Click the link to authorize with your Anthropic account. After you approve access, your browser will land on a console.anthropic.com page — copy the full URL from the address bar and paste it below.' });
        return;
    }
});

router.post('/complete', async (req, res) => {
    const { session_id, provider, code, label } = req.body as {
        session_id: string;
        provider: 'openai' | 'claude' | 'gemini';
        code?: string;
        label?: string;
        account_tier?: 'free' | 'pro';
    };

    if (!code) { res.status(400).json({ error: 'code is required' }); return; }

    if (provider === 'openai') {
        const { accessToken, refreshToken, expiresAt } = await exchangeCode(session_id, code);
        const account = await createAccount({ id: uuid(), provider: 'openai', label: label ?? 'OpenAI account', accessToken, refreshToken, expiresAt, createdBy: req.uid, accountTier: req.body.account_tier ?? 'free' });
        invalidateAccountPool('openai');
        res.json(account);
        return;
    }

    if (provider === 'gemini') {
        const { accessToken, refreshToken, expiresAt } = await exchangeGeminiCode(session_id, code);
        const account = await createAccount({ id: uuid(), provider: 'gemini', label: label ?? 'Gemini account', accessToken, refreshToken, expiresAt, createdBy: req.uid });
        invalidateAccountPool('gemini');
        res.json(account);
        return;
    }

    if (provider === 'claude') {
        const { accessToken, refreshToken, expiresAt } = await exchangeClaudeCode(session_id, code);
        const account = await createAccount({ id: uuid(), provider: 'claude', label: label ?? 'Claude account', accessToken, refreshToken, expiresAt, createdBy: req.uid });
        invalidateAccountPool('claude');
        res.json(account);
        return;
    }

    res.status(400).json({ error: 'Invalid provider' });
});

// Direct token import — for tokens obtained via the standalone get_claude_token.py script
router.post('/import-token', async (req, res) => {
    const { provider, access_token, refresh_token, expires_in, label } = req.body as {
        provider: 'openai' | 'claude' | 'gemini';
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        label?: string;
        account_tier?: 'free' | 'pro';
    };

    if (!provider || !['openai', 'claude', 'gemini'].includes(provider)) {
        res.status(400).json({ error: 'provider must be openai, claude, or gemini' }); return;
    }
    if (!access_token) {
        res.status(400).json({ error: 'access_token is required' }); return;
    }

    const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000);
    const account = await createAccount({
        id: uuid(),
        provider,
        label: label ?? `${provider} account`,
        accessToken: access_token,
        refreshToken: refresh_token ?? '',
        expiresAt,
        createdBy: req.uid,
        accountTier: req.body.account_tier ?? 'free',
    });
    invalidateAccountPool(provider);
    res.json(account);
});

router.post('/:id/test', async (req, res) => {
    const account = await getAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

    const { model: reqModel, message: reqMessage } = req.body as { model?: string; message?: string };
    const prompt = reqMessage || 'say "ok" only';

    const DEFAULT_MODELS: Record<string, string> = {
        openai: 'gpt-5.5',
        gemini: 'gemini-2.5-flash',
        claude: 'claude-sonnet-4-6',
    };

    try {
        const { getDecryptedTokens } = await import('../db/accounts.js');
        const tokens = await getDecryptedTokens(account.id);
        if (!tokens?.accessToken) { res.status(400).json({ error: 'No access token — reconnect this account' }); return; }
        const active = { ...account, access_token: tokens.accessToken } as any;

        const testModel = reqModel || DEFAULT_MODELS[account.provider] || 'gpt-5.5';
        let reply = '';
        const start = Date.now();

        const fakeRes = {
            setHeader: () => {}, write: () => {}, end: () => {},
            json: (d: any) => {
                reply = d.choices?.[0]?.message?.content ?? d.content?.[0]?.text ?? '';
            },
        } as unknown as import('express').Response;

        if (account.provider === 'openai') {
            const { forwardToOpenAI } = await import('../loadbalancer/openai.js');
            await forwardToOpenAI(active, { model: testModel, messages: [{ role: 'user', content: prompt }], stream: false }, fakeRes);
        } else if (account.provider === 'gemini') {
            const { forwardToGemini } = await import('../loadbalancer/gemini.js');
            await forwardToGemini(active, { model: testModel, messages: [{ role: 'user', content: prompt }], stream: false }, fakeRes);
        } else if (account.provider === 'claude') {
            const { forwardToClaude } = await import('../loadbalancer/claude.js');
            await forwardToClaude(active, { model: testModel, messages: [{ role: 'user', content: prompt }], stream: false }, fakeRes);
        }

        // If ping succeeded and account was rate_limited or auth_expired, auto-recover it
        if (account.status === 'rate_limited' || account.status === 'auth_expired' || account.status === 'error') {
            const { patchAccount } = await import('../db/accounts.js');
            await patchAccount(account.id, { status: 'active' });
            invalidateAccountPool(account.provider);
        }

        res.json({ ok: true, reply, model: testModel, latency_ms: Date.now() - start, recovered: account.status !== 'active' });
    } catch (err: unknown) {
        const msg = (err as Error).message;
        const is429 = msg.includes('429');
        res.status(is429 ? 200 : 500).json({
            ok: false,
            rate_limited: is429,
            error: is429 ? 'Account is rate-limited by the provider' : msg,
        });
    }
});

router.patch('/:id', async (req, res) => {
    const { label, status, account_tier } = req.body as { label?: string; status?: Account['status']; account_tier?: Account['account_tier'] };
    if (account_tier && !['free', 'pro'].includes(account_tier)) {
        res.status(400).json({ error: 'account_tier must be free or pro' });
        return;
    }
    await patchAccount(req.params.id, { label, status, account_tier });
    const account = await getAccount(req.params.id);
    invalidateAccountPool(account?.provider);
    res.json(account);
});

router.delete('/:id', async (req, res) => {
    const account = await getAccount(req.params.id);
    await deleteAccount(req.params.id);
    invalidateAccountPool(account?.provider);
    res.json({ ok: true });
});

export default router;
