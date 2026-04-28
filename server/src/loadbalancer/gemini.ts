import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

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

// Cache project IDs per access token (cleared when token refreshes)
const projectCache = new Map<string, { projectId: string; fetchedAt: number }>();

async function getProjectId(accessToken: string): Promise<string> {
    const cached = projectCache.get(accessToken);
    if (cached && Date.now() - cached.fetchedAt < 25 * 60_000) return cached.projectId; // cache 25min

    const res = await axios.post<{ cloudaicompanionProject?: string }>(
        `${BASE}:loadCodeAssist`,
        { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } },
        { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );

    const projectId = res.data.cloudaicompanionProject;
    if (!projectId) throw new Error('Could not get Gemini project ID from loadCodeAssist');

    projectCache.set(accessToken, { projectId, fetchedAt: Date.now() });
    return projectId;
}

function toGeminiContents(messages: OpenAIMessage[]) {
    const system = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    return {
        contents: rest.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        systemInstruction: system ? { parts: [{ text: system.content }] } : undefined,
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

    const projectId = await getProjectId(account.access_token);
    const isStream = openaiRequest.stream ?? false;
    const { contents, systemInstruction } = toGeminiContents(openaiRequest.messages ?? []);

    const innerRequest = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: { maxOutputTokens: openaiRequest.max_tokens ?? 4096 },
    };

    const body = { model, project: projectId, request: innerRequest };
    const headers = { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' };

    if (isStream) {
        const response = await axios.post(
            `${BASE}:streamGenerateContent`,
            body,
            { headers, params: { alt: 'sse' }, responseType: 'stream', timeout: 120_000 },
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
                for (const line of chunk.toString().split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data) continue;
                    try {
                        const evt = JSON.parse(data) as {
                            response?: { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
                        };
                        const text = evt.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
                        const done = evt.response?.candidates?.[0]?.finishReason === 'STOP';
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
            response?: {
                candidates?: { content?: { parts?: { text?: string }[] } }[];
                usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
            };
        }>(`${BASE}:generateContent`, body, { headers, timeout: 120_000 });

        const replyText = response.data.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const usage = response.data.response?.usageMetadata;

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
