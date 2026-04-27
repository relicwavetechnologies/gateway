import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAlerts, resolveAlert } from '../lib/api'
import { Bell, CheckCircle2, AlertTriangle, Wifi, Clock, ShieldAlert } from 'lucide-react'
import { cn, relativeTime } from '../lib/utils'

const KIND_META: Record<string, { label: string; color: string; icon: any }> = {
  rate_limit:   { label: 'Rate Limited',   color: 'text-amber-400 bg-amber-400/10 border-amber-400/20', icon: Clock },
  auth_expired: { label: 'Auth Expired',   color: 'text-red-400 bg-red-400/10 border-red-400/20',       icon: ShieldAlert },
  all_down:     { label: 'All Accounts Down', color: 'text-red-500 bg-red-500/10 border-red-500/20',    icon: Wifi },
  unknown_error:{ label: 'Error',          color: 'text-zinc-400 bg-zinc-700/30 border-zinc-700',        icon: AlertTriangle },
}

function kindMeta(kind: string) {
  return KIND_META[kind] ?? KIND_META.unknown_error
}

export default function Alerts() {
  const qc = useQueryClient()
  const [showResolved, setShowResolved] = useState(false)

  const { data: alerts = [], isLoading } = useQuery({
    queryKey: ['alerts', showResolved],
    queryFn: () => getAlerts(showResolved),
    refetchInterval: 15_000,
  })

  const resolve = useMutation({
    mutationFn: (id: string) => resolveAlert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
  })

  const unresolved = alerts.filter((a: any) => !a.resolved)
  const resolved = alerts.filter((a: any) => a.resolved)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Alerts</h1>
          <p className="text-sm text-zinc-500 mt-1">Account failures and provider issues</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer select-none">
          <div
            onClick={() => setShowResolved(v => !v)}
            className={cn('w-9 h-5 rounded-full transition-colors relative', showResolved ? 'bg-brand' : 'bg-zinc-700')}
          >
            <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', showResolved ? 'translate-x-4' : 'translate-x-0.5')} />
          </div>
          Show resolved
        </label>
      </div>

      {isLoading ? (
        <div className="card h-40 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
        </div>
      ) : unresolved.length === 0 && !showResolved ? (
        <div className="card text-center py-16">
          <CheckCircle2 size={32} className="text-emerald-400 mx-auto mb-3" />
          <p className="text-zinc-100 font-medium">All clear</p>
          <p className="text-zinc-500 text-sm mt-1">No active alerts right now.</p>
        </div>
      ) : (
        <>
          {unresolved.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Active ({unresolved.length})</p>
              {unresolved.map((a: any) => <AlertRow key={a.id} alert={a} onResolve={() => resolve.mutate(a.id)} resolving={resolve.isPending} />)}
            </div>
          )}

          {showResolved && resolved.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mt-4">Resolved ({resolved.length})</p>
              {resolved.map((a: any) => <AlertRow key={a.id} alert={a} resolved />)}
            </div>
          )}

          {showResolved && resolved.length === 0 && unresolved.length === 0 && (
            <div className="card text-center py-12">
              <Bell size={28} className="text-zinc-600 mx-auto mb-3" />
              <p className="text-zinc-500 text-sm">No alerts recorded yet.</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AlertRow({ alert, onResolve, resolving, resolved }: {
  alert: any
  onResolve?: () => void
  resolving?: boolean
  resolved?: boolean
}) {
  const meta = kindMeta(alert.kind)
  const Icon = meta.icon

  return (
    <div className={cn('card flex items-start gap-4', resolved && 'opacity-50')}>
      <div className={cn('p-2 rounded-lg border shrink-0 mt-0.5', meta.color)}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('badge border text-xs', meta.color)}>{meta.label}</span>
          {alert.provider && (
            <span className="text-xs text-zinc-500 capitalize">{alert.provider}</span>
          )}
        </div>
        <p className="text-sm text-zinc-100 mt-1.5">{alert.message}</p>
        {alert.account_label && (
          <p className="text-xs text-zinc-500 mt-0.5">Account: {alert.account_label}</p>
        )}
        <div className="flex items-center gap-4 mt-2 text-xs text-zinc-600">
          <span>First seen {relativeTime(alert.first_seen)}</span>
          <span>Last seen {relativeTime(alert.last_seen)}</span>
          {alert.count > 1 && <span>{alert.count}× occurrences</span>}
          {alert.emailed_at && <span className="text-emerald-600">Email sent {relativeTime(alert.emailed_at)}</span>}
        </div>
      </div>
      {!resolved && onResolve && (
        <button
          onClick={onResolve}
          disabled={resolving}
          className="btn-ghost text-xs flex items-center gap-1.5 shrink-0"
          title="Mark resolved"
        >
          <CheckCircle2 size={13} />
          Resolve
        </button>
      )}
      {resolved && (
        <span className="text-xs text-emerald-600 flex items-center gap-1 shrink-0">
          <CheckCircle2 size={12} /> Resolved
        </span>
      )}
    </div>
  )
}
