export type Provider = 'openai' | 'claude' | 'gemini' | 'deepseek'

export type AccountStatus = 'active' | 'rate_limited' | 'auth_expired' | 'error' | 'disabled'

export type AccountRow = {
  id: string
  provider: Provider
  label: string
  account_tier?: 'free' | 'pro'
  status: AccountStatus
  request_count: number
  error_count: number
  last_error: string | null
  last_used_at: number | null
  cooldown_until: number | null
  codex_plan_type: string | null
  codex_primary_pct: number | null
  codex_primary_reset: number | null
  codex_secondary_pct: number | null
  codex_secondary_reset: number | null
  codex_credits: number | null
  codex_updated_at: number | null
  recovered_at: number | null
}

export type ProxyStats = {
  rescued: number
  total: number
}

export type UsageSummary = {
  total_requests: number
  total_errors: number
  error_rate: number
  openai_requests: number
  claude_requests: number
  gemini_requests: number
  deepseek_requests: number
  total_prompt_tokens: number
  total_completion_tokens: number
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  timeline: { label: string; openai: number; claude: number; gemini: number; deepseek: number; errors: number }[]
  by_account: {
    account_id: string
    label: string | null
    provider: Provider
    count: number
    errors: number
    prompt_tokens: number
    completion_tokens: number
  }[]
  by_key: {
    key_id: string
    key_name: string | null
    key_prefix: string | null
    count: number
    errors: number
    prompt_tokens: number
    completion_tokens: number
  }[]
  by_model: {
    model: string
    provider: Provider
    count: number
    prompt_tokens: number
    completion_tokens: number
  }[]
}
