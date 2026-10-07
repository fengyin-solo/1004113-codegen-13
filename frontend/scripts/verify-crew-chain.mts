import assert from 'node:assert'
import { SEED_ROWS } from '../src/data/seed'
import {
  confirmOnDuty,
  FALLBACK_TEAM,
  isOverlap,
  listChains,
  migrateCrewTeams,
  parsePeriod,
  registerOffDuty,
  submitSchedules,
  toAbsoluteRange,
} from '../src/services/crew-schedule'
import { allRows, resetRows, storageKey } from '../src/data/local-store'

// ---- localStorage 垫片 ----
const memStore = new Map<string, string>()
;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (memStore.has(key) ? memStore.get(key)! : null),
  setItem: (key: string, value: string) => void memStore.set(key, value),
  removeItem: (key: string) => void memStore.delete(key),
  clear: () => memStore.clear(),
  key: (index: number) => [...memStore.keys()][index] ?? null,
  get length() {
    return memStore.size
  },
}

function crewRows() {
  return resetRows('crew_schedule')
}
function emergencyRows() {
  return JSON.parse(memStore.get(storageKey())!).air_emergency
}

// 1. 时段解析：跨夜班
const night = parsePeriod('22:00-06:00')
assert.strictEqual(night.endMin - night.startMin, 480, '跨夜班时长应为 8 小时')
assert.throws(() => parsePeriod('全天'), /格式无法识别/, '非法时段必须抛错')

// 2. 区间重叠与端点相接
const day = '2026-10-08'
assert.strictEqual(
  isOverlap(toAbsoluteRange(day, '08:00-14:00'), toAbsoluteRange(day, '14:00-20:00')),
  false,
  '端点相接不算重叠',
)
assert.strictEqual(
  isOverlap(toAbsoluteRange(day, '08:00-14:00'), toAbsoluteRange(day, '13:00-18:00')),
  true,
  '内部相交算重叠',
)
assert.strictEqual(
  isOverlap(toAbsoluteRange('2026-10-07', '22:00-06:00'), toAbsoluteRange('2026-10-08', '05:00-09:00')),
  true,
  '跨夜班与次日早班重叠应能识别',
)

// 3. 兼容迁移：CREW-0004 本就缺班组，再把 CREW-0001 也置空
crewRows()
allRows().crew_schedule[0] = { ...allRows().crew_schedule[0], 所属班组: '' }
const report = migrateCrewTeams()
assert.strictEqual(report.migrated, 2, '应迁移 2 条缺班组数据（CREW-0001 + CREW-0004）')
const migrated0 = JSON.parse(memStore.get(storageKey())!).crew_schedule[0]
assert.strictEqual(migrated0['所属班组'], FALLBACK_TEAM, '迁移后写入兜底班组')
assert.strictEqual(migrated0['status'], '待排班', '迁移不得改动状态')
const migratedOff = JSON.parse(memStore.get(storageKey())!).crew_schedule.find(
  (r: { id: number }) => r.id === 5,
)
assert.strictEqual(migratedOff['所属班组'], '装卸一班', '离岗记录原本有班组，不得被迁移改动')
assert.strictEqual(migrateCrewTeams().migrated, 0, '迁移幂等：第二次为 0')

// 4. 正常排班 + 回写应急待办 + 链路留痕（在待排班的 CREW-0001 上做）
crewRows()
const beforeTodo = emergencyRows().length
const r1 = submitSchedules([{ crewId: 1, date: '2026-10-08', period: '08:00-14:00', seq: 1 }])
assert.strictEqual(r1.length, 1)
assert.strictEqual(r1[0].ok, true, '待排班人员排班应成功')
assert.strictEqual(emergencyRows().length, beforeTodo + 1, '应回写 1 条应急保障待办')
const todo = emergencyRows().at(-1)
assert.strictEqual(todo['来源'], '地勤排班')
assert.strictEqual(todo['响应人员'].includes('CREW-0001'), true)
const chain1 = listChains().find((c) => c.id === r1[0].chainId)!
assert.strictEqual(chain1.stages.length, 7, '排班链路应有 7 个环节')
assert.ok(chain1.stages.every((s) => s.status === 'ok'), '全部环节通过')

// 5. 并发重叠：同一人员同批两笔重叠请求，只有首个成功（在另一名待排班人员 CREW-0001 重置后换日演示）
crewRows()
const r2 = submitSchedules([
  { crewId: 1, date: '2026-10-09', period: '08:00-14:00', seq: 1 },
  { crewId: 1, date: '2026-10-09', period: '13:00-18:00', seq: 2 },
])
assert.strictEqual(r2[0].ok, true, '首笔登记成功')
assert.strictEqual(r2[1].ok, false, '第二笔重叠必须失败')
assert.match(r2[1].message, /先登记/, '失败原因须指明先登记结果为准')
const failedChain = listChains().find((c) => c.id === r2[1].chainId)!
assert.strictEqual(failedChain.success, false)
assert.strictEqual(
  failedChain.stages.find((s) => s.name === '重叠时段判定')?.status,
  'error',
  '阻断环节必须标红留痕',
)
assert.strictEqual(
  failedChain.stages.filter((s) => s.name === '回写应急保障待办').length,
  0,
  '阻断后不得继续执行后续环节',
)

// 同批同人员两笔「不重叠」窗口：后登记不得静默覆盖先登记（一人一条在班窗口）
crewRows()
const r2b = submitSchedules([
  { crewId: 1, date: '2026-10-09', period: '08:00-14:00', seq: 1 },
  { crewId: 1, date: '2026-10-10', period: '08:00-14:00', seq: 2 },
])
assert.strictEqual(r2b[0].ok, true, '不重叠首笔仍成功')
assert.strictEqual(r2b[1].ok, false, '不重叠第二笔也不得覆盖先登记')
assert.match(r2b[1].message, /不得覆盖|只保留一条/)
const kept = JSON.parse(memStore.get(storageKey())!).crew_schedule.find((r: { id: number }) => r.id === 1)
assert.strictEqual(kept['排班日期'], '2026-10-09', '落库保留的必须是先登记结果')

// 6. 与此前已落库的先登记结果冲突（CREW-0002 种子已排班 10-07 08:00-14:00）
const r3 = submitSchedules([{ crewId: 2, date: '2026-10-07', period: '10:00-12:00', seq: 1 }])
assert.strictEqual(r3[0].ok, false, '与本人先登记结果重叠必须被拦截')
assert.match(r3[0].message, /先登记/)

// 已排班人员换不重叠的新窗口，写回环节按「重复安排」拒绝（原规则：一人一条在班窗口）
const r4 = submitSchedules([{ crewId: 2, date: '2026-10-08', period: '14:00-20:00', seq: 1 }])
assert.strictEqual(r4[0].ok, false, '已排班人员不能再登记第二个窗口')
assert.match(r4[0].message, /不用重复安排/)

// 不同人员同一时段是合法同班，互不拦截；已离岗人员可重新登记（离岗规则保持原样）。
// CREW-0005 已离岗 10-06 22:00-06:00，重新登记 10-07 09:00-12:00（与在岗 CREW-0003 的 08:00-20:00 同窗）。
const r4b = submitSchedules([{ crewId: 5, date: '2026-10-07', period: '09:00-12:00', seq: 1 }])
assert.strictEqual(r4b[0].ok, true, '不同人员可同时段同班值班；离岗人员可重新排班')

// 7. 历史离岗记录保持原规则、不参与冲突
// CREW-0005 的历史离岗窗口 10-06 22:00-06:00 不参与判定：给待排班的 CREW-0001 同时段登记不被拦截
crewRows()
const r5 = submitSchedules([{ crewId: 1, date: '2026-10-06', period: '22:00-06:00', seq: 1 }])
assert.strictEqual(r5[0].ok, true, '他人历史离岗时段不参与冲突判定')

// 状态机：已排班 → 确认在岗 → 登记离岗（在 CREW-0002 上）
const r6 = confirmOnDuty(2, new Date('2026-10-07T07:00:00'))
assert.strictEqual(r6.ok, true, '已排班 → 确认在岗')
const r7 = registerOffDuty(2, new Date('2026-10-07T12:00:00'))
assert.strictEqual(r7.ok, true, '在岗 → 登记离岗')
const offRow = JSON.parse(memStore.get(storageKey())!).crew_schedule.find((r: { id: number }) => r.id === 2)
assert.strictEqual(offRow['status'], '已离岗')
assert.ok(offRow['离岗时间'], '离岗时间应留痕')
// 离岗后回写的应急待办仍按原规则保留一条
assert.ok(
  emergencyRows().some((t) => t['来源链路'] === r7.chainId),
  '登记离岗也应回写应急待办',
)

// 状态机：待排班不能直接确认在岗；错误必须显式返回且留痕
crewRows()
const r8 = confirmOnDuty(1)
assert.strictEqual(r8.ok, false, '待排班不能直接确认在岗')
assert.match(r8.message, /只有「已排班」/, '错误信息显式返回')
const c8 = listChains().find((c) => c.id === r8.chainId)!
assert.strictEqual(c8.stages.find((s) => s.name === '校验在岗状态')?.status, 'error')

// 缺人员编号等档案错误：不静默
const r9 = submitSchedules([{ crewId: 999, date: day, period: '08:00-14:00', seq: 1 }])
assert.strictEqual(r9[0].ok, false)
assert.match(r9[0].message, /没有找到编号/, '链路错误必须显式返回')

console.log('全部断言通过 ✅')
