<template>
  <div class="chain-flow">
    <div class="flow-scroll">
      <div class="flow-track">
        <template v-for="(node, index) in nodes" :key="node.key">
          <div
            class="flow-node"
            :class="statusClass(node.key)"
            :title="detailOf(node.label)"
          >
            <span class="flow-index">{{ index + 1 }}</span>
            <span class="flow-label">{{ node.label }}</span>
          </div>
          <div v-if="index < nodes.length - 1" class="flow-arrow" :class="arrowClass(index)">→</div>
        </template>
      </div>
    </div>

    <ul v-if="stages.length" class="stage-list">
      <li v-for="stage in stages" :key="`${stage.name}-${stage.seq}`" class="stage-item" :class="`is-${stage.status}`">
        <span class="stage-badge">{{ badgeText(stage.status) }}</span>
        <span class="stage-name">{{ stage.name }}<em v-if="batch">（第 {{ stage.seq }} 笔）</em></span>
        <span class="stage-detail">{{ stage.detail }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import type { ChainStage, FlowNode } from '@/data/types'

const props = withDefaults(
  defineProps<{
    nodes: FlowNode[]
    stages?: ChainStage[]
    batch?: boolean
  }>(),
  { stages: () => [], batch: false },
)

// 一个环节可能出现多笔（同批并发），任一 error 即红、任一 warn 即黄、全 ok 才绿。
const stageByKey = computed(() => {
  const map = new Map<string, ChainStage[]>()
  for (const stage of props.stages) {
    const list = map.get(stage.name) ?? []
    list.push(stage)
    map.set(stage.name, list)
  }
  return map
})

function statusOf(label: string): 'ok' | 'warn' | 'error' | 'idle' {
  const list = stageByKey.value.get(label)
  if (!list || !list.length) {
    return 'idle'
  }
  if (list.some((stage) => stage.status === 'error')) {
    return 'error'
  }
  if (list.some((stage) => stage.status === 'warn')) {
    return 'warn'
  }
  return 'ok'
}

function statusClass(key: string) {
  const node = props.nodes.find((item) => item.key === key)
  return `is-${node ? statusOf(node.label) : 'idle'}`
}

function arrowClass(index: number) {
  const current = props.nodes[index]
  return statusOf(current.label) === 'error' ? 'is-blocked' : ''
}

function detailOf(label: string): string {
  const list = stageByKey.value.get(label)
  return list ? list.map((stage) => stage.detail).join('\n') : '尚未执行'
}

function badgeText(status: ChainStageStatus): string {
  return status === 'ok' ? '通过' : status === 'warn' ? '兼容' : '阻断'
}
</script>

<style scoped>
.chain-flow {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.flow-scroll {
  overflow-x: auto;
  padding-bottom: 4px;
}
.flow-track {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-width: min-content;
}
.flow-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 118px;
  max-width: 150px;
  padding: 8px 10px;
  border: 1.5px solid var(--border);
  border-radius: 8px;
  background: #fff;
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
}
.flow-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #e2e8f0;
  color: #475569;
  font-size: 11px;
  font-style: normal;
}
.flow-label {
  font-weight: 600;
}
.flow-node.is-ok {
  border-color: #16a34a;
  background: #f0fdf4;
}
.flow-node.is-ok .flow-index {
  background: #16a34a;
  color: #fff;
}
.flow-node.is-warn {
  border-color: #d97706;
  background: #fffbeb;
}
.flow-node.is-warn .flow-index {
  background: #d97706;
  color: #fff;
}
.flow-node.is-error {
  border-color: #dc2626;
  background: #fef2f2;
}
.flow-node.is-error .flow-index {
  background: #dc2626;
  color: #fff;
}
.flow-node.is-idle {
  border-style: dashed;
  color: var(--muted);
}
.flow-arrow {
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: #94a3b8;
  font-size: 15px;
}
.flow-arrow.is-blocked {
  color: #dc2626;
}
.stage-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.stage-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 12px;
  border-left: 3px solid var(--border);
  padding: 4px 8px;
  background: #f8fafc;
  border-radius: 0 6px 6px 0;
}
.stage-item.is-ok {
  border-left-color: #16a34a;
}
.stage-item.is-warn {
  border-left-color: #d97706;
  background: #fffbeb;
}
.stage-item.is-error {
  border-left-color: #dc2626;
  background: #fef2f2;
}
.stage-badge {
  flex: none;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  color: #fff;
  background: #64748b;
}
.stage-item.is-ok .stage-badge {
  background: #16a34a;
}
.stage-item.is-warn .stage-badge {
  background: #d97706;
}
.stage-item.is-error .stage-badge {
  background: #dc2626;
}
.stage-name {
  flex: none;
  font-weight: 600;
  min-width: 96px;
}
.stage-name em {
  color: var(--muted);
  font-style: normal;
  font-size: 11px;
}
.stage-detail {
  color: #334155;
  word-break: break-all;
}
</style>
