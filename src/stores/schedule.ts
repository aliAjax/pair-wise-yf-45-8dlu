import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, FieldChange, HistoryEntry, Location, OfflineDraft, Operation, PendingUndo, Role, Scene, SceneStatus, Talent, UndoResult, Version } from "../types";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v1";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头" },
  { id: "l2", name: "玻璃厂房" },
  { id: "l3", name: "南站候车厅" }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, order: 0 },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false, order: 1 },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, order: 2 }
];

const FIELD_LABELS: Record<string, string> = {
  code: "编号", title: "名称", day: "拍摄日", start: "开始时间", end: "结束时间",
  talentIds: "演员", locationId: "场地", equipmentIds: "器材", status: "状态",
  locked: "锁定", order: "排序", exemption: "冲突豁免"
};

function normalizeScenes(raw: unknown): Scene[] {
  const list = Array.isArray(raw) ? raw as Scene[] : structuredClone(seedScenes);
  return list.map((scene, index) => ({ ...scene, order: typeof scene.order === "number" ? scene.order : index }));
}

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { scenes: structuredClone(seedScenes), history: [] as HistoryEntry[], versions: [] as Version[], operations: [] as Operation[], exemptions: [] as string[] };
    const parsed = JSON.parse(raw);
    return {
      scenes: normalizeScenes(parsed.scenes),
      history: (parsed.history ?? []) as HistoryEntry[],
      versions: (parsed.versions ?? []) as Version[],
      operations: (parsed.operations ?? []) as Operation[],
      exemptions: (parsed.exemptions ?? []) as string[]
    };
  } catch {
    return { scenes: structuredClone(seedScenes), history: [], versions: [], operations: [], exemptions: [] };
  }
}

function readDraft(): OfflineDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) as OfflineDraft : null;
  } catch {
    return null;
  }
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

export const useScheduleStore = defineStore("schedule", () => {
  const initial = readState();
  const scenes = ref<Scene[]>(initial.scenes);
  const history = ref<HistoryEntry[]>(initial.history);
  const versions = ref<Version[]>(initial.versions);
  const operations = ref<Operation[]>(initial.operations);
  const exemptions = ref<string[]>(initial.exemptions);
  const pendingUndos = ref<PendingUndo[]>([]);
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);
  /** 演示用：置 true 后撤销写入会失败，用于验证待撤销清单与重试 */
  const forceWriteError = ref(false);
  /** 正在写入中的幂等键，防止重复提交产生第二条记录 */
  const inFlight = ref<string[]>([]);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  const latestSeq = computed(() => operations.value.reduce((max, op) => Math.max(max, op.seq), 0));

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const pairId = `${a.id}:${b.id}`;
        if (shared(a.talentIds, b.talentIds)) {
          const id = `${pairId}:talent`;
          if (!exemptions.value.includes(id)) result.push({ id, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        }
        if (a.locationId === b.locationId) {
          const id = `${pairId}:location`;
          if (!exemptions.value.includes(id)) result.push({ id, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        }
        if (shared(a.equipmentIds, b.equipmentIds)) {
          const id = `${pairId}:equipment`;
          if (!exemptions.value.includes(id)) result.push({ id, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        }
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) {
          const id = `${pairId}:transfer`;
          if (!exemptions.value.includes(id)) result.push({ id, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
        }
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => a.order - b.order || `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        scenes: scenes.value,
        history: history.value,
        versions: versions.value,
        operations: operations.value,
        exemptions: exemptions.value
      }));
    } catch {
      /* 持久化失败不阻断内存操作，撤销写入失败由 writeOperations 捕获 */
    }
  }

  watch([scenes, history, versions, operations, exemptions], persist, { deep: true });

  /** 模拟一次可能失败的后端写入（撤销事务） */
  async function writeOperations(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (forceWriteError.value) throw new Error("写入失败：工作区不可写");
  }

  function recordOperation(input: { kind: Operation["kind"]; sceneId?: string; sceneCode?: string; summary: string; changes: FieldChange[] }): Operation {
    const seq = latestSeq.value + 1;
    const op: Operation = {
      id: crypto.randomUUID(),
      seq,
      kind: input.kind,
      actor: role.value,
      time: new Date().toISOString(),
      sceneId: input.sceneId,
      sceneCode: input.sceneCode,
      summary: input.summary,
      changes: input.changes,
      undone: false,
      baseline: latestSeq.value
    };
    operations.value.unshift(op);
    log(input.kind, input.summary);
    return op;
  }

  function diffScene(scene: Scene, patch: Partial<Scene>): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const key of Object.keys(patch) as (keyof Scene)[]) {
      const before = (scene as unknown as Record<string, unknown>)[key];
      const after = (patch as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      changes.push({ sceneId: scene.id, field: key, label: FIELD_LABELS[key] ?? key, before, after });
    }
    return changes;
  }

  function applyChanges(changes: FieldChange[]) {
    for (const change of changes) {
      if (change.sceneId) {
        const scene = scenes.value.find((item) => item.id === change.sceneId);
        if (scene) (scene as unknown as Record<string, unknown>)[change.field] = change.after;
      } else if (change.conflictId) {
        if (change.after === true) {
          if (!exemptions.value.includes(change.conflictId)) exemptions.value.push(change.conflictId);
        } else {
          exemptions.value = exemptions.value.filter((id) => id !== change.conflictId);
        }
      }
    }
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "order">) {
    const order = scenes.value.reduce((max, item) => Math.max(max, item.order), -1) + 1;
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, order });
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateScene(id: string, patch: Partial<Scene>) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    const changes = diffScene(scene, patch);
    if (!changes.length) return;
    Object.assign(scene, patch);
    recordOperation({ kind: "场次修改", sceneId: id, sceneCode: scene.code, summary: `修改 ${scene.code} ${scene.title}`, changes });
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked || scene.status === status) return;
    const before = scene.status;
    scene.status = status;
    recordOperation({ kind: "状态流转", sceneId: id, sceneCode: scene.code, summary: `${scene.code} ${before} → ${status}`, changes: [{ sceneId: id, field: "status", label: FIELD_LABELS.status, before, after: status }] });
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    const before = scene.locked;
    scene.locked = !before;
    recordOperation({ kind: "锁定", sceneId: id, sceneCode: scene.code, summary: scene.locked ? `锁定 ${scene.code}` : `解锁 ${scene.code}`, changes: [{ sceneId: id, field: "locked", label: FIELD_LABELS.locked, before, after: !before }] });
  }

  function moveScene(from: number, to: number) {
    const list = [...sortedScenes.value];
    if (from === to || to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item);
    const changes: FieldChange[] = [];
    list.forEach((scene, index) => {
      if (scene.order !== index) {
        changes.push({ sceneId: scene.id, field: "order", label: FIELD_LABELS.order, before: scene.order, after: index });
        scene.order = index;
      }
    });
    recordOperation({ kind: "场次修改", sceneId: item.id, sceneCode: item.code, summary: `调整 ${item.code} 顺序至第 ${to + 1} 位`, changes });
  }

  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: structuredClone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = normalizeScenes(structuredClone(version.scenes));
    log("恢复版本", version.name);
  }

  function saveDraft() {
    draft.value = { scenes: structuredClone(scenes.value), savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    log("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft() {
    draft.value = readDraft();
  }

  function syncDraft() {
    if (!draft.value) return;
    scenes.value = normalizeScenes(structuredClone(draft.value.scenes));
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  function exempt(conflictId: string) {
    if (exemptions.value.includes(conflictId)) return;
    exemptions.value.push(conflictId);
    recordOperation({ kind: "冲突豁免", summary: `豁免冲突 ${conflictId}`, changes: [{ conflictId, field: "exemption", label: FIELD_LABELS.exemption, before: false, after: true }] });
  }

  function reverseChanges(changes: FieldChange[]): FieldChange[] {
    return changes.map((change) => ({ ...change, before: change.after, after: change.before }));
  }

  /** 撤销一个操作单元；baseline 为调用方看到的最新操作编号，用于乐观并发检查 */
  async function undoOperation(targetOpId: string, baseline?: number): Promise<UndoResult> {
    const idempotencyKey = `undo:${targetOpId}`;

    if (inFlight.value.includes(idempotencyKey)) {
      return { ok: false, error: { type: "in-flight", message: "该撤销正在写入中，请勿重复提交" } };
    }
    const existingPending = pendingUndos.value.find((item) => item.id === idempotencyKey);
    if (existingPending) {
      return { ok: false, error: { type: "pending", message: "该撤销仍在待撤销清单中，可重试", pending: existingPending } };
    }
    const alreadyUndone = operations.value.find((item) => item.undoOf === targetOpId && item.kind === "撤销");
    if (alreadyUndone) {
      return { ok: true, op: alreadyUndone };
    }

    const target = operations.value.find((item) => item.id === targetOpId);
    if (!target) {
      return { ok: false, error: { type: "missing", message: "目标操作不存在或已被清理" } };
    }

    // 权限：演员统筹撤销制片确认过的锁定 / 豁免，按越权拒绝
    if (role.value === "演员统筹" && target.actor === "制片" && (target.kind === "锁定" || target.kind === "冲突豁免")) {
      return { ok: false, error: { type: "unauthorized", message: `越权：演员统筹不能撤销制片确认的${target.kind}（操作 #${target.seq}）` } };
    }

    // 乐观并发：后到者必须看到最新操作编号与冲突说明
    const latest = latestSeq.value;
    if (target.undone) {
      return { ok: false, error: { type: "conflict", latestSeq: latest, message: `该操作已被撤销，当前最新操作编号 #${latest}` } };
    }
    if (baseline !== undefined && baseline < latest) {
      const latestOp = operations.value.find((item) => item.seq === latest);
      return {
        ok: false,
        error: {
          type: "conflict",
          latestSeq: latest,
          latestSummary: latestOp?.summary,
          message: `数据已被他人更新，最新操作编号 #${latest}（${latestOp?.summary ?? "未知操作"}），请刷新后再撤销`
        }
      };
    }

    const changes = reverseChanges(target.changes);
    inFlight.value.push(idempotencyKey);
    try {
      await writeOperations();
    } catch (error) {
      const pending: PendingUndo = {
        id: idempotencyKey,
        targetOpId,
        baseline: baseline ?? latest,
        changes,
        attempts: 1,
        lastError: error instanceof Error ? error.message : "写入失败",
        createdAt: new Date().toISOString()
      };
      pendingUndos.value.unshift(pending);
      inFlight.value = inFlight.value.filter((key) => key !== idempotencyKey);
      persist();
      return { ok: false, error: { type: "write-failed", message: "写入失败，已保留待撤销清单，可重试", pending } };
    }

    const undoOp = commitUndo(target, changes, idempotencyKey, latest);
    inFlight.value = inFlight.value.filter((key) => key !== idempotencyKey);
    return { ok: true, op: undoOp };
  }

  function commitUndo(target: Operation, changes: FieldChange[], idempotencyKey: string, baseline: number): Operation {
    applyChanges(changes);
    target.undone = true;
    target.undoneAt = new Date().toISOString();
    const undoOp: Operation = {
      id: idempotencyKey,
      seq: latestSeq.value + 1,
      kind: "撤销",
      actor: role.value,
      time: new Date().toISOString(),
      summary: `撤销：${target.summary}`,
      changes,
      undone: false,
      undoOf: target.id,
      baseline
    };
    operations.value.unshift(undoOp);
    pendingUndos.value = pendingUndos.value.filter((item) => item.id !== idempotencyKey);
    log("撤销操作", undoOp.summary);
    persist();
    return undoOp;
  }

  /** 从原基线重试待撤销项；幂等键不变，成功后只生成一条撤销记录 */
  async function retryUndo(idempotencyKey: string): Promise<UndoResult> {
    const pending = pendingUndos.value.find((item) => item.id === idempotencyKey);
    if (!pending) return { ok: false, error: { type: "missing", message: "待撤销项不存在" } };
    if (inFlight.value.includes(idempotencyKey)) return { ok: false, error: { type: "in-flight", message: "该撤销正在写入中" } };

    const target = operations.value.find((item) => item.id === pending.targetOpId);
    if (!target || target.undone) {
      pendingUndos.value = pendingUndos.value.filter((item) => item.id !== idempotencyKey);
      persist();
      return { ok: true };
    }

    pending.attempts += 1;
    inFlight.value.push(idempotencyKey);
    try {
      await writeOperations();
    } catch (error) {
      pending.lastError = error instanceof Error ? error.message : "写入失败";
      inFlight.value = inFlight.value.filter((key) => key !== idempotencyKey);
      persist();
      return { ok: false, error: { type: "write-failed", message: "重试仍失败，已保留待撤销清单", pending } };
    }

    const undoOp = commitUndo(target, pending.changes, idempotencyKey, pending.baseline);
    inFlight.value = inFlight.value.filter((key) => key !== idempotencyKey);
    return { ok: true, op: undoOp };
  }

  function dismissPending(idempotencyKey: string) {
    pendingUndos.value = pendingUndos.value.filter((item) => item.id !== idempotencyKey);
    persist();
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  /** 多标签页：其他页签写入后同步最新状态 */
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const parsed = JSON.parse(event.newValue);
        if (Array.isArray(parsed.scenes)) scenes.value = normalizeScenes(parsed.scenes);
        if (Array.isArray(parsed.history)) history.value = parsed.history;
        if (Array.isArray(parsed.versions)) versions.value = parsed.versions;
        if (Array.isArray(parsed.operations)) operations.value = parsed.operations;
        if (Array.isArray(parsed.exemptions)) exemptions.value = parsed.exemptions;
      } catch {
        /* 忽略损坏的同步数据 */
      }
    });
  }

  return {
    scenes, sortedScenes, conflicts, history, versions, operations, pendingUndos,
    role, exemptions, online, draft, talents, locations, equipment, forceWriteError, inFlight,
    latestSeq, talentNames, equipmentNames, locationName,
    addScene, updateScene, updateStatus, toggleLock, moveScene, snapshot, restore,
    saveDraft, loadDraft, syncDraft, exempt, undoOperation, retryUndo, dismissPending,
    applyChanges, setOnline
  };
});
