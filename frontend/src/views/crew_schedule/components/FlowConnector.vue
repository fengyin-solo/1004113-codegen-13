<template>
  <div class="flow-connector" :class="kind">
    <span class="connector-label">{{ label }}</span>
    <span class="connector-line"></span>
    <span class="connector-arrow">↓</span>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    label?: string
    kind?: 'normal' | 'bad'
  }>(),
  { label: '', kind: 'normal' },
)
</script>

<style scoped>
.flow-connector {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 30px;
}
.connector-label {
  font-size: 11px;
  color: #64748b;
  background: #f6f8fb;
  padding: 0 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.connector-line {
  width: 2px;
  flex: 1;
  background: #94a3b8;
}
.connector-arrow {
  color: #64748b;
  font-size: 11px;
  line-height: 10px;
}
.flow-connector.bad .connector-label {
  color: #b42318;
  background: #fff1f0;
}
.flow-connector.bad .connector-line,
.flow-connector.bad .connector-arrow {
  background: #f0a99f;
  color: #b42318;
}
.flow-connector.bad .connector-line {
  background: #f0a99f;
}
</style>
