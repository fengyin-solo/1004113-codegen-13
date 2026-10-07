import { listRows, saveRows } from '@/data/local-store'
import type {
  ChainStage,
  EntryRow,
  FlowNode,
  HandoverChain,
  ScheduleChangeOutcome,
  ScheduleRequest,
  TeamMigrationReport,
} from '@/data/types'

// 地勤排班交接链路：领域服务。
// 约定：链路上的任何环节异常都不允许静默跳过——
//   error 立即阻断本次变更并把原因写进链路；warn 兼容放行但必须在结果里显式提示。

export const CREW_KEY = 'crew_schedule'
export const EMERGENCY_KEY = 'air_emergency'
const CHAINS_STORAGE_KEY = 'airport-ground-handling:crew-handover-chains'
export const FALLBACK_TEAM = '未归属班组（兼容迁移）'

// 三类变更各自经过的环节，静态流程图与动态链路都以这里为准。
export const FLOW_DEFINITIONS: Record<HandoverChain['action'], FlowNode[]> = {
  安排排班: [
    { key: 'read', label: '读取人员档案' },
    { key: 'parse', label: '解析值班时段' },
    { key: 'check-team', label: '校验班组归属' },
    { key: 'check-overlap', label: '重叠时段判定' },
    { key: 'write-schedule', label: '写回排班结果' },
    { key: 'write-todo', label: '回写应急保障待办' },
    { key: 'record-chain', label: '交接链路留痕' },
  ],
  确认在岗: [
    { key: 'read', label: '读取人员档案' },
    { key: 'check-status', label: '校验在岗状态' },
    { key: 'write-schedule', label: '写回在岗结果' },
    { key: 'sync-todo', label: '同步应急待办' },
    { key: 'record-chain', label: '交接链路留痕' },
  ],
  登记离岗: [
    { key: 'read', label: '读取人员档案' },
    { key: 'check-status', label: '校验在岗状态' },
    { key: 'write-schedule', label: '写回离岗结果' },
    { key: 'sync-todo', label: '同步应急待办' },
    { key: 'record-chain', label: '交接链路留痕' },
  ],
}

// 环节执行失败时抛出：携带环节名，由链路编排器捕获并写进链路，绝不静默。
class StageError extends Error {
  constructor(
    public stage: string,
    message: string,
  ) {
    super(message)
    this.name = 'StageError'
  }
}

// ---- 时间 / 时段 ----

// 值班时段统一按「HH:MM-HH:MM」解析；跨夜班用 24 小时以上的分钟数表示（如 22:00-02:00）。
export function parsePeriod(period: string): { startMin: number; endMin: number; label: string } {
  const match = /^\s*(\d{1,2}):(\d{2})\s*[-~～]\s*(\d{1,2}):(\d{2})\s*$/.exec(period)
  if (!match) {
    throw new StageError(
      '解析值班时段',
      `值班时段「${period || '空'}」格式无法识别，应为 HH:MM-HH:MM（支持跨夜班，如 22:00-02:00）`,
    )
  }
  const toMin = (h: string, m: string) => Number(h) * 60 + Number(m)
  let startMin = toMin(match[1], match[2])
  let endMin = toMin(match[3], match[4])
  if (endMin <= startMin) {
    endMin += 24 * 60
  }
  return { startMin, endMin, label: period.trim() }
}

// 把「排班日期 + 时段」换算成绝对分钟区间，跨夜班天然落在同一天的时间轴上。
export function toAbsoluteRange(date: string, period: string): { start: number; end: number } {
  const day = Number(Date.parse(`${date}T00:00:00`))
  if (Number.isNaN(day)) {
    throw new StageError('解析值班时段', `排班日期「${date || '空'}」无法识别，应为 YYYY-MM-DD`)
  }
  const { startMin, endMin } = parsePeriod(period)
  return { start: day / 60000 + startMin, end: day / 60000 + endMin }
}

// 端点相接不算重叠（前班 14:00 收、后班 14:00 上是合法连班）。
export function isOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

// ---- 人员档案（先读懂五要素）----

export type CrewProfile = {
  row: EntryRow
  personNo: string
  post: string
  team: string
  teamFallback: boolean
  status: string
}

// 人员编号、岗位类别、所属班组、在岗状态是排班链路的必填项，缺一项都要显式报错。
export function readCrewProfile(crewId: number): CrewProfile {
  const rows = listRows(CREW_KEY)
  const row = rows.find((item) => Number(item.id) === crewId)
  if (!row) {
    throw new StageError('读取人员档案', `没有找到编号为 ${crewId} 的地勤人员`)
  }
  const personNo = String(row['人员编号'] ?? '').trim()
  if (!personNo) {
    throw new StageError('读取人员档案', `记录 ${crewId} 缺少人员编号，无法进入排班链路`)
  }
  const post = String(row['岗位类别'] ?? '').trim()
  if (!post) {
    throw new StageError('读取人员档案', `${personNo} 缺少岗位类别，无法安排排班`)
  }
  let teamFallback = false
  let team = String(row['所属班组'] ?? '').trim()
  if (!team) {
    // 兼容口径：缺班组归属的既有数据不阻断链路，按兜底班组迁移并显式 warn。
    team = FALLBACK_TEAM
    teamFallback = true
  }
  const status = String(row.status ?? '').trim()
  if (!status) {
    throw new StageError('读取人员档案', `${personNo} 缺少在岗状态，链路无法判定当前环节`)
  }
  return { row, personNo, post, team, teamFallback, status }
}

// ---- 交接链路留痕 ----

let memoryChains: HandoverChain[] = []

function readChains(): HandoverChain[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return memoryChains
  }
  const raw = window.localStorage.getItem(CHAINS_STORAGE_KEY)
  if (!raw) {
    memoryChains = []
    return memoryChains
  }
  try {
    memoryChains = JSON.parse(raw) as HandoverChain[]
    return memoryChains
  } catch (error) {
    // 链路台账损坏属于链路错误，不能静默：本笔仍然显式上抛，由调用方提示。
    throw new StageError(
      '交接链路留痕',
      `交接链路台账解析失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function appendChain(chain: HandoverChain): void {
  const chains = [...readChains(), chain]
  memoryChains = chains
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHAINS_STORAGE_KEY, JSON.stringify(chains))
  }
}

export function listChains(crewId?: number): HandoverChain[] {
  const chains = readChains()
  const filtered = typeof crewId === 'number' ? chains.filter((item) => item.crewId === crewId) : chains
  return [...filtered].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

function formatTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

function newChainId(registeredAt: Date, seq: number): string {
  return `HAND-${String(registeredAt.getTime()).slice(-8)}-${String(seq).padStart(2, '0')}`
}

// 链路编排器：按定义的环节顺序执行，每个环节都留痕；error 阻断、warn 以黄色节点显式标出。
class ChainBuilder {
  private stages: ChainStage[] = []
  constructor(
    private definitions: FlowNode[],
    private seq: number,
  ) {}

  // 执行一个环节：fn 抛 StageError 记 error 并继续抛出；抛其它错误同样视为链路错误，不许静默。
  run(name: string, fn: () => string): void {
    try {
      const detail = fn()
      this.stages.push({ name, status: 'ok', detail, seq: this.seq })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.stages.push({ name, status: 'error', detail, seq: this.seq })
      throw error instanceof StageError ? error : new StageError(name, detail)
    }
  }

  // 把刚通过的环节改标为 warn：兼容口径下放行，但必须在图上和结果里显式提示。
  markWarn(name: string, detail: string): void {
    const stage = [...this.stages].reverse().find((item) => item.name === name)
    if (stage) {
      stage.status = 'warn'
      stage.detail = detail
    }
  }

  result(): ChainStage[] {
    return this.stages
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function buildTodo(
  profile: CrewProfile,
  date: string,
  period: string,
  emergencyRows: EntryRow[],
  action: HandoverChain['action'],
  sourceId: string,
): EntryRow {
  const summaryMap: Record<HandoverChain['action'], string> = {
    安排排班: '到岗待命',
    确认在岗: '在岗期间应急联络保障',
    登记离岗: '离岗交接复核',
  }
  return {
    id: nextId(emergencyRows),
    status: '待响应',
    pending: true,
    abnormal: false,
    应急编号: `AIR-EMG-${String(Date.now()).slice(-6)}-${sourceId.slice(-4)}`,
    事件类型: `排班联动·${action}`,
    涉及航班: '—',
    事发位置: profile.team,
    响应等级: '班组级',
    响应人员: `${profile.personNo} ${String(profile.row['姓名'] ?? '')}`.trim(),
    处置措施: `${profile.post}｜${date} ${period}｜${summaryMap[action]}`,
    应急状态: '待响应',
    来源: '地勤排班',
    来源链路: sourceId,
    排班日期: date,
    值班时段: period,
  }
}

type ParsedRange = { row: EntryRow; start: number; end: number; dirty: boolean }

// 当前仍占用时段的排班：已排班、在岗（含本人已登记窗口与本批更早成功的登记）；
// 历史离岗记录保持原规则，不参与冲突判定。
// 返回 dirty 标记：历史脏数据时段无法解析时不能静默吞掉，要交给链路显式 warn。
function activeRanges(rows: EntryRow[]): ParsedRange[] {
  const ranges: ParsedRange[] = []
  for (const row of rows) {
    const status = String(row.status ?? '')
    if (status !== '已排班' && status !== '在岗') {
      continue
    }
    const date = String(row['排班日期'] ?? '')
    const period = String(row['值班时段'] ?? '')
    if (!date || !period) {
      ranges.push({ row, start: NaN, end: NaN, dirty: true })
      continue
    }
    try {
      ranges.push({ row, ...toAbsoluteRange(date, period), dirty: false })
    } catch {
      ranges.push({ row, start: NaN, end: NaN, dirty: true })
    }
  }
  return ranges
}

// ---- 安排排班（支持同批并发多笔，首个登记者胜）----

function scheduleOne(
  request: ScheduleRequest,
  ctx: { registeredAt: Date; crewRows: EntryRow[]; emergencyRows: EntryRow[]; chains: HandoverChain[] },
): { crewRow: EntryRow; todo: EntryRow; chain: HandoverChain } {
  const definitions = FLOW_DEFINITIONS['安排排班']
  const builder = new ChainBuilder(definitions, request.seq)
  const chainId = newChainId(ctx.registeredAt, request.seq)
  let profile: CrewProfile | null = null
  let todo: EntryRow | null = null
  let updated: EntryRow | null = null

  const buildChain = (success: boolean): HandoverChain => ({
    id: chainId,
    crewId: request.crewId,
    personNo: profile?.personNo ?? String(request.crewId),
    name: String(profile?.row['姓名'] ?? ''),
    action: '安排排班',
    success,
    startedAt: formatTime(ctx.registeredAt),
    finishedAt: formatTime(new Date()),
    stages: builder.result(),
  })

  try {
    builder.run('读取人员档案', () => {
      profile = readCrewProfile(request.crewId)
      return `人员编号 ${profile.personNo}｜岗位类别「${profile.post}」｜所属班组「${profile.team}」｜在岗状态「${profile.status}」`
    })
    const p: CrewProfile = profile!

    builder.run('解析值班时段', () => {
      toAbsoluteRange(request.date, request.period)
      return `排班日期 ${request.date}，值班时段 ${request.period}，时段格式校验通过`
    })

    builder.run('校验班组归属', () => `所属班组「${p.team}」，岗位类别「${p.post}」，归属有效`)
    if (p.teamFallback) {
      builder.markWarn(
        '校验班组归属',
        `该人员缺班组归属，已按兼容口径挂入「${FALLBACK_TEAM}」放行，请尽快补登正式班组`,
      )
    }

    builder.run('重叠时段判定', () => {
      const target = toAbsoluteRange(request.date, request.period)
      // 冲突只认同一人员：不同人员同一时段本就可以同班值班。
      const mine = activeRanges(ctx.crewRows).filter((item) => Number(item.row.id) === request.crewId)
      for (const item of mine.filter((range) => range.dirty)) {
        builder.markWarn(
          '重叠时段判定',
          `${p.personNo} 既有值班时段无法解析，已按历史数据跳过冲突判定，请补录`,
        )
      }
      // 本人活动窗口（此前已落库的已排班/在岗窗口，或本批并发中更早成功的登记）与本次请求重叠：
      // 以先登记结果为准，本次（后登记）阻断。历史离岗窗口不参与（activeRanges 已排除）。
      const conflict = mine
        .filter((item) => !item.dirty)
        .find((item) => isOverlap(target, item))
      if (conflict) {
        const inBatch = Boolean(conflict.row.__inBatch)
        throw new StageError(
          '重叠时段判定',
          `与 ${p.personNo} ${inBatch ? '本批第 ' + String(conflict.row['登记序号']) + ' 笔先登记' : '已登记'}` +
            `的 ${String(conflict.row['排班日期'])} ${String(
              conflict.row['值班时段'],
            )} 值班时段重叠，以先登记结果为准，本次（后登记）不予登记`,
        )
      }
      return `同人员并发占用检查通过，未与本人已排班/在岗时段重叠（历史离岗记录按原规则不参与判定；不限制其他人员同班）`
    })

    builder.run('写回排班结果', () => {
      if (p.status === '已排班') {
        throw new StageError('写回排班结果', `${p.personNo} 已是「已排班」，不用重复安排`)
      }
      if (p.status === '在岗') {
        throw new StageError('写回排班结果', `${p.personNo} 当前在岗，请先登记离岗后再排班`)
      }
      // 同一人员本批已有先登记成功的窗口（即便不重叠）：一人只保留一条在班窗口，
      // 后登记不能静默覆盖先登记，直接显式阻断。
      const alreadyInBatch = ctx.crewRows.find(
        (row) => Number(row.id) === request.crewId && '__inBatch' in row,
      )
      if (alreadyInBatch) {
        throw new StageError(
          '写回排班结果',
          `${p.personNo} 本批第 ${String(alreadyInBatch['登记序号'])} 笔排班已先登记成功，` +
            '同一人员只保留一条在班窗口，后登记请求不得覆盖，本次不予登记',
        )
      }
      updated = {
        ...p.row,
        status: '已排班',
        pending: true,
        排班日期: request.date,
        值班时段: request.period,
        在岗状态: '已排班',
        登记时间: formatTime(ctx.registeredAt),
        登记序号: request.seq,
        登记批次: chainId.replace(/-\d{2}$/, ''),
        链路编号: chainId,
        // 临时标记：仅用于本批并发的「首登者胜」判定，持久化前剥除。
        __inBatch: true,
      } as EntryRow
      return `排班结果已写回：${p.personNo} → 已排班（${request.date} ${request.period}），登记序号 ${request.seq}`
    })

    builder.run('回写应急保障待办', () => {
      todo = buildTodo(p, request.date, request.period, ctx.emergencyRows, '安排排班', chainId)
      return `已生成应急保障待办 ${String(todo['应急编号'])}（待响应），排班结果同步完成`
    })

    builder.run('交接链路留痕', () => `链路 ${chainId} 登记完成，共 ${definitions.length} 个环节`)

    const chain = buildChain(true)
    ctx.chains.push(chain)
    return { crewRow: updated!, todo: todo!, chain }
  } catch (error) {
    // 失败也要留痕：链路错误不能静默跳过。
    ctx.chains.push(buildChain(false))
    throw error
  }
}

// 提交排班：支持同批并发多笔。全部先在内存里按登记序号判定，
// 只有「首个」重叠请求成功；全部跑完后一次性持久化（任一笔都不做半套写入）。
export function submitSchedules(
  requests: ScheduleRequest[],
  now: Date = new Date(),
): ScheduleChangeOutcome[] {
  if (!requests.length) {
    throw new StageError('重叠时段判定', '没有收到任何排班请求')
  }
  // 快照用于失败回滚（map 克隆，缓存里的原数组不会被中途改动）。
  const crewSnapshot = listRows(CREW_KEY)
  const emergencySnapshot = listRows(EMERGENCY_KEY)
  const crewRows = crewSnapshot.map((row) => ({ ...row }))
  const emergencyRows = emergencySnapshot.map((row) => ({ ...row }))
  const chains: HandoverChain[] = []
  const ctx = { registeredAt: now, crewRows, emergencyRows, chains }
  const outcomes: ScheduleChangeOutcome[] = []

  requests.forEach((request, index) => {
    const seq = index + 1
    const chainId = newChainId(now, seq)
    let profile: CrewProfile
    try {
      profile = readCrewProfile(request.crewId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      chains.push({
        id: chainId,
        crewId: request.crewId,
        personNo: String(request.crewId),
        name: '',
        action: '安排排班',
        success: false,
        startedAt: formatTime(now),
        finishedAt: formatTime(new Date()),
        stages: [{ name: '读取人员档案', status: 'error', detail: message, seq }],
      })
      outcomes.push({
        ok: false,
        crewId: request.crewId,
        personNo: String(request.crewId),
        name: '',
        seq,
        chainId,
        message,
      })
      return
    }

    try {
      const result = scheduleOne({ ...request, seq }, ctx)
      const rowIndex = crewRows.findIndex((row) => Number(row.id) === request.crewId)
      crewRows[rowIndex] = result.crewRow
      emergencyRows.push(result.todo)
      const warns = result.chain.stages.filter((stage) => stage.status === 'warn')
      outcomes.push({
        ok: true,
        crewId: request.crewId,
        personNo: profile.personNo,
        name: String(profile.row['姓名'] ?? ''),
        seq,
        chainId: result.chain.id,
        message:
          `排班登记成功（链路 ${result.chain.id}，先登记结果已生效）` +
          (warns.length ? `；兼容提示：${warns.map((w) => w.detail).join('；')}` : ''),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcomes.push({
        ok: false,
        crewId: request.crewId,
        personNo: profile.personNo,
        name: String(profile.row['姓名'] ?? ''),
        seq,
        chainId,
        message,
      })
    }
  })

  // 统一持久化：排班结果与应急待办要么都落，失败则整批回滚快照。
  // __inBatch 只是本批并发的临时标记，落库前剥除，不写进数据。
  const persistedCrewRows = crewRows.map((row) => {
    if (!('__inBatch' in row)) {
      return row
    }
    const clean = { ...row }
    delete clean.__inBatch
    return clean
  })
  try {
    saveRows(CREW_KEY, persistedCrewRows)
    saveRows(EMERGENCY_KEY, emergencyRows)
  } catch (error) {
    saveRows(CREW_KEY, crewSnapshot)
    saveRows(EMERGENCY_KEY, emergencySnapshot)
    throw new StageError(
      '写回排班结果',
      `排班结果/应急待办持久化失败，已整批回滚：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  for (const chain of chains) {
    appendChain(chain)
  }
  return outcomes
}

// ---- 确认在岗 / 登记离岗 ----

function submitStatusChange(
  crewId: number,
  action: '确认在岗' | '登记离岗',
  now: Date,
): ScheduleChangeOutcome {
  const definitions = FLOW_DEFINITIONS[action]
  const builder = new ChainBuilder(definitions, 1)
  const chainId = newChainId(now, 1)
  const seq = 1
  let profile: CrewProfile
  try {
    profile = readCrewProfile(crewId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stageName = error instanceof StageError ? error.stage : '读取人员档案'
    appendChain({
      id: chainId,
      crewId,
      personNo: String(crewId),
      name: '',
      action,
      success: false,
      startedAt: formatTime(now),
      finishedAt: formatTime(new Date()),
      stages: [{ name: stageName, status: 'error', detail: message, seq }],
    })
    return { ok: false, crewId, personNo: String(crewId), name: '', seq, chainId, message }
  }
  builder.run('读取人员档案', () => {
    return `人员编号 ${profile.personNo}｜岗位类别「${profile.post}」｜所属班组「${profile.team}」｜在岗状态「${profile.status}」`
  })

  const allowedFrom = action === '确认在岗' ? '已排班' : '在岗'
  const targetStatus = action === '确认在岗' ? '在岗' : '已离岗'
  const crewSnapshot = listRows(CREW_KEY)
  const emergencySnapshot = listRows(EMERGENCY_KEY)
  const crewRows = crewSnapshot.map((row) => ({ ...row }))
  const emergencyRows = emergencySnapshot.map((row) => ({ ...row }))
  const date = String(profile.row['排班日期'] ?? '')
  const period = String(profile.row['值班时段'] ?? '')
  let updated: EntryRow = profile.row
  let todo: EntryRow | null = null

  const finish = (success: boolean): HandoverChain => ({
    id: chainId,
    crewId,
    personNo: profile.personNo,
    name: String(profile.row['姓名'] ?? ''),
    action,
    success,
    startedAt: formatTime(now),
    finishedAt: formatTime(new Date()),
    stages: builder.result(),
  })

  const failOutcome = (message: string): ScheduleChangeOutcome => {
    appendChain(finish(false))
    return {
      ok: false,
      crewId,
      personNo: profile.personNo,
      name: String(profile.row['姓名'] ?? ''),
      seq,
      chainId,
      message,
    }
  }

  let blocked: string | null = null
  try {
    builder.run('校验在岗状态', () => {
      if (profile.status !== allowedFrom) {
        blocked =
          action === '确认在岗'
            ? `${profile.personNo} 当前为「${profile.status}」，只有「已排班」人员才能确认在岗`
            : `${profile.personNo} 当前为「${profile.status}」，只有「在岗」人员才能登记离岗`
        throw new StageError('校验在岗状态', blocked)
      }
      return `在岗状态「${profile.status}」校验通过，允许${action}`
    })
  } catch {
    // 状态不允许是业务级阻断：builder 已记录红节点，这里转成失败结果返回，不得向上逃逸。
    return failOutcome(blocked ?? '在岗状态校验未通过')
  }
  if (profile.teamFallback) {
    builder.markWarn('校验在岗状态', `该人员班组为兼容迁移口径，${action}已放行，请补登正式班组`)
  }

  const writeLabel = action === '确认在岗' ? '写回在岗结果' : '写回离岗结果'
  builder.run(writeLabel, () => {
    updated = {
      ...profile.row,
      status: targetStatus,
      pending: targetStatus !== '已离岗',
      在岗状态: targetStatus,
      链路编号: chainId,
      ...(action === '登记离岗' ? { 离岗时间: formatTime(now) } : {}),
    }
    return `${profile.personNo} 状态已流转为「${targetStatus}」（历史离岗规则保持不变）`
  })

  const missingPeriod = !date || !period
  builder.run('同步应急待办', () => {
    todo = buildTodo(profile, date || '未登记', period || '未登记', emergencyRows, action, chainId)
    return `已生成应急保障待办 ${String(todo['应急编号'])}（待响应）`
  })
  if (missingPeriod) {
    // 历史人员没有值班时段也允许状态流转（原规则不变），但不能静默：黄节点显式提示。
    builder.markWarn('同步应急待办', `${profile.personNo} 缺少排班日期或值班时段，应急待办按空时段登记，请补录`)
  }

  builder.run('交接链路留痕', () => `链路 ${chainId} 登记完成，共 ${definitions.length} 个环节`)

  // 持久化失败同样不能静默：回滚快照并显式返回错误。
  try {
    const rowIndex = crewRows.findIndex((row) => Number(row.id) === crewId)
    crewRows[rowIndex] = updated
    saveRows(CREW_KEY, crewRows)
    emergencyRows.push(todo!)
    saveRows(EMERGENCY_KEY, emergencyRows)
  } catch (error) {
    saveRows(CREW_KEY, crewSnapshot)
    saveRows(EMERGENCY_KEY, emergencySnapshot)
    return failOutcome(
      `${action}结果或应急待办持久化失败，已回滚：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  appendChain(finish(true))
  const warns = builder.result().filter((stage) => stage.status === 'warn')
  return {
    ok: true,
    crewId,
    personNo: profile.personNo,
    name: String(profile.row['姓名'] ?? ''),
    seq,
    chainId,
    message:
      `${profile.personNo} 已${action}，当前状态「${targetStatus}」，应急保障待办 ${String(
        todo!['应急编号'],
      )} 已生成` + (warns.length ? `；兼容提示：${warns.map((w) => w.detail).join('；')}` : ''),
  }
}

export function confirmOnDuty(crewId: number, now: Date = new Date()): ScheduleChangeOutcome {
  return submitStatusChange(crewId, '确认在岗', now)
}

export function registerOffDuty(crewId: number, now: Date = new Date()): ScheduleChangeOutcome {
  return submitStatusChange(crewId, '登记离岗', now)
}

// ---- 兼容迁移：缺班组归属的既有数据 ----

// 只补「所属班组」，不改状态、不碰历史离岗记录的任何业务字段（离岗规则保持原样）。
export function migrateCrewTeams(): TeamMigrationReport {
  const rows = listRows(CREW_KEY)
  const report: TeamMigrationReport = { migrated: 0, crewTotal: rows.length, details: [] }
  let changed = false
  const next = rows.map((row) => {
    const team = String(row['所属班组'] ?? '').trim()
    if (team) {
      return row
    }
    changed = true
    const personNo = String(row['人员编号'] ?? `记录${row.id}`)
    report.migrated += 1
    report.details.push({ id: Number(row.id), personNo, fallbackTeam: FALLBACK_TEAM })
    return {
      ...row,
      所属班组: FALLBACK_TEAM,
      兼容迁移: '所属班组缺失-按兜底口径迁移',
    }
  })
  if (changed) {
    saveRows(CREW_KEY, next)
  }
  return report
}
