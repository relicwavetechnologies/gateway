import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getUsage, getAccounts } from '../lib/api'
import { cn } from '../lib/utils'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const PROVIDER_COLOR: Record<string, string> = {
  openai: 'bg-emerald-400',
  claude: 'bg-violet-400',
  gemini: 'bg-blue-400',
}

export default function Usage() {
  const [days, setDays] = useState(7)
  const { data: usage, isLoading } = useQuery({
    queryKey: ['usage', days],
    queryFn: () => getUsage(days),
    refetchInterval: 30_000,
  })
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })

  const timeline: any[] = usage?.timeline ?? []
  const byAccount: any[] = usage?.by_account ?? []
  const byKey: any[] = usage?.by_key ?? []
  const byModel: any[] = usage?.by_model ?? []
  const totalReqs = usage?.total_requests ?? 0

  const stats = [
    { label: 'Total Requests', value: usage?.total_requests ?? '—', sub: 'all providers' },
    { label: 'Errors', value: usage?.total_errors ?? '—', sub: `${usage?.error_rate ?? 0}% error rate` },
    { label: 'Prompt Tokens', value: usage ? fmtTokens(usage.total_prompt_tokens ?? 0) : '—', sub: 'input tokens used' },
    { label: 'Completion Tokens', value: usage ? fmtTokens(usage.total_completion_tokens ?? 0) : '—', sub: 'output tokens generated' },
  ]

  const providerStats = [
    { label: 'OpenAI', value: usage?.openai_requests ?? 0, color: 'text-emerald-400' },
    { label: 'Gemini', value: usage?.gemini_requests ?? 0, color: 'text-blue-400' },
    { label: 'Claude', value: usage?.claude_requests ?? 0, color: 'text-violet-400' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Usage</h1>
          <p className="text-sm text-zinc-500 mt-1">Request volume, tokens, and account distribution</p>
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
          {RANGES.map(r => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={cn('px-3 py-1.5 rounded-md text-sm font-medium transition-colors', days === r.days ? 'bg-brand text-white' : 'text-zinc-400 hover:text-zinc-100')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map(s => (
          <div key={s.label} className="card">
            <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
            <p className="text-3xl font-bold text-zinc-100 mt-1">{typeof s.value === 'number' ? s.value.toLocaleString() : s.value}</p>
            <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Per-provider breakdown */}
      <div className="grid grid-cols-3 gap-4">
        {providerStats.map(p => (
          <div key={p.label} className="card flex items-center gap-4">
            <div className={cn('text-2xl font-bold', p.color)}>{p.value.toLocaleString()}</div>
            <div>
              <p className="text-sm text-zinc-100 font-medium">{p.label}</p>
              <p className="text-xs text-zinc-500">requests</p>
            </div>
          </div>
        ))}
      </div>

      {/* Timeline chart */}
      <div className="card">
        <h2 className="text-sm font-semibold text-zinc-100 mb-5">Requests over time</h2>
        {isLoading ? (
          <div className="h-52 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : timeline.length === 0 ? (
          <div className="h-52 flex items-center justify-center">
            <p className="text-zinc-600 text-sm">No data yet</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={timeline} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="openaiGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="claudeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="geminiGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="errorGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#d4d4d8' }}
                itemStyle={{ color: '#a1a1aa' }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: '#71717a' }} />
              <Area type="monotone" dataKey="openai" name="OpenAI" stroke="#10b981" fill="url(#openaiGrad)" strokeWidth={1.5} dot={false} />
              <Area type="monotone" dataKey="gemini" name="Gemini" stroke="#3b82f6" fill="url(#geminiGrad)" strokeWidth={1.5} dot={false} />
              <Area type="monotone" dataKey="claude" name="Claude" stroke="#8b5cf6" fill="url(#claudeGrad)" strokeWidth={1.5} dot={false} />
              <Area type="monotone" dataKey="errors" name="Errors" stroke="#ef4444" fill="url(#errorGrad)" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* By model breakdown */}
      {byModel.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-zinc-100 mb-4">Requests by model</h2>
          <div className="divide-y divide-zinc-800">
            {byModel.map((row: any) => (
              <div key={row.model} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <span className={cn('w-2 h-2 rounded-full shrink-0', PROVIDER_COLOR[row.provider] ?? 'bg-zinc-400')} />
                  <div>
                    <p className="text-sm text-zinc-100 font-mono">{row.model}</p>
                    <p className="text-xs text-zinc-500">{row.provider}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-100">{row.count.toLocaleString()} req</p>
                  {(row.prompt_tokens + row.completion_tokens) > 0 && (
                    <p className="text-xs text-zinc-500">
                      {fmtTokens(row.prompt_tokens)} in · {fmtTokens(row.completion_tokens)} out
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* By account breakdown */}
      <div className="card">
        <h2 className="text-sm font-semibold text-zinc-100 mb-5">Requests by account</h2>
        {isLoading ? (
          <div className="h-40 flex items-center justify-center">
            <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : byAccount.length === 0 ? (
          <div className="h-40 flex items-center justify-center">
            <p className="text-zinc-600 text-sm">No data yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {byAccount.map((row: any) => {
              const acc = accounts.find((a: any) => a.id === row.account_id)
              const label = acc?.label ?? row.account_id?.slice(0, 8)
              const pct = totalReqs ? Math.round((row.count / totalReqs) * 100) : 0
              const barColor = row.provider === 'openai' ? 'bg-emerald-500' : row.provider === 'gemini' ? 'bg-blue-500' : 'bg-violet-500'
              return (
                <div key={row.account_id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span className="flex items-center gap-2">
                      <span className={cn('w-2 h-2 rounded-full', PROVIDER_COLOR[row.provider] ?? 'bg-zinc-400')} />
                      {label}
                      <span className="text-zinc-600">{row.provider}</span>
                    </span>
                    <span className="font-mono">{row.count.toLocaleString()} req · {row.errors} err</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-1.5">
                    <div className={cn('h-1.5 rounded-full', barColor)} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Top API keys table */}
      {byKey.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-zinc-100 mb-4">Top API keys — token usage</h2>
          <div className="divide-y divide-zinc-800">
            {byKey.map((row: any) => (
              <div key={row.key_id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm text-zinc-100">{row.key_name ?? 'Unknown key'}</p>
                  <p className="text-xs text-zinc-500 font-mono">{row.key_prefix}…</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-100">{row.count.toLocaleString()} requests · {row.errors} errors</p>
                  {(row.prompt_tokens + row.completion_tokens) > 0 ? (
                    <p className="text-xs text-zinc-500">
                      {fmtTokens(row.prompt_tokens)} in · {fmtTokens(row.completion_tokens)} out
                      <span className="text-zinc-600 ml-1">({fmtTokens(row.prompt_tokens + row.completion_tokens)} total)</span>
                    </p>
                  ) : (
                    <p className="text-xs text-zinc-600">no token data</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
