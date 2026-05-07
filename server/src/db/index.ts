import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const sql = postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    max: 10,
    idle_timeout: 30,
});

export default sql;

export async function initSchema(): Promise<void> {
    await sql`
        CREATE TABLE IF NOT EXISTS accounts (
            id                TEXT PRIMARY KEY,
            provider          TEXT NOT NULL CHECK(provider IN ('openai','claude','gemini')),
            label             TEXT NOT NULL,
            account_tier      TEXT NOT NULL DEFAULT 'free'
                              CHECK(account_tier IN ('free','pro')),
            status            TEXT NOT NULL DEFAULT 'active'
                              CHECK(status IN ('active','rate_limited','auth_expired','error','disabled')),
            access_token_enc  TEXT,
            refresh_token_enc TEXT,
            oauth_expires_at  BIGINT,
            cooldown_until    BIGINT,
            request_count     INTEGER NOT NULL DEFAULT 0,
            error_count       INTEGER NOT NULL DEFAULT 0,
            last_error        TEXT,
            last_used_at      BIGINT,
            created_at        BIGINT NOT NULL,
            created_by        TEXT NOT NULL
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS api_keys (
            id                TEXT PRIMARY KEY,
            hashed_key        TEXT NOT NULL UNIQUE,
            key_prefix        TEXT NOT NULL,
            name              TEXT NOT NULL,
            allowed_providers TEXT NOT NULL DEFAULT 'openai,claude',
            rate_limit_rpm    INTEGER,
            created_at        BIGINT NOT NULL,
            created_by        TEXT NOT NULL,
            last_used_at      BIGINT,
            revoked           INTEGER NOT NULL DEFAULT 0
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS usage_logs (
            id                TEXT PRIMARY KEY,
            api_key_id        TEXT NOT NULL,
            account_id        TEXT NOT NULL,
            provider          TEXT NOT NULL,
            model             TEXT NOT NULL,
            status_code       INTEGER NOT NULL,
            latency_ms        INTEGER NOT NULL,
            error             TEXT,
            prompt_tokens     INTEGER,
            completion_tokens INTEGER,
            created_at        BIGINT NOT NULL
        )
    `;

    await sql`
        CREATE TABLE IF NOT EXISTS alerts (
            id          TEXT PRIMARY KEY,
            account_id  TEXT,
            provider    TEXT,
            kind        TEXT NOT NULL,
            message     TEXT NOT NULL,
            count       INTEGER NOT NULL DEFAULT 1,
            first_seen  BIGINT NOT NULL,
            last_seen   BIGINT NOT NULL,
            emailed_at  BIGINT,
            resolved    INTEGER NOT NULL DEFAULT 0
        )
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_logs(account_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved, last_seen DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(hashed_key)`;

    await sql`
        ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS account_tier TEXT NOT NULL DEFAULT 'free'
    `;

    await sql`
        ALTER TABLE accounts
        DROP CONSTRAINT IF EXISTS accounts_account_tier_check
    `.catch(() => { /* ignore if constraint name differs */ });
    await sql`
        ALTER TABLE accounts
        ADD CONSTRAINT accounts_account_tier_check CHECK(account_tier IN ('free','pro'))
    `.catch(() => { /* already correct */ });

    // Migration: widen provider constraint to include gemini
    await sql`
        ALTER TABLE accounts
        DROP CONSTRAINT IF EXISTS accounts_provider_check
    `.catch(() => { /* ignore if constraint name differs */ });
    await sql`
        ALTER TABLE accounts
        ADD CONSTRAINT accounts_provider_check CHECK(provider IN ('openai','claude','gemini'))
    `.catch(() => { /* already correct */ });
}
