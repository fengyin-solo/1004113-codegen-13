/* 交接链路业务规则验证（由 scripts/test-handover.cjs 调用，参数为打包产物路径）。 */
const bundlePath = process.argv[2]
const mem = new Map()
class MemoryStorage {
  getItem(k) { return mem.has(k) ? mem.get(k) : null }
  setItem(k, v) {
    if (globalThis.__failSecondEntriesWrite && k.includes('entries')) {
      globalThis.__entriesWriteCount = (globalThis.__entriesWriteCount || 0) + 1
      if (globalThis.__entriesWriteCount === 2) {
        throw new Error('模拟应急写回失败')
      }
    }
    mem.set(k, String(v))
  }
  removeItem(k) { mem.delete(k) }
}
globalThis.window = { localStorage: new MemoryStorage() }
globalThis.localStorage = window.localStorage

const assert = require('node:assert')
const bundle = require(bundlePath)
const svc = bundle.service
const store = bundle.store
const query = bundle.query

let passed = 0
function check(name, cond, extra) {
  assert.ok(cond, `❌ ${name}${extra ? ` — ${extra}` : ''}`)
  console.log(`✓ ${name}`)
  passed++
}

// 干净起点
store.resetRows('crew_schedule')
store.resetRows('air_emergency')
const crew0 = store.listRows('crew_schedule')

// 兼容迁移：种子数据班组是占位串 → 兜底班组
check('缺班组既有数据按兼容口径迁移', crew0.every(r => r['所属班组'] === '未归属班组（兼容迁移）'))

// 登记三人
const ra = svc.registerPerson({ crewCode: '', name: '张三', position: '机务', team: '甲班', contact: '138' })
const rb = svc.registerPerson({ crewCode: '', name: '李四', position: '加油员', team: '乙班', contact: '139' })
const rc = svc.registerPerson({ crewCode: '', name: '王五', position: '引导员', team: '甲班', contact: '' })
check('登记人员成功', ra.ok && rb.ok && rc.ok, ra.message)
const A = store.listRows('crew_schedule').find(r => r['姓名'] === '张三')
const B = store.listRows('crew_schedule').find(r => r['姓名'] === '李四')
const C = store.listRows('crew_schedule').find(r => r['姓名'] === '王五')

// 新登记缺班组 → 失败且留失败链路
const rNoTeam = svc.registerPerson({ crewCode: '', name: '赵六', position: '机务', team: '', contact: '' })
check('新登记缺班组被拒', !rNoTeam.ok && /所属班组不能为空/.test(rNoTeam.message))
check('失败链路也已归档', rNoTeam.chain && rNoTeam.chain.stages.some(s => s.status === 'failed'))

// 首次排班成功
const s1 = svc.submitSchedule({ personId: A.id, date: '2026-10-07', startTime: '08:00', endTime: '12:00' })
check('首次排班成功', s1.ok, s1.message)
const A1 = store.listRows('crew_schedule').find(r => r.id === A.id)
check('排班后状态为已排班', A1.status === '已排班' && A1['值班时段'] === '08:00-12:00')
check('排班结果写回新建应急待办', String(A1['关联应急编号']).startsWith('AIR-'))
const em1 = store.listRows('air_emergency').find(r => r['应急编号'] === A1['关联应急编号'])
check('应急待办状态待响应且响应人同步', em1 && em1.status === '待响应' && String(em1['响应人员']).includes('张三'))

// 同人重叠时段并发：后登记失败，首个保持
const s2 = svc.submitSchedule({ personId: A.id, date: '2026-10-07', startTime: '10:00', endTime: '14:00' })
check('重叠时段后登记被拒（先登记为准）', !s2.ok && /先登记/.test(s2.message), s2.message)
check('被拒链路裁决环节失败', s2.chain.stages.find(s => s.stage === 'arbitrate').status === 'failed')
const A2 = store.listRows('crew_schedule').find(r => r.id === A.id)
check('被拒后先登记结果不变', A2['值班时段'] === '08:00-12:00' && A2.status === '已排班')

// 端点相接（12:00 开始）不算重叠
const s2b = svc.submitSchedule({ personId: A.id, date: '2026-10-07', startTime: '12:00', endTime: '13:00' })
check('端点相接不判为重叠（改排允许）', s2b.ok, s2b.message)
const A2b = store.listRows('crew_schedule').find(r => r.id === A.id)
check('改排后时段更新', A2b['值班时段'] === '12:00-13:00')

// 换日不重叠 → 允许
const s3 = svc.submitSchedule({ personId: A.id, date: '2026-10-08', startTime: '08:00', endTime: '12:00' })
check('换日排班允许', s3.ok, s3.message)

// B 夜班跨天 20:00-08:00 与次日 07:00 班次重叠
const sb1 = svc.submitSchedule({ personId: B.id, date: '2026-10-07', startTime: '20:00', endTime: '08:00' })
check('跨天夜班排班成功', sb1.ok, sb1.message)
const sb2 = svc.submitSchedule({ personId: B.id, date: '2026-10-08', startTime: '07:00', endTime: '09:00' })
check('跨天夜班与次日凌晨重叠被识别', !sb2.ok && /重叠/.test(sb2.message), sb2.message)
const sb3 = svc.submitSchedule({ personId: B.id, date: '2026-10-08', startTime: '08:00', endTime: '09:00' })
check('夜班结束端点相接不冲突', sb3.ok, sb3.message)

// 到岗确认与应急待办联动
const d1 = svc.confirmOnDuty(A.id)
check('确认在岗成功', d1.ok, d1.message)
const A3 = store.listRows('crew_schedule').find(r => r.id === A.id)
const em3 = store.listRows('air_emergency').find(r => r['应急编号'] === A3['关联应急编号'])
check('到岗后应急待办响应中且追加处置', A3.status === '在岗' && em3.status === '响应中' && /确认在岗/.test(String(em3['处置措施'])))
const s4 = svc.submitSchedule({ personId: A.id, date: '2026-10-08', startTime: '09:00', endTime: '10:00' })
check('在岗人员重复排班被拒', !s4.ok && /在岗/.test(s4.message), s4.message)

// 交接班 A(在岗) → C(待排班)
const h1 = svc.handover({ fromRowId: A.id, successorId: C.id, reason: '工时届满' })
check('交接班成功', h1.ok, h1.message)
const A4 = store.listRows('crew_schedule').find(r => r.id === A.id)
const C4 = store.listRows('crew_schedule').find(r => r.id === C.id)
check('交班人按历史规则离岗', A4.status === '已离岗' && A4['交接去向'].includes('王五'))
check('接班人排入同时段并到岗', C4.status === '在岗' && C4['值班时段'] === A3['值班时段'] && C4['排班日期'] === '2026-10-08')
const em4 = store.listRows('air_emergency').find(r => r['应急编号'] === A3['关联应急编号'])
check('应急待办响应人改挂接班人', String(em4['响应人员']).includes(C['人员编号']) && /交接班/.test(String(em4['处置措施'])))

// 接班人已在岗 → 交接失败
const sbOn = svc.confirmOnDuty(B.id)
check('B 到岗成功（前置）', sbOn.ok, sbOn.message)
const h2 = svc.handover({ fromRowId: B.id, successorId: C.id, reason: '再试' })
check('接班人已在岗时交接失败', !h2.ok && /接班人/.test(h2.message), h2.message)

// 离岗 → 应急待办解除
const o1 = svc.registerOffDuty({ rowId: C.id, note: '正常下班' })
check('离岗登记成功', o1.ok, o1.message)
const C5 = store.listRows('crew_schedule').find(r => r.id === C.id)
const em5 = store.listRows('air_emergency').find(r => r['应急编号'] === A3['关联应急编号'])
check('离岗为终态', C5.status === '已离岗' && C5.pending === false)
check('离岗后应急待办解除闭环', em5.status === '已解除')

// 历史离岗记录保持原规则
const before = JSON.stringify(C5)
const o2 = svc.registerOffDuty({ rowId: C.id, note: '再点一次' })
check('历史离岗记录拒绝重复操作', !o2.ok && /历史离岗记录/.test(o2.message), o2.message)
const afterRecord = store.listRows('crew_schedule').find(r => r.id === C.id)
check('历史离岗记录未被改写', before === JSON.stringify(afterRecord))

// 链路统计
const stats = query.chainStats()
check('链路只追加且含失败链路', stats.total >= 15 && stats.failed >= 5, `total=${stats.total} failed=${stats.failed}`)
check('冲突拒绝数被统计', stats.conflictRejected >= 3, String(stats.conflictRejected))
const failedList = query.queryChains({ result: 'failed' })
check('失败链路每条都带失败环节且非静默', failedList.every(c => c.stages.some(s => s.status === 'failed' && s.error)))

// 事务回滚：应急写回失败时排班也不落库
store.resetRows('crew_schedule')
store.resetRows('air_emergency')
const rd = svc.registerPerson({ crewCode: '', name: '测试丁', position: '机务', team: '丁班', contact: '' })
const D = store.listRows('crew_schedule').find(r => r['姓名'] === '测试丁')
globalThis.__failSecondEntriesWrite = true
globalThis.__entriesWriteCount = 0
const rb2 = svc.submitSchedule({ personId: D.id, date: '2026-10-09', startTime: '08:00', endTime: '12:00' })
check('应急写回失败时排班结果为失败', !rb2.ok && /回滚/.test(rb2.message), rb2.message)
const D2 = store.listRows('crew_schedule').find(r => r.id === D.id)
check('应急写回失败已回滚排班（不留半截）', D2.status === '待排班' && !D2['关联应急编号'])
check('回滚也登记了失败链路', rb2.chain.stages.find(s => s.stage === 'writeback').status === 'failed')

// 流程图所用链路结构完整
const failStages = s2.chain.stages
check('失败链路在裁决环节终止且带错误说明', failStages.some(s => s.stage === 'arbitrate' && s.status === 'failed' && s.error) && failStages.every(s => s.order <= 3))
const okStages = s1.chain.stages
check('成功链路包含全部五个环节', ['validate','arbitrate','writeback','emergency','archive'].every(k => okStages.some(s => s.stage === k)))
check('链路环节带有序号、标签、时间与说明', okStages.every(s => s.order && s.label && s.at && s.detail))

console.log(`\n全部 ${passed} 项验证通过`)
