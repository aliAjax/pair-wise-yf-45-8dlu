<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import { isSceneLocked } from "../core/engine";
import { nextStatus } from "../data/catalog";
import type { FieldValues, Scene, SceneField, SceneStatus } from "../types";

const store = useScheduleStore();
const saving = ref(false);
const draggingId = ref<string | null>(null);
const form = reactive({ code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });
const editable = computed(() => store.role === "制片" || store.role === "导演");
const canReorder = computed(() => editable.value);

/* 场次修改对话框 */
const editing = ref(false);
const savingEdit = ref(false);
const editId = ref("");
const editForm = reactive({ code: "", title: "", day: "", start: "", end: "", locationId: "", talentIds: [] as string[], equipmentIds: [] as string[] });
const editBaseline = ref<FieldValues>({});

function locked(scene: Scene): boolean {
  return isSceneLocked(scene.id, store.operations);
}

function startEdit(scene: Scene) {
  editId.value = scene.id;
  Object.assign(editForm, {
    code: scene.code,
    title: scene.title,
    day: scene.day,
    start: scene.start,
    end: scene.end,
    locationId: scene.locationId,
    talentIds: [...scene.talentIds],
    equipmentIds: [...scene.equipmentIds]
  });
  editBaseline.value = {
    code: scene.code,
    title: scene.title,
    day: scene.day,
    start: scene.start,
    end: scene.end,
    locationId: scene.locationId,
    talentIds: [...scene.talentIds],
    equipmentIds: [...scene.equipmentIds]
  };
  editing.value = true;
}

async function submitEdit() {
  const scene = store.scenes.find((s) => s.id === editId.value);
  if (!scene) return;
  const before: FieldValues = {};
  const after: FieldValues = {};
  const candidates: [SceneField, unknown][] = [
    ["code", editForm.code],
    ["title", editForm.title],
    ["day", editForm.day],
    ["start", editForm.start],
    ["end", editForm.end],
    ["locationId", editForm.locationId],
    ["talentIds", [...editForm.talentIds]],
    ["equipmentIds", [...editForm.equipmentIds]]
  ];
  for (const [field, value] of candidates) {
    const base = (editBaseline.value as Record<string, unknown>)[field];
    if (JSON.stringify(base) !== JSON.stringify(value)) {
      (before as Record<string, unknown>)[field] = base;
      (after as Record<string, unknown>)[field] = value;
    }
  }
  if (!Object.keys(after).length) {
    editing.value = false;
    return;
  }
  savingEdit.value = true;
  await store.modifyScene(editId.value, before, after);
  savingEdit.value = false;
  editing.value = false;
}

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  await store.addScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

/** 拖动到目标场次位置：取前后相邻场次 order 的中点，只产生一条"顺序调整"操作单元 */
function dropOn(targetId: string) {
  if (!draggingId.value || draggingId.value === targetId) {
    draggingId.value = null;
    return;
  }
  const list = store.sortedScenes;
  const targetIndex = list.findIndex((s) => s.id === targetId);
  const dragged = list.find((s) => s.id === draggingId.value);
  if (!dragged || locked(dragged)) {
    draggingId.value = null;
    return;
  }
  const before = dragged.order;
  const prev = list[targetIndex - 1];
  const next = list[targetIndex + 1];
  const lower = prev ? prev.order : (Math.min(...list.map((s) => s.order)) - 1);
  const upper = next ? next.order : (Math.max(...list.map((s) => s.order)) + 1);
  const after = Math.round(((lower + upper) / 2) * 1000) / 1000;
  void store.moveScene(dragged.id, before, after);
  draggingId.value = null;
}

async function advance(scene: Scene) {
  const next = nextStatus[scene.status] as SceneStatus;
  if (next === scene.status) return;
  await store.updateStatus(scene.id, scene.status, next);
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === '已确认').length }}</strong></article>
      <article class="metric"><span>操作编号</span><strong>#{{ store.ledgerSeq }}</strong></article>
    </div>
    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次。</span>
      <div class="actions"><button class="secondary" @click="store.syncDraft">作为新场次并入</button></div>
    </div>
    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide"><button class="primary" :disabled="saving || !editable" type="submit">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div><h2>当日通告顺序</h2><small class="muted">每次修改、锁定、状态流转、拖动都记为一个操作单元，可在"操作单元"页按字段撤销，无需回滚整个版本</small></div>
          <button class="primary" :disabled="store.role === '场记'" @click="store.snapshot()">保存版本快照</button>
        </div>
        <div class="scene-list">
          <article
            v-for="(scene,index) in store.sortedScenes"
            :key="scene.id"
            class="scene"
            :class="{ locked: locked(scene), dragging: draggingId === scene.id, denied: !canReorder }"
            draggable="true"
            @dragstart="draggingId=scene.id"
            @dragover.prevent
            @drop="dropOn(scene.id)"
          >
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ scene.day }} {{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}<em v-if="locked(scene)" class="lock-tag">已锁定</em></small>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || locked(scene)" @click="advance(scene)">推进</button>
              <button class="secondary" :disabled="store.role === '场记' || store.role === '演员统筹'" @click="store.setLock(scene.id, !locked(scene))">{{ locked(scene) ? "解锁" : "锁定" }}</button>
              <button class="secondary" :disabled="!editable || locked(scene)" @click="startEdit(scene)">修改</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <el-dialog v-model="editing" title="修改场次（仅提交变化字段，可按字段撤销）" width="560px">
      <form class="form-grid" @submit.prevent="submitEdit">
        <label class="field"><span>场次编号</span><input v-model="editForm.code" /></label>
        <label class="field"><span>场次名称</span><input v-model="editForm.title" /></label>
        <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
        <label class="field"><span>场地</span><select v-model="editForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label class="field"><span>开始</span><input v-model="editForm.start" type="time" /></label>
        <label class="field"><span>结束</span><input v-model="editForm.end" type="time" /></label>
        <label class="field wide"><span>演员档期</span><select v-model="editForm.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
        <label class="field wide"><span>器材借用</span><select v-model="editForm.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      </form>
      <template #footer>
        <button class="secondary" @click="editing = false">取消</button>
        <button class="primary" :disabled="savingEdit" @click="submitEdit">提交修改操作单元</button>
      </template>
    </el-dialog>
  </section>
</template>
