#!/usr/bin/env python3
"""
Claude OAuth token fetcher — no dependencies, no sudo required.
Run:  python3 get_claude_token.py
"""
import base64, hashlib, json, os, sys, threading, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

# Claude Code's public OAuth client (no secret — PKCE only)
CLIENT_ID    = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
AUTH_URL     = 'https://claude.ai/oauth/authorize'
TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'
PORT         = 53692          # unprivileged port — no sudo needed
REDIRECT_URI = f'http://localhost:{PORT}/callback'
SCOPE        = 'org:create_api_key user:profile user:inference'

# ── PKCE helpers ──────────────────────────────────────────────────────────────

def pkce():
    verifier  = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b'=').decode()
    return verifier, challenge

def build_auth_url(challenge, verifier):
    # Anthropic uses the PKCE verifier as the state value (non-standard but required)
    params = {
        'code':                  'true',   # Anthropic-specific: signals PKCE flow
        'client_id':             CLIENT_ID,
        'redirect_uri':          REDIRECT_URI,
        'response_type':         'code',
        'scope':                 SCOPE,
        'code_challenge':        challenge,
        'code_challenge_method': 'S256',
        'state':                 verifier, # state == verifier (Anthropic requirement)
    }
    return AUTH_URL + '?' + urllib.parse.urlencode(params)

def exchange(code, verifier):
    # Token exchange must be JSON (not form-encoded) and must include state = verifier
    body = json.dumps({
        'grant_type':    'authorization_code',
        'client_id':     CLIENT_ID,
        'code':          code,
        'redirect_uri':  REDIRECT_URI,
        'code_verifier': verifier,
        'state':         verifier,   # Anthropic requires state echoed back
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body,
        headers={
            'Content-Type': 'application/json',
            'Accept':       'application/json',
            'User-Agent':   'claude-cli/1.0.57 (darwin arm64)',
        },
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# ── Local callback server ─────────────────────────────────────────────────────

def wait_for_code(expected_state):
    """Start a local HTTP server, wait for the OAuth redirect, return the code."""
    result = {'code': None, 'error': None}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            params   = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code     = params.get('code',  [None])[0]
            state    = params.get('state', [None])[0]
            error    = params.get('error', [None])[0]

            if self.path.startswith('/callback'):
                if error:
                    result['error'] = error
                elif state != expected_state:
                    result['error'] = f'state mismatch (got {state!r})'
                else:
                    result['code'] = code

                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                if result['code']:
                    self.wfile.write(b'<h2>Auth complete &#10003;</h2><p>You can close this tab and return to the terminal.</p>')
                else:
                    self.wfile.write(b'<h2>Auth failed</h2><p>Check the terminal for details.</p>')
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *_):
            pass  # suppress request noise

    server = HTTPServer(('127.0.0.1', PORT), Handler)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()
    t.join(timeout=300)   # 5-minute window to complete login
    server.server_close()

    if result['error']:
        print(f'\nAuth error: {result["error"]}', file=sys.stderr)
        sys.exit(1)
    if not result['code']:
        print('\nTimed out waiting for redirect.', file=sys.stderr)
        sys.exit(1)
    return result['code']

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    verifier, challenge = pkce()
    auth_url = build_auth_url(challenge, verifier)

    print()
    print('Opening your browser to complete Claude login...')
    print('(If the browser does not open, copy the URL below and paste it manually)')
    print()
    print(auth_url)
    print()

    opened = webbrowser.open(auth_url)
    if not opened:
        print('Could not open browser automatically — please open the URL above.')

    print(f'Waiting for Anthropic to redirect back to localhost:{PORT}...')
    code = wait_for_code(verifier)

    print('Got authorization code — exchanging for tokens...')
    try:
        tokens = exchange(code, verifier)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors='replace')
        print(f'\nToken exchange failed: HTTP {e.code} — {body}', file=sys.stderr)
        sys.exit(1)

    access_token  = tokens.get('access_token',  '')
    refresh_token = tokens.get('refresh_token', '')
    expires_in    = tokens.get('expires_in',    3600)

    print()
    print('=' * 60)
    print('SUCCESS — copy the values below')
    print('=' * 60)
    print()
    print(f'Access token  : {access_token}')
    print()
    print(f'Refresh token : {refresh_token}')
    print()
    print(f'Expires in    : {expires_in}s (~{round(expires_in / 3600, 1)}h)')
    print()
    print('─' * 60)
    print('Add this account to your gateway with:')
    print()
    print(f'  1. Login to get a JWT:')
    print(f'     curl https://gateway-v21w.onrender.com/auth/login \\')
    print(f'       -H "Content-Type: application/json" \\')
    print(f'       -d \'{{"email":"<admin-email>","password":"<admin-password>"}}\'')
    print()
    print(f'  2. Import the token:')
    print(f'     curl https://gateway-v21w.onrender.com/admin/accounts/import-token \\')
    print(f'       -H "Authorization: Bearer <jwt>" \\')
    print(f'       -H "Content-Type: application/json" \\')
    print(f'       -d \'{{')
    print(f'         "provider": "claude",')
    print(f'         "label": "My Claude account",')
    print(f'         "access_token": "{access_token[:20]}...",')
    print(f'         "refresh_token": "{refresh_token[:20] if refresh_token else ""}...",')
    print(f'         "expires_in": {expires_in}')
    print(f'       }}\'')
    print()

if __name__ == '__main__':
    main()
