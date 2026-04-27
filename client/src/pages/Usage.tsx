import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getUsage, getAccounts } from '../lib/api'
import { BarChart2, TrendingUp, TrendingDown, Activity } from 'lucide-react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
} from 'recharts'
import { cn } from '../lib/utils'

const RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
]

function statCard(label: string, value: string | number, sub: string, trend?: number) {
  return { label, value, sub, trend }
}

export default function Usage() {
  const [days, setDays] = useState(7)
  const { data: usage, isLoading } = useQuery({
    queryKey: ['usage', days],
    queryFn: () => getUsage(days),
    refetchInterval: 30_000,
  })
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })

  const stats = [
    statCard('Total Requests', usage?.total_requests ?? '—', 'all providers'),
    statCard('Errors', usage?.total_errors ?? '—', `${usage?.error_rate ?? 0}% error rate`),
    statCard('OpenAI Requests', usage?.openai_requests ?? '—', 'via ChatGPT accounts'),
    statCard('Claude Requests', usage?.claude_requests ?? '—', 'via Claude accounts'),
  ]

  const timeline: any[] = usage?.timeline ?? []
  const byAccount: any[] = usage?.by_account ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Usage</h1>
          <p className="text-sm text-zinc-500 mt-1">Request volume, errors, and account distribution</p>
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
      <div className="grid grid-cols-4 gap-4">
        {stats.map(s => (
          <div key={s.label} className="card">
            <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
            <p className="text-3xl font-bold text-zinc-100 mt-1">{s.value.toLocaleString()}</p>
            <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
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
              <Area type="monotone" dataKey="claude" name="Claude" stroke="#8b5cf6" fill="url(#claudeGrad)" strokeWidth={1.5} dot={false} />
              <Area type="monotone" dataKey="errors" name="Errors" stroke="#ef4444" fill="url(#errorGrad)" strokeWidth={1.5} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

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
              const label = acc?.label ?? row.account_id.slice(0, 8)
              const pct = usage?.total_requests ? Math.round((row.count / usage.total_requests) * 100) : 0
              return (
                <div key={row.account_id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-zinc-400">
                    <span className="flex items-center gap-2">
                      <span className={cn('w-2 h-2 rounded-full', row.provider === 'openai' ? 'bg-emerald-400' : 'bg-violet-400')} />
                      {label}
                      <span className="text-zinc-600">{row.provider}</span>
                    </span>
                    <span className="font-mono">{row.count.toLocaleString()} req · {row.errors} err</span>
                  </div>
                  <div className="w-full bg-zinc-800 rounded-full h-1.5">
                    <div
                      className={cn('h-1.5 rounded-full', row.provider === 'openai' ? 'bg-emerald-500' : 'bg-violet-500')}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Top API keys table */}
      {usage?.by_key && usage.by_key.length > 0 && (
        <div className="card">
          <h2 className="text-sm font-semibold text-zinc-100 mb-4">Top API keys</h2>
          <div className="divide-y divide-zinc-800">
            {usage.by_key.map((row: any) => (
              <div key={row.key_id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm text-zinc-100">{row.key_name ?? 'Unknown key'}</p>
                  <p className="text-xs text-zinc-500 font-mono">{row.key_prefix}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-100">{row.count.toLocaleString()} requests</p>
                  <p className="text-xs text-zinc-500">{row.errors} errors</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
