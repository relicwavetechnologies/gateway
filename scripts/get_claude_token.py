#!/usr/bin/env python3
import base64, hashlib, json, os, sys, threading, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_ID    = 'https://claude.ai/oauth/claude-code-client-metadata'
AUTH_URL     = 'https://platform.claude.com/oauth/authorize'
TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'
REDIRECT_URI = 'http://localhost/callback'
SCOPE        = 'org:create_api_key user:profile user:email'

def pkce():
    verifier  = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge

def build_auth_url(challenge, state):
    return AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id': CLIENT_ID, 'redirect_uri': REDIRECT_URI,
        'response_type': 'code', 'scope': SCOPE,
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': state,
    })

def exchange(code, verifier):
    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'client_id': CLIENT_ID,
        'code': code, 'redirect_uri': REDIRECT_URI, 'code_verifier': verifier,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                  headers={'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def extract_code(url_or_code):
    try:
        p = urllib.parse.urlparse(url_or_code)
        return urllib.parse.parse_qs(p.query).get('code', [url_or_code])[0]
    except Exception:
        return url_or_code.strip()

def main():
    verifier, challenge = pkce()
    state    = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b'=').decode()
    auth_url = build_auth_url(challenge, state)

    code   = None
    server = None

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal code
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code   = params.get('code', [None])[0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'<h1>Done. Close this tab and return to the terminal.</h1>')
        def log_message(self, *_): pass

    try:
        server = HTTPServer(('', 80), Handler)
        t = threading.Thread(target=server.handle_request, daemon=True)
        t.start()
        print('Opening browser...')
        webbrowser.open(auth_url)
        t.join(timeout=180)
        server.server_close()
    except PermissionError:
        if server:
            try: server.server_close()
            except Exception: pass
        print()
        print('Port 80 needs sudo. Two options:')
        print()
        print('  Option A — run with sudo:')
        print('    sudo python3 get_claude_token.py')
        print()
        print('  Option B — open this URL in your browser, complete login,')
        print('  then paste the full callback URL (http://localhost/callback?code=...):')
        print()
        print(auth_url)
        print()
        raw  = input('Callback URL or code: ').strip()
        code = extract_code(raw)

    if not code:
        print('No code received.', file=sys.stderr)
        sys.exit(1)

    try:
        tokens = exchange(code, verifier)
    except Exception as e:
        print(f'Token exchange failed: {e}', file=sys.stderr)
        sys.exit(1)

    access_token  = tokens.get('access_token', '')
    refresh_token = tokens.get('refresh_token', '')
    expires_in    = tokens.get('expires_in', '')

    print()
    print('=== ACCESS TOKEN (paste this into the gateway) ===')
    print(access_token)
    if refresh_token:
        print()
        print('=== REFRESH TOKEN ===')
        print(refresh_token)
    if expires_in:
        print()
        print(f'Expires in: {expires_in}s')

if __name__ == '__main__':
    main()
