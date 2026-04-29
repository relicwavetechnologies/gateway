import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAccounts, initiateAccount, completeAccount, importToken, testAccount, patchAccount, deleteAccount } from '../lib/api'
import { Plus, Trash2, TestTube2, Power, Copy, CheckCircle2, Terminal, ChevronRight } from 'lucide-react'
import { cn, relativeTime, statusColor } from '../lib/utils'

type Step = 'idle' | 'initiated' | 'completing'
type OS = 'mac' | 'windows'

const CLAUDE_SCRIPT = `#!/usr/bin/env python3
import base64, hashlib, json, os, sys, threading, urllib.parse, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

CLIENT_ID    = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
AUTH_URL     = 'https://claude.ai/oauth/authorize'
TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'
PORT         = 53692
REDIRECT_URI = f'http://localhost:{PORT}/callback'
SCOPE        = 'org:create_api_key user:profile user:inference'

def pkce():
    verifier  = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
    return verifier, challenge

def build_auth_url(challenge, verifier):
    return AUTH_URL + '?' + urllib.parse.urlencode({
        'code': 'true', 'client_id': CLIENT_ID, 'redirect_uri': REDIRECT_URI,
        'response_type': 'code', 'scope': SCOPE,
        'code_challenge': challenge, 'code_challenge_method': 'S256', 'state': verifier,
    })

def exchange(code, verifier):
    body = json.dumps({'grant_type': 'authorization_code', 'client_id': CLIENT_ID,
        'code': code, 'redirect_uri': REDIRECT_URI, 'code_verifier': verifier, 'state': verifier,
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'User-Agent': 'claude-cli/1.0.57 (darwin arm64)',
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def wait_for_code(expected_state):
    result = {'code': None}
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if self.path.startswith('/callback'):
                result['code'] = params.get('code', [None])[0]
                self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
                self.wfile.write(b'<h2>Done! Close this tab and return to the terminal.</h2>')
        def log_message(self, *_): pass
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start(); t.join(timeout=300); server.server_close()
    return result['code']

verifier, challenge = pkce()
print('\\nOpening browser for Claude login...')
webbrowser.open(build_auth_url(challenge, verifier))
code = wait_for_code(verifier)
if not code: print('No code received.', file=sys.stderr); sys.exit(1)
tokens = exchange(code, verifier)
print('\\n' + '='*60)
print('ACCESS TOKEN:')
print(tokens['access_token'])
print('\\nREFRESH TOKEN:')
print(tokens.get('refresh_token', ''))
print('='*60)`

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button onClick={copy} className={cn('flex items-center gap-1.5 text-xs transition-colors', copied ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-200', className)}>
      {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

function CodeBlock({ code, language = 'bash' }: { code: string; language?: string }) {
  return (
    <div className="relative group">
      <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
        {code}
      </pre>
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <CopyButton text={code} className="bg-zinc-800 px-2 py-1 rounded-md" />
      </div>
    </div>
  )
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="w-5 h-5 rounded-full bg-brand/20 text-brand text-xs font-bold flex items-center justify-center shrink-0">{n}</span>
  )
}

export default function Accounts() {
  const qc = useQueryClient()
  const { data: accounts = [], isLoading } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })

  const [showModal, setShowModal] = useState(false)
  const [provider, setProvider] = useState<'openai' | 'claude' | 'gemini'>('openai')
  const [step, setStep] = useState<Step>('idle')
  const [initData, setInitData] = useState<any>(null)
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [testResults, setTestResults] = useState<Record<string, any>>({})
  const [completeError, setCompleteError] = useState<string | null>(null)

  // Claude script flow state
  const [os, setOs] = useState<OS>('mac')
  const [claudeAccessToken, setClaudeAccessToken] = useState('')
  const [claudeRefreshToken, setClaudeRefreshToken] = useState('')
  const [scriptStep, setScriptStep] = useState<1 | 2 | 3>(1)

  const initiate = useMutation({
    mutationFn: () => initiateAccount(provider),
    onSuccess: (data) => { setInitData(data); setStep('initiated'); setCompleteError(null) },
  })

  const complete = useMutation({
    mutationFn: () => completeAccount({ session_id: initData.session_id, provider, code: code || undefined, label: label || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); reset() },
    onError: (err: any) => setCompleteError(err?.response?.data?.error ?? err?.message ?? 'Unknown error'),
  })

  const importMutation = useMutation({
    mutationFn: () => importToken({
      provider: 'claude',
      access_token: claudeAccessToken.trim(),
      refresh_token: claudeRefreshToken.trim() || undefined,
      expires_in: 28800,
      label: label || 'Claude account',
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); reset() },
    onError: (err: any) => setCompleteError(err?.response?.data?.error ?? err?.message ?? 'Import failed'),
  })

  const test = useMutation({
    mutationFn: (id: string) => testAccount(id),
    onSuccess: (data, id) => setTestResults(r => ({ ...r, [id]: data })),
    onError: (err: any, id) => setTestResults(r => ({ ...r, [id]: { ok: false, error: err.message } })),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: any) => patchAccount(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })

  const del = useMutation({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['accounts'] }),
  })

  function reset() {
    setShowModal(false); setStep('idle'); setInitData(null); setCode(''); setLabel('')
    setCompleteError(null); setClaudeAccessToken(''); setClaudeRefreshToken(''); setScriptStep(1)
  }

  function extractCodeFromUrl(url: string) {
    try { return new URL(url).searchParams.get('code') ?? url } catch { return url }
  }

  const runCommand = os === 'mac' ? 'python3 get_claude_token.py' : 'python get_claude_token.py'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Accounts</h1>
          <p className="text-sm text-zinc-500 mt-1">Connected provider accounts — load balanced automatically</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus size={15} /> Connect Account
        </button>
      </div>

      {isLoading ? (
        <div className="card flex items-center justify-center h-32">
          <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-zinc-500 text-sm">No accounts connected yet.</p>
          <button onClick={() => setShowModal(true)} className="btn-primary mt-4 inline-flex items-center gap-2">
            <Plus size={14} /> Connect your first account
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {(['openai', 'gemini', 'claude'] as const).map(prov => {
            const group = accounts.filter((a: any) => a.provider === prov)
            if (!group.length) return null
            const provLabel = prov === 'openai' ? '🤖 OpenAI' : prov === 'gemini' ? '✨ Gemini' : '🧠 Claude'
            return (
              <div key={prov}>
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">{provLabel}</p>
                <div className="space-y-2">
                  {group.map((a: any) => (
                    <div key={a.id} className="card flex items-center gap-4">
                      <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', a.status === 'active' ? 'bg-emerald-400' : a.status === 'rate_limited' ? 'bg-amber-400' : 'bg-red-400')} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-100">{a.label}</p>
                        <p className="text-xs text-zinc-500">{Number(a.request_count).toLocaleString()} requests · {a.error_count} errors · last used {relativeTime(a.last_used_at)}</p>
                        {testResults[a.id] && (
                          <p className={cn('text-xs mt-1', testResults[a.id].ok ? 'text-emerald-400' : 'text-red-400')}>
                            {testResults[a.id].ok ? `✓ ${testResults[a.id].reply}` : `✗ ${testResults[a.id].error}`}
                          </p>
                        )}
                      </div>
                      <span className={cn('badge', statusColor(a.status))}>{a.status.replace('_', ' ')}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => test.mutate(a.id)} disabled={test.isPending} className="btn-ghost p-2" title="Test"><TestTube2 size={14} /></button>
                        <button onClick={() => patch.mutate({ id: a.id, body: { status: a.status === 'disabled' ? 'active' : 'disabled' } })} className="btn-ghost p-2" title={a.status === 'disabled' ? 'Enable' : 'Disable'}><Power size={14} /></button>
                        <button onClick={() => { if (confirm('Delete this account?')) del.mutate(a.id) }} className="btn-danger p-2" title="Delete"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">

            {/* Header */}
            <div className="p-6 border-b border-zinc-800 shrink-0">
              <h2 className="text-lg font-semibold text-zinc-100">Connect Account</h2>
              <p className="text-sm text-zinc-500 mt-1">Add an AI provider account to the pool</p>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto">

              {/* Provider picker — always visible */}
              {step === 'idle' && (
                <>
                  <div>
                    <label className="label">Provider</label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['openai', 'gemini', 'claude'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)}
                          className={cn('px-3 py-3 rounded-lg border text-sm font-medium transition-colors',
                            provider === p ? 'border-brand bg-brand/10 text-brand' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600')}>
                          {p === 'openai' ? '🤖 OpenAI' : p === 'gemini' ? '✨ Gemini' : '🧠 Claude'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="label">Label <span className="text-zinc-600">(optional)</span></label>
                    <input className="input" placeholder="e.g. My main account" value={label} onChange={e => setLabel(e.target.value)} />
                  </div>
                </>
              )}

              {/* OpenAI / Gemini — standard OAuth flow */}
              {step === 'initiated' && provider !== 'claude' && (
                <div className="space-y-4">
                  <div className={cn('p-3 rounded-lg border text-sm',
                    provider === 'gemini' ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300')}>
                    {initData.instructions}
                  </div>
                  <a href={initData.auth_url} target="_blank" rel="noreferrer"
                    className="btn-primary w-full flex items-center justify-center gap-2">
                    Open {provider === 'gemini' ? 'Google' : 'OpenAI'} Login ↗
                  </a>
                  <div>
                    <label className="label">Paste the full callback URL from your browser address bar</label>
                    <input className="input" placeholder="http://localhost:9475/callback?code=..." value={code}
                      onChange={e => setCode(extractCodeFromUrl(e.target.value))} />
                  </div>
                </div>
              )}

              {/* Claude — script-based flow */}
              {provider === 'claude' && step === 'idle' && (
                <div className="space-y-5">
                  {/* OS tabs */}
                  <div>
                    <label className="label mb-2">Your OS</label>
                    <div className="flex gap-2">
                      {(['mac', 'windows'] as const).map(o => (
                        <button key={o} onClick={() => setOs(o)}
                          className={cn('px-4 py-2 rounded-lg border text-sm font-medium transition-colors',
                            os === o ? 'border-brand bg-brand/10 text-brand' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600')}>
                          {o === 'mac' ? '🍎 Mac' : '🪟 Windows'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Step 1 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <StepBadge n={1} />
                      <p className="text-sm font-medium text-zinc-200">Save this script as <code className="text-brand font-mono">get_claude_token.py</code></p>
                    </div>
                    <div className="relative group">
                      <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-zinc-300 overflow-x-auto max-h-40 leading-relaxed whitespace-pre">
                        {CLAUDE_SCRIPT}
                      </pre>
                      <div className="absolute top-2 right-2">
                        <CopyButton text={CLAUDE_SCRIPT} className="bg-zinc-800 px-2 py-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <StepBadge n={2} />
                      <p className="text-sm font-medium text-zinc-200">Run it in your terminal</p>
                    </div>
                    <CodeBlock code={runCommand} />
                    <p className="text-xs text-zinc-500 flex items-center gap-1">
                      <Terminal size={11} /> Your browser will open automatically — log in to Claude and approve access.
                      No sudo or extra packages needed.
                    </p>
                  </div>

                  {/* Step 3 */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <StepBadge n={3} />
                      <p className="text-sm font-medium text-zinc-200">Paste the tokens printed by the script</p>
                    </div>
                    <div>
                      <label className="label">Access Token <span className="text-red-400">*</span></label>
                      <input className="input font-mono text-xs" placeholder="sk-ant-oat01-..." value={claudeAccessToken}
                        onChange={e => setClaudeAccessToken(e.target.value)} />
                    </div>
                    <div>
                      <label className="label">Refresh Token <span className="text-zinc-600">(optional but recommended)</span></label>
                      <input className="input font-mono text-xs" placeholder="sk-ant-ort01-..." value={claudeRefreshToken}
                        onChange={e => setClaudeRefreshToken(e.target.value)} />
                      <p className="text-xs text-zinc-600 mt-1">Without a refresh token the account will stop working after 8 hours.</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Error */}
            {completeError && (
              <div className="px-6 pb-2 shrink-0">
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 space-y-1">
                  <p className="font-medium">Failed</p>
                  <p className="font-mono text-xs break-all">{completeError}</p>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="p-6 border-t border-zinc-800 flex justify-end gap-3 shrink-0">
              <button onClick={reset} className="btn-ghost">Cancel</button>

              {/* OpenAI / Gemini idle */}
              {step === 'idle' && provider !== 'claude' && (
                <button onClick={() => initiate.mutate()} disabled={initiate.isPending} className="btn-primary">
                  {initiate.isPending ? 'Loading...' : 'Continue →'}
                </button>
              )}

              {/* OpenAI / Gemini initiated */}
              {step === 'initiated' && provider !== 'claude' && (
                <>
                  {completeError && (
                    <button onClick={() => { setCode(''); setCompleteError(null); initiate.mutate() }} className="btn-ghost">
                      Start Over
                    </button>
                  )}
                  <button onClick={() => complete.mutate()} disabled={complete.isPending || !code} className="btn-primary">
                    {complete.isPending ? 'Connecting...' : 'Connect Account'}
                  </button>
                </>
              )}

              {/* Claude */}
              {provider === 'claude' && step === 'idle' && (
                <button
                  onClick={() => importMutation.mutate()}
                  disabled={importMutation.isPending || !claudeAccessToken.trim()}
                  className="btn-primary"
                >
                  {importMutation.isPending ? 'Saving...' : 'Save Account'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
