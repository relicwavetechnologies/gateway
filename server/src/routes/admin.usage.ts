import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getUsageSummary, listAlerts, resolveAlert } from '../db/usage.js';
import { sendEmail } from '../utils/email.js';
import { getProxyStats } from './proxy.js';

const router = Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
    const days = req.query.days ? Number(req.query.days) : 7;
    res.json(await getUsageSummary({ days }));
});

router.get('/stats', (_req, res) => {
    res.json(getProxyStats());
});

router.get('/alerts', async (req, res) => {
    const resolved = req.query.resolved === 'true';
    res.json(await listAlerts(resolved));
});

router.post('/alerts/:id/resolve', async (req, res) => {
    await resolveAlert(req.params.id);
    res.json({ ok: true });
});

router.post('/test-email', async (req, res) => {
    const to = (req.body as { to?: string }).to ?? process.env.ALERT_TO_EMAIL ?? '';
    if (!to) { res.status(400).json({ error: 'Provide a "to" email address or set ALERT_TO_EMAIL env var' }); return; }
    const result = await sendEmail({
        to,
        subject: '✅ Gateway email test',
        html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
          <h2 style="color:#10b981">✅ Email is working!</h2>
          <p>Your AI Gateway can send emails. Alert notifications will be delivered here when accounts hit rate limits or auth expires.</p>
          <p style="color:#6b7280;font-size:12px;margin-top:24px">Sent by your AI Gateway · ${new Date().toISOString()}</p>
        </div>`,
    });
    res.json(result);
});

export default router;
