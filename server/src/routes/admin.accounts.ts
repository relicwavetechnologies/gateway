import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { createSession, exchangeCode } from '../oauth/openai.js';
import { removeCredentials } from '../oauth/claude.js';
import { createAccount, listAccounts, getAccount, patchAccount, deleteAccount, Account } from '../db/accounts.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (_req, res) => {
    res.json(await listAccounts());
});

router.post('/initiate', (req, res) => {
    const { provider } = req.body as { provider?: string };
    if (!provider || !['openai', 'claude'].includes(provider)) {
        res.status(400).json({ error: 'provider must be openai or claude' });
        return;
    }

    if (provider === 'openai') {
        const { sessionId, authUrl } = createSession();
        res.json({ session_id: sessionId, provider, auth_url: authUrl, instructions: 'Click the link to authenticate with your ChatGPT account.' });
        return;
    }

    res.json({ session_id: uuid(), provider: 'claude', auth_url: null, instructions: 'Run gateway/scripts/get_claude_token.py on your machine, then paste the access token below.' });
});

router.post('/complete', async (req, res) => {
    const { session_id, provider, code, credential_blob, label } = req.body as {
        session_id: string;
        provider: 'openai' | 'claude';
        code?: string;
        credential_blob?: string;
        label?: string;
    };

    if (provider === 'openai') {
        if (!code) { res.status(400).json({ error: 'code is required for OpenAI' }); return; }
        const { accessToken, refreshToken, expiresAt } = await exchangeCode(session_id, code);
        const account = await createAccount({ id: uuid(), provider: 'openai', label: label ?? 'OpenAI account', accessToken, refreshToken, expiresAt, createdBy: req.uid });
        res.json(account);
        return;
    }

    if (provider === 'claude') {
        if (!credential_blob) { res.status(400).json({ error: 'Paste the access token from get_claude_token.py' }); return; }
        const id = uuid();
        const account = await createAccount({ id, provider: 'claude', label: label ?? 'Claude account', accessToken: credential_blob.trim(), refreshToken: null, expiresAt: null, createdBy: req.uid });
        res.json(account);
        return;
    }

    res.status(400).json({ error: 'Invalid provider' });
});

router.post('/:id/test', async (req, res) => {
    const account = await getAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Account not found' }); return; }

    try {
        if (account.provider === 'openai') {
            const { listActiveAccounts } = await import('../db/accounts.js');
            const { forwardToOpenAI } = await import('../loadbalancer/openai.js');
            const actives = await listActiveAccounts('openai');
            const active = actives.find(a => a.id === account.id);
            if (!active) { res.status(400).json({ error: 'Account not active or no token' }); return; }

            let reply = '';
            const fakeRes = {
                setHeader: () => { /* noop */ }, write: () => { /* noop */ }, end: () => { /* noop */ },
                json: (data: { choices?: { message?: { content?: string } }[] }) => { reply = data.choices?.[0]?.message?.content ?? ''; },
            } as unknown as import('express').Response;

            await forwardToOpenAI(active, { model: 'gpt-5.4', messages: [{ role: 'user', content: 'say "ok" only' }], stream: false }, fakeRes);
            res.json({ ok: true, reply });
            return;
        }

        if (account.provider === 'claude') {
            const { forwardToClaude } = await import('../loadbalancer/claude.js');
            let reply = '';
            const fakeRes = {
                setHeader: () => { /* noop */ }, write: () => { /* noop */ }, end: () => { /* noop */ },
                json: (data: { content?: { text?: string }[] }) => { reply = data.content?.[0]?.text ?? ''; },
                status: () => ({ json: () => { /* noop */ } }),
            } as unknown as import('express').Response;

            // ActiveAccount shape: spread account + access_token field
            await forwardToClaude({ ...account, access_token: null }, { messages: [{ role: 'user', content: 'say "ok" only' }], stream: false }, fakeRes);
            res.json({ ok: true, reply });
            return;
        }
    } catch (err: unknown) {
        res.status(500).json({ ok: false, error: (err as Error).message });
    }
});

router.patch('/:id', async (req, res) => {
    const { label, status } = req.body as { label?: string; status?: Account['status'] };
    await patchAccount(req.params.id, { label, status });
    res.json(await getAccount(req.params.id));
});

router.delete('/:id', async (req, res) => {
    const account = await getAccount(req.params.id);
    if (account?.provider === 'claude') removeCredentials(req.params.id);
    await deleteAccount(req.params.id);
    res.json({ ok: true });
});

export default router;
