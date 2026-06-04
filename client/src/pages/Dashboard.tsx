import { useQuery } from '@tanstack/react-query'
import { getAccounts, getAlerts, getProxyStats, getUsage } from '../lib/api'
import { Activity, AlertTriangle, RefreshCw, Server, XCircle } from 'lucide-react'
import QuotaBar from '../components/QuotaBar'
import { cn, relativeTime, statusColor, timeUntil, absoluteTime } from '../lib/utils'
import type { AccountRow } from '../lib/types'

function fmt(n: number) {
  return Math.round(n).toLocaleString()
}

function quotaTier(account: AccountRow) {
  if (account.codex_plan_type) return account.codex_plan_type
  return account.account_tier ?? 'free'
}

function isRecentlyRecovered(account: AccountRow) {
  return Boolean(account.recovered_at && Date.now() - Number(account.recovered_at) < 3_600_000)
}

function errorRate(account: AccountRow) {
  const total = Number(account.request_count ?? 0)
  if (!total) return '0%'
  return `${Math.round((Number(account.error_count ?? 0) / total) * 100)}%`
}

function freshness(account: AccountRow) {
  return account.codex_updated_at ? `data as of ${relativeTime(account.codex_updated_at)}` : 'no quota data yet'
}

export default function Dashboard() {
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts, refetchInterval: 15_000 })
  const { data: usage } = useQuery({ queryKey: ['usage', 1], queryFn: () => getUsage(1), refetchInterval: 15_000 })
  const { data: alerts = [] } = useQuery({ queryKey: ['alerts'], queryFn: () => getAlerts(false) })
  const { data: proxyStats } = useQuery({ queryKey: ['proxy-stats'], queryFn: getProxyStats, refetchInterval: 15_000 })

  const openaiAccounts = accounts.filter(a => a.provider === 'openai')
  const claudeAccounts = accounts.filter(a => a.provider === 'claude')
  const geminiAccounts = accounts.filter(a => a.provider === 'gemini')
  const activeOpenAI = openaiAccounts.filter(a => a.status === 'active').length
  const activeOpenAIPro = openaiAccounts.filter(a => a.status === 'active' && (a.account_tier === 'pro' || Boolean(a.codex_plan_type))).length
  const coolingOpenAI = openaiAccounts.filter(a => a.status === 'rate_limited').length
  const activeClaude = claudeAccounts.filter(a => a.status === 'active').length
  const activeGemini = geminiAccounts.filter(a => a.status === 'active').length
  const unresolvedAlerts = alerts.filter((a: any) => !a.resolved).length
  const rescueRate = proxyStats?.total ? Math.round((proxyStats.rescued / proxyStats.total) * 100) : 0

  const providerStats = [
    { label: 'OpenAI Accounts', value: `${activeOpenAI} / ${openaiAccounts.length}`, sub: `${activeOpenAIPro} pro active · ${coolingOpenAI} cooling`, icon: Server, color: 'text-emerald-400' },
    { label: 'Gemini Accounts', value: `${activeGemini} / ${geminiAccounts.length}`, sub: 'active', icon: Server, color: 'text-blue-400' },
    { label: 'Claude Accounts', value: `${activeClaude} / ${claudeAccounts.length}`, sub: 'active', icon: Server, color: 'text-violet-400' },
    { label: 'DeepSeek', value: usage ? fmt(usage.deepseek_requests) : '—', sub: 'API key · no pool · 24h reqs', icon: Server, color: 'text-cyan-400' },
  ]

  const systemStats = [
    { label: '24h Requests', value: usage?.total_requests ?? '—', sub: `${usage?.total_errors ?? 0} errors`, icon: Activity, color: 'text-brand' },
    { label: 'Open Alerts', value: unresolvedAlerts, sub: unresolvedAlerts > 0 ? 'needs attention' : 'all clear', icon: AlertTriangle, color: unresolvedAlerts > 0 ? 'text-amber-400' : 'text-emerald-400' },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Dashboard</h1>
        <p className="text-sm text-zinc-500 mt-1">Real-time Gateway health from account, quota, and request telemetry</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {systemStats.map(s => (
          <div key={s.label} className="card">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wide">{s.label}</p>
                <p className="text-3xl font-bold text-zinc-100 mt-1">{typeof s.value === 'number' ? fmt(s.value) : s.value}</p>
                <p className="text-xs text-zinc-500 mt-1">{s.sub}</p>
              </div>
              <s.icon size={20} className={cn(s.color, 'mt-0.5')} />
            </div>
          </div>
        ))}
        <div className="card">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide">Requests Rescued</p>
              <p className="text-3xl font-bold text-zinc-100 mt-1">{fmt(proxyStats?.rescued ?? 0)}</p>
              <p className="text-xs text-zinc-500 mt-1">{proxyStats?.total ? `${rescueRate}% of successful proxied requests since restart` : 'since restart'}</p>
            </div>
            <RefreshCw size={20} className="text-cyan-400 mt-0.5" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">OpenAI Quota</h2>
            <p className="text-xs text-zinc-500 mt-1">Codex quota headers only. Accounts without observed headers show N/A.</p>
          </div>
          <span className="text-xs text-zinc-500">{openaiAccounts.length} accounts</span>
        </div>

        {openaiAccounts.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4 text-center">No OpenAI accounts connected yet.</p>
        ) : (
          <div className="divide-y divide-zinc-800">
            {openaiAccounts.map(account => (
              <div key={account.id} className="py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-zinc-100 truncate">{account.label}</p>
                      <span className={cn('badge text-[10px] uppercase', account.account_tier === 'pro' || account.codex_plan_type ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400')}>
                        {quotaTier(account)}
                      </span>
                      {isRecentlyRecovered(account) && (
                        <span className="badge border-emerald-500/30 bg-emerald-500/10 text-emerald-300 animate-pulse">recently recovered</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500 mt-1">{freshness(account)} · credits {account.codex_credits == null ? 'N/A' : account.codex_credits.toLocaleString()}</p>
                    {account.status === 'rate_limited' && account.cooldown_until && (
                      <p className="text-xs text-amber-400 mt-1">Available in {timeUntil(account.cooldown_until)} · {absoluteTime(account.cooldown_until)}</p>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full lg:max-w-2xl">
                    <QuotaBar label="5h window" pct={account.codex_primary_pct} resetAt={account.codex_primary_reset} />
                    <QuotaBar label="7d window" pct={account.codex_secondary_pct} resetAt={account.codex_secondary_reset} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 className="text-sm font-semibold text-zinc-100 mb-4">Account Health</h2>
        {accounts.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4 text-center">No accounts connected yet. <a href="/accounts" className="text-brand underline">Add one</a></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 uppercase tracking-wide border-b border-zinc-800">
                  <th className="py-2 pr-4 font-medium">Account</th>
                  <th className="py-2 pr-4 font-medium">Provider</th>
                  <th className="py-2 pr-4 font-medium">Requests</th>
                  <th className="py-2 pr-4 font-medium">Error Rate</th>
                  <th className="py-2 pr-4 font-medium">Last Used</th>
                  <th className="py-2 font-medium text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {accounts.map(account => (
                  <tr key={account.id}>
                    <td className="py-3 pr-4 min-w-52">
                      <p className="text-zinc-100 truncate">{account.label}</p>
                      {account.last_error && <p className="text-xs text-zinc-500 truncate max-w-sm">Last error: {account.last_error}</p>}
                    </td>
                    <td className="py-3 pr-4 text-zinc-400">{account.provider}</td>
                    <td className="py-3 pr-4 text-zinc-400">{fmt(Number(account.request_count ?? 0))}</td>
                    <td className="py-3 pr-4 text-zinc-400">{errorRate(account)}</td>
                    <td className="py-3 pr-4 text-zinc-400">{relativeTime(account.last_used_at)}</td>
                    <td className="py-3 text-right"><span className={cn('badge', statusColor(account.status))}>{account.status.replace('_', ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {unresolvedAlerts > 0 && (
        <div className="card border-amber-500/20">
          <h2 className="text-sm font-semibold text-zinc-100 mb-4 flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-400" /> Recent Alerts
          </h2>
          <div className="space-y-2">
            {alerts.slice(0, 5).map((alert: any) => (
              <div key={alert.id} className="flex items-start gap-3 p-3 bg-amber-500/5 border border-amber-500/15 rounded-lg">
                <XCircle size={14} className="text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm text-zinc-100">{alert.message}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{relativeTime(alert.last_seen)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
