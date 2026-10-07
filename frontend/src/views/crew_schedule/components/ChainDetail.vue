<template>
  <div class="chain-detail">
    <section class="detail-section">
      <h4>变更链路流程图</h4>
      <ChainFlow :chain="chain" />
    </section>

    <section class="detail-section">
      <h4>环节明细（{{ chain.stages.length }} 个环节）</h4>
      <table class="stage-table">
        <thead>
          <tr>
            <th style="width: 44px">序号</th>
            <th style="width: 130px">环节</th>
            <th>经过说明</th>
            <th style="width: 70px">结果</th>
            <th style="width: 150px">时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="stage in chain.stages" :key="stage.order" :class="{ failed: stage.status === 'failed' }">
            <td>{{ stage.order }}</td>
            <td>{{ stage.label }}</td>
            <td>
              <div>{{ stage.detail }}</div>
              <div v-if="stage.error" class="stage-error">⛔ {{ stage.error }}</div>
            </td>
            <td>
              <span class="badge" :class="stage.status">{{ stage.status === 'success' ? '通过' : '失败' }}</span>
            </td>
            <td>{{ formatTime(stage.at) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { formatTime } from '@/api/crew-schedule-service'
import type { HandoverChain } from '@/data/handover-types'
import ChainFlow from './ChainFlow.vue'

defineProps<{ chain: HandoverChain }>()
</script>

<style scoped>
.detail-section {
  margin-bottom: 16px;
}
.detail-section h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: #334155;
}
.stage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.stage-table th,
.stage-table td {
  border: 1px solid var(--border, #d8dee6);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.stage-table tr.failed {
  background: #fff7f6;
}
.stage-error {
  color: #b42318;
  margin-top: 2px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
}
.badge.success {
  background: #e8f7ee;
  color: #1a7f37;
}
.badge.failed {
  background: #fee4e2;
  color: #b42318;
}
</style>
