import { useQuery } from '@tanstack/react-query'
import { getAccounts, getUsage, getAlerts } from '../lib/api'
import { Server, AlertTriangle, Activity, XCircle } from 'lucide-react'
import { absoluteTime, cn, relativeTime, statusColor, timeUntil } from '../lib/utils'

type AccountRow = {
  id: string
  provider: string
  label: string
  account_tier?: 'free' | 'pro'
  status: string
  request_count: number
  error_count: number
  last_error: string | null
  last_used_at: number | null
  cooldown_until: number | null
}

function fmt(n: number) {
  return Math.round(n).toLocaleString()
}

function hasRateLimitHistory(account: AccountRow) {
  const error = account.last_error?.toLowerCase() ?? ''
  return account.status === 'rate_limited' || error.includes('rate_limit') || error.includes('rate limit')
}

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function tierBaseline(accounts: AccountRow[], tier: 'free' | 'pro') {
  const samples = accounts
    .filter(a => (a.account_tier ?? 'free') === tier && hasRateLimitHistory(a) && Number(a.request_count) > 0)
    .map(a => Number(a.request_count))
  return { samples: samples.length, perAccount: median(samples) }
}

export default function Dashboard() {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts, refetchInterval: 15_000 })
  const { data: usage } = useQuery({ queryKey: ['usage'], queryFn: () => getUsage(), refetchInterval: 15_000 })
  const { data: alerts = [] } = useQuery({ queryKey: ['alerts'], queryFn: () => getAlerts(false) })

  const openaiAccounts = accounts.filter((a: AccountRow) => a.provider === 'openai')
  const claudeAccounts = accounts.filter((a: AccountRow) => a.provider === 'claude')
  const geminiAccounts = accounts.filter((a: AccountRow) => a.provider === 'gemini')
  const activeOpenAI = openaiAccounts.filter((a: AccountRow) => a.status === 'active').length
  const activeOpenAIPro = openaiAccounts.filter((a: AccountRow) => a.status === 'active' && a.account_tier === 'pro').length
  const activeOpenAIFree = openaiAccounts.filter((a: AccountRow) => a.status === 'active' && (a.account_tier ?? 'free') === 'free').length
  const coolingOpenAI = openaiAccounts.filter((a: AccountRow) => a.status === 'rate_limited').length
  const activeClaude = claudeAccounts.filter((a: AccountRow) => a.status === 'active').length
  const activeGemini = geminiAccounts.filter((a: AccountRow) => a.status === 'active').length
  const unresolvedAlerts = alerts.filter((a: any) => !a.resolved).length
  const freeBaseline = tierBaseline(openaiAccounts, 'free')
  const proBaseline = tierBaseline(openaiAccounts, 'pro')
  const estimatedProRequests = proBaseline.perAccount === null ? null : proBaseline.perAccount * activeOpenAIPro
  const estimatedFreeRequests = freeBaseline.perAccount === null ? null : freeBaseline.perAccount * activeOpenAIFree
  const estimatedOpenAIRequests =
    estimatedProRequests === null && estimatedFreeRequests === null
      ? null
      : (estimatedProRequests ?? 0) + (estimatedFreeRequests ?? 0)
  const coolingOpenAIAccounts = openaiAccounts
    .filter((a: AccountRow) => a.status === 'rate_limited')
    .sort((a: AccountRow, b: AccountRow) => (a.cooldown_until ?? Number.MAX_SAFE_INTEGER) - (b.cooldown_until ?? Number.MAX_SAFE_INTEGER))
  const nextOpenAIReset = coolingOpenAIAccounts.find((a: AccountRow) => a.cooldown_until && a.cooldown_until > Date.now())

  const providerStats = [
    { label: 'OpenAI Accounts', value: `${activeOpenAI} / ${openaiAccounts.length}`, sub: `${activeOpenAIPro} pro active · ${coolingOpenAI} cooling`, icon: Server, color: 'text-emerald-400' },
    { label: 'Gemini Accounts', value: `${activeGemini} / ${geminiAccounts.length}`, sub: 'active', icon: Server, color: 'text-blue-400' },
    { label: 'Claude Accounts', value: `${activeClaude} / ${claudeAccounts.length}`, sub: 'active', icon: Server, color: 'text-violet-400' },
  ]
  const systemStats = [
    { label: "Today's Requests", value: usage?.total_requests ?? '—', sub: `${usage?.total_errors ?? 0} errors`, icon: Activity, color: 'text-brand' },
    { label: 'Open Alerts', value: unresolvedAlerts, sub: unresolvedAlerts > 0 ? 'needs attention' : 'all clear', icon: AlertTriangle, color: unresolvedAlerts > 0 ? 'text-amber-400' : 'text-emerald-400' },
  ]
  const openaiCapacityStats = [
    {
      label: 'Estimated OpenAI Capacity',
      value: estimatedOpenAIRequests === null ? '—' : `~${fmt(estimatedOpenAIRequests)}`,
      sub: estimatedOpenAIRequests === null ? 'waiting for rate-limit history' : `${activeOpenAIPro} pro + ${activeOpenAIFree} free active`,
    },
    {
      label: 'Pro Pool',
      value: `${activeOpenAIPro} active`,
      sub: proBaseline.perAccount === null ? 'no prior pro limit sample' : `~${fmt(proBaseline.perAccount)} req/account from ${proBaseline.samples} sample${proBaseline.samples === 1 ? '' : 's'}`,
    },
    {
      label: 'Free Pool',
      value: `${activeOpenAIFree} active`,
      sub: freeBaseline.perAccount === null ? 'no prior free limit sample' : `~${fmt(freeBaseline.perAccount)} req/account from ${freeBaseline.samples} sample${freeBaseline.samples === 1 ? '' : 's'}`,
    },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Overview of your AI Gateway</p>
      </div>

      {/* Provider stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

      {/* OpenAI capacity */}
      <div className="card">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">OpenAI Capacity</h2>
            <p className="text-xs text-zinc-500 mt-1">Estimate uses past rate-limit samples from the current account pool</p>
          </div>
          {nextOpenAIReset ? (
            <div className="text-right shrink-0">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">Next Reset</p>
              <p className="text-sm text-amber-300 mt-1">{timeUntil(nextOpenAIReset.cooldown_until)}</p>
              <p className="text-xs text-zinc-500">{absoluteTime(nextOpenAIReset.cooldown_until)}</p>
            </div>
          ) : (
            <div className="text-right shrink-0">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">Next Reset</p>
              <p className="text-sm text-emerald-300 mt-1">none waiting</p>
            </div>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {openaiCapacityStats.map(s => (
            <div key={s.label} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
              <p className="text-2xl font-semibold text-zinc-100 mt-1">{s.value}</p>
              <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
            </div>
          ))}
        </div>
        {coolingOpenAIAccounts.length > 0 && (
          <div className="mt-4 divide-y divide-zinc-800">
            {coolingOpenAIAccounts.slice(0, 5).map((a: AccountRow) => (
              <div key={a.id} className="flex items-center justify-between gap-4 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-100 truncate">{a.label}</p>
                  <p className="text-xs text-zinc-500 uppercase">{a.account_tier ?? 'free'}</p>
                </div>
                <div className="text-right shrink-0">
                  {a.cooldown_until ? (
                    <>
                      <p className="text-xs text-amber-300">available in {timeUntil(a.cooldown_until)}</p>
                      <p className="text-xs text-zinc-500">{absoluteTime(a.cooldown_until)}</p>
                    </>
                  ) : (
                    <p className="text-xs text-red-300">no reset scheduled</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accounts health */}
      <div className="card">
        <h2 className="text-sm font-semibold text-zinc-100 mb-4">Account Health</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4 text-center">No accounts connected yet. <a href="/accounts" className="text-brand underline">Add one →</a></p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {accounts.map((a: AccountRow) => (
              <div key={a.id} className="flex items-center justify-between gap-4 py-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={cn('w-2 h-2 rounded-full mt-1.5 shrink-0', a.status === 'active' ? 'bg-emerald-400' : a.status === 'rate_limited' ? 'bg-amber-400' : 'bg-red-400')} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-zinc-100 truncate">{a.label}</p>
                      {a.provider === 'openai' && (
                        <span className={cn('badge text-[10px] uppercase', a.account_tier === 'pro' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400')}>
                          {a.account_tier ?? 'free'}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500">{a.provider} · {a.request_count} requests · {a.error_count} errors · last used {relativeTime(a.last_used_at)}</p>
                    {a.status === 'rate_limited' && a.cooldown_until && (
                      <p className="text-xs text-amber-400 mt-1">Available in {timeUntil(a.cooldown_until)} · {absoluteTime(a.cooldown_until)}</p>
                    )}
                    {a.status === 'rate_limited' && !a.cooldown_until && (
                      <p className="text-xs text-red-400 mt-1">No automatic reset scheduled</p>
                    )}
                    {a.last_error && (
                      <p className="text-xs text-zinc-500 mt-1 truncate">Last error: {a.last_error}</p>
                    )}
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
