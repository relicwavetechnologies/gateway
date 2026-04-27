import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Server, Key, BarChart2, Bell, LogOut, Zap } from 'lucide-react'
import { clearToken } from '../../lib/auth'
import { useQuery } from '@tanstack/react-query'
import { getAlerts } from '../../lib/api'

const nav = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/accounts', icon: Server, label: 'Accounts' },
  { to: '/keys', icon: Key, label: 'API Keys' },
  { to: '/usage', icon: BarChart2, label: 'Usage' },
  { to: '/alerts', icon: Bell, label: 'Alerts' },
]

export default function Layout() {
  const navigate = useNavigate()
  const { data: alerts } = useQuery({ queryKey: ['alerts'], queryFn: () => getAlerts(false), refetchInterval: 30_000 })
  const unread = alerts?.filter((a: any) => !a.resolved).length ?? 0

  function handleLogout() {
    clearToken()
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 bg-zinc-900 border-r border-zinc-800 flex flex-col fixed inset-y-0">
        <div className="p-5 border-b border-zinc-800">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-brand rounded-lg flex items-center justify-center">
              <Zap size={14} className="text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-100">AI Gateway</p>
              <p className="text-xs text-zinc-500">Admin Panel</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-0.5">
          {nav.map(({ to, icon: Icon, label, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors relative ${isActive
                ? 'bg-brand/15 text-brand font-medium'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'}`
            }>
              <Icon size={16} />
              {label}
              {label === 'Alerts' && unread > 0 && (
                <span className="ml-auto bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="p-3 border-t border-zinc-800">
          <button onClick={handleLogout} className="btn-ghost w-full flex items-center gap-2">
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>

      <main className="ml-56 flex-1 p-8">
        <Outlet />
      </main>
    </div>
  )
}
