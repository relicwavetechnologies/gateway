import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ResolvedKey } from '../db/keys.js';
import { getCachedApiKey } from '../cache/hotpath.js';

declare global {
    namespace Express {
        interface Request {
            uid: string;
            apiKey: ResolvedKey;
        }
    }
}

const SECRET = process.env.GATEWAY_SECRET ?? '';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) { res.status(401).json({ error: 'Missing authorization token' }); return; }

    try {
        const decoded = jwt.verify(token, SECRET) as { email: string; role: string };
        if (decoded.role !== 'admin') { res.status(403).json({ error: 'Forbidden' }); return; }
        req.uid = decoded.email;
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = (req.headers['x-api-key'] as string | undefined) ?? req.headers.authorization?.replace('Bearer ', '');
    if (!key) { res.status(401).json({ error: 'Missing X-API-Key header' }); return; }

    const keyData = await getCachedApiKey(key);
    if (!keyData) { res.status(401).json({ error: 'Invalid or revoked API key' }); return; }

    req.apiKey = keyData;
    next();
}
