import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

const SUPPORTED_MODELS = new Set([
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-base',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3-flash-base',
]);

interface OpenAIMessage {
    role: string;
    content: string;
}

interface OpenAIRequest {
    model: string;
    messages?: OpenAIMessage[];
    stream?: boolean;
    max_tokens?: number;
}

interface GeminiContent {
    role: string;
    parts: { text: string }[];
}

function toGeminiContents(messages: OpenAIMessage[]): {
    contents: GeminiContent[];
    systemInstruction?: { parts: { text: string }[] };
} {
    const system = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');

    const contents: GeminiContent[] = rest.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));

    return {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system.content }] } } : {}),
    };
}

export async function forwardToGemini(
    account: ActiveAccount,
    openaiRequest: OpenAIRequest,
    res: Response,
): Promise<{ replyText: string }> {
    const model = openaiRequest.model;
    if (!SUPPORTED_MODELS.has(model)) {
        throw new Error(`Unsupported Gemini model "${model}". Available: ${[...SUPPORTED_MODELS].join(', ')}`);
    }
    if (!account.access_token) throw new Error('No Gemini access token on account');

    const isStream = openaiRequest.stream ?? false;
    const { contents, systemInstruction } = toGeminiContents(openaiRequest.messages ?? []);

    const payload = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: { maxOutputTokens: openaiRequest.max_tokens ?? 4096 },
    };

    const headers = {
        Authorization: `Bearer ${account.access_token}`,
        'Content-Type': 'application/json',
    };

    if (isStream) {
        const response = await axios.post(
            `${BASE_URL}/${model}:streamGenerateContent?alt=sse`,
            payload,
            { headers, responseType: 'stream', timeout: 120_000 },
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data) continue;
                    try {
                        const evt = JSON.parse(data) as {
                            candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
                        };
                        const text = evt.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                        const done = evt.candidates?.[0]?.finishReason === 'STOP';
                        if (text) {
                            replyText += text;
                            res.write(`data: ${JSON.stringify({
                                id: `chatcmpl-${Date.now()}`,
                                object: 'chat.completion.chunk',
                                model,
                                choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                            })}\n\n`);
                        }
                        if (done) res.write('data: [DONE]\n\n');
                    } catch { /* skip malformed */ }
                }
            });
            response.data.on('end', () => { res.end(); resolve({ replyText }); });
            response.data.on('error', reject);
        });
    } else {
        const response = await axios.post<{
            candidates?: { content?: { parts?: { text?: string }[] } }[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        }>(
            `${BASE_URL}/${model}:generateContent`,
            payload,
            { headers, timeout: 120_000 },
        );

        const replyText = response.data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const usage = response.data.usageMetadata;

        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: usage?.promptTokenCount ?? null,
                completion_tokens: usage?.candidatesTokenCount ?? null,
                total_tokens: usage ? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0) : null,
            },
        });
        return { replyText };
    }
}
