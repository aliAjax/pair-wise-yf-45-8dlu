<script setup lang="ts">
import dayjs from "dayjs";
import { computed } from "vue";
import { useScheduleStore } from "../stores/schedule";
import { canUndo, fieldLabels, fieldValueText } from "../core/engine";
import type { OperationRecord, SceneField } from "../types";

const store = useScheduleStore();

function undoPermission(op: OperationRecord) {
  return canUndo(store.currentActor, op);
}

const activeOps = computed(() => store.operations.filter((op) => op.undoneBySeq === undefined && !op.note.startsWith("撤销 #")));
const undoOps = computed(() => store.operations.filter((op) => op.note.startsWith("撤销 #")));

function pendingTarget(seq: number) {
  return store.pendingUndos.find((p) => p.targetSeq === seq);
}

function typeClass(type: string) {
  return `op-type ${type}`;
}
</script>

<template>
  <section class="page grid-2 history-grid">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>操作单元（可检查 / 可撤销）</h2>
          <small class="muted">撤销只还原该单元触及的字段；后续已生效的场地、器材等改动留在现场，冲突立即重算。</small>
        </div>
        <span class="status">最新 #{{ store.ledgerSeq }}</span>
      </div>

      <div v-if="store.pendingUndos.length" class="pending-box">
        <h3>待撤销清单（写入失败后保留，重试从原基线继续）</h3>
        <article v-for="item in store.pendingUndos" :key="item.requestId" class="pending-row">
          <div>
            <b>撤销 #{{ item.targetSeq }}：{{ item.note }}</b>
            <small class="muted">
              原基线 #{{ item.baselineSeq }} · 当前 #{{ store.ledgerSeq }} · 已尝试 {{ item.attempts }} 次
              <template v-if="item.lastError"> · 上次失败：{{ item.lastError }}</template>
            </small>
          </div>
          <div class="actions">
            <button class="primary" @click="store.requestUndo(item.targetSeq)">从原基线重试</button>
            <button class="secondary" @click="store.rebaseAndRetry(item)">按最新编号对齐后重试</button>
            <button class="danger" @click="store.discardPending(item.requestId)">放弃</button>
          </div>
        </article>
      </div>

      <div class="ops">
        <el-empty v-if="!store.operations.length" description="尚无操作单元" />
        <article v-for="op in activeOps" :key="op.seq" class="op-row" :class="{ undone: op.undoneBySeq !== undefined }">
          <header>
            <b class="seq">#{{ op.seq }}</b>
            <span :class="typeClass(op.type)">{{ op.type }}</span>
            <b>{{ op.note }}</b>
            <span class="muted">{{ dayjs(op.time).format("MM-DD HH:mm:ss") }}</span>
          </header>
          <div v-if="op.changes?.length" class="changes">
            <div v-for="c in op.changes" :key="c.field" class="change-line">
              <span>{{ fieldLabels[c.field as SceneField] }}</span>
              <del>{{ fieldValueText(c.field as SceneField, c.before) }}</del>
              <i>→</i>
              <b>{{ fieldValueText(c.field as SceneField, c.after) }}</b>
            </div>
          </div>
          <footer>
            <small class="muted">{{ op.actorName }}（{{ op.actorRole }}）提交</small>
            <button
              class="danger"
              :disabled="!undoPermission(op).allowed || !!pendingTarget(op.seq)"
              :title="undoPermission(op).reason ?? '撤销该操作单元'"
              @click="store.requestUndo(op.seq)"
            >
              {{ pendingTarget(op.seq) ? "已在待撤销清单" : "撤销此单元" }}
            </button>
          </footer>
          <small v-if="!undoPermission(op).allowed" class="deny-reason">{{ undoPermission(op).reason }}</small>
        </article>
      </div>
    </section>

    <div style="display:grid;gap:18px;align-items:start">
      <section class="panel">
        <div class="panel-head"><h2>撤销记录</h2><span class="muted">撤销也产生编号，便于并发对账</span></div>
        <el-empty v-if="!undoOps.length && !store.operations.some(o => o.undoneBySeq !== undefined)" description="暂无撤销" />
        <div class="undo-list">
          <div v-for="op in store.operations.filter(o => o.note.startsWith('撤销 #'))" :key="op.seq" class="history-row">
            <span class="muted">{{ dayjs(op.time).format("MM-DD HH:mm:ss") }}</span>
            <b>#{{ op.seq }}</b>
            <span>{{ op.note }} — {{ op.actorName }}</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div><h2>版本快照（只读参考）</h2><small class="muted">不再整版恢复覆盖他人改动；需要回退请在左侧按操作单元撤销</small></div>
          <button class="primary" :disabled="store.role === '场记'" @click="store.snapshot()">创建快照</button>
        </div>
        <el-empty v-if="!store.versions.length" description="尚未创建快照" />
        <article v-for="item in store.versions" :key="item.id" class="snapshot-row">
          <div><b>{{ item.name }}</b><br><small class="muted">{{ dayjs(item.time).format("YYYY-MM-DD HH:mm:ss") }} · {{ item.scenes.length }} 场（存档对比用，不覆盖现场）</small></div>
        </article>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>审计事件</h2></div>
        <el-empty v-if="!store.history.length" description="暂无事件" />
        <div class="undo-list">
          <div v-for="item in store.history" :key="item.id" class="history-row"><span class="muted">{{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</span><b>{{ item.action }}</b><span>{{ item.detail }}</span></div>
        </div>
      </section>

      <section class="panel debug-box">
        <div class="panel-head"><h2>故障演练</h2><small class="muted">验证"写入失败留住待撤销清单、重试从原基线继续、重复提交不多一条记录"</small></div>
        <div class="actions">
          <button class="secondary" @click="store.injectWriteFailures(1)">模拟下一次写入失败</button>
          <button class="danger" @click="store.debugReset()">清空操作日志（复位演示）</button>
        </div>
      </section>
    </div>
  </section>
</template>
