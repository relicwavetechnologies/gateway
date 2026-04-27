import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { requireAdmin } from '../middleware/auth.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/keys.js';

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
        allowedProviders: allowed_providers ?? ['openai', 'claude'],
        rateLimitRpm: rate_limit_rpm ?? null,
        createdBy: req.uid,
    });
    res.json({ key: raw, metadata });
});

router.delete('/:id', async (req, res) => {
    await revokeApiKey(req.params.id, req.uid);
    res.json({ ok: true });
});

export default router;
