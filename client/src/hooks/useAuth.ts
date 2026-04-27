import { useState, useEffect } from 'react'
import { isLoggedIn } from '../lib/auth'

export function useAuth() {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)

  useEffect(() => {
    setLoggedIn(isLoggedIn())
  }, [])

  return { user: loggedIn ? {} : null, loading: loggedIn === null }
}
