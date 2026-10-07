<template>
  <div class="std-flow">
    <div class="flow-row">
      <div class="std-node entry">
        <strong>地勤人员发起变更</strong>
        <span>登记 / 排班 / 到岗 / 交接班 / 离岗</span>
      </div>
    </div>
    <FlowConnector label="①" />
    <div class="flow-row">
      <div class="std-node stage">
        <strong>① 校验登记</strong>
        <span>读懂人员编号、岗位类别、所属班组、值班时段、在岗状态</span>
      </div>
    </div>
    <div class="branch-row">
      <div class="branch-path">
        <FlowConnector label="字段缺失 / 状态不允许" kind="bad" />
        <div class="std-node bad">⛔ 拒绝并登记失败链路</div>
      </div>
      <div class="branch-path main">
        <FlowConnector label="校验通过" />
        <div class="std-node stage">
          <strong>② 冲突裁决</strong>
          <span>同一人员重叠时段并发登记，先登记者成功</span>
        </div>
      </div>
    </div>
    <div class="branch-row">
      <div class="branch-path">
        <FlowConnector label="后登记撞先登记" kind="bad" />
        <div class="std-node bad">⛔ 并发登记失败，以先登记结果为准</div>
      </div>
      <div class="branch-path main">
        <FlowConnector label="无重叠" />
        <div class="std-node stage">
          <strong>③ 排班写回</strong>
          <span>更新排班日期 / 值班时段 / 在岗状态 / 登记顺序</span>
        </div>
      </div>
    </div>
    <div class="branch-row">
      <div></div>
      <div class="branch-path main">
        <FlowConnector label="同一事务" />
      </div>
    </div>
    <div class="flow-row">
      <div class="std-node stage">
        <strong>④ 应急写回</strong>
        <span>排班结果写回应急保障待办；失败则回滚③，不留半截状态</span>
      </div>
    </div>
    <FlowConnector label="⑤" />
    <div class="flow-row">
      <div class="std-node stage">
        <strong>⑤ 链路归档（只追加）</strong>
        <span>成功、失败链路都留存；历史离岗记录保持原规则直接终态</span>
      </div>
    </div>
    <FlowConnector />
    <div class="flow-row">
      <div class="std-node ok">
        <strong>完成：排班与应急待办一致</strong>
        <span>链路可追溯，错误不静默跳过</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FlowConnector from './FlowConnector.vue'
</script>

<style scoped>
.std-flow {
  display: flex;
  flex-direction: column;
}
.flow-row {
  display: flex;
  justify-content: center;
}
.branch-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(260px, 1.4fr);
  gap: 12px;
  align-items: start;
}
.branch-path {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.branch-path.main {
  justify-self: stretch;
}
.std-node {
  border: 1px solid var(--border, #d8dee6);
  border-radius: 8px;
  padding: 8px 12px;
  background: #fff;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: center;
}
.std-node span {
  color: #475569;
  font-size: 12px;
}
.std-node.entry {
  background: #eef4ff;
  border-color: #1f6feb;
  text-align: center;
}
.std-node.stage {
  background: #f8fafc;
  border-left: 4px solid #1f6feb;
  text-align: left;
}
.std-node.bad {
  background: #fff1f0;
  border: 1px solid #f0a99f;
  color: #7a271a;
}
.std-node.ok {
  background: #e8f7ee;
  border-color: #1a7f37;
  color: #14532d;
}
</style>
