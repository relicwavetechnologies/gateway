import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const sql = postgres(process.env.DATABASE_URL, {
    ssl: 'require',
    max: 10,
    idle_timeout: 30,
    prepare: false,  // Neon uses pgBouncer in transaction mode — prepared statements don't survive connection reuse
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
            codex_plan_type   TEXT,
            codex_primary_pct REAL,
            codex_primary_reset BIGINT,
            codex_secondary_pct REAL,
            codex_secondary_reset BIGINT,
            codex_credits     REAL,
            codex_updated_at  BIGINT,
            recovered_at      BIGINT,
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

    await sql`
        CREATE TABLE IF NOT EXISTS dedicated_accounts (
            id                      TEXT PRIMARY KEY,
            owner_app               TEXT NOT NULL,
            label                   TEXT,
            provider                TEXT NOT NULL DEFAULT 'openai',
            tier                    TEXT NOT NULL DEFAULT 'pro',
            access_token_enc        TEXT,
            refresh_token_enc       TEXT,
            oauth_expires_at        BIGINT,
            status                  TEXT NOT NULL DEFAULT 'pending',
            cooldown_until          BIGINT,
            last_error              TEXT,
            last_used_at            BIGINT,
            request_count           BIGINT NOT NULL DEFAULT 0,
            primary_used_percent    REAL,
            primary_reset_at        BIGINT,
            secondary_used_percent  REAL,
            secondary_reset_at      BIGINT,
            plan_type               TEXT,
            credits_balance         REAL,
            api_key_id              TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
            pkce_session_id         TEXT,
            created_at              BIGINT NOT NULL,
            updated_at              BIGINT NOT NULL
        )
    `;

    await sql`CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_logs(account_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved, last_seen DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(hashed_key)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_dedicated_owner ON dedicated_accounts(owner_app)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_dedicated_api_key ON dedicated_accounts(api_key_id)`;

    await sql`
        ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS account_tier TEXT NOT NULL DEFAULT 'free'
    `;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_plan_type TEXT`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_primary_pct REAL`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_primary_reset BIGINT`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_secondary_pct REAL`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_secondary_reset BIGINT`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_credits REAL`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS codex_updated_at BIGINT`;
    await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovered_at BIGINT`;
    await sql`ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS is_dedicated INTEGER NOT NULL DEFAULT 0`;
    await sql`ALTER TABLE dedicated_accounts ADD COLUMN IF NOT EXISTS pkce_session_id TEXT`;

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
