#!/usr/bin/env node
/**
 * Test whether ChatGPT/Codex OAuth tokens can call the embeddings API.
 *
 * Usage:
 *   node scripts/test_embeddings.mjs
 *
 * 1. Opens browser for OAuth login
 * 2. You log in, paste the callback URL back here
 * 3. Script exchanges code for token
 * 4. Tries embeddings on multiple endpoints / formats
 */

import crypto from 'crypto';
import http from 'http';
import { execSync } from 'child_process';
import readline from 'readline';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

// --- PKCE ---
function pkce() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

// --- Ask user for input ---
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// --- Step 1: Start OAuth + local callback server ---
async function getToken() {
    const state = crypto.randomBytes(16).toString('base64url');
    const { verifier, challenge } = pkce();

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
    });

    const authUrl = `${AUTH_URL}?${params}`;
    console.log('\n=== Step 1: OAuth Login ===');
    console.log('Opening browser...\n');

    try {
        execSync(`open "${authUrl}"`);
    } catch {
        console.log('Could not open browser. Open this URL manually:');
        console.log(authUrl);
    }

    // Start a tiny server to catch the callback
    const code = await new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost:1455');
            if (url.pathname === '/auth/callback') {
                const code = url.searchParams.get('code');
                const returnedState = url.searchParams.get('state');
                if (returnedState !== state) {
                    res.writeHead(400);
                    res.end('State mismatch');
                    reject(new Error('State mismatch'));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h2>Done! Go back to terminal.</h2><script>window.close()</script>');
                server.close();
                resolve(code);
            }
        });
        server.listen(1455, () => {
            console.log('Waiting for callback on http://localhost:1455/auth/callback ...');
        });
        setTimeout(() => { server.close(); reject(new Error('Timeout waiting for callback')); }, 300_000);
    });

    console.log(`\nGot auth code: ${code.slice(0, 20)}...`);

    // --- Step 2: Exchange code for token ---
    console.log('\n=== Step 2: Exchanging code for token ===');
    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
        }),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token exchange failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    console.log('Token obtained!');
    console.log(`  access_token: ${data.access_token.slice(0, 30)}...`);
    console.log(`  expires_in: ${data.expires_in ?? 'not provided'}`);
    console.log(`  refresh_token: ${data.refresh_token ? data.refresh_token.slice(0, 20) + '...' : 'none'}`);

    return data.access_token;
}

// --- Step 3: Try embeddings on various endpoints ---
async function tryEmbeddings(token) {
    console.log('\n=== Step 3: Testing Embeddings Endpoints ===\n');

    const testInput = 'Hello, world!';

    const endpoints = [
        {
            name: 'Official API (api.openai.com/v1/embeddings)',
            url: 'https://api.openai.com/v1/embeddings',
            body: { model: 'text-embedding-3-small', input: testInput },
        },
        {
            name: 'Official API (text-embedding-ada-002)',
            url: 'https://api.openai.com/v1/embeddings',
            body: { model: 'text-embedding-ada-002', input: testInput },
        },
        {
            name: 'Official API (text-embedding-3-large)',
            url: 'https://api.openai.com/v1/embeddings',
            body: { model: 'text-embedding-3-large', input: testInput },
        },
        {
            name: 'Codex backend (chatgpt.com/backend-api/v1/embeddings)',
            url: 'https://chatgpt.com/backend-api/v1/embeddings',
            body: { model: 'text-embedding-3-small', input: testInput },
        },
        {
            name: 'Codex backend (chatgpt.com/backend-api/embeddings)',
            url: 'https://chatgpt.com/backend-api/embeddings',
            body: { model: 'text-embedding-3-small', input: testInput },
        },
        {
            name: 'Codex codex path (chatgpt.com/backend-api/codex/v1/embeddings)',
            url: 'https://chatgpt.com/backend-api/codex/v1/embeddings',
            body: { model: 'text-embedding-3-small', input: testInput },
        },
        {
            name: 'Platform API via chatgpt token (platform.openai.com/v1/embeddings)',
            url: 'https://platform.openai.com/v1/embeddings',
            body: { model: 'text-embedding-3-small', input: testInput },
        },
    ];

    for (const ep of endpoints) {
        console.log(`--- ${ep.name} ---`);
        console.log(`  URL: ${ep.url}`);
        console.log(`  Model: ${ep.body.model}`);

        try {
            const resp = await fetch(ep.url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(ep.body),
            });

            const status = resp.status;
            const headers = Object.fromEntries(resp.headers.entries());

            // Grab interesting headers
            const interestingHeaders = {};
            for (const [k, v] of Object.entries(headers)) {
                if (k.startsWith('x-') || k.startsWith('openai-') || k === 'content-type') {
                    interestingHeaders[k] = v;
                }
            }

            let body;
            const contentType = headers['content-type'] || '';
            if (contentType.includes('json')) {
                body = await resp.json();
            } else {
                body = await resp.text();
            }

            console.log(`  Status: ${status}`);
            if (Object.keys(interestingHeaders).length > 0) {
                console.log(`  Headers: ${JSON.stringify(interestingHeaders, null, 2)}`);
            }

            if (status === 200 && body?.data?.[0]?.embedding) {
                const emb = body.data[0].embedding;
                console.log(`  ✅ SUCCESS! Got embedding with ${emb.length} dimensions`);
                console.log(`  Usage: ${JSON.stringify(body.usage)}`);
                console.log(`  First 5 values: [${emb.slice(0, 5).map(v => v.toFixed(6)).join(', ')}]`);
            } else if (status === 200) {
                console.log(`  ⚠️  200 but unexpected body shape:`);
                console.log(`  ${JSON.stringify(body).slice(0, 300)}`);
            } else {
                console.log(`  ❌ Failed:`);
                const errMsg = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
                console.log(`  ${errMsg}`);
            }
        } catch (err) {
            console.log(`  ❌ Error: ${err.message}`);
        }
        console.log();
    }
}

// --- Main ---
async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  OpenAI Embeddings Test with ChatGPT OAuth Token ║');
    console.log('╚══════════════════════════════════════════════════╝');

    const token = await getToken();
    await tryEmbeddings(token);

    console.log('\n=== Done ===');
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
