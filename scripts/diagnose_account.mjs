#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: for each OpenAI account, show its status + how its
 * recent requests were logged (status_code). This answers: were the failing
 * requests recorded as SUCCESS (200) or as errors (429/5xx)?
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(new URL('../server/', import.meta.url));
const postgres = require('postgres');

const envFile = readFileSync(new URL('../server/.env', import.meta.url), 'utf8');
for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2];
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false });

try {
    console.log('\n=== OpenAI accounts: status, tier, cooldown, counters ===\n');
    const accounts = await sql`
        SELECT id, label, status, account_tier,
               request_count, error_count,
               cooldown_until, last_error,
               codex_primary_pct, codex_secondary_pct,
               last_used_at
        FROM accounts
        WHERE provider = 'openai'
        ORDER BY request_count DESC
    `;
    for (const a of accounts) {
        const cd = a.cooldown_until ? new Date(Number(a.cooldown_until)).toISOString() : 'none';
        const cdActive = a.cooldown_until && Number(a.cooldown_until) > Date.now() ? ' (ACTIVE)' : ' (expired)';
        console.log(`• ${a.label} (${a.id.slice(0,8)})`);
        console.log(`    status=${a.status}  tier=${a.account_tier}`);
        console.log(`    request_count=${a.request_count}  error_count=${a.error_count}`);
        console.log(`    cooldown_until=${cd}${a.cooldown_until ? cdActive : ''}`);
        console.log(`    codex_primary_pct=${a.codex_primary_pct ?? 'null'}  codex_secondary_pct=${a.codex_secondary_pct ?? 'null'}`);
        console.log(`    last_error=${(a.last_error ?? 'none').toString().slice(0,120)}`);
        console.log('');
    }

    console.log('\n=== usage_logs: status_code breakdown per account (last 7 days) ===\n');
    const week = Date.now() - 7 * 24 * 60 * 60_000;
    const breakdown = await sql`
        SELECT u.account_id, a.label,
               u.status_code,
               count(*)::int as n,
               max(u.created_at) as last_at
        FROM usage_logs u
        LEFT JOIN accounts a ON a.id = u.account_id
        WHERE u.provider = 'openai' AND u.created_at > ${week}
        GROUP BY u.account_id, a.label, u.status_code
        ORDER BY u.account_id, n DESC
    `;
    let lastAcct = null;
    for (const r of breakdown) {
        if (r.account_id !== lastAcct) {
            console.log(`\n  ${r.label ?? r.account_id?.slice(0,8) ?? 'unknown'} (${(r.account_id ?? '').slice(0,8)}):`);
            lastAcct = r.account_id;
        }
        console.log(`     status_code=${r.status_code}  ×${r.n}   last=${new Date(Number(r.last_at)).toISOString()}`);
    }

    console.log('\n\n=== Sample of recent OpenAI usage rows (latest 15) ===\n');
    const recent = await sql`
        SELECT u.account_id, a.label, u.model, u.status_code, u.latency_ms,
               u.prompt_tokens, u.completion_tokens, u.error, u.created_at
        FROM usage_logs u
        LEFT JOIN accounts a ON a.id = u.account_id
        WHERE u.provider = 'openai'
        ORDER BY u.created_at DESC
        LIMIT 15
    `;
    for (const r of recent) {
        console.log(`  ${new Date(Number(r.created_at)).toISOString()} | ${(r.label??'?').slice(0,14).padEnd(14)} | ${r.model?.padEnd(14)} | code=${r.status_code} | ${r.latency_ms}ms | err=${(r.error??'').toString().slice(0,60)}`);
    }
} catch (err) {
    console.error('DB error:', err.message);
} finally {
    await sql.end();
}
