import axios from 'axios'
import { getToken, clearToken } from './auth'

const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ?? '/' })

api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      clearToken()
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api

export const login = (email: string, password: string) =>
  api.post('/auth/login', { email, password }).then(r => r.data as { token: string })

// Accounts
export const getAccounts = () => api.get('/admin/accounts').then(r => r.data)
export const initiateAccount = (provider: string) => api.post('/admin/accounts/initiate', { provider }).then(r => r.data)
export const completeAccount = (body: object) => api.post('/admin/accounts/complete', body).then(r => r.data)
export const testAccount = (id: string) => api.post(`/admin/accounts/${id}/test`).then(r => r.data)
export const patchAccount = (id: string, body: object) => api.patch(`/admin/accounts/${id}`, body).then(r => r.data)
export const deleteAccount = (id: string) => api.delete(`/admin/accounts/${id}`).then(r => r.data)
export const importToken = (body: { provider: string; access_token: string; refresh_token?: string; expires_in?: number; label?: string }) =>
  api.post('/admin/accounts/import-token', body).then(r => r.data)

// API Keys
export const getApiKeys = () => api.get('/admin/api-keys').then(r => r.data)
export const createApiKey = (body: object) => api.post('/admin/api-keys', body).then(r => r.data)
export const revokeApiKey = (id: string) => api.delete(`/admin/api-keys/${id}`).then(r => r.data)

// Usage
export const getUsage = (days = 7) => api.get('/admin/usage', { params: { days } }).then(r => r.data)
export const getAlerts = (resolved = false) => api.get('/admin/usage/alerts', { params: { resolved } }).then(r => r.data)
export const resolveAlert = (id: string) => api.post(`/admin/usage/alerts/${id}/resolve`).then(r => r.data)
