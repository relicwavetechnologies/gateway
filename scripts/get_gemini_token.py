#!/usr/bin/env python3
import base64, hashlib, json, os, sys, threading, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_ID     = os.environ.get('GEMINI_CLIENT_ID', '')
CLIENT_SECRET = os.environ.get('GEMINI_CLIENT_SECRET', '')
AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL     = 'https://oauth2.googleapis.com/token'
REDIRECT_PATH = '/oauth/callback'
SCOPES        = ' '.join([
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
])

def pkce():
    verifier  = base64.urlsafe_b64encode(os.urandom(64)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge

def main():
    verifier, challenge = pkce()
    state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b'=').decode()
    code  = None

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            nonlocal code
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            code   = params.get('code', [None])[0]
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'<h1>Done. Close this tab and return to the terminal.</h1>')
        def log_message(self, *_): pass

    server = HTTPServer(('localhost', 0), Handler)
    port   = server.server_address[1]
    redirect_uri = f'http://localhost:{port}{REDIRECT_PATH}'

    auth_url = AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id': CLIENT_ID, 'redirect_uri': redirect_uri,
        'response_type': 'code', 'scope': SCOPES,
        'code_challenge': challenge, 'code_challenge_method': 'S256',
        'state': state, 'access_type': 'offline', 'prompt': 'consent',
    })

    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()
    print(f'Opening browser (local server on port {port})...')
    webbrowser.open(auth_url)
    t.join(timeout=180)
    server.server_close()

    if not code:
        print('No code received.', file=sys.stderr)
        sys.exit(1)

    body = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET, 'code': code,
        'redirect_uri': redirect_uri, 'code_verifier': verifier,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body,
                                  headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        with urllib.request.urlopen(req) as r:
            tokens = json.loads(r.read())
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
