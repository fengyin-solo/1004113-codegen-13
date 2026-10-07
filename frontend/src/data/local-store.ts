import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'

/** 既有数据中缺班组归属时的兼容口径：落到兜底班组，后续可重新指派。 */
export const FALLBACK_TEAM = '未归属班组（兼容迁移）'
const MIGRATION_VERSION = 2
const MIGRATION_STAMP_KEY = '_migrationVersion'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function looksLikeDate(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value.trim())
}

/**
 * 地勤排班既有数据的兼容迁移（只迁移、不改历史规则）：
 * - 所属班组缺失或明显是占位脏值（样例串/日期）→ 归入兜底班组；
 * - 其余字段（含历史离岗记录、脏的值班时段）一律保持原样；
 * - 打迁移版本戳，已迁移的数据不再重复迁移。
 * 返回是否发生过迁移。
 */
export function migrateCrewScheduleRows(rows: EntryRow[]): boolean {
  let changed = false
  for (const row of rows) {
    if (Number(row[MIGRATION_STAMP_KEY]) >= MIGRATION_VERSION) {
      continue
    }
    const team = String(row['所属班组'] ?? '').trim()
    const crewCode = String(row['人员编号'] ?? '')
    const isPlaceholder = crewCode.startsWith('CREW-') && team.includes('样例')
    if (!team || isPlaceholder || looksLikeDate(team)) {
      row['所属班组'] = FALLBACK_TEAM
      changed = true
    }
    row[MIGRATION_STAMP_KEY] = MIGRATION_VERSION
    changed = true
  }
  return changed
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let data: Record<string, EntryRow[]>
  if (!raw) {
    data = fallback
  } else {
    try {
      const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
      // 示例数据随版本新增模块时要补进来，已落库的模块仍以库里为准。
      data = { ...fallback, ...parsed }
    } catch {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
  }
  // 缺班组归属的既有数据按兼容口径迁移一次；落库失败不阻断，内存里仍是迁移后的数据。
  if (Array.isArray(data.crew_schedule) && migrateCrewScheduleRows(data.crew_schedule)) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      // 不能静默：打印到控制台，便于排查为什么刷新后又要迁移。
      console.warn('地勤排班兼容迁移结果持久化失败：', error)
    }
  }
  return data
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  if (key === 'crew_schedule') {
    migrateCrewScheduleRows(rows)
  }
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
