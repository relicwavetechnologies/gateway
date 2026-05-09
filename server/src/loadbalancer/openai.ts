import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount, CodexHeaders } from '../db/accounts.js';
import { logLatency } from '../utils/timing.js';

const ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';

// ─── Model aliases ────────────────────────────────────────────────────────────
// Maps public/common model names to the actual chatgpt.com backend model IDs.
// Unknown names pass through — the API returns the error.
const MODEL_ALIASES: Record<string, string> = {
    // GPT-4o family → latest internal equivalent
    'gpt-4o':             'gpt-5.4',
    'gpt-4o-mini':        'gpt-5.4-mini',
    'gpt-4o-2024-11-20':  'gpt-5.4',
    'gpt-4o-2024-08-06':  'gpt-5.4',
    // GPT-4 family
    'gpt-4':              'gpt-5.4',
    'gpt-4-turbo':        'gpt-5.4',
    // o-series → codex
    'o1':                 'gpt-5.3-codex',
    'o1-mini':            'gpt-5.4-mini',
    'o3':                 'gpt-5.3-codex',
    'o3-mini':            'gpt-5.4-mini',
    'o4-mini':            'gpt-5.4-mini',
    // Canonical names pass through unchanged (still listed for clarity)
    'gpt-5.4':            'gpt-5.4',
    'gpt-5.4-mini':       'gpt-5.4-mini',
    'gpt-5.3-codex':      'gpt-5.3-codex',
};

function normalizeModel(model: string): string {
    return MODEL_ALIASES[model] ?? model;
}

interface OpenAIMessage {
    role: string;
    content: string;
}

interface OpenAIRequest {
    model: string;
    messages?: OpenAIMessage[];
    stream?: boolean;
}

type OpenAIForwardResult = { replyText: string; codexHeaders?: CodexHeaders };

function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const maybeGetter = headers as { get?: (key: string) => unknown };
    const value = typeof maybeGetter.get === 'function'
        ? maybeGetter.get(name)
        : (headers as Record<string, unknown>)[name] ?? (headers as Record<string, unknown>)[name.toLowerCase()];
    if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
    if (value === undefined || value === null) return undefined;
    return String(value);
}

function parseHeaderNumber(headers: unknown, name: string): number | undefined {
    const value = headerValue(headers, name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCodexHeaders(headers: unknown): CodexHeaders | undefined {
    const codexHeaders: CodexHeaders = {};
    const planType = headerValue(headers, 'x-codex-plan-type')?.trim().toLowerCase();
    const primaryPct = parseHeaderNumber(headers, 'x-codex-primary-used-percent');
    const primaryResetSeconds = parseHeaderNumber(headers, 'x-codex-primary-reset-after-seconds');
    const secondaryPct = parseHeaderNumber(headers, 'x-codex-secondary-used-percent');
    const secondaryResetSeconds = parseHeaderNumber(headers, 'x-codex-secondary-reset-after-seconds');
    const credits = parseHeaderNumber(headers, 'x-codex-credits-balance');

    if (planType) codexHeaders.planType = planType;
    if (primaryPct !== undefined) codexHeaders.primaryPct = primaryPct;
    if (primaryResetSeconds !== undefined) codexHeaders.primaryResetSeconds = primaryResetSeconds;
    if (secondaryPct !== undefined) codexHeaders.secondaryPct = secondaryPct;
    if (secondaryResetSeconds !== undefined) codexHeaders.secondaryResetSeconds = secondaryResetSeconds;
    if (credits !== undefined) codexHeaders.credits = credits;

    return Object.keys(codexHeaders).length ? codexHeaders : undefined;
}

export async function forwardToOpenAI(
    account: ActiveAccount,
    openaiRequest: OpenAIRequest,
    res: Response,
): Promise<OpenAIForwardResult> {
    const model = normalizeModel(openaiRequest.model);
    if (model !== openaiRequest.model) {
        console.log(`[openai] model alias: ${openaiRequest.model} → ${model}`);
    }
    const isStream = openaiRequest.stream ?? false;

    const payload = {
        model,
        instructions: openaiRequest.messages?.find(m => m.role === 'system')?.content ?? 'You are a helpful assistant.',
        input: (openaiRequest.messages ?? [])
            .filter(m => m.role !== 'system')
            .map(m => ({ type: 'message', role: m.role, content: m.content })),
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        reasoning: { summary: 'auto' },
        store: false,
        stream: true,
        prompt_cache_key: crypto.randomUUID(),
    };

    const upstreamStart = Date.now();
    const response = await axios.post(ENDPOINT, payload, {
        headers: {
            Authorization: `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60_000,
    });
    logLatency('openai', 'headers', upstreamStart, `account=${account.id}`);
    const codexHeaders = parseCodexHeaders(response.headers);

    if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sawFirstByte = false;
        response.data.on('data', (chunk: Buffer) => {
            if (!sawFirstByte) {
                sawFirstByte = true;
                logLatency('openai', 'first_byte', upstreamStart, `account=${account.id}`);
            }
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') { res.write('data: [DONE]\n\n'); return; }
                try {
                    const evt = JSON.parse(data) as { type: string; delta?: string };
                    if (evt.type === 'response.output_text.delta') {
                        replyText += evt.delta ?? '';
                        res.write(`data: ${JSON.stringify({
                            id: `chatcmpl-${Date.now()}`,
                            object: 'chat.completion.chunk',
                            model: openaiRequest.model,
                            choices: [{ index: 0, delta: { content: evt.delta ?? '' }, finish_reason: null }],
                        })}\n\n`);
                    } else if (evt.type === 'response.completed') {
                        res.write('data: [DONE]\n\n');
                    }
                } catch { /* skip malformed lines */ }
            }
        });

        return new Promise((resolve, reject) => {
            response.data.on('end', () => {
                logLatency('openai', 'complete', upstreamStart, `account=${account.id}`);
                res.end();
                resolve({ replyText, codexHeaders });
            });
            response.data.on('error', reject);
        });
    } else {
        let replyText = '';
        let sawFirstByte = false;
        await new Promise<void>((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
                if (!sawFirstByte) {
                    sawFirstByte = true;
                    logLatency('openai', 'first_byte', upstreamStart, `account=${account.id}`);
                }
                for (const line of chunk.toString().split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') return;
                    try {
                        const evt = JSON.parse(data) as { type: string; delta?: string };
                        if (evt.type === 'response.output_text.delta') replyText += evt.delta ?? '';
                    } catch { /* skip */ }
                }
            });
            response.data.on('end', () => {
                logLatency('openai', 'complete', upstreamStart, `account=${account.id}`);
                resolve();
            });
            response.data.on('error', reject);
        });

        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            model: openaiRequest.model,
            choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
        });
        return { replyText, codexHeaders };
    }
}
