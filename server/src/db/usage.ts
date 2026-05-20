import sql from './index.js';

export interface Alert {
    id: string;
    account_id: string | null;
    provider: string | null;
    kind: string;
    message: string;
    count: number;
    first_seen: number;
    last_seen: number;
    emailed_at: number | null;
    resolved: number;
    account_label?: string | null;
}

const now = () => Date.now();
const DAY = 86_400_000;

export async function logUsage(params: {
    id: string;
    apiKeyId: string;
    accountId: string;
    provider: string;
    model: string;
    statusCode: number;
    latencyMs: number;
    error?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
}): Promise<void> {
    const { id, apiKeyId, accountId, provider, model, statusCode, latencyMs, error, promptTokens, completionTokens } = params;
    await sql`
        INSERT INTO usage_logs (id, api_key_id, account_id, provider, model, status_code, latency_ms, error, prompt_tokens, completion_tokens, created_at)
        VALUES (${id}, ${apiKeyId}, ${accountId}, ${provider}, ${model}, ${statusCode}, ${latencyMs}, ${error ?? null}, ${promptTokens ?? null}, ${completionTokens ?? null}, ${now()})
    `;
    // prune old logs (fire-and-forget)
    sql`DELETE FROM usage_logs WHERE created_at < ${now() - 30 * DAY}`.catch(() => null);
}

export async function getUsageSummary({ days = 7 }: { days?: number } = {}): Promise<{
    total_requests: number;
    total_errors: number;
    error_rate: number;
    openai_requests: number;
    claude_requests: number;
    gemini_requests: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    p50_latency_ms: number | null;
    p95_latency_ms: number | null;
    timeline: { label: string; openai: number; claude: number; gemini: number; errors: number }[];
    by_account: { account_id: string; label: string | null; provider: string; count: number; errors: number; prompt_tokens: number; completion_tokens: number }[];
    by_key: { key_id: string; key_name: string | null; key_prefix: string | null; count: number; errors: number; prompt_tokens: number; completion_tokens: number }[];
    by_model: { model: string; provider: string; count: number; prompt_tokens: number; completion_tokens: number }[];
}> {
    const from = now() - days * DAY;
    const to = now();

    const [totalRow] = await sql<[{ n: string; pt: string; ct: string }]>`
        SELECT COUNT(*) as n,
               COALESCE(SUM(prompt_tokens), 0) as pt,
               COALESCE(SUM(completion_tokens), 0) as ct
        FROM usage_logs WHERE created_at BETWEEN ${from} AND ${to}`;
    const [errRow] = await sql<[{ n: string }]>`SELECT COUNT(*) as n FROM usage_logs WHERE status_code >= 400 AND created_at BETWEEN ${from} AND ${to}`;
    const [latencyRow] = await sql<[{ p50_latency_ms: number | null; p95_latency_ms: number | null }]>`
        SELECT
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) as p50_latency_ms,
            PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency_ms
        FROM usage_logs
        WHERE status_code < 400 AND created_at BETWEEN ${from} AND ${to}
    `;

    const byProvider = await sql<{ provider: string; n: string }[]>`
        SELECT provider, COUNT(*) as n
        FROM usage_logs WHERE created_at BETWEEN ${from} AND ${to}
        GROUP BY provider
    `;

    const byAccount = await sql<{ account_id: string; label: string | null; provider: string; count: string; errors: string; prompt_tokens: string; completion_tokens: string }[]>`
        SELECT u.account_id, a.label, COALESCE(a.provider, u.provider) as provider,
               COUNT(*) as count,
               SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) as errors,
               COALESCE(SUM(u.prompt_tokens), 0) as prompt_tokens,
               COALESCE(SUM(u.completion_tokens), 0) as completion_tokens
        FROM usage_logs u
        LEFT JOIN accounts a ON a.id = u.account_id
        WHERE u.created_at BETWEEN ${from} AND ${to}
        GROUP BY u.account_id, a.label, a.provider, u.provider
        ORDER BY count DESC
        LIMIT 20
    `;

    const byKey = await sql<{ key_id: string; key_name: string | null; key_prefix: string | null; count: string; errors: string; prompt_tokens: string; completion_tokens: string }[]>`
        SELECT u.api_key_id as key_id, k.name as key_name, k.key_prefix,
               COUNT(*) as count,
               SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) as errors,
               COALESCE(SUM(u.prompt_tokens), 0) as prompt_tokens,
               COALESCE(SUM(u.completion_tokens), 0) as completion_tokens
        FROM usage_logs u
        LEFT JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.created_at BETWEEN ${from} AND ${to}
        GROUP BY u.api_key_id, k.name, k.key_prefix
        ORDER BY count DESC
        LIMIT 10
    `;

    const byModel = await sql<{ model: string; provider: string; count: string; prompt_tokens: string; completion_tokens: string }[]>`
        SELECT model, provider,
               COUNT(*) as count,
               COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
               COALESCE(SUM(completion_tokens), 0) as completion_tokens
        FROM usage_logs
        WHERE created_at BETWEEN ${from} AND ${to}
        GROUP BY model, provider
        ORDER BY count DESC
        LIMIT 20
    `;

    const bucketMs = days <= 1 ? 3_600_000 : DAY;
    const bucketCount = days <= 1 ? 24 : days;

    const timeline: { label: string; openai: number; claude: number; gemini: number; errors: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
        const bucketFrom = from + i * bucketMs;
        const bucketTo = bucketFrom + bucketMs;
        const label = days <= 1
            ? new Date(bucketFrom).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
            : new Date(bucketFrom).toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });

        const [row] = await sql<[{ openai: string | null; claude: string | null; gemini: string | null; errors: string | null }]>`
            SELECT
                SUM(CASE WHEN provider = 'openai' THEN 1 ELSE 0 END) as openai,
                SUM(CASE WHEN provider = 'claude' THEN 1 ELSE 0 END) as claude,
                SUM(CASE WHEN provider = 'gemini' THEN 1 ELSE 0 END) as gemini,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
            FROM usage_logs WHERE created_at BETWEEN ${bucketFrom} AND ${bucketTo}
        `;
        timeline.push({ label, openai: Number(row?.openai ?? 0), claude: Number(row?.claude ?? 0), gemini: Number(row?.gemini ?? 0), errors: Number(row?.errors ?? 0) });
    }

    const providerMap = Object.fromEntries(byProvider.map(r => [r.provider, Number(r.n)]));
    const totalReqs = Number(totalRow.n);
    const totalErrors = Number(errRow.n);

    return {
        total_requests: totalReqs,
        total_errors: totalErrors,
        error_rate: totalReqs > 0 ? Math.round((totalErrors / totalReqs) * 100) : 0,
        openai_requests: providerMap['openai'] ?? 0,
        claude_requests: providerMap['claude'] ?? 0,
        gemini_requests: providerMap['gemini'] ?? 0,
        total_prompt_tokens: Number(totalRow.pt),
        total_completion_tokens: Number(totalRow.ct),
        p50_latency_ms: latencyRow?.p50_latency_ms == null ? null : Math.round(Number(latencyRow.p50_latency_ms)),
        p95_latency_ms: latencyRow?.p95_latency_ms == null ? null : Math.round(Number(latencyRow.p95_latency_ms)),
        timeline,
        by_account: byAccount.map(r => ({ ...r, count: Number(r.count), errors: Number(r.errors), prompt_tokens: Number(r.prompt_tokens), completion_tokens: Number(r.completion_tokens) })),
        by_key: byKey.map(r => ({ ...r, count: Number(r.count), errors: Number(r.errors), prompt_tokens: Number(r.prompt_tokens), completion_tokens: Number(r.completion_tokens) })),
        by_model: byModel.map(r => ({ ...r, count: Number(r.count), prompt_tokens: Number(r.prompt_tokens), completion_tokens: Number(r.completion_tokens) })),
    };
}

export async function createAlert(params: {
    id: string;
    accountId: string | null;
    provider: string | null;
    kind: string;
    message: string;
}): Promise<string> {
    const { id, accountId, provider, kind, message } = params;
    // Use IS NOT DISTINCT FROM for NULL-safe comparison in PostgreSQL
    const [existing] = await sql<Alert[]>`
        SELECT * FROM alerts
        WHERE account_id IS NOT DISTINCT FROM ${accountId}
          AND kind = ${kind}
          AND resolved = 0
    `;
    if (existing) {
        await sql`UPDATE alerts SET count = count + 1, last_seen = ${now()}, message = ${message} WHERE id = ${existing.id}`;
        return existing.id;
    }
    await sql`
        INSERT INTO alerts (id, account_id, provider, kind, message, first_seen, last_seen)
        VALUES (${id}, ${accountId}, ${provider}, ${kind}, ${message}, ${now()}, ${now()})
    `;
    return id;
}

export async function markAlertEmailed(id: string): Promise<void> {
    await sql`UPDATE alerts SET emailed_at = ${now()} WHERE id = ${id}`;
}

export async function listAlerts(resolvedFilter = false): Promise<Alert[]> {
    return sql<Alert[]>`
        SELECT al.*, a.label as account_label
        FROM alerts al
        LEFT JOIN accounts a ON a.id = al.account_id
        WHERE al.resolved = ${resolvedFilter ? 1 : 0}
        ORDER BY al.last_seen DESC
        LIMIT 200
    `;
}

export async function resolveAlert(id: string): Promise<void> {
    await sql`UPDATE alerts SET resolved = 1 WHERE id = ${id}`;
}

export async function resolveAccountAlerts(accountId: string): Promise<void> {
    await sql`
        UPDATE alerts
        SET resolved = 1
        WHERE resolved = 0
          AND account_id = ${accountId}
          AND kind IN ('auth_expired', 'rate_limit')
    `;
}

export async function resolveProviderAllDownAlerts(provider: string): Promise<void> {
    await sql`
        UPDATE alerts
        SET resolved = 1
        WHERE resolved = 0
          AND provider = ${provider}
          AND account_id IS NULL
          AND kind = 'all_down'
    `;
}

export async function getUnEmailedAlerts(): Promise<Alert[]> {
    return sql<Alert[]>`
        SELECT * FROM alerts
        WHERE resolved = 0
          AND emailed_at IS NULL
        ORDER BY last_seen DESC
    `;
}
