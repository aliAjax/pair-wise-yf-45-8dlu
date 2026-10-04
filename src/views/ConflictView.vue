<script setup lang="ts">
import { computed } from "vue";
import { useScheduleStore } from "../stores/schedule";
import { canUndo } from "../core/engine";
const store = useScheduleStore();
function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}

/** 已生效的冲突豁免操作（未被撤销），可在冲突中心直接撤销 */
const activeExemptions = computed(() =>
  store.operations
    .filter((op) => op.type === "冲突豁免" && op.undoneBySeq === undefined && op.conflictKey)
    .map((op) => ({ op, conflict: store.conflicts.find((c) => c.key === op.conflictKey) }))
);

function undoAllowed(seq: number): boolean {
  const op = store.operations.find((o) => o.seq === seq);
  return op ? canUndo(store.currentActor, op).allowed : false;
}
</script>
<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head">
        <div><h2>资源冲突中心</h2><small class="muted">每次场次修改或撤销后立即按最新现场重算；豁免本身是可撤销的操作单元，撤销后冲突回到清单</small></div>
        <span class="status">{{ store.conflicts.length }} 项待处理</span>
      </div>
      <article v-for="item in store.conflicts" :key="item.key" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div><b>{{ item.type }}</b><p>{{ item.message }}</p><small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small></div>
        <button class="secondary" :disabled="store.role === '场记' || store.role === '演员统筹'" @click="store.exemptConflict(item.key)">负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理冲突" />
    </section>

    <section class="panel">
      <div class="panel-head"><h2>已生效的冲突豁免</h2><span class="muted">仅制片可撤销制片确认的豁免</span></div>
      <el-empty v-if="!activeExemptions.length" description="暂无豁免记录" />
      <article v-for="{ op, conflict } in activeExemptions" :key="op.seq" class="exempt-row">
        <div>
          <b>#{{ op.seq }} {{ op.note }}</b>
          <p v-if="conflict" class="muted">豁免若撤销，该冲突将立即重新出现：{{ conflict.message }}</p>
          <p v-else class="muted">对应冲突目前已被其他改动化解；撤销豁免不会新增冲突。</p>
          <small class="muted">{{ op.actorName }} · {{ op.actorRole }}</small>
        </div>
        <button class="danger" :disabled="!undoAllowed(op.seq)" @click="store.requestUndo(op.seq)">撤销豁免</button>
      </article>
    </section>
  </section>
</template>
