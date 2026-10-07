<template>
  <section class="page" data-module="crew_schedule">
    <header class="page-head">
      <div>
        <h2>地勤排班管理</h2>
        <p class="page-desc">
          先读懂人员编号、岗位类别、所属班组、值班时段、在岗状态五要素，再按交接链路安排排班；
          排班结果自动回写应急保障待办，同人员重叠时段只认先登记结果。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出地勤排班清单</button>
      </div>
    </header>

    <div v-if="migrationNotice" class="migration-banner">
      <strong>兼容迁移：</strong>{{ migrationNotice }}
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="flow-card">
      <header class="flow-card-head">
        <div>
          <h3>排班变更交接链路图</h3>
          <p class="page-desc">每次变更依次经过下列环节，任一环节出错都会标红阻断，兼容口径放行标黄提示，绝不静默跳过。</p>
        </div>
        <div class="flow-tabs">
          <button
            v-for="action in flowActions"
            :key="action"
            type="button"
            class="btn"
            :class="{ primary: activeFlow === action }"
            @click="activeFlow = action"
          >
            {{ action }}
          </button>
        </div>
      </header>
      <ChainFlow :nodes="flowDefinitions[activeFlow]" />
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            <span class="status-pill" :class="`st-${String(row.status)}`">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openSchedule(row)">安排排班</button>
            <button
              class="link"
              type="button"
              :disabled="String(row.status) !== '已排班'"
              @click="changeStatus('确认在岗', row)"
            >
              确认在岗
            </button>
            <button
              class="link"
              type="button"
              :disabled="String(row.status) !== '在岗'"
              @click="changeStatus('登记离岗', row)"
            >
              登记离岗
            </button>
            <button class="link trace" type="button" @click="openTrace(row)">交接链路</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无地勤排班数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 安排排班弹窗 -->
    <div v-if="scheduleTarget" class="modal-mask" @click.self="closeSchedule">
      <div class="modal-box">
        <h3>安排排班 · {{ String(scheduleTarget['人员编号']) }} {{ String(scheduleTarget['姓名']) }}</h3>
        <p class="modal-meta">
          岗位类别 {{ String(scheduleTarget['岗位类别']) }}｜所属班组
          {{ String(scheduleTarget['所属班组']) }}｜当前 {{ String(scheduleTarget.status) }}
        </p>
        <div class="form-grid">
          <label class="filter-item">
            <span>排班日期</span>
            <input v-model="scheduleForm.date" type="date" />
          </label>
          <label class="filter-item">
            <span>值班时段（支持跨夜，如 22:00-06:00）</span>
            <input v-model="scheduleForm.period" placeholder="08:00-14:00" />
          </label>
        </div>
        <label class="concurrent-line">
          <input v-model="scheduleForm.concurrent" type="checkbox" />
          模拟同人员并发提交两笔重叠排班（验证只有首个登记成功）
        </label>
        <p v-if="scheduleForm.concurrent" class="concurrent-hint">
          将以同一登记时间提交两笔（第二笔时段重叠 1 小时），系统按登记序号判定：首笔生效，第二笔被先登记结果拦截。
        </p>
        <ul v-if="scheduleOutcomes.length" class="outcome-list">
          <li v-for="outcome in scheduleOutcomes" :key="outcome.chainId" :class="outcome.ok ? 'is-ok' : 'is-error'">
            <strong>第 {{ outcome.seq }} 笔：{{ outcome.ok ? '登记成功' : '登记失败' }}</strong>
            <span>{{ outcome.message }}</span>
            <button class="link" type="button" @click="openChainById(outcome.chainId)">查看链路图</button>
          </li>
        </ul>
        <div class="modal-actions">
          <button class="btn primary" type="button" :disabled="submitting" @click="submitSchedule">
            {{ scheduleForm.concurrent ? '并发提交两笔' : '提交排班' }}
          </button>
          <button class="btn ghost" type="button" @click="closeSchedule">关闭</button>
        </div>
      </div>
    </div>

    <!-- 链路追踪弹窗 -->
    <div v-if="traceTarget" class="modal-mask wide" @click.self="traceTarget = null">
      <div class="modal-box">
        <h3>
          交接链路追踪 · {{ String(traceTarget['人员编号']) }} {{ String(traceTarget['姓名']) }}
        </h3>
        <p class="modal-meta">
          历史离岗记录保持原规则；下列为该人员全部排班变更经过的环节链路，红节点为阻断、黄节点为兼容放行。
        </p>
        <div v-if="traceChains.length" class="trace-list">
          <article v-for="chain in traceChains" :key="chain.id" class="trace-item">
            <header class="trace-head">
              <div>
                <strong>{{ chain.action }}</strong>
                <span class="trace-id">{{ chain.id }}</span>
                <span class="status-pill" :class="chain.success ? 'st-ok' : 'st-fail'">
                  {{ chain.success ? '成功' : '失败' }}
                </span>
              </div>
              <span class="trace-time">{{ chain.startedAt }} → {{ chain.finishedAt }}</span>
            </header>
            <ChainFlow :nodes="flowDefinitions[chain.action]" :stages="chain.stages" />
          </article>
        </div>
        <p v-else class="empty-state">该人员暂无交接链路记录</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="traceTarget = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 单笔链路弹窗（从排班结果跳转） -->
    <div v-if="chainDialog" class="modal-mask wide" @click.self="chainDialog = null">
      <div class="modal-box">
        <h3>链路 {{ chainDialog.id }} · {{ chainDialog.action }}</h3>
        <p class="modal-meta">
          {{ chainDialog.personNo }} {{ chainDialog.name }}｜{{ chainDialog.startedAt }}
        </p>
        <ChainFlow
          :nodes="flowDefinitions[chainDialog.action]"
          :stages="chainDialog.stages"
          :batch="chainDialog.action === '安排排班'"
        />
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="chainDialog = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import ChainFlow from '@/components/ChainFlow.vue'
import type { EntryRow, HandoverChain, ScheduleChangeOutcome } from '@/data/types'
import {
  confirmOnDuty,
  FLOW_DEFINITIONS,
  listChains,
  migrateCrewTeams,
  registerOffDuty,
  submitSchedules,
} from '@/services/crew-schedule'

const meta = moduleMeta('crew_schedule')
const columns = ['人员编号', '姓名', '岗位类别', '所属班组', '排班日期', '值班时段', '联络方式']
const filterFields = ['人员编号', '姓名', '岗位类别', '所属班组']
const statuses = ['待排班', '已排班', '在岗', '已离岗']
const flowActions = ['安排排班', '确认在岗', '登记离岗'] as const
const flowDefinitions = FLOW_DEFINITIONS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const migrationNotice = ref('')
const activeFlow = ref<(typeof flowActions)[number]>('安排排班')

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const onDuty = rows.value.filter((row) => String(row.status) === '在岗').length
  const scheduled = rows.value.filter((row) => String(row.status) === '已排班').length
  const active = rows.value.filter((row) => ['已排班', '在岗'].includes(String(row.status))).length
  const rate = active ? Math.round(((onDuty + scheduled) / rows.value.length) * 100) : 0
  return [
    { label: '在岗人员', value: onDuty },
    { label: '已排班待到岗', value: scheduled },
    { label: '今日排班到岗率', value: rows.value.length ? rate : 0 },
  ]
})

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '地勤排班列表读取失败'
  }
}

// ---- 安排排班弹窗 ----

const scheduleTarget = ref<EntryRow | null>(null)
const submitting = ref(false)
const scheduleOutcomes = ref<ScheduleChangeOutcome[]>([])
const scheduleForm = reactive({ date: '2026-10-08', period: '08:00-14:00', concurrent: false })

function openSchedule(row: EntryRow) {
  errorMessage.value = ''
  scheduleTarget.value = row
  scheduleOutcomes.value = []
}

function closeSchedule() {
  scheduleTarget.value = null
  scheduleOutcomes.value = []
}

// 并发演示：两笔同登记时间提交，第二笔与首笔重叠 1 小时，应被「先登记结果」拦截。
function buildConcurrentPeriod(base: string): string {
  const map: Record<string, string> = {
    '08:00-14:00': '13:00-18:00',
    '14:00-22:00': '20:00-06:00',
    '22:00-06:00': '05:00-09:00',
  }
  return map[base] ?? '13:00-18:00'
}

function submitSchedule() {
  if (!scheduleTarget.value) {
    return
  }
  errorMessage.value = ''
  submitting.value = true
  try {
    const crewId = Number(scheduleTarget.value.id)
    const requests = [
      { crewId, date: scheduleForm.date, period: scheduleForm.period, seq: 1 },
    ]
    if (scheduleForm.concurrent) {
      requests.push({
        crewId,
        date: scheduleForm.date,
        period: buildConcurrentPeriod(scheduleForm.period),
        seq: 2,
      })
    }
    scheduleOutcomes.value = submitSchedules(requests)
    const failed = scheduleOutcomes.value.filter((item) => !item.ok)
    if (failed.length === scheduleOutcomes.value.length) {
      errorMessage.value = failed.map((item) => item.message).join('；')
    }
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排班提交失败'
  } finally {
    submitting.value = false
  }
}

// ---- 确认在岗 / 登记离岗 ----

function changeStatus(action: '确认在岗' | '登记离岗', row: EntryRow) {
  errorMessage.value = ''
  try {
    const result =
      action === '确认在岗' ? confirmOnDuty(Number(row.id)) : registerOffDuty(Number(row.id))
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
    if (!result.ok) {
      openChainById(result.chainId)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : `${action}失败`
  }
}

// ---- 链路追踪 ----

const traceTarget = ref<EntryRow | null>(null)
const traceChains = ref<HandoverChain[]>([])
const chainDialog = ref<HandoverChain | null>(null)

function openTrace(row: EntryRow) {
  errorMessage.value = ''
  traceTarget.value = row
  try {
    traceChains.value = listChains(Number(row.id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '交接链路读取失败'
    traceChains.value = []
  }
}

function openChainById(chainId: string) {
  try {
    const chain = listChains().find((item) => item.id === chainId)
    if (chain) {
      scheduleTarget.value = null
      traceTarget.value = null
      chainDialog.value = chain
    } else {
      errorMessage.value = `未找到链路 ${chainId}，链路台账可能已损坏`
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '交接链路读取失败'
  }
}

onMounted(() => {
  // 缺班组归属的既有数据按兼容口径迁移（只补班组，不动离岗等历史规则）。
  try {
    const report = migrateCrewTeams()
    if (report.migrated > 0) {
      migrationNotice.value =
        `检测到 ${report.migrated}/${report.crewTotal} 名人员缺班组归属，已按「未归属班组（兼容迁移）」兜底：` +
        report.details.map((item) => item.personNo).join('、')
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '班组兼容迁移失败'
  }
  reload()
})
</script>

<style scoped>
.migration-banner {
  background: #fffbeb;
  border: 1px solid #fcd34d;
  color: #92400e;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 12px;
}
.flow-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.flow-card-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.flow-card-head h3 {
  margin: 0 0 2px;
  font-size: 15px;
}
.flow-tabs {
  display: flex;
  gap: 6px;
  flex: none;
}
.status-pill {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  background: #e2e8f0;
}
.st-在岗,
.st-ok {
  background: #dcfce7;
  color: #166534;
}
.st-已排班 {
  background: #dbeafe;
  color: #1e40af;
}
.st-已离岗 {
  background: #f1f5f9;
  color: #475569;
}
.st-待排班 {
  background: #fef9c3;
  color: #854d0e;
}
.st-fail {
  background: #fee2e2;
  color: #991b1b;
}
.link:disabled {
  color: #cbd5e1;
  cursor: not-allowed;
}
.link.trace {
  color: #7c3aed;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 20px;
}
.modal-box {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 560px;
  max-width: 100%;
  max-height: 86vh;
  overflow-y: auto;
}
.modal-mask.wide .modal-box {
  width: 860px;
}
.modal-box h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.modal-meta {
  color: var(--muted);
  font-size: 12px;
  margin: 0 0 12px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.concurrent-line {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.concurrent-hint {
  font-size: 12px;
  color: #92400e;
  background: #fffbeb;
  border-radius: 6px;
  padding: 6px 8px;
  margin: 8px 0 0;
}
.outcome-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.outcome-list li {
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.outcome-list li.is-ok {
  background: #f0fdf4;
  border: 1px solid #86efac;
}
.outcome-list li.is-error {
  background: #fef2f2;
  border: 1px solid #fca5a5;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.trace-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.trace-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.trace-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  font-size: 13px;
  gap: 8px;
}
.trace-id {
  color: var(--muted);
  margin: 0 8px;
  font-size: 12px;
}
.trace-time {
  color: var(--muted);
  font-size: 12px;
}
</style>
