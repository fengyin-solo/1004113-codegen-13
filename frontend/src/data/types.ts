/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ===== 地勤排班交接链路 =====

// 单个环节的结论：ok 正常通过；warn 兼容放行（历史数据等，需要显式提示）；error 阻断本次变更
export type ChainStageStatus = 'ok' | 'warn' | 'error'

// 一次排班变更经过的环节记录：环节名、结论、说明、登记序号（同一次提交内的先后顺序）
export type ChainStage = {
  name: string
  status: ChainStageStatus
  detail: string
  seq: number
}

// 交接链路：对应一次「安排排班 / 确认在岗 / 登记离岗」的完整流转过程
export type HandoverChain = {
  id: string
  crewId: number
  personNo: string
  name: string
  action: '安排排班' | '确认在岗' | '登记离岗'
  success: boolean
  startedAt: string
  finishedAt: string
  stages: ChainStage[]
}

// 链路图上的一个节点（静态流程图与动态链路共用）
export type FlowNode = {
  key: string
  label: string
}

// 一笔排班变更请求（并发压测时可同批提交多笔）
export type ScheduleRequest = {
  crewId: number
  date: string
  period: string
  seq: number
}

// 单笔变更结果：链路上的任何 error 都必须带 message 显式返回，不能静默吞掉
export type ScheduleChangeOutcome = {
  ok: boolean
  crewId: number
  personNo: string
  name: string
  seq: number
  chainId: string
  message: string
}

// 缺班组归属的兼容迁移结论
export type TeamMigrationReport = {
  migrated: number
  crewTotal: number
  details: { id: number; personNo: string; fallbackTeam: string }[]
}
