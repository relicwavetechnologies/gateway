import { isLoggedIn } from '../lib/auth'

export function useAuth() {
  const loggedIn = isLoggedIn()
  return { user: loggedIn ? {} : null, loading: false }
}
