/**
 * 地勤排班交接链路追踪的领域模型。
 *
 * 一条「交接链路」对应一次排班/在岗/离岗/交接业务变更，按环节顺序记录：
 * 校验 → 冲突裁决 → 排班写入 → 应急待办写回 → 链路归档。
 * 任何环节失败都不允许静默跳过：失败环节连同错误原因写进链路，页面可见。
 */

/** 链路环节标识：顺序即变更经过的环节顺序。 */
export type ChainStageKey =
  | 'validate' // 环节1：读懂并校验人员编号/岗位类别/所属班组/值班时段/在岗状态
  | 'arbitrate' // 环节2：并发登记与值班时段冲突裁决（先登记优先）
  | 'writeback' // 环节3：排班结果落库
  | 'emergency' // 环节4：排班结果写回应急保障待办
  | 'archive' // 环节5：交接链路归档

export type ChainStageStatus = 'success' | 'failed'

/** 岗位类别（在岗状态沿用状态机：待排班/已排班/在岗/已离岗）。 */
export const POSITION_CATEGORIES = ['机务', '加油员', '行李装卸', '货运装卸', '客舱清洁', '特种车司机', '引导员', '桥载操作工'] as const
export type PositionCategory = (typeof POSITION_CATEGORIES)[number]

/** 链路经过的单个环节。 */
export interface HandoverStage {
  /** 环节顺序，从 1 开始。 */
  order: number
  stage: ChainStageKey
  label: string
  status: ChainStageStatus
  /** 环节发生时间（ISO8601）。 */
  at: string
  detail: string
  /** 失败环节必须带错误原因，不能静默跳过。 */
  error?: string
}

/** 链路追踪的变更动作类型。 */
export type HandoverEvent =
  | '登记人员'
  | '安排排班'
  | '确认在岗'
  | '交接班'
  | '登记离岗'

/** 一条交接链路：一次变更经过的全部环节。 */
export interface HandoverChain {
  id: number
  /** 业务流水号，页面展示用，如 HAND-20261007-0001。 */
  serial: string
  /** 触发本次变更的人员编号。 */
  crewCode: string
  crewName: string
  /** 所属班组；兼容迁移数据为「未归属班组（兼容迁移）」。 */
  team: string
  event: HandoverEvent
  /** 变更后在本班次的状态。 */
  resultStatus: string
  /** 登记顺序序号，并发/冲突裁决时序号小的（先登记）获胜。 */
  registerOrder: number
  success: boolean
  stages: HandoverStage[]
  /** 交接班时的接班人编号，其余动作为空。 */
  successorCode?: string
  successorName?: string
  createdAt: string
}
