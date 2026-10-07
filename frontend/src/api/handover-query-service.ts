/**
 * 交接链路查询服务：给链路追踪页面提供筛选与统计。
 * 流程图由 ChainFlow / StandardFlow 组件用纯 CSS 渲染，保持离线无外部依赖。
 */
import { getChainLoadWarning, listChains } from '@/data/handover-store'
import type { HandoverChain } from '@/data/handover-types'

export interface ChainQuery {
  keyword?: string
  event?: string
  result?: 'all' | 'success' | 'failed'
}

/** 读取全部链路（最新在前）。 */
export function queryChains(query: ChainQuery = {}): HandoverChain[] {
  const keyword = query.keyword?.trim() ?? ''
  return listChains().filter((chain) => {
    if (query.event && chain.event !== query.event) {
      return false
    }
    if (query.result === 'success' && !chain.success) {
      return false
    }
    if (query.result === 'failed' && chain.success) {
      return false
    }
    if (keyword) {
      const haystack = [
        chain.serial,
        chain.crewCode,
        chain.crewName,
        chain.team,
        chain.event,
        chain.successorCode ?? '',
        chain.successorName ?? '',
        ...chain.stages.map((stage) => `${stage.detail} ${stage.error ?? ''}`),
      ].join(' ')
      if (!haystack.includes(keyword)) {
        return false
      }
    }
    return true
  })
}

export interface ChainStats {
  total: number
  success: number
  failed: number
  conflictRejected: number
}

export function chainStats(): ChainStats {
  const chains = listChains()
  return {
    total: chains.length,
    success: chains.filter((chain) => chain.success).length,
    failed: chains.filter((chain) => !chain.success).length,
    conflictRejected: chains.filter((chain) =>
      chain.stages.some((stage) => stage.stage === 'arbitrate' && stage.status === 'failed'),
    ).length,
  }
}

/** 链路存储损坏等初始化告警，页面必须显式展示，不能静默跳过。 */
export function storeWarning(): string {
  return getChainLoadWarning()
}
