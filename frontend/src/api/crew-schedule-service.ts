/**
 * 地勤排班交接链路服务（纯前端事务实现）。
 *
 * 每次变更经过的环节：
 *   ① 校验登记   读懂人员编号、岗位类别、所属班组、值班时段、在岗状态
 *   ② 冲突裁决   同一人员并发排到重叠时段，只允许先登记的成功
 *   ③ 排班写回   排班结果落到地勤排班模块
 *   ④ 应急写回   排班结果写回「应急保障」模块的待办
 *   ⑤ 链路归档   成功与失败链路都登记，错误不静默跳过
 *
 * ③④ 用同一份工作副本一次性提交：任一环节失败则整体不生效（不留下半截排班）。
 */
import { FALLBACK_TEAM, listRows, saveRows } from '@/data/local-store'
import { appendChain } from '@/data/handover-store'
import type {
  ChainStageKey,
  ChainStageStatus,
  HandoverChain,
  HandoverEvent,
  HandoverStage,
} from '@/data/handover-types'
import type { EntryRow } from '@/data/types'

const CREW_KEY = 'crew_schedule'
const EMERGENCY_KEY = 'air_emergency'
/** 新写入行的数据版本戳，与 local-store 的兼容迁移版本对齐。 */
const DATA_VERSION = 2

export const CREW_STATUSES = ['待排班', '已排班', '在岗', '已离岗'] as const
export const FINAL_STATUS = '已离岗'

const STAGE_LABELS: Record<ChainStageKey, string> = {
  validate: '① 校验登记',
  arbitrate: '② 冲突裁决',
  writeback: '③ 排班写回',
  emergency: '④ 应急写回',
  archive: '⑤ 链路归档',
}

export interface StageResult {
  status: ChainStageStatus
  detail: string
  error?: string
}

export interface CrewOperationResult {
  ok: boolean
  message: string
  chain?: HandoverChain
}

export interface RegisterPersonInput {
  crewCode: string
  name: string
  position: string
  team: string
  contact: string
}

export interface ScheduleInput {
  personId: number
  /** YYYY-MM-DD */
  date: string
  /** HH:MM */
  startTime: string
  /** HH:MM */
  endTime: string
  /** 可选：本次值班需要挂接的应急待办 id；不指定则新建一条应急保障待办。 */
  emergencyTodoId?: number
}

export interface HandoverInput {
  /** 交班人的排班行 id（在岗）。 */
  fromRowId: number
  successorId: number
  reason: string
}

export interface OffDutyInput {
  rowId: number
  note: string
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString()
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCrewCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /^CREW-(\d+)$/.exec(String(row['人员编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `CREW-${String(max + 1).padStart(4, '0')}`
}

function nextEmergencyCode(rows: EntryRow[]): string {
  let max = 0
  for (const row of rows) {
    const match = /^AIR-(\d+)$/.exec(String(row['应急编号'] ?? ''))
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `AIR-${String(max + 1).padStart(4, '0')}`
}

/** 全局登记顺序：并发登记时序号小的（先登记）在冲突裁决中获胜。JS 同步执行下天然串行。 */
let registerCounter = 0

function claimRegistration(): { order: number; serial: string } {
  registerCounter += 1
  const date = new Date()
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  return { order: registerCounter, serial: `HAND-${stamp}-${String(registerCounter).padStart(4, '0')}` }
}

/* ------------------------------------------------------------------ */
/* 值班时段解析与重叠判断                                              */
/* ------------------------------------------------------------------ */

export interface SlotRange {
  /** 相对排班日期零点的分钟数，跨天夜班的结束时间 +1440。 */
  start: number
  end: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^(\d{1,2}):(\d{2})$/

/** 把日期 +「HH:MM-HH:MM」解析成可比较的分钟区间。 */
export function parseSlot(date: string, startTime: string, endTime: string): SlotRange {
  if (!DATE_RE.test(date)) {
    throw new Error('排班日期格式应为 YYYY-MM-DD')
  }
  const startMatch = TIME_RE.exec(startTime)
  const endMatch = TIME_RE.exec(endTime)
  if (!startMatch || !endMatch) {
    throw new Error('值班时段应形如 08:00-20:00')
  }
  const start = Number(startMatch[1]) * 60 + Number(startMatch[2])
  let end = Number(endMatch[1]) * 60 + Number(endMatch[2])
  if (start === end) {
    throw new Error('值班开始与结束时间不能相同')
  }
  if (end < start) {
    // 跨天夜班：结束时间落在次日。
    end += 24 * 60
  }
  return { start, end }
}

/** 解析既有行的日期+值班时段；脏数据解析不了返回 null（历史遗留不参与裁决）。 */
export function rowSlot(row: EntryRow): SlotRange | null {
  const date = String(row['排班日期'] ?? '').trim()
  const slot = String(row['值班时段'] ?? '').trim()
  const match = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(slot)
  if (!DATE_RE.test(date) || !match) {
    return null
  }
  try {
    return parseSlot(date, match[1], match[2])
  } catch {
    return null
  }
}

/** 日期换算成自纪元起的天数，用于跨天夜班的绝对分钟比较。 */
function dayIndex(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / (24 * 60 * 60 * 1000))
}

/**
 * 既有行与目标时段是否重叠（端点相接不算重叠）。
 * 跨天夜班（如 10-07 20:00-08:00）会延伸到次日凌晨，因此按「日期零点+分钟」换算成
 * 绝对时间后比较，能识别夜班与次日早班的重叠。
 */
function overlapsOnDate(row: EntryRow, date: string, target: SlotRange): boolean {
  const current = rowSlot(row)
  if (!current) {
    return false
  }
  const currentDate = String(row['排班日期'] ?? '')
  const targetBase = dayIndex(date) * 24 * 60
  const currentBase = dayIndex(currentDate) * 24 * 60
  if (Number.isNaN(targetBase) || Number.isNaN(currentBase)) {
    return false
  }
  const currentStart = currentBase + current.start
  const currentEnd = currentBase + current.end
  const targetStart = targetBase + target.start
  const targetEnd = targetBase + target.end
  return currentStart < targetEnd && targetStart < currentEnd
}

/* ------------------------------------------------------------------ */
/* 链路构建与归档                                                      */
/* ------------------------------------------------------------------ */

class ChainBuilder {
  readonly stages: HandoverStage[] = []
  private order = 0

  add(stage: ChainStageKey, result: StageResult): void {
    this.order += 1
    this.stages.push({
      order: this.order,
      stage,
      label: STAGE_LABELS[stage],
      status: result.status,
      at: nowIso(),
      detail: result.detail,
      ...(result.error ? { error: result.error } : {}),
    })
  }

  get failed(): boolean {
    return this.stages.some((stage) => stage.status === 'failed')
  }
}

interface ChainDraft {
  registration: { order: number; serial: string }
  crewCode: string
  crewName: string
  team: string
  event: HandoverEvent
  resultStatus: string
  stages: HandoverStage[]
  successorCode?: string
  successorName?: string
}

/**
 * 归档整条链路并补上环节⑤。
 * 成功：链路（含成功的归档环节）一次写入；失败：归档环节带错误原因返回，
 * 链路错误由此对调用方可见，绝不静默跳过。
 */
function finalizeChain(builder: ChainBuilder, draft: Omit<ChainDraft, 'stages'>): CrewOperationResult {
  const { order, serial } = draft.registration
  const stages = [...builder.stages]
  const archiveStage: HandoverStage = {
    order: stages.length + 1,
    stage: 'archive',
    label: STAGE_LABELS.archive,
    status: 'success',
    at: nowIso(),
    detail: `链路已归档，流水号 ${serial}`,
  }
  const businessFailed = builder.failed
  const chain: HandoverChain = {
    id: order,
    serial,
    registerOrder: order,
    createdAt: nowIso(),
    crewCode: draft.crewCode,
    crewName: draft.crewName,
    team: draft.team,
    event: draft.event,
    resultStatus: draft.resultStatus,
    success: !businessFailed,
    stages: [...stages, archiveStage],
    ...(draft.successorCode ? { successorCode: draft.successorCode, successorName: draft.successorName } : {}),
  }
  try {
    appendChain(chain)
  } catch (error) {
    archiveStage.status = 'failed'
    archiveStage.detail = '链路归档失败'
    archiveStage.error = error instanceof Error ? error.message : '链路持久化失败'
    chain.success = false
    return {
      ok: false,
      message: businessFailed
        ? `${stages.find((stage) => stage.status === 'failed')?.error ?? '排班变更失败'}；且${archiveStage.error}`
        : `业务变更已生效，但链路归档失败：${archiveStage.error}`,
      chain,
    }
  }
  if (businessFailed) {
    return { ok: false, message: stages.find((stage) => stage.status === 'failed')?.error ?? '排班变更失败', chain }
  }
  return { ok: true, message: '', chain }
}

/* ------------------------------------------------------------------ */
/* 事务提交：排班写回 + 应急写回 要么全成，要么全不成                    */
/* ------------------------------------------------------------------ */

interface CommitPlan {
  crewRows: EntryRow[]
  emergencyRows: EntryRow[]
}

function commit(plan: CommitPlan): void {
  const previousCrew = listRows(CREW_KEY)
  try {
    saveRows(CREW_KEY, plan.crewRows)
  } catch (error) {
    throw new Error(`排班写回失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
  try {
    saveRows(EMERGENCY_KEY, plan.emergencyRows)
  } catch (error) {
    // 应急写回失败必须回滚排班，不允许留下没有待办的排班。
    saveRows(CREW_KEY, previousCrew)
    throw new Error(`应急待办写回失败，排班变更已整体回滚：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/* ------------------------------------------------------------------ */
/* 动作实现                                                            */
/* ------------------------------------------------------------------ */

function baseRowInfo(row: EntryRow): { crewCode: string; crewName: string; team: string } {
  return {
    crewCode: String(row['人员编号'] ?? ''),
    crewName: String(row['姓名'] ?? ''),
    team: String(row['所属班组'] ?? FALLBACK_TEAM),
  }
}

/** 缺班组归属（兼容迁移）的既有数据判定。 */
export function rowIsLegacy(row: EntryRow): boolean {
  return String(row['所属班组'] ?? '') === FALLBACK_TEAM
}

function appendMeasure(current: string, addition: string): string {
  return current && !current.includes('样例') ? `${current}；${addition}` : addition
}

function findRow(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === Number(id))
}

/** 登记地勤人员（原页面「尚未接入审批流」的入口在此接通）。 */
export function registerPerson(input: RegisterPersonInput): CrewOperationResult {
  const registration = claimRegistration()
  const builder = new ChainBuilder()
  const rows = listRows(CREW_KEY)
  const crewCode = input.crewCode.trim() || nextCrewCode(rows)
  const name = input.name.trim()
  const position = input.position.trim()
  const team = input.team.trim()
  const contact = input.contact.trim()

  // 环节①：读懂并校验五项关键字段（人员登记尚无值班时段，标注为未排班）。
  if (!name) {
    builder.add('validate', { status: 'failed', detail: '人员登记校验', error: '姓名不能为空' })
    return finalizeChain(builder, { registration, crewCode, crewName: name || '(未填写)', team: team || FALLBACK_TEAM, event: '登记人员', resultStatus: '待排班' })
  }
  if (!position) {
    builder.add('validate', { status: 'failed', detail: '人员登记校验', error: '岗位类别不能为空' })
    return finalizeChain(builder, { registration, crewCode, crewName: name, team: team || FALLBACK_TEAM, event: '登记人员', resultStatus: '待排班' })
  }
  // 新数据必须有明确班组归属，不再产生缺归属数据；缺归属只用于兼容历史。
  if (!team) {
    builder.add('validate', {
      status: 'failed',
      detail: '人员登记校验',
      error: '所属班组不能为空（历史缺归属数据按兼容口径保留，新登记必须指派班组）',
    })
    return finalizeChain(builder, { registration, crewCode, crewName: name, team: FALLBACK_TEAM, event: '登记人员', resultStatus: '待排班' })
  }
  if (rows.some((row) => String(row['人员编号']) === crewCode)) {
    builder.add('validate', { status: 'failed', detail: '人员登记校验', error: `人员编号 ${crewCode} 已存在` })
    return finalizeChain(builder, { registration, crewCode, crewName: name, team, event: '登记人员', resultStatus: '待排班' })
  }
  builder.add('validate', {
    status: 'success',
    detail: `已读取：人员编号 ${crewCode} / 姓名 ${name} / 岗位类别 ${position} / 所属班组 ${team} / 在岗状态 待排班`,
  })
  // 人员登记不占值班时段，裁决环节留痕并说明。
  builder.add('arbitrate', { status: 'success', detail: '登记人员不占用值班时段，无需冲突裁决' })

  const row: EntryRow = {
    id: nextId(rows),
    status: '待排班',
    pending: true,
    abnormal: false,
    _migrationVersion: DATA_VERSION,
    人员编号: crewCode,
    姓名: name,
    岗位类别: position,
    所属班组: team,
    排班日期: '',
    值班时段: '',
    在岗状态: '待排班',
    联络方式: contact,
    登记时间: formatTime(nowIso()),
    登记顺序: registration.order,
    链路编号: registration.serial,
  }
  try {
    saveRows(CREW_KEY, [...rows, row])
    builder.add('writeback', { status: 'success', detail: `地勤人员 ${crewCode} 已登记，在岗状态「待排班」` })
    builder.add('emergency', { status: 'success', detail: '尚未排班，暂不生成应急保障待办' })
  } catch (error) {
    builder.add('writeback', {
      status: 'failed',
      detail: '地勤人员登记写库失败',
      error: error instanceof Error ? error.message : '未知错误',
    })
    builder.add('emergency', { status: 'failed', detail: '排班写回未完成，应急待办不生成', error: '前置环节失败' })
  }

  const result = finalizeChain(builder, { registration, crewCode, crewName: name, team, event: '登记人员', resultStatus: '待排班' })
  return result.ok ? { ...result, message: `地勤人员 ${name}（${crewCode}）登记成功` } : result
}

/** 安排排班：同一人员重叠时段并发登记，只有首个成功；冲突时以先登记结果为准。 */
export function submitSchedule(input: ScheduleInput): CrewOperationResult {
  const registration = claimRegistration()
  const builder = new ChainBuilder()
  const crewRows = listRows(CREW_KEY)
  const emergencyRows = listRows(EMERGENCY_KEY)
  const target = findRow(crewRows, input.personId)

  if (!target) {
    builder.add('validate', { status: 'failed', detail: '排班登记校验', error: `没有找到编号为 ${input.personId} 的地勤人员` })
    return finalizeChain(builder, {
      registration,
      crewCode: `#${input.personId}`,
      crewName: '(未知)',
      team: FALLBACK_TEAM,
      event: '安排排班',
      resultStatus: '待排班',
    })
  }
  const info = baseRowInfo(target)

  // 环节①：读懂人员编号、岗位类别、所属班组、值班时段、在岗状态。
  let slot: SlotRange
  try {
    slot = parseSlot(input.date, input.startTime, input.endTime)
  } catch (error) {
    builder.add('validate', {
      status: 'failed',
      detail: `读取 ${info.crewCode} 的值班时段`,
      error: error instanceof Error ? error.message : '值班时段不合法',
    })
    return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: String(target.status) })
  }
  if (rowIsLegacy(target)) {
    // 缺班组归属的既有数据按兼容口径仍可排班，但必须显式提示。
    builder.add('validate', {
      status: 'success',
      detail: `兼容口径：人员 ${info.crewCode}（${info.crewName}）所属班组缺失，已按「${FALLBACK_TEAM}」迁移，排班前建议重新指派班组；值班时段 ${input.date} ${input.startTime}-${input.endTime}；当前在岗状态「${String(target.status)}」`,
    })
  } else {
    builder.add('validate', {
      status: 'success',
      detail: `已读取：人员编号 ${info.crewCode} / 岗位类别 ${String(target['岗位类别'])} / 所属班组 ${info.team} / 值班时段 ${input.date} ${input.startTime}-${input.endTime} / 在岗状态 ${String(target.status)}`,
    })
  }

  if (String(target.status) === '在岗') {
    builder.add('arbitrate', {
      status: 'failed',
      detail: '在岗状态校验',
      error: `${info.crewCode} 当前在岗，不能重复安排排班；如需换人请走交接班`,
    })
    return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: '在岗' })
  }

  // 环节②：冲突裁决。同一人员已有生效排班（已排班/在岗）即视为先登记结果：
  // 同日时段重叠 → 后登记失败（以先登记为准）；同日不重叠/换日 → 视为改排，允许。
  const conflict = crewRows.find(
    (row) =>
      String(row['人员编号']) === info.crewCode &&
      ['已排班', '在岗'].includes(String(row.status)) &&
      overlapsOnDate(row, input.date, slot),
  )
  if (conflict) {
    builder.add('arbitrate', {
      status: 'failed',
      detail: '值班时段冲突裁决（先登记优先）',
      error: `与先登记的排班 #${conflict.id}（${String(conflict['排班日期'])} ${String(conflict['值班时段'])}，状态「${String(conflict.status)}」，登记顺序 ${String(conflict['登记顺序'] ?? '未知')}）重叠，以先登记结果为准，本次并发登记失败`,
    })
    return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: String(target.status) })
  }
  builder.add('arbitrate', {
    status: 'success',
    detail: `未发现 ${info.crewCode} 在 ${input.date} ${input.startTime}-${input.endTime} 的重叠排班；本次登记顺序 ${registration.order}，并发冲突按先登记者获胜裁决`,
  })

  // 关联应急待办校验（若指定）。
  let linkedTodo: EntryRow | undefined
  if (input.emergencyTodoId !== undefined) {
    linkedTodo = findRow(emergencyRows, input.emergencyTodoId)
    if (!linkedTodo) {
      builder.add('emergency', {
        status: 'failed',
        detail: '读取关联应急待办',
        error: `没有找到编号为 ${input.emergencyTodoId} 的应急保障待办`,
      })
      return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: String(target.status) })
    }
    if (!['待响应', '响应中'].includes(String(linkedTodo.status))) {
      builder.add('emergency', {
        status: 'failed',
        detail: '读取关联应急待办',
        error: `应急待办 ${String(linkedTodo['应急编号'])} 已为「${String(linkedTodo.status)}」，不能再挂接排班`,
      })
      return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: String(target.status) })
    }
  }

  // 环节③④ 同一事务准备工作副本。
  const slotText = `${input.startTime}-${input.endTime}`
  const updated: EntryRow = {
    ...target,
    _migrationVersion: DATA_VERSION,
    status: '已排班',
    pending: true,
    排班日期: input.date,
    值班时段: slotText,
    在岗状态: '已排班',
    登记时间: formatTime(nowIso()),
    登记顺序: registration.order,
    链路编号: registration.serial,
  }

  let nextEmergency: EntryRow[]
  if (linkedTodo) {
    const todoUpdated: EntryRow = {
      ...linkedTodo,
      status: '响应中',
      pending: true,
      响应人员: `${info.crewCode} ${info.crewName}`,
      处置措施: appendMeasure(
        String(linkedTodo['处置措施'] ?? ''),
        `排班写回：${info.crewCode} 已排入 ${input.date} ${slotText}（链路 ${registration.serial}）`,
      ),
      当前排班行编号: Number(target.id),
    }
    nextEmergency = emergencyRows.map((row) => (Number(row.id) === Number(linkedTodo!.id) ? todoUpdated : row))
    updated['关联应急编号'] = String(linkedTodo['应急编号'])
  } else {
    // 未指定应急待办：按排班结果新建一条应急保障待办，值班期间联动处置。
    const created: EntryRow = {
      id: nextId(emergencyRows),
      status: '待响应',
      pending: true,
      abnormal: false,
      应急编号: nextEmergencyCode(emergencyRows),
      事件类型: '排班保障',
      涉及航班: '—',
      事发位置: info.team,
      响应等级: '常规',
      响应人员: `${info.crewCode} ${info.crewName}`,
      处置措施: `排班写回：${info.crewName} 已排入 ${input.date} ${slotText}（链路 ${registration.serial}），值班待命中`,
      应急状态: '待响应',
      来源链路: registration.serial,
      排班行编号: Number(target.id),
      当前排班行编号: Number(target.id),
    }
    nextEmergency = [...emergencyRows, created]
    updated['关联应急编号'] = String(created['应急编号'])
  }

  const nextCrew = crewRows.map((row) => (Number(row.id) === Number(target.id) ? updated : row))

  try {
    commit({ crewRows: nextCrew, emergencyRows: nextEmergency })
  } catch (error) {
    builder.add('writeback', {
      status: 'failed',
      detail: '排班结果与应急待办同一事务写回',
      error: error instanceof Error ? error.message : '未知错误',
    })
    return finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: String(target.status) })
  }
  builder.add('writeback', {
    status: 'success',
    detail: `${info.crewCode} 排班结果已写入：${input.date} ${slotText}，在岗状态「已排班」，登记顺序 ${registration.order}`,
  })
  builder.add('emergency', {
    status: 'success',
    detail: linkedTodo
      ? `排班结果已写回应急待办 ${String(linkedTodo['应急编号'])}，响应人员同步为 ${info.crewCode}`
      : `已按排班结果新建应急保障待办 ${String(updated['关联应急编号'])}`,
  })

  const result = finalizeChain(builder, { ...info, registration, event: '安排排班', resultStatus: '已排班' })
  return result.ok
    ? { ...result, message: `${info.crewName} 已排入 ${input.date} ${slotText}，排班结果已写回应急保障待办` }
    : result
}

/** 确认在岗：同步刷新关联应急待办的处置措施。 */
export function confirmOnDuty(rowId: number): CrewOperationResult {
  const registration = claimRegistration()
  const builder = new ChainBuilder()
  const crewRows = listRows(CREW_KEY)
  const emergencyRows = listRows(EMERGENCY_KEY)
  const target = findRow(crewRows, rowId)
  if (!target) {
    builder.add('validate', { status: 'failed', detail: '到岗确认校验', error: `没有找到排班 #${rowId}` })
    return finalizeChain(builder, {
      registration,
      crewCode: `#${rowId}`,
      crewName: '(未知)',
      team: FALLBACK_TEAM,
      event: '确认在岗',
      resultStatus: '已排班',
    })
  }
  const info = baseRowInfo(target)
  if (String(target.status) !== '已排班') {
    builder.add('validate', {
      status: 'failed',
      detail: '到岗确认校验',
      error: `只有「已排班」可以确认在岗，#${target.id} 当前为「${String(target.status)}」`,
    })
    return finalizeChain(builder, { ...info, registration, event: '确认在岗', resultStatus: String(target.status) })
  }
  builder.add('validate', {
    status: 'success',
    detail: `已读取：${info.crewCode} ${info.crewName} / 岗位类别 ${String(target['岗位类别'])} / 所属班组 ${info.team} / 值班时段 ${String(target['排班日期'])} ${String(target['值班时段'])}，在岗状态由「已排班」转「在岗」`,
  })
  builder.add('arbitrate', { status: 'success', detail: '到岗确认不改变值班时段，无需冲突裁决' })

  const at = formatTime(nowIso())
  const updated: EntryRow = {
    ...target,
    _migrationVersion: DATA_VERSION,
    status: '在岗',
    pending: false,
    在岗状态: '在岗',
    到岗时间: at,
  }
  const linkedCode = String(target['关联应急编号'] ?? '')
  let emergencyChanged = false
  const nextEmergency = emergencyRows.map((row) => {
    if (linkedCode && String(row['应急编号']) === linkedCode) {
      emergencyChanged = true
      return {
        ...row,
        status: '响应中',
        pending: true,
        处置措施: appendMeasure(String(row['处置措施'] ?? ''), `人员到岗：${info.crewCode} 于 ${at} 确认在岗（链路 ${registration.serial}）`),
      }
    }
    return row
  })
  if (linkedCode && !emergencyChanged) {
    builder.add('emergency', {
      status: 'failed',
      detail: '应急待办写回',
      error: `排班关联的应急待办 ${linkedCode} 已不存在，到岗确认无法写回（链路错误不静默跳过）`,
    })
    return finalizeChain(builder, { ...info, registration, event: '确认在岗', resultStatus: '已排班' })
  }

  const nextCrew = crewRows.map((row) => (Number(row.id) === Number(target.id) ? updated : row))
  try {
    commit({ crewRows: nextCrew, emergencyRows: nextEmergency })
  } catch (error) {
    builder.add('writeback', {
      status: 'failed',
      detail: '到岗确认写回（排班/应急同一事务）',
      error: error instanceof Error ? error.message : '未知错误',
    })
    return finalizeChain(builder, { ...info, registration, event: '确认在岗', resultStatus: '已排班' })
  }
  builder.add('writeback', { status: 'success', detail: `${info.crewCode} 已到岗，在岗状态「在岗」，到岗时间 ${at}` })
  builder.add('emergency', {
    status: 'success',
    detail: linkedCode ? `应急待办 ${linkedCode} 已追加到岗处置记录` : '本班次未关联应急待办，无需写回',
  })

  const result = finalizeChain(builder, { ...info, registration, event: '确认在岗', resultStatus: '在岗' })
  return result.ok ? { ...result, message: `${info.crewName} 已确认在岗` } : result
}

/** 交接班：接班人的排班同时生效（先通过重叠时段裁决），应急待办响应人改挂接班人。 */
export function handover(input: HandoverInput): CrewOperationResult {
  const registration = claimRegistration()
  const builder = new ChainBuilder()
  const crewRows = listRows(CREW_KEY)
  const emergencyRows = listRows(EMERGENCY_KEY)
  const fromRow = findRow(crewRows, input.fromRowId)
  const successor = findRow(crewRows, input.successorId)

  if (!fromRow) {
    builder.add('validate', { status: 'failed', detail: '交接班校验', error: `没有找到交班排班 #${input.fromRowId}` })
    return finalizeChain(builder, {
      registration,
      crewCode: `#${input.fromRowId}`,
      crewName: '(未知)',
      team: FALLBACK_TEAM,
      event: '交接班',
      resultStatus: '在岗',
    })
  }
  const info = baseRowInfo(fromRow)
  if (String(fromRow.status) !== '在岗') {
    builder.add('validate', {
      status: 'failed',
      detail: '交接班校验',
      error: `只有在岗排班可以交班，#${fromRow.id} 当前为「${String(fromRow.status)}」`,
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: String(fromRow.status) })
  }
  if (!successor || Number(successor.id) === Number(fromRow.id)) {
    builder.add('validate', { status: 'failed', detail: '交接班校验', error: '必须指定不同的接班人' })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }
  const successorInfo = baseRowInfo(successor)
  if (String(successor.status) === '在岗') {
    builder.add('validate', {
      status: 'failed',
      detail: '交接班校验',
      error: `接班人 ${successorInfo.crewCode} 当前已在岗，不能重复接班`,
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }
  if (String(successor.status) === '已排班') {
    builder.add('validate', {
      status: 'failed',
      detail: '交接班校验',
      error: `接班人 ${successorInfo.crewCode} 已有生效排班（已排班），请先解除其排班或另选人员`,
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }

  builder.add('validate', {
    status: 'success',
    detail: `交班 ${info.crewCode}（${info.crewName}，${info.team}，${String(fromRow['岗位类别'])}）→ 接班 ${successorInfo.crewCode}（${successorInfo.crewName}，${successorInfo.team}）；接班值班时段 ${String(fromRow['排班日期'])} ${String(fromRow['值班时段'])}；事由：${input.reason.trim() || '未填'}`,
  })

  // 接班人沿用交班人的日期与时段，必须先通过同一套重叠裁决（先登记优先）。
  const date = String(fromRow['排班日期'] ?? '')
  const currentSlot = rowSlot(fromRow)
  if (!currentSlot) {
    builder.add('arbitrate', {
      status: 'failed',
      detail: '接班人冲突裁决',
      error: '交班班次的值班时段无法解析，不能为接班人裁决重叠时段',
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }
  const conflict = crewRows.find(
    (row) =>
      Number(row.id) !== Number(successor.id) &&
      String(row['人员编号']) === successorInfo.crewCode &&
      ['已排班', '在岗'].includes(String(row.status)) &&
      overlapsOnDate(row, date, currentSlot),
  )
  if (conflict) {
    builder.add('arbitrate', {
      status: 'failed',
      detail: '接班人值班时段冲突裁决（先登记优先）',
      error: `接班人 ${successorInfo.crewCode} 与先登记的排班 #${conflict.id}（${String(conflict['排班日期'])} ${String(conflict['值班时段'])}）重叠，以先登记结果为准，交接班失败`,
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }
  builder.add('arbitrate', {
    status: 'success',
    detail: `接班人 ${successorInfo.crewCode} 在 ${date} ${String(fromRow['值班时段'])} 无重叠排班，裁决通过，登记顺序 ${registration.order}`,
  })

  const handoverAt = formatTime(nowIso())

  // 交班人：按历史离岗规则登记离岗（终态，不再做冲突检查）。
  const fromUpdated: EntryRow = {
    ...fromRow,
    _migrationVersion: DATA_VERSION,
    status: FINAL_STATUS,
    pending: false,
    在岗状态: FINAL_STATUS,
    离岗时间: handoverAt,
    交接去向: `交班给 ${successorInfo.crewCode} ${successorInfo.crewName}`,
    交接链路: registration.serial,
  }
  // 接班人：排入同一时段并直接到岗。
  const successorUpdated: EntryRow = {
    ...successor,
    _migrationVersion: DATA_VERSION,
    status: '在岗',
    pending: false,
    排班日期: date,
    值班时段: String(fromRow['值班时段']),
    在岗状态: '在岗',
    接班自: `${info.crewCode} ${info.crewName} #${fromRow.id}`,
    接班时间: handoverAt,
    登记时间: handoverAt,
    登记顺序: registration.order,
    链路编号: registration.serial,
    关联应急编号: fromRow['关联应急编号'] ?? '',
  }

  // 应急待办：响应人改挂接班人，处置措施追加交接记录。
  const linkedCode = String(fromRow['关联应急编号'] ?? '')
  let emergencyChanged = false
  const nextEmergency = emergencyRows.map((row) => {
    if (linkedCode && String(row['应急编号']) === linkedCode) {
      emergencyChanged = true
      return {
        ...row,
        status: '响应中',
        pending: true,
        响应人员: `${successorInfo.crewCode} ${successorInfo.crewName}`,
        处置措施: appendMeasure(
          String(row['处置措施'] ?? ''),
          `交接班：${info.crewCode} → ${successorInfo.crewCode}（${handoverAt}，链路 ${registration.serial}）`,
        ),
        当前排班行编号: Number(successor.id),
      }
    }
    return row
  })
  if (linkedCode && !emergencyChanged) {
    builder.add('emergency', {
      status: 'failed',
      detail: '应急待办写回',
      error: `关联应急待办 ${linkedCode} 已不存在，交接班无法写回（链路错误不静默跳过）`,
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }

  const nextCrew = crewRows.map((row) => {
    if (Number(row.id) === Number(fromRow.id)) {
      return fromUpdated
    }
    if (Number(row.id) === Number(successor.id)) {
      return successorUpdated
    }
    return row
  })

  try {
    commit({ crewRows: nextCrew, emergencyRows: nextEmergency })
  } catch (error) {
    builder.add('writeback', {
      status: 'failed',
      detail: '交接班写回（交班离岗/接班到岗/应急待办同一事务）',
      error: error instanceof Error ? error.message : '未知错误',
    })
    return finalizeChain(builder, { ...info, registration, event: '交接班', resultStatus: '在岗' })
  }
  builder.add('writeback', {
    status: 'success',
    detail: `交班人 ${info.crewCode} 已离岗；接班人 ${successorInfo.crewCode} 已排入 ${date} ${String(fromRow['值班时段'])} 并到岗`,
  })
  builder.add('emergency', {
    status: 'success',
    detail: linkedCode
      ? `应急待办 ${linkedCode} 响应人已改挂 ${successorInfo.crewCode}，处置措施已追加交接记录`
      : '交班班次未关联应急待办，无需写回',
  })

  const result = finalizeChain(builder, {
    ...info,
    registration,
    event: '交接班',
    resultStatus: FINAL_STATUS,
    successorCode: successorInfo.crewCode,
    successorName: successorInfo.crewName,
  })
  return result.ok ? { ...result, message: `交接班完成：${info.crewName} → ${successorInfo.crewName}，应急待办已同步` } : result
}

/** 登记离岗：历史离岗规则保持不变（直接终态、不做冲突检查），但要写回应急待办并留链路。 */
export function registerOffDuty(input: OffDutyInput): CrewOperationResult {
  const registration = claimRegistration()
  const builder = new ChainBuilder()
  const crewRows = listRows(CREW_KEY)
  const emergencyRows = listRows(EMERGENCY_KEY)
  const target = findRow(crewRows, input.rowId)
  if (!target) {
    builder.add('validate', { status: 'failed', detail: '离岗登记校验', error: `没有找到排班 #${input.rowId}` })
    return finalizeChain(builder, {
      registration,
      crewCode: `#${input.rowId}`,
      crewName: '(未知)',
      team: FALLBACK_TEAM,
      event: '登记离岗',
      resultStatus: '在岗',
    })
  }
  const info = baseRowInfo(target)
  const current = String(target.status)
  if (current === FINAL_STATUS) {
    // 历史离岗记录保持原规则：不重跑校验、不改写、不重新裁决，拒绝重复操作。
    builder.add('validate', {
      status: 'failed',
      detail: '离岗登记校验（历史离岗规则）',
      error: `#${target.id} 已是历史离岗记录，按原规则保持不变，不重复登记`,
    })
    return finalizeChain(builder, { ...info, registration, event: '登记离岗', resultStatus: FINAL_STATUS })
  }
  if (current !== '在岗' && current !== '已排班') {
    builder.add('validate', {
      status: 'failed',
      detail: '离岗登记校验',
      error: `当前在岗状态「${current}」不能登记离岗`,
    })
    return finalizeChain(builder, { ...info, registration, event: '登记离岗', resultStatus: current })
  }

  // 历史离岗规则：直接终态，不做值班时段冲突检查（离岗只会释放时段）。
  builder.add('validate', {
    status: 'success',
    detail: `已读取：人员编号 ${info.crewCode} / 岗位类别 ${String(target['岗位类别'])} / 所属班组 ${info.team} / 值班时段 ${String(target['排班日期'])} ${String(target['值班时段'])} / 在岗状态「${current}」，离岗备注：${input.note.trim() || '无'}`,
  })
  builder.add('arbitrate', { status: 'success', detail: '按历史离岗规则，离岗直接终态生效，不做冲突裁决' })

  const at = formatTime(nowIso())
  const updated: EntryRow = {
    ...target,
    _migrationVersion: DATA_VERSION,
    status: FINAL_STATUS,
    pending: false,
    在岗状态: FINAL_STATUS,
    离岗时间: at,
    离岗备注: input.note.trim(),
  }
  const linkedCode = String(target['关联应急编号'] ?? '')
  let emergencyChanged = false
  const nextEmergency = emergencyRows.map((row) => {
    if (linkedCode && String(row['应急编号']) === linkedCode) {
      emergencyChanged = true
      return {
        ...row,
        status: '已解除',
        pending: false,
        应急状态: '已解除',
        处置措施: appendMeasure(
          String(row['处置措施'] ?? ''),
          `人员离岗：${info.crewCode} 于 ${at} 登记离岗（链路 ${registration.serial}），应急保障待办闭环`,
        ),
      }
    }
    return row
  })
  if (linkedCode && !emergencyChanged) {
    builder.add('emergency', {
      status: 'failed',
      detail: '应急待办写回',
      error: `排班关联的应急待办 ${linkedCode} 已不存在，离岗结果无法写回（链路错误不静默跳过）`,
    })
    return finalizeChain(builder, { ...info, registration, event: '登记离岗', resultStatus: current })
  }

  const nextCrew = crewRows.map((row) => (Number(row.id) === Number(target.id) ? updated : row))
  try {
    commit({ crewRows: nextCrew, emergencyRows: nextEmergency })
  } catch (error) {
    builder.add('writeback', {
      status: 'failed',
      detail: '离岗登记写回（排班/应急同一事务）',
      error: error instanceof Error ? error.message : '未知错误',
    })
    return finalizeChain(builder, { ...info, registration, event: '登记离岗', resultStatus: current })
  }
  builder.add('writeback', { status: 'success', detail: `${info.crewCode} 已离岗（历史离岗规则），离岗时间 ${at}` })
  builder.add('emergency', {
    status: 'success',
    detail: linkedCode ? `应急待办 ${linkedCode} 已随离岗解除并闭环` : '本班次未关联应急待办，无需写回',
  })

  const result = finalizeChain(builder, { ...info, registration, event: '登记离岗', resultStatus: FINAL_STATUS })
  return result.ok ? { ...result, message: `${info.crewName} 已登记离岗，关联应急待办已闭环` } : result
}

/* ------------------------------------------------------------------ */
/* 页面查询辅助                                                        */
/* ------------------------------------------------------------------ */

/** 可挂接的应急待办（待响应优先，响应中表示已有人挂接，仍允许改挂）。 */
export function availableEmergencyTodos(): EntryRow[] {
  return listRows(EMERGENCY_KEY).filter((row) => ['待响应', '响应中'].includes(String(row.status)))
}

/** 供页面刷新统计使用：直接读数据层。 */
export function crewRows(): EntryRow[] {
  return listRows(CREW_KEY)
}

export function emergencyRowsView(): EntryRow[] {
  return listRows(EMERGENCY_KEY)
}
