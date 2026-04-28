import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAccounts, initiateAccount, completeAccount, testAccount, patchAccount, deleteAccount } from '../lib/api'
import { Plus, Trash2, TestTube2, Power } from 'lucide-react'
import { cn, relativeTime, statusColor } from '../lib/utils'

type Step = 'idle' | 'initiated' | 'completing'

export default function Accounts() {
  const qc = useQueryClient()
  const { data: accounts = [], isLoading } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })

  const [showModal, setShowModal] = useState(false)
  const [provider, setProvider] = useState<'openai' | 'claude' | 'gemini'>('openai')
  const [step, setStep] = useState<Step>('idle')
  const [initData, setInitData] = useState<any>(null)
  const [code, setCode] = useState('')
  const [blob, setBlob] = useState('')
  const [label, setLabel] = useState('')
  const [testResults, setTestResults] = useState<Record<string, any>>({})

  const initiate = useMutation({
    mutationFn: () => initiateAccount(provider),
    onSuccess: (data) => { setInitData(data); setStep('initiated') },
  })

  const complete = useMutation({
    mutationFn: () => completeAccount({
      session_id: initData.session_id,
      provider,
      code: (provider === 'openai' || provider === 'gemini') ? code : undefined,
      credential_blob: provider === 'claude' ? blob : undefined,
      label: label || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); reset() },
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

  function reset() { setShowModal(false); setStep('idle'); setInitData(null); setCode(''); setBlob(''); setLabel('') }

  function extractCodeFromUrl(url: string) {
    try { return new URL(url).searchParams.get('code') ?? url } catch { return url }
  }

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

      {/* Accounts list */}
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
          {['openai', 'gemini', 'claude'].map(prov => {
            const group = accounts.filter((a: any) => a.provider === prov)
            if (!group.length) return null
            return (
              <div key={prov}>
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">{prov}</p>
                <div className="space-y-2">
                  {group.map((a: any) => (
                    <div key={a.id} className="card flex items-center gap-4">
                      <div className={cn('w-2.5 h-2.5 rounded-full shrink-0', a.status === 'active' ? 'bg-emerald-400' : a.status === 'rate_limited' ? 'bg-amber-400' : 'bg-red-400')} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-100">{a.label}</p>
                        <p className="text-xs text-zinc-500">{a.request_count.toLocaleString()} requests · {a.error_count} errors · last used {relativeTime(a.last_used_at)}</p>
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
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 border-b border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-100">Connect Account</h2>
              <p className="text-sm text-zinc-500 mt-1">Add a ChatGPT or Claude account to the pool</p>
            </div>

            <div className="p-6 space-y-4">
              {step === 'idle' && (
                <>
                  <div>
                    <label className="label">Provider</label>
                    <div className="grid grid-cols-3 gap-2">
                      {(['openai', 'gemini', 'claude'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={cn('px-3 py-3 rounded-lg border text-sm font-medium transition-colors', provider === p ? 'border-brand bg-brand/10 text-brand' : 'border-zinc-700 text-zinc-400 hover:border-zinc-600')}>
                          {p === 'openai' ? '🤖 OpenAI' : p === 'gemini' ? '✨ Gemini' : '🧠 Claude'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="label">Label (optional)</label>
                    <input className="input" placeholder="e.g. Main account" value={label} onChange={e => setLabel(e.target.value)} />
                  </div>
                </>
              )}

              {step === 'initiated' && (provider === 'openai' || provider === 'gemini') && (
                <div className="space-y-4">
                  <div className={cn('p-3 rounded-lg border text-sm', provider === 'openai' ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300')}>
                    {initData.instructions}
                  </div>
                  <a href={initData.auth_url} target="_blank" rel="noreferrer" className="btn-primary w-full flex items-center justify-center gap-2">
                    Open {provider === 'openai' ? 'OpenAI' : 'Google'} Login ↗
                  </a>
                  <div>
                    <label className="label">Paste the full callback URL from your browser address bar</label>
                    <input className="input" placeholder="http://localhost:.../oauth/callback?code=..." value={code} onChange={e => setCode(extractCodeFromUrl(e.target.value))} />
                  </div>
                </div>
              )}

              {step === 'initiated' && provider === 'claude' && (
                <div className="space-y-4">
                  <div className="p-3 bg-violet-500/10 border border-violet-500/20 rounded-lg text-sm text-violet-300">
                    {initData.instructions}
                  </div>
                  <div>
                    <label className="label">Paste access token</label>
                    <textarea
                      className="input h-20 resize-none font-mono text-xs"
                      placeholder="eyJ..."
                      value={blob}
                      onChange={e => setBlob(e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t border-zinc-800 flex justify-end gap-3">
              <button onClick={reset} className="btn-ghost">Cancel</button>
              {step === 'idle' && (
                <button onClick={() => initiate.mutate()} disabled={initiate.isPending} className="btn-primary">
                  {initiate.isPending ? 'Loading...' : 'Continue'}
                </button>
              )}
              {step === 'initiated' && (
                <button
                  onClick={() => complete.mutate()}
                  disabled={complete.isPending || ((provider === 'openai' || provider === 'gemini') ? !code : !blob)}
                  className="btn-primary"
                >
                  {complete.isPending ? 'Connecting...' : 'Connect Account'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
