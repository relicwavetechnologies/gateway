import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getUsageSummary, listAlerts, resolveAlert } from '../db/usage.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : 7;
    res.json(await getUsageSummary({ days }));
});

router.get('/alerts', async (req, res) => {
    const resolved = req.query.resolved === 'true';
    res.json(await listAlerts(resolved));
});

router.post('/alerts/:id/resolve', async (req, res) => {
    await resolveAlert(req.params.id);
    res.json({ ok: true });
});

export default router;
