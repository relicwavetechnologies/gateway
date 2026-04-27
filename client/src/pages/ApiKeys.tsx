import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiKeys, createApiKey, revokeApiKey } from '../lib/api'
import { Plus, Copy, CheckCircle2, Trash2, Key } from 'lucide-react'
import { relativeTime } from '../lib/utils'

export default function ApiKeys() {
  const qc = useQueryClient()
  const { data: keys = [], isLoading } = useQuery({ queryKey: ['api-keys'], queryFn: getApiKeys })

  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => createApiKey({ name, allowed_providers: ['openai', 'claude'] }),
    onSuccess: (data) => { setNewKey(data.key); qc.invalidateQueries({ queryKey: ['api-keys'] }) },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  function copyKey(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  function reset() { setShowModal(false); setName(''); setNewKey(null) }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">API Keys</h1>
          <p className="text-sm text-zinc-500 mt-1">Keys your team uses to call the gateway. Hand them out — never commit them.</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-2">
          <Plus size={15} /> New Key
        </button>
      </div>

      {/* Usage snippet */}
      <div className="card bg-zinc-900/50 border-dashed">
        <p className="text-xs font-medium text-zinc-400 mb-2">How your team uses it</p>
        <pre className="text-xs text-zinc-400 bg-zinc-800 rounded-lg p-3 overflow-auto">{`# OpenAI-compatible (Cursor, Cline, etc.)
curl https://your-gateway/v1/chat/completions \\
  -H "X-API-Key: cnsc_gw_xxxx" \\
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'

# Anthropic-compatible
curl https://your-gateway/v1/messages \\
  -H "X-API-Key: cnsc_gw_xxxx" \\
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}]}'`}
        </pre>
      </div>

      {isLoading ? (
        <div className="card h-32 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : keys.length === 0 ? (
        <div className="card text-center py-12">
          <Key size={28} className="text-zinc-600 mx-auto mb-3" />
          <p className="text-zinc-500 text-sm">No keys yet. Create one to share with your team.</p>
        </div>
      ) : (
        <div className="card divide-y divide-zinc-800 p-0 overflow-hidden">
          {keys.map((k: any) => (
            <div key={k.id} className="flex items-center gap-4 px-5 py-4">
              <Key size={15} className="text-zinc-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-100">{k.name}</p>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">{k.key_prefix}</p>
              </div>
              <div className="text-right hidden sm:block">
                <p className="text-xs text-zinc-500">Providers: {k.allowed_providers.join(', ')}</p>
                <p className="text-xs text-zinc-600">Last used {relativeTime(k.last_used_at)}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={() => { if (confirm('Revoke this key? This cannot be undone.')) revoke.mutate(k.id) }} className="btn-danger p-2"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="p-6 border-b border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-100">New API Key</h2>
            </div>

            {newKey ? (
              <div className="p-6 space-y-4">
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-sm text-emerald-300">
                  ✓ Key created! Copy it now — it won't be shown again.
                </div>
                <div className="bg-zinc-800 rounded-lg p-3 flex items-center gap-3">
                  <code className="text-sm text-zinc-100 flex-1 break-all font-mono">{newKey}</code>
                  <button onClick={() => copyKey(newKey, 'new')} className="shrink-0">
                    {copiedId === 'new' ? <CheckCircle2 size={16} className="text-emerald-400" /> : <Copy size={16} className="text-zinc-400 hover:text-zinc-100" />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <label className="label">Key name</label>
                <input className="input" placeholder="e.g. Rahul's key" value={name} onChange={e => setName(e.target.value)} autoFocus />
              </div>
            )}

            <div className="p-6 border-t border-zinc-800 flex justify-end gap-3">
              <button onClick={reset} className="btn-ghost">{newKey ? 'Done' : 'Cancel'}</button>
              {!newKey && (
                <button onClick={() => create.mutate()} disabled={!name || create.isPending} className="btn-primary">
                  {create.isPending ? 'Creating...' : 'Create Key'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
