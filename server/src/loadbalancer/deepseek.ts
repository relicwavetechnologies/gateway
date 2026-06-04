import OpenAI from 'openai';
import { Response } from 'express';
import { logLatency } from '../utils/timing.js';

// DeepSeek is OpenAI-wire-compatible — we point the official OpenAI SDK at their
// base URL and pass the request through almost unchanged. Single API key, no
// account pool, no token rotation: the only resilience we add is the SDK's
// built-in retry/backoff on transient (429 / 5xx) failures.
const BASE_URL = 'https://api.deepseek.com/v1';

// ─── Model aliases ──────────────────────────────────────────────────────────
// V4 unified chat + reasoning into one model each, toggled by a `thinking` param.
// The legacy deepseek-chat / deepseek-reasoner names are deprecated upstream on
// 2026/07/24 — we keep them as aliases and preserve their think/non-think
// semantics so existing callers don't break.
const MODEL_ALIASES: Record<string, string> = {
    'deepseek-v4-flash':  'deepseek-v4-flash',
    'deepseek-v4-pro':    'deepseek-v4-pro',
    'deepseek-chat':      'deepseek-v4-flash', // legacy → non-thinking flash
    'deepseek-reasoner':  'deepseek-v4-flash', // legacy → thinking flash
};

export function getDeepSeekKey(): string {
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    if (!key) throw new Error('DEEPSEEK_API_KEY is not configured');
    return key;
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
    if (!client) {
        client = new OpenAI({
            apiKey: getDeepSeekKey(),
            baseURL: BASE_URL,
            maxRetries: 3,       // exponential backoff on 429 / 5xx — our single-key "load balancing"
            timeout: 120_000,    // reasoning traces can run long
        });
    }
    return client;
}

interface DeepSeekRequest {
    model: string;
    messages?: Array<{ role: string; content: unknown }>;
    stream?: boolean;
    [key: string]: unknown;
}

type DeepSeekForwardResult = { replyText: string; promptTokens?: number; completionTokens?: number };

// Apply the model alias and, for the legacy names, force the matching thinking mode.
function buildParams(req: DeepSeekRequest): Record<string, unknown> {
    const requested = req.model;
    const mapped = MODEL_ALIASES[requested] ?? requested;
    if (mapped !== requested) console.log(`[deepseek] model alias: ${requested} → ${mapped}`);

    const params: Record<string, unknown> = { ...req, model: mapped };
    // Preserve legacy semantics; for v4-* names we pass through whatever the caller sent.
    if (requested === 'deepseek-chat') params.thinking = { type: 'disabled' };
    else if (requested === 'deepseek-reasoner') params.thinking = { type: 'enabled' };
    return params;
}

export async function forwardToDeepSeek(
    deepseekRequest: DeepSeekRequest,
    res: Response,
): Promise<DeepSeekForwardResult> {
    const isStream = deepseekRequest.stream ?? false;
    const params = buildParams(deepseekRequest);
    const upstreamStart = Date.now();

    if (isStream) {
        // Ask the upstream to include token usage in the final chunk so we can log it.
        params.stream = true;
        params.stream_options = { include_usage: true };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream = await getClient().chat.completions.create(params as any) as any;
        logLatency('deepseek', 'headers', upstreamStart, 'stream');

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');

        let replyText = '';
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;
        let sawFirstByte = false;

        for await (const chunk of stream) {
            if (!sawFirstByte) {
                sawFirstByte = true;
                logLatency('deepseek', 'first_byte', upstreamStart, 'stream');
            }
            // DeepSeek chunks are already OpenAI chat.completion.chunk shaped
            // (including delta.reasoning_content) — pass straight through.
            const delta = chunk?.choices?.[0]?.delta;
            if (delta?.content) replyText += delta.content;
            if (chunk?.usage) {
                promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
                completionTokens = chunk.usage.completion_tokens ?? completionTokens;
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        logLatency('deepseek', 'complete', upstreamStart, 'stream');
        res.end();
        return { replyText, promptTokens, completionTokens };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completion = await getClient().chat.completions.create(params as any) as any;
    logLatency('deepseek', 'complete', upstreamStart, 'non-stream');

    res.json(completion);
    return {
        replyText: completion?.choices?.[0]?.message?.content ?? '',
        promptTokens: completion?.usage?.prompt_tokens,
        completionTokens: completion?.usage?.completion_tokens,
    };
}
