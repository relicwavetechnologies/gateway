import { useQuery } from '@tanstack/react-query'
import { getAccounts, getUsage, getAlerts } from '../lib/api'
import { Server, Key, AlertTriangle, Activity, CheckCircle2, XCircle } from 'lucide-react'
import { cn, relativeTime, statusColor } from '../lib/utils'

export default function Dashboard() {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts, refetchInterval: 15_000 })
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: () => getUsage(), refetchInterval: 15_000 })
  const { data: alerts = [] } = useQuery({ queryKey: ['alerts'], queryFn: () => getAlerts(false) })

  const openaiAccounts = accounts.filter((a: any) => a.provider === 'openai')
  const claudeAccounts = accounts.filter((a: any) => a.provider === 'claude')
  const geminiAccounts = accounts.filter((a: any) => a.provider === 'gemini')
  const activeOpenAI = openaiAccounts.filter((a: any) => a.status === 'active').length
  const activeClaude = claudeAccounts.filter((a: any) => a.status === 'active').length
  const activeGemini = geminiAccounts.filter((a: any) => a.status === 'active').length
  const unresolvedAlerts = alerts.filter((a: any) => !a.resolved).length

  const providerStats = [
    { label: 'OpenAI Accounts', value: `${activeOpenAI} / ${openaiAccounts.length}`, sub: 'active', icon: Server, color: 'text-emerald-400' },
    { label: 'Gemini Accounts', value: `${activeGemini} / ${geminiAccounts.length}`, sub: 'active', icon: Server, color: 'text-blue-400' },
    { label: 'Claude Accounts', value: `${activeClaude} / ${claudeAccounts.length}`, sub: 'active', icon: Server, color: 'text-violet-400' },
  ]
  const systemStats = [
    { label: "Today's Requests", value: usage?.total_requests ?? '—', sub: `${usage?.total_errors ?? 0} errors`, icon: Activity, color: 'text-brand' },
    { label: 'Open Alerts', value: unresolvedAlerts, sub: unresolvedAlerts > 0 ? 'needs attention' : 'all clear', icon: AlertTriangle, color: unresolvedAlerts > 0 ? 'text-amber-400' : 'text-emerald-400' },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Overview of your AI Gateway</p>
      </div>

      {/* Provider stats */}
      <div className="grid grid-cols-3 gap-4">
        {providerStats.map(s => (
          <div key={s.label} className="card">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
                <p className="text-3xl font-bold text-zinc-100 mt-1">{s.value}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
              </div>
              <s.icon size={20} className={cn(s.color, 'mt-0.5')} />
            </div>
          </div>
        ))}
      </div>
      {/* System stats */}
      <div className="grid grid-cols-2 gap-4">
        {systemStats.map(s => (
          <div key={s.label} className="card">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
                <p className="text-3xl font-bold text-zinc-100 mt-1">{s.value}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
              </div>
              <s.icon size={20} className={cn(s.color, 'mt-0.5')} />
            </div>
          </div>
        ))}
      </div>

      {/* Accounts health */}
      <div className="card">
        <h2 className="text-sm font-semibold text-zinc-100 mb-4">Account Health</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4 text-center">No accounts connected yet. <a href="/accounts" className="text-brand underline">Add one →</a></p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {accounts.map((a: any) => (
              <div key={a.id} className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3">
                  <div className={cn('w-2 h-2 rounded-full', a.status === 'active' ? 'bg-emerald-400' : 'bg-red-400')} />
                  <div>
                    <p className="text-sm text-zinc-100">{a.label}</p>
                    <p className="text-xs text-zinc-500">{a.provider} · {a.request_count} requests · last used {relativeTime(a.last_used_at)}</p>
                  </div>
                </div>
                <span className={cn('badge', statusColor(a.status))}>{a.status.replace('_', ' ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent alerts */}
      {unresolvedAlerts > 0 && (
        <div className="card border-amber-500/20">
          <h2 className="text-sm font-semibold text-zinc-100 mb-4 flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-400" /> Recent Alerts
          </h2>
          <div className="space-y-2">
            {alerts.slice(0, 5).map((a: any) => (
              <div key={a.id} className="flex items-start gap-3 p-3 bg-amber-500/5 border border-amber-500/15 rounded-lg">
                <XCircle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-zinc-100">{a.message}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{relativeTime(a.last_seen)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
