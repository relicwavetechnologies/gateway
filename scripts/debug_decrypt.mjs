#!/usr/bin/env node
/**
 * Debug script: query accounts table and attempt decrypt on each one.
 * Shows exactly what's stored and why decrypt fails.
 */
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(new URL('../server/', import.meta.url));
const postgres = require('postgres');

// Load .env manually
const envFile = readFileSync(new URL('../server/.env', import.meta.url), 'utf8');
for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
}

const SECRET = process.env.GATEWAY_SECRET;
if (!SECRET || SECRET.length < 32) {
    console.error('GATEWAY_SECRET must be at least 32 characters');
    process.exit(1);
}

const KEY = crypto.scryptSync(SECRET, 'gateway-salt', 32);

function decrypt(b64) {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const sql = postgres(process.env.DATABASE_URL);

try {
    const rows = await sql`
        SELECT id, provider, label, status,
               access_token_enc, refresh_token_enc,
               oauth_expires_at, last_used_at, last_error,
               length(access_token_enc::text) as enc_len
        FROM accounts
        ORDER BY created_at DESC
    `;

    console.log(`\nFound ${rows.length} accounts\n`);
    console.log('='.repeat(80));

    for (const row of rows) {
        console.log(`\nAccount: ${row.label} (${row.id.slice(0, 8)}...)`);
        console.log(`  Provider: ${row.provider}`);
        console.log(`  Status: ${row.status}`);
        console.log(`  Last error: ${row.last_error ?? 'none'}`);
        console.log(`  OAuth expires: ${row.oauth_expires_at ? new Date(Number(row.oauth_expires_at)).toISOString() : 'NULL'}`);
        console.log(`  access_token_enc: ${row.access_token_enc ? `present (${row.enc_len} chars)` : 'NULL'}`);
        console.log(`  refresh_token_enc: ${row.refresh_token_enc ? `present (${String(row.refresh_token_enc).length} chars)` : 'NULL'}`);

        // Try to decrypt access token
        if (row.access_token_enc) {
            try {
                const raw = Buffer.from(row.access_token_enc, 'base64');
                console.log(`  access_token raw bytes: ${raw.length} (need >= 28)`);
                const token = decrypt(row.access_token_enc);
                console.log(`  ✅ access_token decrypts OK — ${token.slice(0, 30)}... (${token.length} chars)`);
            } catch (err) {
                console.log(`  ❌ access_token DECRYPT FAILED: ${err.message}`);
                console.log(`  ❌ First 60 chars of enc: ${row.access_token_enc.slice(0, 60)}`);
            }
        } else {
            console.log(`  ⚠️  access_token_enc is NULL — no token stored`);
        }

        // Try to decrypt refresh token
        if (row.refresh_token_enc) {
            try {
                const token = decrypt(row.refresh_token_enc);
                console.log(`  ✅ refresh_token decrypts OK — ${token.slice(0, 30)}... (${token.length} chars)`);
            } catch (err) {
                console.log(`  ❌ refresh_token DECRYPT FAILED: ${err.message}`);
            }
        } else {
            console.log(`  ⚠️  refresh_token_enc is NULL`);
        }

        console.log('-'.repeat(80));
    }
} catch (err) {
    console.error('DB error:', err.message);
} finally {
    await sql.end();
}
