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
    timeline: { label: string; openai: number; claude: number; errors: number }[];
    by_account: { account_id: string; label: string | null; provider: string; count: number; errors: number }[];
    by_key: { key_id: string; key_name: string | null; key_prefix: string | null; count: number; errors: number }[];
}> {
    const from = now() - days * DAY;
    const to = now();

    const [totalRow] = await sql<[{ n: string }]>`SELECT COUNT(*) as n FROM usage_logs WHERE created_at BETWEEN ${from} AND ${to}`;
    const [errRow] = await sql<[{ n: string }]>`SELECT COUNT(*) as n FROM usage_logs WHERE status_code >= 400 AND created_at BETWEEN ${from} AND ${to}`;

    const byProvider = await sql<{ provider: string; n: string }[]>`
        SELECT provider, COUNT(*) as n
        FROM usage_logs WHERE created_at BETWEEN ${from} AND ${to}
        GROUP BY provider
    `;

    const byAccount = await sql<{ account_id: string; label: string | null; provider: string; count: string; errors: string }[]>`
        SELECT u.account_id, a.label, a.provider,
               COUNT(*) as count,
               SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) as errors
        FROM usage_logs u
        LEFT JOIN accounts a ON a.id = u.account_id
        WHERE u.created_at BETWEEN ${from} AND ${to}
        GROUP BY u.account_id, a.label, a.provider
        ORDER BY count DESC
        LIMIT 20
    `;

    const byKey = await sql<{ key_id: string; key_name: string | null; key_prefix: string | null; count: string; errors: string }[]>`
        SELECT u.api_key_id as key_id, k.name as key_name, k.key_prefix,
               COUNT(*) as count,
               SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) as errors
        FROM usage_logs u
        LEFT JOIN api_keys k ON k.id = u.api_key_id
        WHERE u.created_at BETWEEN ${from} AND ${to}
        GROUP BY u.api_key_id, k.name, k.key_prefix
        ORDER BY count DESC
        LIMIT 10
    `;

    const bucketMs = days <= 1 ? 3_600_000 : DAY;
    const bucketCount = days <= 1 ? 24 : days;

    const timeline: { label: string; openai: number; claude: number; errors: number }[] = [];
    for (let i = 0; i < bucketCount; i++) {
        const bucketFrom = from + i * bucketMs;
        const bucketTo = bucketFrom + bucketMs;
        const label = days <= 1
            ? new Date(bucketFrom).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : new Date(bucketFrom).toLocaleDateString([], { month: 'short', day: 'numeric' });

        const [row] = await sql<[{ openai: string | null; claude: string | null; errors: string | null }]>`
            SELECT
                SUM(CASE WHEN provider = 'openai' THEN 1 ELSE 0 END) as openai,
                SUM(CASE WHEN provider = 'claude' THEN 1 ELSE 0 END) as claude,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors
            FROM usage_logs WHERE created_at BETWEEN ${bucketFrom} AND ${bucketTo}
        `;
        timeline.push({ label, openai: Number(row?.openai ?? 0), claude: Number(row?.claude ?? 0), errors: Number(row?.errors ?? 0) });
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
        timeline,
        by_account: byAccount.map(r => ({ ...r, count: Number(r.count), errors: Number(r.errors) })),
        by_key: byKey.map(r => ({ ...r, count: Number(r.count), errors: Number(r.errors) })),
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

export async function getUnEmailedAlerts(): Promise<Alert[]> {
    const oneHourAgo = now() - 3_600_000;
    return sql<Alert[]>`
        SELECT * FROM alerts
        WHERE resolved = 0
          AND (emailed_at IS NULL OR emailed_at < ${oneHourAgo})
        ORDER BY last_seen DESC
    `;
}
