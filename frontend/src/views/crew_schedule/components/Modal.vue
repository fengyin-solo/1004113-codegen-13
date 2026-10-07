<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="$emit('close')">
      <div class="modal-box" :style="{ maxWidth: width }" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h3>{{ title }}</h3>
          <button type="button" class="link" @click="$emit('close')">关闭</button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ open: boolean; title: string; width?: string }>(), {
  width: '560px',
})
defineEmits<{ (event: 'close'): void }>()
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  z-index: 1000;
  overflow-y: auto;
}
.modal-box {
  width: 100%;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #d8dee6);
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
}
.modal-body {
  padding: 14px 16px;
  max-height: 70vh;
  overflow-y: auto;
}
.modal-foot {
  padding: 10px 16px;
  border-top: 1px solid var(--border, #d8dee6);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
