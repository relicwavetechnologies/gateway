import { execFile } from 'child_process';
import { Response } from 'express';
import { ActiveAccount } from '../db/accounts.js';

const CLAUDE_BINARY = process.env.CLAUDE_BINARY ?? 'claude';
const DEFAULT_MODEL = process.env.CLAUDE_DEFAULT_MODEL ?? 'claude-sonnet-4-6';

interface AnthropicMessage {
    role: string;
    content: string;
}

interface AnthropicRequest {
    model?: string;
    messages?: AnthropicMessage[];
    stream?: boolean;
    max_tokens?: number;
}

function buildPrompt(messages: AnthropicMessage[]): string {
    return messages.map(m => {
        if (m.role === 'system') return `<system>${m.content}</system>`;
        if (m.role === 'assistant') return `Assistant: ${m.content}`;
        return m.content;
    }).join('\n\n');
}

export function forwardToClaude(
    account: ActiveAccount,
    anthropicRequest: AnthropicRequest,
    res: Response,
): Promise<{ replyText: string }> {
    const model = anthropicRequest.model ?? DEFAULT_MODEL;
    const messages = anthropicRequest.messages ?? [];
    const isStream = anthropicRequest.stream ?? false;
    const maxTokens = anthropicRequest.max_tokens ?? 4096;
    const prompt = buildPrompt(messages);

    return new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (account.access_token) env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = account.access_token;

        const child = execFile(
            CLAUDE_BINARY,
            ['-p', '--output-format', 'json', '--model', model, '--max-tokens', String(maxTokens)],
            { env, timeout: 120_000 },
            (err, stdout, stderr) => {
                if (err) {
                    const errMsg = stderr || err.message;
                    if (isStream) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg } })}\n\n`);
                        res.end();
                    } else {
                        res.status(500).json({ error: { type: 'api_error', message: errMsg } });
                    }
                    return reject(new Error(errMsg));
                }

                let parsed: { result?: string; content?: string } = {};
                try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
                const text = parsed.result ?? parsed.content ?? stdout.trim();

                if (isStream) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null } })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`);
                    res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                    res.end();
                } else {
                    res.json({
                        id: `msg_${Date.now()}`,
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [{ type: 'text', text }],
                        stop_reason: 'end_turn',
                        usage: { input_tokens: null, output_tokens: null },
                    });
                }
                resolve({ replyText: text });
            },
        );

        child.stdin?.write(prompt);
        child.stdin?.end();
    });
}
