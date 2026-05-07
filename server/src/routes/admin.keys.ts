import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/keys.js';
import { invalidateApiKey } from '../cache/hotpath.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
    res.json(await listApiKeys(req.uid));
});

router.post('/', async (req, res) => {
    const { name, allowed_providers, rate_limit_rpm } = req.body as {
        name?: string;
        allowed_providers?: string[];
        rate_limit_rpm?: number | null;
    };
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }

    const { raw, metadata } = await createApiKey({
        id: uuid(),
        name,
        allowedProviders: allowed_providers ?? ['openai', 'claude', 'gemini'],
        rateLimitRpm: rate_limit_rpm ?? null,
        createdBy: req.uid,
    });
    invalidateApiKey(metadata.id);
    res.json({ key: raw, metadata });
});

router.patch('/:id', async (req, res) => {
    const { allowed_providers } = req.body as { allowed_providers?: string[] };
    if (!allowed_providers?.length) { res.status(400).json({ error: 'allowed_providers required' }); return; }
    const { default: sql } = await import('../db/index.js');
    await sql`UPDATE api_keys SET allowed_providers = ${allowed_providers.join(',')} WHERE id = ${req.params.id}`;
    invalidateApiKey(req.params.id);
    res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
    await revokeApiKey(req.params.id, req.uid);
    invalidateApiKey(req.params.id);
    res.json({ ok: true });
});

export default router;
