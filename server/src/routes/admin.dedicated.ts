import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { createSession, exchangeCode, refreshToken as refreshOpenAIToken } from '../oauth/openai.js';
import {
    createDedicatedAccount,
    getDedicatedAccount,
    listDedicatedAccounts,
    activateDedicatedAccount,
    disconnectDedicatedAccount,
    setDedicatedStatus,
    getDecryptedDedicatedTokens,
} from '../db/dedicated-accounts.js';
import { createApiKey, revokeApiKeyById } from '../db/keys.js';
import { forwardToOpenAI } from '../loadbalancer/openai.js';

const router = Router();
router.use(requireAdmin);

// ── List all dedicated accounts ───────────────────────────────────────────────
router.get('/', async (_req, res) => {
    res.json(await listDedicatedAccounts());
});

// ── Start OAuth flow for a new dedicated account ──────────────────────────────
router.post('/initiate', async (req, res) => {
    const { owner_app, label, tier } = req.body as {
        owner_app?: string;
        label?: string;
        tier?: 'free' | 'pro';
    };

    if (!owner_app) {
        res.status(400).json({ error: 'owner_app is required' });
        return;
    }
    if (tier && !['free', 'pro'].includes(tier)) {
        res.status(400).json({ error: 'tier must be free or pro' });
        return;
    }

    const account = await createDedicatedAccount({ ownerApp: owner_app, label, tier });
    const { sessionId, authUrl } = createSession();

    res.json({
        auth_url: authUrl,
        session_id: sessionId,
        dedicated_account_id: account.id,
        instructions: 'Click the link to authenticate with your OpenAI account. After login, copy the full callback URL from your browser address bar and paste it to POST /admin/dedicated/complete.',
    });
});

// ── Complete OAuth and activate the dedicated account ─────────────────────────
router.post('/complete', async (req, res) => {
    const { dedicated_account_id, session_id, callback_url } = req.body as {
        dedicated_account_id?: string;
        session_id?: string;
        callback_url?: string;
    };

    if (!dedicated_account_id) { res.status(400).json({ error: 'dedicated_account_id is required' }); return; }
    if (!session_id) { res.status(400).json({ error: 'session_id is required' }); return; }
    if (!callback_url) { res.status(400).json({ error: 'callback_url is required' }); return; }

    const account = await getDedicatedAccount(dedicated_account_id);
    if (!account) { res.status(404).json({ error: 'Dedicated account not found' }); return; }
    if (account.status !== 'pending') { res.status(409).json({ error: `Account is already ${account.status}` }); return; }

    // Extract code from callback URL
    let code: string;
    try {
        const url = new URL(callback_url);
        const extracted = url.searchParams.get('code');
        if (!extracted) throw new Error('no code param');
        code = extracted;
    } catch {
        res.status(400).json({ error: 'callback_url must be a valid URL containing ?code=...' });
        return;
    }

    // Exchange code for tokens
    const { accessToken, refreshToken, expiresAt } = await exchangeCode(session_id, code);

    // Create a dedicated API key
    const keyId = uuid();
    const keyName = `${account.owner_app}-dedicated-${account.id.slice(0, 8)}`;
    const { raw: apiKeyRaw, metadata: keyMeta } = await createApiKey({
        id: keyId,
        name: keyName,
        allowedProviders: ['openai'],
        rateLimitRpm: null,
        createdBy: req.uid,
        isDedicated: true,
    });

    // Store tokens and link api_key
    await activateDedicatedAccount(dedicated_account_id, accessToken, refreshToken, expiresAt, keyMeta.id);

    res.json({
        dedicated_account_id,
        status: 'active',
        api_key: apiKeyRaw,
        api_key_id: keyMeta.id,
        tier: account.tier,
        owner_app: account.owner_app,
    });
});

// ── Get status ────────────────────────────────────────────────────────────────
router.get('/status/:id', async (req, res) => {
    const account = await getDedicatedAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Dedicated account not found' }); return; }

    res.json({
        id: account.id,
        owner_app: account.owner_app,
        label: account.label,
        provider: account.provider,
        tier: account.tier,
        status: account.status,
        last_error: account.last_error,
        last_used_at: account.last_used_at,
        cooldown_until: account.cooldown_until,
        request_count: account.request_count,
        api_key_id: account.api_key_id,
        created_at: account.created_at,
        updated_at: account.updated_at,
        rate_limits: {
            primary_used_percent: account.primary_used_percent,
            primary_reset_at: account.primary_reset_at ? new Date(Number(account.primary_reset_at)).toISOString() : null,
            secondary_used_percent: account.secondary_used_percent,
            secondary_reset_at: account.secondary_reset_at ? new Date(Number(account.secondary_reset_at)).toISOString() : null,
            plan_type: account.plan_type,
            credits_balance: account.credits_balance,
        },
        token_expires_at: account.oauth_expires_at ? new Date(Number(account.oauth_expires_at)).toISOString() : null,
    });
});

// ── Disconnect and revoke ─────────────────────────────────────────────────────
router.post('/disconnect/:id', async (req, res) => {
    const account = await getDedicatedAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Dedicated account not found' }); return; }

    const { apiKeyId } = await disconnectDedicatedAccount(req.params.id);

    let apiKeyRevoked = false;
    if (apiKeyId) {
        await revokeApiKeyById(apiKeyId);
        apiKeyRevoked = true;
    }

    res.json({ id: req.params.id, status: 'disconnected', api_key_revoked: apiKeyRevoked });
});

// ── Test the dedicated account ────────────────────────────────────────────────
router.post('/test/:id', async (req, res) => {
    const account = await getDedicatedAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Dedicated account not found' }); return; }

    const tokens = await getDecryptedDedicatedTokens(req.params.id);
    if (!tokens?.accessToken) {
        res.status(400).json({ error: 'No access token — reconnect this account' });
        return;
    }

    const { model: reqModel, message: reqMessage } = req.body as { model?: string; message?: string };
    const testModel = reqModel ?? 'gpt-5.4';
    const prompt = reqMessage ?? 'say "ok" only';

    const start = Date.now();
    let reply = '';
    let codexHeadersOut: Record<string, unknown> | null = null;

    const fakeRes = {
        setHeader: () => {},
        write: () => {},
        end: () => {},
        json: (d: unknown) => {
            const data = d as { choices?: { message?: { content?: string } }[] };
            reply = data.choices?.[0]?.message?.content ?? '';
        },
    } as unknown as import('express').Response;

    const fakeAccount = {
        id: account.id,
        access_token: tokens.accessToken,
        label: account.label ?? account.owner_app,
        provider: 'openai' as const,
        account_tier: account.tier,
        status: 'active' as const,
        cooldown_until: null,
        request_count: account.request_count,
        error_count: 0,
        last_error: null,
        last_used_at: account.last_used_at,
        codex_plan_type: account.plan_type,
        codex_primary_pct: account.primary_used_percent,
        codex_primary_reset: account.primary_reset_at,
        codex_secondary_pct: account.secondary_used_percent,
        codex_secondary_reset: account.secondary_reset_at,
        codex_credits: account.credits_balance,
        codex_updated_at: null,
        recovered_at: null,
        created_at: account.created_at,
        created_by: account.owner_app,
        oauth_expires_at: account.oauth_expires_at,
    };

    try {
        const result = await forwardToOpenAI(fakeAccount, { model: testModel, messages: [{ role: 'user', content: prompt }], stream: false }, fakeRes);
        if (result.codexHeaders) {
            codexHeadersOut = {
                plan_type: result.codexHeaders.planType ?? null,
                primary_used_percent: result.codexHeaders.primaryPct ?? null,
                secondary_used_percent: result.codexHeaders.secondaryPct ?? null,
                credits_balance: result.codexHeaders.credits ?? null,
            };
        }
        res.json({ success: true, latency_ms: Date.now() - start, model_used: testModel, reply, rate_limits: codexHeadersOut });
    } catch (err: unknown) {
        const msg = (err as Error).message;
        const is429 = msg.includes('429');
        res.status(is429 ? 200 : 500).json({
            success: false,
            latency_ms: Date.now() - start,
            model_used: testModel,
            error: is429 ? 'Account is rate-limited by the provider' : msg,
            rate_limits: null,
        });
    }
});

// ── Refresh token manually (debug) ────────────────────────────────────────────
router.post('/refresh/:id', async (req, res) => {
    const account = await getDedicatedAccount(req.params.id);
    if (!account) { res.status(404).json({ error: 'Dedicated account not found' }); return; }

    const tokens = await getDecryptedDedicatedTokens(req.params.id);
    if (!tokens?.refreshToken) {
        res.status(400).json({ error: 'No refresh token — reconnect this account' });
        return;
    }

    try {
        const { accessToken, refreshToken, expiresAt } = await refreshOpenAIToken(tokens.refreshToken);
        const { updateDedicatedTokens } = await import('../db/dedicated-accounts.js');
        await updateDedicatedTokens(req.params.id, accessToken, refreshToken, expiresAt);
        res.json({ ok: true, expires_at: expiresAt.toISOString() });
    } catch (err: unknown) {
        const msg = (err as Error).message;
        await setDedicatedStatus(req.params.id, 'auth_expired', msg);
        res.status(500).json({ error: msg });
    }
});

export default router;
