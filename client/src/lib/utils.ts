import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function relativeTime(ts: number | string | null) {
  if (!ts) return '—'
  const t = typeof ts === 'string' ? Number(ts) : ts
  if (!t || isNaN(t)) return '—'
  const diff = Date.now() - t
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function statusColor(status: string) {
  switch (status) {
    case 'active': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
    case 'rate_limited': return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
    case 'auth_expired': return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'error': return 'bg-red-500/15 text-red-400 border-red-500/30'
    case 'disabled': return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
    default: return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
  }
}
