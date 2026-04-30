import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

// ─── Endpoints ────────────────────────────────────────────────────────────────
// Gemini CLI OAuth tokens use cloudcode-pa (NOT generativelanguage.googleapis.com).
// generativelanguage.googleapis.com requires `generative-language` scope, but
// the CLI OAuth flow only grants `cloud-platform` scope.
// cloudcode-pa accepts `cloud-platform` scoped Bearer tokens.
const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com';
const LOAD_CODE_ASSIST_METADATA = {
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
};

const SUPPORTED_MODELS = new Set([
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash-base',
    'gemini-3.1-pro-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3-flash-lite-preview',
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

// ─── Project ID cache ─────────────────────────────────────────────────────────
// Keyed by access token; TTL 25 min (token lifetime is ~1 hour)
const projectCache = new Map<string, { projectId: string; fetchedAt: number }>();

function cacheProject(token: string, projectId: string) {
    projectCache.set(token, { projectId, fetchedAt: Date.now() });
}

function getCachedProject(token: string): string | undefined {
    const entry = projectCache.get(token);
    if (entry && Date.now() - entry.fetchedAt < 25 * 60_000) return entry.projectId;
    projectCache.delete(token);
    return undefined;
}

// ─── Project provisioning ─────────────────────────────────────────────────────
// Follows the full OpenClaw flow:
//   1. loadCodeAssist  — may return projectId directly (existing accounts)
//   2. onboardUser     — provisions a new project if needed (new accounts)
//   3. poll operation  — waits for async provisioning to complete
async function discoverProjectId(accessToken: string): Promise<string> {
    const cached = getCachedProject(accessToken);
    if (cached) return cached;

    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
        'Client-Metadata': JSON.stringify(LOAD_CODE_ASSIST_METADATA),
    };

    // Step 1: loadCodeAssist
    let loadData: {
        currentTier?: { id?: string };
        cloudaicompanionProject?: string | { id?: string };
        allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
    } = {};

    try {
        const res = await axios.post<typeof loadData>(
            `${CODE_ASSIST_BASE}/v1internal:loadCodeAssist`,
            { metadata: LOAD_CODE_ASSIST_METADATA },
            { headers, timeout: 15_000 },
        );
        loadData = res.data;
    } catch (err: any) {
        console.error('[gemini] loadCodeAssist error:', err.response?.status, err.response?.data);
        throw new Error(`loadCodeAssist failed: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    }

    // Extract projectId if loadCodeAssist already returned one
    const rawProject = loadData.cloudaicompanionProject;
    if (typeof rawProject === 'string' && rawProject) {
        cacheProject(accessToken, rawProject);
        return rawProject;
    }
    if (typeof rawProject === 'object' && rawProject?.id) {
        cacheProject(accessToken, rawProject.id);
        return rawProject.id;
    }

    // Step 2: onboardUser — provision a project (free-tier by default)
    const defaultTier =
        loadData.allowedTiers?.find(t => t.isDefault) ??
        loadData.allowedTiers?.[0] ??
        { id: 'free-tier' };

    let lro: {
        done?: boolean;
        name?: string;
        response?: { cloudaicompanionProject?: { id?: string } };
    };

    try {
        const res = await axios.post<typeof lro>(
            `${CODE_ASSIST_BASE}/v1internal:onboardUser`,
            { tierId: defaultTier.id ?? 'free-tier', metadata: LOAD_CODE_ASSIST_METADATA },
            { headers, timeout: 15_000 },
        );
        lro = res.data;
    } catch (err: any) {
        console.error('[gemini] onboardUser error:', err.response?.status, err.response?.data);
        throw new Error(`onboardUser failed: ${err.response?.status} ${JSON.stringify(err.response?.data)}`);
    }

    // Step 3: poll until the long-running operation completes
    if (!lro.done && lro.name) {
        for (let i = 0; i < 24; i++) {
            await new Promise(r => setTimeout(r, 5_000));
            try {
                const poll = await axios.get<typeof lro>(
                    `${CODE_ASSIST_BASE}/v1internal/${lro.name}`,
                    { headers, timeout: 10_000 },
                );
                lro = poll.data;
                if (lro.done) break;
            } catch { /* keep polling */ }
        }
    }

    const projectId = lro.response?.cloudaicompanionProject?.id;
    if (!projectId) throw new Error('Could not provision Gemini project. Try setting GOOGLE_CLOUD_PROJECT.');

    cacheProject(accessToken, projectId);
    return projectId;
}

// ─── Message conversion ───────────────────────────────────────────────────────
function toGeminiContents(messages: OpenAIMessage[]) {
    const system = messages.find(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    return {
        contents: rest.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        })),
        systemInstruction: system ? { parts: [{ text: system.content }] } : undefined,
    };
}

// ─── Inference ────────────────────────────────────────────────────────────────
export async function forwardToGemini(
    account: ActiveAccount,
    openaiRequest: OpenAIRequest,
    res: Response,
): Promise<{ replyText: string; promptTokens?: number; completionTokens?: number }> {
    const model = openaiRequest.model;
    if (!SUPPORTED_MODELS.has(model)) {
        throw new Error(`Unsupported Gemini model "${model}". Available: ${[...SUPPORTED_MODELS].join(', ')}`);
    }
    if (!account.access_token) throw new Error('No Gemini access token on account');

    // Discover / provision the project ID (cached after first call)
    const projectId = await discoverProjectId(account.access_token);

    const isStream = openaiRequest.stream ?? false;
    const { contents, systemInstruction } = toGeminiContents(openaiRequest.messages ?? []);

    // cloudcode-pa request body: { model, project, request: { contents, ... } }
    const innerRequest: Record<string, unknown> = {
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        generationConfig: { maxOutputTokens: openaiRequest.max_tokens ?? 4096 },
    };
    const body = { model, project: projectId, request: innerRequest };

    const headers = {
        'Authorization': `Bearer ${account.access_token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': `gl-node/${process.versions.node}`,
    };

    if (isStream) {
        const url = `${CODE_ASSIST_BASE}/v1internal:streamGenerateContent`;
        console.log('[gemini] stream →', url, '| project:', projectId);
        const response = await axios.post(url, body, {
            headers,
            params: { alt: 'sse' },
            responseType: 'stream',
            timeout: 120_000,
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        return new Promise((resolve, reject) => {
            let buffer = '';
            response.data.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        // cloudcode-pa SSE shape: { response: { candidates: [...] } }
                        const evt = JSON.parse(data) as {
                            response?: {
                                candidates?: {
                                    content?: { parts?: { text?: string }[] };
                                    finishReason?: string;
                                }[];
                                usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
                            };
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
                    } catch { /* skip malformed SSE chunks */ }
                }
            });
            response.data.on('end', () => { res.end(); resolve({ replyText }); });
            response.data.on('error', reject);
        });
    } else {
        const url = `${CODE_ASSIST_BASE}/v1internal:generateContent`;
        console.log('[gemini] non-stream →', url, '| project:', projectId);

        let response;
        try {
            response = await axios.post<{
                response?: {
                    candidates?: { content?: { parts?: { text?: string }[] } }[];
                    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
                };
            }>(url, body, { headers, timeout: 120_000 });
        } catch (err: any) {
            console.error('[gemini] generateContent error:', err.response?.status, JSON.stringify(err.response?.data));
            throw err;
        }

        // cloudcode-pa non-stream response: { response: { candidates, usageMetadata } }
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
                total_tokens: usage
                    ? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0)
                    : null,
            },
        });
        return {
            replyText,
            promptTokens: usage?.promptTokenCount ?? undefined,
            completionTokens: usage?.candidatesTokenCount ?? undefined,
        };
    }
}
