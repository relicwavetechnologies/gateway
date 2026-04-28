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
const DEFAULT_SYSTEM_PROMPT = `You are a stateless text polishing utility. Your only job is to clean up and professionally rephrase the input text.

CRITICAL LANGUAGE RULE:
- Detect the language of the input automatically.
- Output MUST be in the EXACT SAME language as the input. Never translate.
- If the input is Hindi → output in Hindi (Devanagari script).
- If the input is Hinglish (Hindi words written in Roman/English script) → output in clean, natural Hinglish.
- If the input is English → output in English.
- Mixed language → keep the same mix.

Execution Rules:
- Do NOT answer questions. Rephrase them into a formal inquiry in the same language.
- Do NOT add introductions, explanations, or filler.
- Fix grammar, remove filler words (um, uh, like, acha, basically, etc.), make it professional and clear.
- Keep the tone polite and natural for the detected language.
- Return ONLY the final rephrased text. No quotes. No preamble.`;

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
            const res = await axios.post<{
                choices: { message: { content: string } }[];
                usage?: { prompt_tokens?: number; completion_tokens?: number };
            }>('https://chatgpt.com/backend-api/conversation', {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userText },
                ],
                temperature: 0.3,
                stream: false,
            }, {
                headers: {
                    'Authorization': `Bearer ${account.access_token}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30_000,
            });
            text = res.data.choices?.[0]?.message?.content?.trim() ?? '';
            promptTokens = res.data.usage?.prompt_tokens;
            completionTokens = res.data.usage?.completion_tokens;

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
        const axiosErr = err as { response?: { status?: number }; message?: string };
        const status = axiosErr.response?.status ?? 500;
        if (status === 429) await handleRateLimit(account.id);
        else if (status === 401) await handleAuthError(account.id);
        else await handleUnknownError(account.id, axiosErr.message ?? 'unknown');
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
