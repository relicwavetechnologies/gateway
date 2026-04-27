import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';
const SECRET = process.env.GATEWAY_SECRET ?? '';

router.post('/login', (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
        res.status(400).json({ error: 'email and password are required' });
        return;
    }

    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
    }

    const token = jwt.sign({ email, role: 'admin' }, SECRET, { expiresIn: '30d' });
    res.json({ token });
});

export default router;
