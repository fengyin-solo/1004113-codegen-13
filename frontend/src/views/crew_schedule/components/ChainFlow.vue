<template>
  <div class="chain-flow" :class="{ 'is-failed': !chain.success }">
    <div class="flow-node start">
      <strong>{{ chain.event }}</strong>
      <span class="node-sub">{{ chain.serial }} · 登记顺序 #{{ chain.registerOrder }}</span>
      <span class="node-sub">{{ chain.crewCode }} {{ chain.crewName }}（{{ chain.team }}）</span>
      <span v-if="chain.successorCode" class="node-sub">接班人：{{ chain.successorCode }} {{ chain.successorName }}</span>
    </div>

    <template v-for="stage in chain.stages" :key="stage.order">
      <div class="flow-link" aria-hidden="true">
        <span class="link-line"></span>
        <span class="link-arrow">↓</span>
      </div>
      <div class="flow-step">
        <div class="flow-node stage" :class="stage.status === 'failed' ? 'failed' : 'success'">
          <div class="stage-head">
            <strong>{{ stage.label }}</strong>
            <span class="stage-time">{{ formatTime(stage.at) }}</span>
          </div>
          <span class="node-sub">{{ stage.detail }}</span>
        </div>
        <div v-if="stage.status === 'failed'" class="flow-error">
          <span class="error-arrow" aria-hidden="true">←</span>
          <div class="error-box">
            <strong>⛔ 环节失败（不静默跳过）</strong>
            <span>{{ stage.error }}</span>
          </div>
        </div>
      </div>
    </template>

    <div class="flow-link" aria-hidden="true">
      <span class="link-line"></span>
      <span class="link-arrow">↓</span>
    </div>
    <div class="flow-node end" :class="chain.success ? 'ok' : 'bad'">
      <strong v-if="chain.success">变更完成</strong>
      <strong v-else>变更被拒绝 / 已回滚</strong>
      <span class="node-sub">结果在岗状态：{{ chain.resultStatus }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatTime } from '@/api/crew-schedule-service'
import type { HandoverChain } from '@/data/handover-types'

defineProps<{ chain: HandoverChain }>()
</script>

<style scoped>
.chain-flow {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.flow-node {
  border: 1px solid var(--border, #d8dee6);
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.flow-node.start {
  background: #eef4ff;
  border-color: #1f6feb;
  align-self: stretch;
}
.node-sub {
  color: #475569;
  font-size: 12px;
}
.flow-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 22px;
}
.link-line {
  width: 2px;
  flex: 1;
  background: #94a3b8;
}
.link-arrow {
  color: #64748b;
  font-size: 11px;
  line-height: 11px;
}
.flow-step {
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}
.flow-node.stage.success {
  border-left: 4px solid #1a7f37;
  background: #f4fbf6;
}
.flow-node.stage.failed {
  border-left: 4px solid #b42318;
  background: #fff1f0;
}
.stage-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.stage-time {
  color: #94a3b8;
  font-size: 11px;
}
.flow-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding-left: 18px;
}
.error-arrow {
  color: #b54708;
  font-size: 13px;
  line-height: 20px;
}
.error-box {
  flex: 1;
  border: 1px dashed #b54708;
  background: #fef3c7;
  color: #7c2d12;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.flow-node.end.ok {
  background: #e8f7ee;
  border-color: #1a7f37;
}
.flow-node.end.bad {
  background: #fee4e2;
  border-color: #b42318;
}
</style>
