<script setup lang="ts">
import { onMounted, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";
import type { FieldChange, Operation } from "../types";

const schedule = useScheduleStore();
/** 调用方看到的最新操作编号，用于乐观并发检查 */
const baseline = ref(0);

onMounted(() => {
  baseline.value = schedule.latestSeq;
});

function refreshBaseline() {
  baseline.value = schedule.latestSeq;
  ElMessage.info(`已同步最新操作编号 #${baseline.value}`);
}

function displayValue(change: FieldChange, value: unknown): string {
  if (Array.isArray(value)) {
    if (change.field === "talentIds") return schedule.talentNames(value as string[]).join("、") || "—";
    if (change.field === "equipmentIds") return schedule.equipmentNames(value as string[]).join("、") || "—";
    return value.join("、") || "—";
  }
  if (change.field === "locationId") return schedule.locationName(value as string);
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value ?? "—");
}

async function undo(item: Operation) {
  const result = await schedule.undoOperation(item.id, baseline.value);
  if (result.ok) {
    ElMessage.success(`已撤销：${item.summary}`);
    baseline.value = schedule.latestSeq;
    return;
  }
  const error = result.error!;
  if (error.type === "conflict") {
    ElMessage.error(`操作冲突：最新操作编号 #${error.latestSeq}${error.latestSummary ? `（${error.latestSummary}）` : ""}，请刷新后重试`);
    baseline.value = schedule.latestSeq;
  } else if (error.type === "unauthorized") {
    ElMessage.error(error.message);
  } else if (error.type === "write-failed") {
    ElMessage.warning("写入失败，已保留在待撤销清单，可重试");
  } else if (error.type === "in-flight") {
    ElMessage.info(error.message);
  } else {
    ElMessage.warning(error.message);
  }
}

async function retry(id: string) {
  const result = await schedule.retryUndo(id);
  if (result.ok) {
    ElMessage.success("重试成功，已完成撤销");
    baseline.value = schedule.latestSeq;
  } else {
    ElMessage.error(result.error?.message ?? "重试失败");
  }
}
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>待撤销清单</h2>
          <small class="muted">写入失败时留住待撤销项，重试从原基线继续，重复提交不会多出撤销记录</small>
        </div>
        <label class="sim-toggle">模拟写入失败<el-switch v-model="schedule.forceWriteError" /></label>
      </div>
      <el-empty v-if="!schedule.pendingUndos.length" description="无待撤销项" />
      <article v-for="item in schedule.pendingUndos" :key="item.id" class="pending-row">
        <div>
          <b>撤销操作 #{{ item.targetOpId.slice(0, 8) }}</b>
          <small>基线 #{{ item.baseline }} · 已重试 {{ item.attempts }} 次 · {{ dayjs(item.createdAt).format("MM-DD HH:mm:ss") }}</small>
          <small v-if="item.lastError" class="error-text">最近错误：{{ item.lastError }}</small>
        </div>
        <div class="actions">
          <button class="primary" :disabled="schedule.inFlight.includes(item.id)" @click="retry(item.id)">{{ schedule.inFlight.includes(item.id) ? "写入中…" : "重试" }}</button>
          <button class="secondary" @click="schedule.dismissPending(item.id)">移除</button>
        </div>
      </article>
    </section>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><div><h2>版本快照</h2><small class="muted">恢复会覆盖当前通告，但保留恢复记录</small></div><button class="primary" :disabled="schedule.role === '场记'" @click="schedule.snapshot()">创建版本</button></div>
        <el-empty v-if="!schedule.versions.length" description="尚未创建版本" />
        <article v-for="item in schedule.versions" :key="item.id" class="draft-banner" style="margin-bottom:10px">
          <div><b>{{ item.name }}</b><br><small>{{ dayjs(item.time).format("YYYY-MM-DD HH:mm:ss") }} · {{ item.scenes.length }} 场</small></div>
          <button class="secondary" :disabled="schedule.role !== '制片'" @click="schedule.restore(item.id)">恢复</button>
        </article>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>操作单元</h2>
            <small class="muted">场次修改、锁定、状态流转、冲突豁免均为可检查的操作单元，撤销只还原受影响字段</small>
          </div>
          <button class="secondary" @click="refreshBaseline">最新操作 #{{ schedule.latestSeq }} ↻</button>
        </div>
        <el-empty v-if="!schedule.operations.length" description="暂无操作" />
        <article v-for="item in schedule.operations" :key="item.id" class="op-row" :class="{ undone: item.undone }">
          <div class="op-head">
            <span class="seq">#{{ item.seq }}</span>
            <span class="kind" :class="item.kind">{{ item.kind }}</span>
            <span class="actor">{{ item.actor }}</span>
            <span class="time">{{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</span>
            <span v-if="item.undone" class="undone-tag">已撤销{{ item.undoneAt ? ` · ${dayjs(item.undoneAt).format("MM-DD HH:mm:ss")}` : "" }}</span>
          </div>
          <div class="op-summary">{{ item.summary }}</div>
          <ul class="op-changes">
            <li v-for="(change, index) in item.changes" :key="index">
              <span class="field-label">{{ change.label }}</span>
              <span class="before">{{ displayValue(change, change.before) }}</span>
              <span class="arrow">→</span>
              <span class="after">{{ displayValue(change, change.after) }}</span>
            </li>
          </ul>
          <div v-if="item.kind !== '撤销'" class="op-actions">
            <button class="secondary" :disabled="item.undone" @click="undo(item)">{{ item.undone ? "已撤销" : "撤销此项" }}</button>
          </div>
        </article>
      </section>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>活动记录</h2></div>
      <div class="history">
        <el-empty v-if="!schedule.history.length" description="暂无操作" />
        <div v-for="item in schedule.history" :key="item.id" class="history-row"><span class="muted">{{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</span><b>{{ item.action }}</b><span>{{ item.detail }}</span></div>
      </div>
    </section>
  </section>
</template>
