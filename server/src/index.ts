import './utils/env.js';
import express from 'express';
import cors from 'cors';
import 'express-async-errors';
import { initSchema } from './db/index.js';

import authRouter from './routes/auth.js';
import adminAccountsRouter from './routes/admin.accounts.js';
import adminKeysRouter from './routes/admin.keys.js';
import adminUsageRouter from './routes/admin.usage.js';
import proxyRouter from './routes/proxy.js';

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.use('/auth', authRouter);
app.use('/admin/accounts', adminAccountsRouter);
app.use('/admin/api-keys', adminKeysRouter);
app.use('/admin/usage', adminUsageRouter);
app.use('/v1', proxyRouter);

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));


app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
});

async function main() {
    await initSchema();
    app.listen(PORT, () => {
        console.log(`Gateway server running on http://localhost:${PORT}`);
        console.log(`  OpenAI proxy : POST /v1/chat/completions`);
        console.log(`  Claude proxy : POST /v1/messages`);
        console.log(`  Admin API    : /admin/*`);
    });
}

main().catch(err => { console.error('Failed to start:', err); process.exit(1); });

export default app;
