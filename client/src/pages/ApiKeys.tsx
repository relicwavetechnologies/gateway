import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getApiKeys, createApiKey, revokeApiKey } from '../lib/api'
import { Plus, Copy, CheckCircle2, Trash2, Key } from 'lucide-react'
import { cn, relativeTime } from '../lib/utils'

const MODELS: Record<string, { label: string; models: string[] }> = {
  openai: {
    label: '🤖 OpenAI',
    models: ['gpt-5.5', 'gpt-5.4-mini'],
  },
  gemini: {
    label: '✨ Gemini',
    models: [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-base',
      'gemini-3-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3-flash-base',
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-preview',
    ],
  },
  claude: {
    label: '🧠 Claude',
    models: [
      'claude-opus-4-7',       // Opus 4.7 — latest flagship
      'claude-sonnet-4-6',     // Sonnet 4.6 — balanced (default)
      'claude-haiku-4-5',      // Haiku 4.5 — fast & cheap
      'claude-opus-4-6',       // Opus 4.6 — legacy
    ],
  },
  deepseek: {
    label: '🐋 DeepSeek',
    models: [
      'deepseek-v4-flash',     // V4 Flash — fast, 1M ctx
      'deepseek-v4-pro',       // V4 Pro — strongest
      'deepseek-reasoner',     // legacy alias → flash (thinking on)
      'deepseek-chat',         // legacy alias → flash (thinking off)
    ],
  },
}

const GATEWAY_URL = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '')

function buildCurl(provider: string, model: string, apiKey: string) {
  const key = apiKey || 'cnsc_gw_xxxx'
  if (provider === 'claude') {
    return `curl ${GATEWAY_URL}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{"model":"${model}","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'`
  }
  return `curl ${GATEWAY_URL}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"Hello"}]}'`
}

export default function ApiKeys() {
  const qc = useQueryClient()
  const { data: keys = [], isLoading } = useQuery({ queryKey: ['api-keys'], queryFn: getApiKeys })

  const [showModal, setShowModal] = useState(false)
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // snippet picker state
  const [snipProvider, setSnipProvider] = useState<string>('openai')
  const [snipModel, setSnipModel] = useState<string>(MODELS.openai.models[0])
  const [snipKey, setSnipKey] = useState<string>('')

  const create = useMutation({
    mutationFn: () => createApiKey({ name, allowed_providers: ['openai', 'claude', 'gemini', 'deepseek'] }),
    onSuccess: (data) => { setNewKey(data.key); qc.invalidateQueries({ queryKey: ['api-keys'] }) },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  function reset() { setShowModal(false); setName(''); setNewKey(null) }

  function changeProvider(p: string) {
    setSnipProvider(p)
    setSnipModel(MODELS[p].models[0])
  }

  const curlSnippet = buildCurl(snipProvider, snipModel, snipKey)

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

      {/* Interactive snippet builder */}
      <div className="card space-y-4">
        <p className="text-sm font-medium text-zinc-100">Quick start — pick provider &amp; model</p>

        {/* Provider selector */}
        <div className="flex gap-2">
          {Object.entries(MODELS).map(([p, { label }]) => (
            <button
              key={p}
              onClick={() => changeProvider(p)}
              className={cn(
                'px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors',
                snipProvider === p
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-600',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Model dropdown + key selector */}
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <label className="label mb-1">Model</label>
            <select
              className="input"
              value={snipModel}
              onChange={e => setSnipModel(e.target.value)}
            >
              {MODELS[snipProvider].models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          {keys.length > 0 && (
            <div className="flex-1 min-w-48">
              <label className="label mb-1">API Key (optional)</label>
              <select className="input" value={snipKey} onChange={e => setSnipKey(e.target.value)}>
                <option value="">cnsc_gw_xxxx (placeholder)</option>
                {keys.map((k: any) => (
                  <option key={k.id} value={k.key_prefix}>{k.name} ({k.key_prefix}…)</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Live curl snippet */}
        <div className="relative">
          <pre className="text-xs text-zinc-300 bg-zinc-800 rounded-lg p-4 overflow-auto leading-relaxed">
            {curlSnippet}
          </pre>
          <button
            onClick={() => copy(curlSnippet, 'snippet')}
            className="absolute top-3 right-3 p-1.5 rounded-md bg-zinc-700 hover:bg-zinc-600 transition-colors"
            title="Copy"
          >
            {copiedId === 'snippet'
              ? <CheckCircle2 size={14} className="text-emerald-400" />
              : <Copy size={14} className="text-zinc-400" />}
          </button>
        </div>
      </div>

      {/* Keys list */}
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
                <p className="text-xs text-zinc-500 font-mono mt-0.5">{k.key_prefix}…</p>
              </div>
              <div className="text-right hidden sm:block">
                <p className="text-xs text-zinc-500">{k.allowed_providers.join(', ')}</p>
                <p className="text-xs text-zinc-600">Last used {relativeTime(k.last_used_at)}</p>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => { if (confirm('Revoke this key? This cannot be undone.')) revoke.mutate(k.id) }}
                  className="btn-danger p-2"
                >
                  <Trash2 size={14} />
                </button>
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
                  <button onClick={() => copy(newKey, 'new')}>
                    {copiedId === 'new'
                      ? <CheckCircle2 size={16} className="text-emerald-400" />
                      : <Copy size={16} className="text-zinc-400 hover:text-zinc-100" />}
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
