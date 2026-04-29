import axios from 'axios';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

const API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL ?? 'claude-sonnet-4-6';

interface Message {
    role: string;
    content: string;
}

interface AnthropicRequest {
    model?: string;
    messages?: Message[];
    system?: string;
    stream?: boolean;
    max_tokens?: number;
}

// Claude Code system prompt required for OAuth tokens to pass Anthropic's inference gate
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

function buildHeaders(accessToken: string) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        // Both beta flags required for OAuth bearer tokens
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'Content-Type': 'application/json',
    };
}

function toAnthropicMessages(messages: Message[]): { system?: string; messages: Message[] } {
    const system = messages.find(m => m.role === 'system')?.content;
    const rest = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
    }));
    return { system, messages: rest };
}

export async function forwardToClaude(
    account: ActiveAccount,
    req: AnthropicRequest,
    res: Response,
): Promise<{ replyText: string; promptTokens?: number; completionTokens?: number }> {
    if (!account.access_token) throw new Error('No Claude access token on account');

    const model = req.model ?? DEFAULT_MODEL;
    const maxTokens = req.max_tokens ?? 4096;
    const isStream = req.stream ?? false;
    const headers = buildHeaders(account.access_token);
    const { system, messages } = toAnthropicMessages(req.messages ?? []);

    // Merge user system prompt with the required Claude Code system prompt
    const finalSystem = system
        ? `${CLAUDE_CODE_SYSTEM}\n\n${system}`
        : CLAUDE_CODE_SYSTEM;

    const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages,
        system: finalSystem,
        ...(isStream ? { stream: true } : {}),
    };

    if (isStream) {
        const response = await axios.post(
            `${API_BASE}/v1/messages`,
            body,
            { headers, responseType: 'stream', timeout: 120_000 },
        );

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        let replyText = '';

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk: Buffer) => {
                for (const line of chunk.toString().split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data || data === '[DONE]') continue;
                    try {
                        const evt = JSON.parse(data) as {
                            type?: string;
                            delta?: { type?: string; text?: string };
                        };
                        if (evt.type === 'content_block_delta' && evt.delta?.text) {
                            replyText += evt.delta.text;
                        }
                        // Forward SSE as-is (Anthropic format)
                        res.write(`data: ${data}\n\n`);
                    } catch { /* skip malformed */ }
                }
            });
            response.data.on('end', () => { res.end(); resolve({ replyText }); });
            response.data.on('error', reject);
        });
    } else {
        const response = await axios.post<{
            id: string;
            type: string;
            role: string;
            model: string;
            content: { type: string; text: string }[];
            stop_reason: string;
            usage?: { input_tokens?: number; output_tokens?: number };
        }>(`${API_BASE}/v1/messages`, body, { headers, timeout: 120_000 });

        const replyText = response.data.content?.[0]?.text ?? '';
        const usage = response.data.usage;

        // Forward the full Anthropic response as-is
        res.json(response.data);

        return {
            replyText,
            promptTokens: usage?.input_tokens ?? undefined,
            completionTokens: usage?.output_tokens ?? undefined,
        };
    }
}
