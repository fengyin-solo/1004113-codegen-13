<template>
  <section class="page" data-module="crew_schedule">
    <header class="page-head">
      <div>
        <h2>地勤排班管理</h2>
        <p class="page-desc">
          维护地勤人员与值班时段，安排排班、确认在岗、交接班、登记离岗全程走交接链路；排班结果写回应急保障待办，
          同一人员重叠时段并发登记只允许先登记者成功。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openRegister">登记地勤人员</button>
        <button class="btn" type="button" @click="showStandardFlow = true">交接链路流程图</button>
        <button class="btn" type="button" @click="toggleChainPanel">交接链路追踪（{{ chainStatsData.total }}）</button>
        <button class="btn" type="button" @click="exportRows">导出排班清单</button>
      </div>
    </header>

    <div v-if="storeWarningText" class="banner warn">{{ storeWarningText }}</div>

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

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table crew-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ legacy: isLegacyRow(row) }">
          <td>
            {{ row['人员编号'] ?? '—' }}
            <span v-if="isLegacyRow(row)" class="tag tag-warn" title="缺班组归属的既有数据，已按兼容口径迁移">兼容迁移</span>
          </td>
          <td>{{ row['姓名'] ?? '—' }}</td>
          <td>{{ row['岗位类别'] ?? '—' }}</td>
          <td>{{ row['所属班组'] ?? '—' }}</td>
          <td>{{ row['排班日期'] || '—' }}</td>
          <td>{{ row['值班时段'] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row['关联应急编号']" class="tag tag-info" :title="`已写回应急待办 ${row['关联应急编号']}`">
              应急 {{ row['关联应急编号'] }}
            </span>
          </td>
          <td>{{ row['联络方式'] ?? '—' }}</td>
          <td class="row-actions">
            <button
              v-if="['待排班', '已离岗'].includes(String(row.status))"
              class="link"
              type="button"
              @click="openSchedule(row)"
            >
              安排排班
            </button>
            <button v-if="String(row.status) === '已排班'" class="link" type="button" @click="onConfirmDuty(row)">
              确认在岗
            </button>
            <button v-if="String(row.status) === '在岗'" class="link" type="button" @click="openHandover(row)">
              交接班
            </button>
            <button
              v-if="['在岗', '已排班'].includes(String(row.status))"
              class="link link-danger"
              type="button"
              @click="openOffDuty(row)"
            >
              登记离岗
            </button>
            <span v-if="String(row.status) === '已离岗'" class="muted-text">历史离岗记录</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无地勤排班数据，可先登记地勤人员</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条地勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 交接链路追踪面板 -->
    <section v-if="chainPanelOpen" class="chain-panel">
      <header class="panel-head">
        <h3>交接链路追踪</h3>
        <div class="panel-tools">
          <input v-model="chainKeyword" placeholder="按流水号/人员/环节说明检索" class="chain-search" />
          <select v-model="chainEventFilter">
            <option value="">全部变更</option>
            <option v-for="event in eventOptions" :key="event" :value="event">{{ event }}</option>
          </select>
          <select v-model="chainResultFilter">
            <option value="all">成功与失败</option>
            <option value="success">仅成功</option>
            <option value="failed">仅失败/回滚</option>
          </select>
          <button class="btn ghost" type="button" @click="chainPanelOpen = false">收起</button>
        </div>
      </header>

      <p class="chain-summary">
        链路共 {{ chainStatsData.total }} 条：成功 {{ chainStatsData.success }} 条，失败 {{ chainStatsData.failed }} 条，
        其中冲突裁决拒绝 {{ chainStatsData.conflictRejected }} 条。失败链路以红色标注，错误不静默跳过。
      </p>

      <table class="data-table">
        <thead>
          <tr>
            <th>流水号 / 登记顺序</th>
            <th>变更动作</th>
            <th>人员</th>
            <th>所属班组</th>
            <th>结果状态</th>
            <th>环节结果</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="chain in filteredChains" :key="chain.serial" :class="{ 'row-failed': !chain.success }">
            <td>{{ chain.serial }}<br /><span class="muted-text">#{{ chain.registerOrder }}</span></td>
            <td>
              {{ chain.event }}
              <span v-if="chain.successorCode" class="muted-text">→ {{ chain.successorCode }}</span>
            </td>
            <td>{{ chain.crewCode }} {{ chain.crewName }}</td>
            <td>{{ chain.team }}</td>
            <td>{{ chain.resultStatus }}</td>
            <td>
              <span class="stage-dots">
                <span
                  v-for="stage in chain.stages"
                  :key="stage.order"
                  class="dot"
                  :class="stage.status"
                  :title="`${stage.label}：${stage.error ?? stage.detail}`"
                ></span>
              </span>
            </td>
            <td>{{ formatTime(chain.createdAt) }}</td>
            <td><button class="link" type="button" @click="viewChain(chain)">查看流程图</button></td>
          </tr>
          <tr v-if="!filteredChains.length">
            <td colspan="8" class="empty-state">暂无符合条件的交接链路</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 登记人员 -->
    <Modal :open="registerOpen" title="登记地勤人员" width="520px" @close="registerOpen = false">
      <form class="action-form" @submit.prevent="submitRegister">
        <label class="form-item">
          <span>人员编号</span>
          <input v-model="registerForm.crewCode" placeholder="留空自动生成 CREW-XXXX" />
        </label>
        <label class="form-item">
          <span>姓名 *</span>
          <input v-model="registerForm.name" placeholder="如：张志强" />
        </label>
        <label class="form-item">
          <span>岗位类别 *</span>
          <input v-model="registerForm.position" list="position-options" placeholder="选择或输入岗位类别" />
          <datalist id="position-options">
            <option v-for="item in positionOptions" :key="item" :value="item"></option>
          </datalist>
        </label>
        <label class="form-item">
          <span>所属班组 *</span>
          <input v-model="registerForm.team" list="team-options" placeholder="选择或输入所属班组" />
          <datalist id="team-options">
            <option v-for="item in teamOptions" :key="item" :value="item"></option>
          </datalist>
        </label>
        <label class="form-item">
          <span>联络方式</span>
          <input v-model="registerForm.contact" placeholder="手机号/对讲频道" />
        </label>
        <p class="form-hint">新登记人员必须指派班组；缺班组归属的历史数据按「未归属班组（兼容迁移）」兼容保留。</p>
      </form>
      <template #footer>
        <button class="btn ghost" type="button" @click="registerOpen = false">取消</button>
        <button class="btn primary" type="button" @click="submitRegister">提交登记</button>
      </template>
    </Modal>

    <!-- 安排排班 -->
    <Modal :open="scheduleOpen" :title="`安排排班 · ${scheduleTarget?.['人员编号'] ?? ''} ${scheduleTarget?.['姓名'] ?? ''}`" width="560px" @close="scheduleOpen = false">
      <div v-if="scheduleTarget" class="action-form">
        <p class="form-hint">
          当前：{{ scheduleTarget['岗位类别'] }} / {{ scheduleTarget['所属班组'] }} / 在岗状态「{{ scheduleTarget.status }}」
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>排班日期 *</span>
            <input v-model="scheduleForm.date" type="date" />
          </label>
          <div class="form-item">
            <span>值班时段 *</span>
            <div class="time-inputs">
              <input v-model="scheduleForm.startTime" type="time" />
              <em>至</em>
              <input v-model="scheduleForm.endTime" type="time" />
            </div>
            <div class="preset-row">
              <button class="btn ghost btn-sm" type="button" @click="applyPreset('08:00', '20:00')">白班 08-20</button>
              <button class="btn ghost btn-sm" type="button" @click="applyPreset('20:00', '08:00')">夜班 20-08（跨天）</button>
            </div>
          </div>
        </div>
        <label class="form-item">
          <span>应急保障待办写回</span>
          <select v-model="scheduleForm.emergencyChoice">
            <option value="new">按排班结果新建一条应急保障待办</option>
            <option v-for="todo in emergencyTodos" :key="String(todo.id)" :value="String(todo.id)">
              挂接待办 {{ todo['应急编号'] }}（{{ todo['事件类型'] }}/{{ todo.status }}）
            </option>
          </select>
        </label>
        <p class="form-hint">
          提交后经过：校验登记 → 冲突裁决（同人同日重叠时段只允许先登记成功）→ 排班写回 → 应急待办写回（同一事务）→ 链路归档。
        </p>
      </div>
      <template #footer>
        <button class="btn ghost" type="button" @click="scheduleOpen = false">取消</button>
        <button class="btn primary" type="button" @click="submitSchedule">提交排班</button>
      </template>
    </Modal>

    <!-- 交接班 -->
    <Modal :open="handoverOpen" :title="`交接班 · ${handoverTarget?.['人员编号'] ?? ''} ${handoverTarget?.['姓名'] ?? ''}`" width="520px" @close="handoverOpen = false">
      <div v-if="handoverTarget" class="action-form">
        <p class="form-hint">
          交班人将按历史离岗规则登记离岗；接班人排入同一时段 {{ handoverTarget['排班日期'] }}
          {{ handoverTarget['值班时段'] }} 并直接到岗，应急待办响应人同步改挂。
        </p>
        <label class="form-item">
          <span>接班人 *（仅限待排班/已离岗人员）</span>
          <select v-model="handoverForm.successorId">
            <option value="">请选择接班人</option>
            <option v-for="person in handoverCandidates" :key="String(person.id)" :value="String(person.id)">
              {{ person['人员编号'] }} {{ person['姓名'] }}（{{ person['岗位类别'] }}/{{ person['所属班组'] }}）
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>交接事由</span>
          <textarea v-model="handoverForm.reason" rows="2" placeholder="如：工时届满、临时换岗"></textarea>
        </label>
      </div>
      <template #footer>
        <button class="btn ghost" type="button" @click="handoverOpen = false">取消</button>
        <button class="btn primary" type="button" @click="submitHandover">确认交接班</button>
      </template>
    </Modal>

    <!-- 登记离岗 -->
    <Modal :open="offDutyOpen" :title="`登记离岗 · ${offDutyTarget?.['人员编号'] ?? ''} ${offDutyTarget?.['姓名'] ?? ''}`" width="480px" @close="offDutyOpen = false">
      <div v-if="offDutyTarget" class="action-form">
        <p class="form-hint">
          离岗按历史规则直接置为「已离岗」终态、不做冲突裁决；关联应急待办 {{ offDutyTarget['关联应急编号'] || '（无）' }}
          将同步解除闭环。
        </p>
        <label class="form-item">
          <span>离岗备注</span>
          <textarea v-model="offDutyForm.note" rows="2" placeholder="如：正常交班离岗"></textarea>
        </label>
      </div>
      <template #footer>
        <button class="btn ghost" type="button" @click="offDutyOpen = false">取消</button>
        <button class="btn primary" type="button" @click="submitOffDuty">确认离岗</button>
      </template>
    </Modal>

    <!-- 标准流程图 -->
    <Modal :open="showStandardFlow" title="排班变更交接链路标准流程图" width="760px" @close="showStandardFlow = false">
      <StandardFlow />
    </Modal>

    <!-- 变更结果 / 链路详情 -->
    <Modal :open="Boolean(detailChain)" :title="detailTitle" width="780px" @close="detailChain = undefined">
      <ChainDetail v-if="detailChain" :chain="detailChain" />
      <template #footer>
        <button class="btn primary" type="button" @click="detailChain = undefined">知道了</button>
      </template>
    </Modal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  availableEmergencyTodos,
  confirmOnDuty,
  formatTime,
  handover,
  registerOffDuty,
  registerPerson,
  rowIsLegacy,
  submitSchedule as submitScheduleOp,
} from '@/api/crew-schedule-service'
import { chainStats, queryChains, storeWarning } from '@/api/handover-query-service'
import { POSITION_CATEGORIES } from '@/data/handover-types'
import type { EntryRow } from '@/data/types'
import type { CrewOperationResult, ScheduleInput } from '@/api/crew-schedule-service'
import type { HandoverChain } from '@/data/handover-types'
import ChainDetail from './components/ChainDetail.vue'
import Modal from './components/Modal.vue'
import StandardFlow from './components/StandardFlow.vue'

const meta = moduleMeta('crew_schedule')
const columns = ['人员编号', '姓名', '岗位类别', '所属班组', '排班日期', '值班时段', '在岗状态', '联络方式']
const eventOptions = ['登记人员', '安排排班', '确认在岗', '交接班', '登记离岗']
const positionOptions = [...POSITION_CATEGORIES]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['人员编号', '姓名', '岗位类别']

/* ---------------- 弹窗与表单状态 ---------------- */

const registerOpen = ref(false)
const scheduleOpen = ref(false)
const handoverOpen = ref(false)
const offDutyOpen = ref(false)
const showStandardFlow = ref(false)
const chainPanelOpen = ref(false)

const registerForm = reactive({ crewCode: '', name: '', position: '', team: '', contact: '' })
const scheduleForm = reactive({ date: today(), startTime: '08:00', endTime: '20:00', emergencyChoice: 'new' })
const handoverForm = reactive({ successorId: '', reason: '' })
const offDutyForm = reactive({ note: '' })

const scheduleTarget = ref<EntryRow>()
const handoverTarget = ref<EntryRow>()
const offDutyTarget = ref<EntryRow>()
const detailChain = ref<HandoverChain>()
const detailTitle = ref('交接链路详情')

const emergencyTodos = ref<EntryRow[]>([])
const storeWarningText = ref('')

/* ---------------- 链路追踪面板 ---------------- */

const chainKeyword = ref('')
const chainEventFilter = ref('')
const chainResultFilter = ref<'all' | 'success' | 'failed'>('all')
const chainStatsData = ref(chainStats())

const filteredChains = computed(() =>
  queryChains({
    keyword: chainKeyword.value,
    event: chainEventFilter.value || undefined,
    result: chainResultFilter.value,
  }),
)

function toggleChainPanel() {
  chainPanelOpen.value = !chainPanelOpen.value
}

function viewChain(chain: HandoverChain) {
  detailTitle.value = `交接链路详情 · ${chain.serial}`
  detailChain.value = chain
}

/* ---------------- 统计 ---------------- */

function today(): string {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const statusSummary = computed(() =>
  ['待排班', '已排班', '在岗', '已离岗'].map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const onDuty = rows.value.filter((row) => String(row.status) === '在岗').length
  const waiting = rows.value.filter((row) => String(row.status) === '待排班').length
  const todayRows = rows.value.filter(
    (row) => String(row['排班日期']) === today() && ['已排班', '在岗', '已离岗'].includes(String(row.status)),
  )
  const arrived = todayRows.filter((row) => ['在岗', '已离岗'].includes(String(row.status))).length
  const rate = todayRows.length === 0 ? 0 : Math.round((arrived / todayRows.length) * 100)
  return [
    { label: '在岗人员', value: onDuty },
    { label: '待排班人员', value: waiting },
    { label: `今日到岗率（${today()}）`, value: `${rate}%` },
    { label: '链路失败/回滚', value: chainStatsData.value.failed },
  ]
})

const teamOptions = computed(() => {
  const teams = new Set<string>()
  for (const row of rows.value) {
    const team = String(row['所属班组'] ?? '').trim()
    if (team) {
      teams.add(team)
    }
  }
  return [...teams]
})

const handoverCandidates = computed(() =>
  rows.value.filter((row) => ['待排班', '已离岗'].includes(String(row.status))),
)

function isLegacyRow(row: EntryRow): boolean {
  return rowIsLegacy(row)
}

/* ---------------- 数据加载 ---------------- */

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
    emergencyTodos.value = availableEmergencyTodos()
    chainStatsData.value = chainStats()
    storeWarningText.value = storeWarning()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '地勤排班列表读取失败'
  }
}

/* ---------------- 动作处理 ---------------- */

function handleResult(result: CrewOperationResult, successTitle: string) {
  reload()
  if (result.chain) {
    detailTitle.value = result.ok ? `${successTitle} · 链路已归档` : `${successTitle}失败 · 失败链路`
    detailChain.value = result.chain
  } else if (!result.ok) {
    errorMessage.value = result.message
  }
}

function openRegister() {
  Object.assign(registerForm, { crewCode: '', name: '', position: '', team: '', contact: '' })
  registerOpen.value = true
}

function submitRegister() {
  const result = registerPerson({ ...registerForm })
  if (result.ok) {
    registerOpen.value = false
  }
  handleResult(result, '人员登记')
}

function openSchedule(row: EntryRow) {
  scheduleTarget.value = row
  Object.assign(scheduleForm, { date: String(row['排班日期']) || today(), startTime: '08:00', endTime: '20:00', emergencyChoice: 'new' })
  emergencyTodos.value = availableEmergencyTodos()
  scheduleOpen.value = true
}

function applyPreset(start: string, end: string) {
  scheduleForm.startTime = start
  scheduleForm.endTime = end
}

function submitSchedule() {
  if (!scheduleTarget.value) {
    return
  }
  const payload: ScheduleInput = {
    personId: Number(scheduleTarget.value.id),
    date: scheduleForm.date,
    startTime: scheduleForm.startTime,
    endTime: scheduleForm.endTime,
  }
  if (scheduleForm.emergencyChoice !== 'new') {
    payload.emergencyTodoId = Number(scheduleForm.emergencyChoice)
  }
  const result = submitScheduleOp(payload)
  if (result.ok) {
    scheduleOpen.value = false
  }
  handleResult(result, '安排排班')
}

function onConfirmDuty(row: EntryRow) {
  handleResult(confirmOnDuty(Number(row.id)), '确认在岗')
}

function openHandover(row: EntryRow) {
  handoverTarget.value = row
  Object.assign(handoverForm, { successorId: '', reason: '' })
  handoverOpen.value = true
}

function submitHandover() {
  if (!handoverTarget.value || !handoverForm.successorId) {
    errorMessage.value = '请选择接班人'
    return
  }
  const result = handover({
    fromRowId: Number(handoverTarget.value.id),
    successorId: Number(handoverForm.successorId),
    reason: handoverForm.reason,
  })
  if (result.ok) {
    handoverOpen.value = false
  }
  handleResult(result, '交接班')
}

function openOffDuty(row: EntryRow) {
  offDutyTarget.value = row
  offDutyForm.note = ''
  offDutyOpen.value = true
}

function submitOffDuty() {
  if (!offDutyTarget.value) {
    return
  }
  const result = registerOffDuty({ rowId: Number(offDutyTarget.value.id), note: offDutyForm.note })
  if (result.ok) {
    offDutyOpen.value = false
  }
  handleResult(result, '登记离岗')
}

onMounted(reload)
</script>

<style scoped>
.banner {
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 13px;
}
.banner.warn {
  background: #fef3c7;
  border: 1px solid #f5c56b;
  color: #7c2d12;
}
.page-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.crew-table tr.legacy {
  background: #fffdf5;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 11px;
  margin-left: 4px;
  vertical-align: middle;
}
.tag-warn {
  background: #fef3c7;
  color: #92400e;
}
.tag-info {
  background: #eef4ff;
  color: #1d4ed8;
}
.link-danger {
  color: #b42318;
}
.muted-text {
  color: #94a3b8;
  font-size: 12px;
}
.chain-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border, #d8dee6);
  border-radius: 10px;
  padding: 12px 14px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.panel-head h3 {
  margin: 0;
  font-size: 15px;
}
.panel-tools {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.chain-search {
  width: 240px;
  padding: 5px 8px;
  border: 1px solid var(--border, #d8dee6);
  border-radius: 6px;
}
.panel-tools select {
  padding: 5px 8px;
  border: 1px solid var(--border, #d8dee6);
  border-radius: 6px;
}
.chain-summary {
  font-size: 12px;
  color: #475569;
  margin: 8px 0;
}
.row-failed {
  background: #fff7f6;
}
.stage-dots {
  display: inline-flex;
  gap: 4px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.dot.success {
  background: #1a7f37;
}
.dot.failed {
  background: #b42318;
}
.action-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.form-item > span {
  color: #475569;
  font-size: 12px;
}
.form-item input,
.form-item select,
.form-item textarea {
  border: 1px solid var(--border, #d8dee6);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.time-inputs {
  display: flex;
  align-items: center;
  gap: 6px;
}
.time-inputs input {
  flex: 1;
}
.time-inputs em {
  font-style: normal;
  color: #94a3b8;
}
.preset-row {
  display: flex;
  gap: 6px;
}
.btn-sm {
  padding: 3px 8px;
  font-size: 12px;
}
.form-hint {
  margin: 0;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.6;
}
</style>
