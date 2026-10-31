import type { SyncBudget } from './operation-types.js'

export function finiteSyncBudget(budget: SyncBudget): Exclude<SyncBudget, { mode: 'unlimited' }> | null {
  return 'mode' in budget ? null : budget
}

export function syncDeadlineExpired(deadlineAtMs: number | null, now = Date.now()): boolean {
  return deadlineAtMs !== null && deadlineAtMs <= now
}
