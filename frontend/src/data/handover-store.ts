import type { HandoverChain } from './handover-types'

/**
 * 交接链路的独立持久化存储。
 * 与业务条目分开存放：链路是只追加（append-only）的审计记录，
 * 即使业务数据回滚，已经登记的链路（含失败链路）也不能丢。
 */
const CHAIN_STORAGE_KEY = 'airport-ground-handling:handover-chains:v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: HandoverChain[] | null = null
/** 存储损坏等初始化问题，页面需要显式告警，不能静默跳过。 */
let loadWarning = ''

function load(): HandoverChain[] {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = []
    return cache
  }
  const raw = window.localStorage.getItem(CHAIN_STORAGE_KEY)
  if (!raw) {
    cache = []
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error('链路数据不是数组结构')
    }
    cache = parsed as HandoverChain[]
    loadWarning = ''
  } catch (error) {
    // 损坏数据不能静默吞掉：备份原文、内存中以空链路起步，并把错误暴露给页面。
    const reason = error instanceof Error ? error.message : '未知解析错误'
    loadWarning = `交接链路存储已损坏（${reason}），原数据已保留在 ${CHAIN_STORAGE_KEY}#corrupted，本次会话链路从头登记。`
    try {
      window.localStorage.setItem(`${CHAIN_STORAGE_KEY}#corrupted`, raw)
      window.localStorage.removeItem(CHAIN_STORAGE_KEY)
    } catch {
      // 备份也失败时仍保留告警，不抛异常以免阻断业务操作。
    }
    cache = []
  }
  return cache
}

function persist(): void {
  if (typeof window === 'undefined' || !window.localStorage || cache === null) {
    return
  }
  // 归档失败必须向上抛错，调用方据此把链路环节标为失败。
  window.localStorage.setItem(CHAIN_STORAGE_KEY, JSON.stringify(cache))
}

/** 追加一条链路（成功/失败链路都要登记）。 */
export function appendChain(chain: HandoverChain): void {
  const rows = load()
  rows.unshift(chain)
  cache = clone(rows)
  persist()
}

export function listChains(): HandoverChain[] {
  return load()
}

export function getChainLoadWarning(): string {
  return loadWarning
}

export function chainStorageKey(): string {
  return CHAIN_STORAGE_KEY
}
