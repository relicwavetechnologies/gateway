import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

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

export async function forwardToOpenAI(
    account: ActiveAccount,
    openaiRequest: OpenAIRequest,
    res: Response,
): Promise<{ replyText: string }> {
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

    const response = await axios.post(ENDPOINT, payload, {
        headers: {
            Authorization: `Bearer ${account.access_token}`,
            'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 60_000,
    });

    if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response.data.on('data', (chunk: Buffer) => {
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
            response.data.on('end', () => { res.end(); resolve({ replyText }); });
            response.data.on('error', reject);
        });
    } else {
        let replyText = '';
        await new Promise<void>((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
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
            response.data.on('end', resolve);
            response.data.on('error', reject);
        });

        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            model: openaiRequest.model,
            choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null },
        });
        return { replyText };
    }
}
