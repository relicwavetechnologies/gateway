const DEBUG_LATENCY = process.env.GATEWAY_LATENCY_DEBUG === '1';

export function logLatency(scope: string, event: string, startedAt: number, details?: string): void {
    if (!DEBUG_LATENCY) return;
    const suffix = details ? ` ${details}` : '';
    console.log(`[latency] ${scope} ${event} ${Date.now() - startedAt}ms${suffix}`);
}
