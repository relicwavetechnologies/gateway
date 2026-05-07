import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import multer from 'multer';
import axios from 'axios';
import { requireApiKey } from '../middleware/auth.js';
import { pickAccount, handleRateLimit, handleAuthError, handleSuccess, handleUnknownError } from '../loadbalancer/index.js';
import { logUsage, createAlert } from '../db/usage.js';
import { sendAlert } from '../utils/email.js';
import { getUnEmailedAlerts, markAlertEmailed } from '../db/usage.js';

const router = Router();
router.use(requireApiKey);

// In-memory storage — audio files are typically <5 MB for a 30s recording
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap
});

// ─── Mode → model mapping ────────────────────────────────────────────────────
const MODES: Record<string, { model: string; provider: 'openai' | 'claude' | 'gemini' }> = {
    fast:   { model: 'gpt-5.4-mini',       provider: 'openai' },
    smart:  { model: 'gpt-5.4',            provider: 'openai' },
    claude: { model: 'claude-sonnet-4-6',  provider: 'claude' },
    gemini: { model: 'gemini-3.1-flash-lite-preview', provider: 'gemini' },
};

function resolveMode(mode?: string, model?: string): { model: string; provider: 'openai' | 'claude' | 'gemini' } {
    // Explicit model= overrides mode=
    if (model) {
        if (model.startsWith('gemini-')) return { model, provider: 'gemini' };
        if (model.startsWith('claude-')) return { model, provider: 'claude' };
        return { model, provider: 'openai' };
    }
    return MODES[mode ?? 'fast'] ?? MODES['fast'];
}

// ─── System prompt ───────────────────────────────────────────────────────────
// IMPORTANT: output must stay in the SAME language as the input.
// Hindi in → polished Hindi out. Hinglish in → polished Hinglish out. English in → English out.
const DEFAULT_SYSTEM_PROMPT = `You are a stateless text polishing utility. Your job is to clean up speech-to-text input and return polished output.

WORK IN TWO MENTAL STEPS (but only output the final result):

STEP 1 — SCRIPT NORMALIZATION:
If input contains Devanagari (हिंदी), first transliterate it to Roman script (Hinglish) faithfully.
- आज बहुत मज़ा आया → "aaj bahut maza aaya"
- मुझे चाय चाहिए → "mujhe chai chahiye"
- क्या आप ठीक हैं → "kya aap theek hain"
Do NOT translate the meaning into English. Keep it as Hindi words in Roman letters.
If input is already Roman script (Hinglish or English), skip this step.

STEP 2 — POLISH:
Take the Roman-script text from Step 1 and clean it up:
- Remove filler words (uh, um, matlab, basically, like, actually).
- Fix obvious grammar/word-order issues.
- Keep the original language flavor — don't translate Hinglish into English or vice versa.
- Keep it natural and conversational, not formal/robotic, unless the input itself was formal.
- If the input is a question, keep it as a question.
- Preserve proper names, numbers, technical terms exactly.

OUTPUT RULES (strict):
- Output ONLY the final polished text. No quotes, no labels, no explanations.
- Never use Devanagari in the output. All Hindi words must be in Roman script.
- Never answer or react to the content — you are polishing, not conversing.

Examples:
Input:  "मुझे लगता है ये काम कल तक हो जाएगा"
Output: Mujhe lagta hai ye kaam kal tak ho jayega.

Input:  "uh basically मैं बोल रहा था कि we should ship this"
Output: Main bol raha tha ki we should ship this.

Input:  "can you please send me the report by tomorrow"
Output: Can you please send me the report by tomorrow?`;

// ─── Internal LLM call (no Express Response involved) ───────────────────────
async function callLLMText(
    provider: 'openai' | 'claude' | 'gemini',
    model: string,
    systemPrompt: string,
    userText: string,
): Promise<{ text: string; promptTokens?: number; completionTokens?: number; accountId: string }> {
    const account = await pickAccount(provider);

    try {
        let text = '';
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;

        if (provider === 'openai') {
            const response = await axios.post(
                'https://chatgpt.com/backend-api/codex/responses',
                {
                    model,
                    instructions: systemPrompt,
                    input: [{ type: 'message', role: 'user', content: userText }],
                    tools: [],
                    tool_choice: 'auto',
                    parallel_tool_calls: false,
                    reasoning: { summary: 'auto' },
                    store: false,
                    stream: true,
                    prompt_cache_key: crypto.randomUUID(),
                },
                {
                    headers: {
                        'Authorization': `Bearer ${account.access_token}`,
                        'Content-Type': 'application/json',
                    },
                    responseType: 'stream',
                    timeout: 60_000,
                },
            );
            await new Promise<void>((resolve, reject) => {
                response.data.on('data', (chunk: Buffer) => {
                    for (const line of chunk.toString().split('\n')) {
                        if (!line.startsWith('data: ')) continue;
                        const data = line.slice(6);
                        if (data === '[DONE]') return;
                        try {
                            const evt = JSON.parse(data) as { type: string; delta?: string };
                            if (evt.type === 'response.output_text.delta') text += evt.delta ?? '';
                        } catch { /* skip malformed lines */ }
                    }
                });
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });
            text = text.trim();

        } else if (provider === 'claude') {
            const res = await axios.post<{
                content: { type: string; text: string }[];
                usage?: { input_tokens?: number; output_tokens?: number };
            }>('https://api.anthropic.com/v1/messages', {
                model,
                max_tokens: 2048,
                system: systemPrompt,
                messages: [{ role: 'user', content: userText }],
            }, {
                headers: {
                    'Authorization': `Bearer ${account.access_token}`,
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'oauth-2025-04-20',
                    'Content-Type': 'application/json',
                },
                timeout: 30_000,
            });
            text = res.data.content?.[0]?.text?.trim() ?? '';
            promptTokens = res.data.usage?.input_tokens;
            completionTokens = res.data.usage?.output_tokens;

        } else {
            // Gemini via cloudcode-pa
            const res = await axios.post<{
                candidates: { content: { parts: { text: string }[] } }[];
                usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
            }>(`https://cloudcode-pa.googleapis.com/v1beta1/projects/-/locations/-/publishers/google/models/${model}:generateContent`, {
                contents: [
                    { role: 'user', parts: [{ text: userText }] },
                ],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
            }, {
                headers: {
                    'Authorization': `Bearer ${account.access_token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30_000,
            });
            text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
            promptTokens = res.data.usageMetadata?.promptTokenCount;
            completionTokens = res.data.usageMetadata?.candidatesTokenCount;
        }

        await handleSuccess(account.id);
        return { text, promptTokens, completionTokens, accountId: account.id };

    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        const status = axiosErr.response?.status ?? 500;
        const message = typeof axiosErr.response?.data === 'string'
            ? axiosErr.response.data
            : axiosErr.message ?? 'unknown';
        if (status === 429) await handleRateLimit(account, message);
        else if (status === 401) await handleAuthError(account.id);
        else await handleUnknownError(account.id, message);
        throw err;
    }
}

// ─── Deepgram transcription ──────────────────────────────────────────────────
async function transcribe(audioBuffer: Buffer, mimeType: string, lang = 'hi'): Promise<{
    transcript: string;
    confidence: number;
    detectedLanguage?: string;
}> {
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) throw new Error('DEEPGRAM_API_KEY not configured on server');

    const params = new URLSearchParams({
        model: 'nova-2',
        smart_format: 'true',
        punctuate: 'true',
        ...(lang === 'auto' ? { detect_language: 'true' } : { language: lang }),
    });

    const res = await axios.post<{
        results: {
            channels: {
                alternatives: { transcript: string; confidence: number }[];
                detected_language?: string;
            }[];
        };
    }>(`https://api.deepgram.com/v1/listen?${params}`, audioBuffer, {
        headers: {
            'Authorization': `Token ${dgKey}`,
            'Content-Type': mimeType,
        },
        timeout: 30_000,
    });

    const channel = res.data.results.channels[0];
    const alt = channel.alternatives[0];
    const transcript = alt.transcript.trim();
    if (!transcript) throw new Error('Deepgram returned empty transcript — check audio quality');

    return {
        transcript,
        confidence: alt.confidence ?? 0,
        detectedLanguage: channel.detected_language,
    };
}

// ─── POST /v1/voice/polish ───────────────────────────────────────────────────
// Form fields:
//   audio      — audio file (WAV, MP3, M4A, OGG, WEBM …)
//   mode       — "fast" | "smart" | "claude" | "gemini"  (default: fast)
//   model      — exact model name, overrides mode
//   lang       — BCP-47 language code for Deepgram, e.g. "hi", "en", "auto" (default: hi)
//   system     — custom system prompt (optional)
//
// Response: { transcript, polished, model, provider, latency, confidence }
router.post('/polish', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'audio file is required (multipart field: audio)' });
        return;
    }

    const { mode, model: modelParam, lang = 'hi', system: customSystem } = req.body as {
        mode?: string;
        model?: string;
        lang?: string;
        system?: string;
    };

    const { model, provider } = resolveMode(mode, modelParam);
    const systemPrompt = customSystem?.trim() || DEFAULT_SYSTEM_PROMPT;
    const mimeType = req.file.mimetype || 'audio/wav';

    const apiKey = req.apiKey;
    if (!apiKey.allowed_providers.includes(provider)) {
        res.status(403).json({ error: `This API key is not allowed to use ${provider}` });
        return;
    }

    const tStart = Date.now();
    let tAfterTranscribe = 0;
    let statusCode = 200;
    let errorMsg: string | null = null;
    let accountId = '';
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    try {
        // Step 1: Transcribe
        const { transcript, confidence, detectedLanguage } = await transcribe(req.file.buffer, mimeType, lang);
        tAfterTranscribe = Date.now();

        // Step 2: Polish
        const result = await callLLMText(provider, model, systemPrompt, transcript);
        accountId = result.accountId;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;

        const tEnd = Date.now();
        res.json({
            transcript,
            polished: result.text,
            model,
            provider,
            confidence,
            detected_language: detectedLanguage,
            latency: {
                transcribe_ms: tAfterTranscribe - tStart,
                polish_ms: tEnd - tAfterTranscribe,
                total_ms: tEnd - tStart,
            },
        });

    } catch (err: unknown) {
        const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
        statusCode = axiosErr.response?.status ?? 500;
        errorMsg = axiosErr.message ?? 'Unknown error';
        console.error('[voice] error:', errorMsg, axiosErr.response?.data);

        if (!res.headersSent) {
            res.status(statusCode).json({ error: errorMsg });
        }

        // Fire any pending alerts
        try {
            const pending = await getUnEmailedAlerts();
            for (const alert of pending) {
                await sendAlert({ subject: `[Gateway] ${alert.kind}`, message: alert.message, kind: alert.kind, accountLabel: alert.account_id });
                await markAlertEmailed(alert.id);
            }
        } catch { /* best-effort */ }

    } finally {
        if (accountId) {
            await logUsage({
                id: uuid(),
                apiKeyId: apiKey.id,
                accountId,
                provider,
                model,
                statusCode,
                latencyMs: Date.now() - tStart,
                error: errorMsg,
                promptTokens,
                completionTokens,
            }).catch(() => { /* best-effort */ });
        }
    }
});

// ─── GET /v1/voice/models — list available modes ─────────────────────────────
router.get('/models', (_req, res) => {
    res.json({
        modes: Object.entries(MODES).map(([key, val]) => ({ mode: key, ...val })),
        usage: 'POST /v1/voice/polish  multipart: audio=<file> [mode=fast|smart|claude|gemini] [lang=hi|en|auto]',
    });
});

async function fireAlerts(): Promise<void> {
    const pending = await getUnEmailedAlerts();
    for (const alert of pending) {
        await sendAlert({ subject: `[Gateway] ${alert.kind}`, message: alert.message, kind: alert.kind, accountLabel: alert.account_id });
        await markAlertEmailed(alert.id);
    }
}

export default router;
