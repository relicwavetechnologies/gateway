import { cn, timeUntil } from '../lib/utils'

type QuotaBarProps = {
  label: string
  pct: number | null | undefined
  resetAt: number | string | null | undefined
  className?: string
}

function clampPct(value: number) {
  return Math.max(0, Math.min(100, value))
}

function resetTime(ts: number | string | null | undefined) {
  if (!ts) return 'N/A'
  const t = typeof ts === 'string' ? Number(ts) : ts
  if (!t || Number.isNaN(t)) return 'N/A'
  return new Date(t).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function QuotaBar({ label, pct, resetAt, className }: QuotaBarProps) {
  const hasData = pct !== null && pct !== undefined && Number.isFinite(Number(pct))
  const value = hasData ? clampPct(Number(pct)) : 0
  const barColor = value >= 80 ? 'bg-red-500' : value >= 50 ? 'bg-amber-400' : 'bg-emerald-500'

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-400">{label}</span>
        <span className={cn('text-xs font-mono', hasData ? 'text-zinc-200' : 'text-zinc-600')}>
          {hasData ? `${value.toFixed(1)}%` : 'No data yet'}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
        <div className={cn('h-2 rounded-full transition-all', hasData ? barColor : 'bg-zinc-700')} style={{ width: `${value}%` }} />
      </div>
      <p className="text-[11px] text-zinc-500">
        {hasData && resetAt ? `Resets in ${timeUntil(resetAt)} · ${resetTime(resetAt)} IST` : 'Reset time N/A'}
      </p>
    </div>
  )
}
