import { computed, ref } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  Actor,
  CommitFailure,
  CommitRequest,
  CommitResult,
  Conflict,
  FieldValues,
  HistoryEntry,
  OfflineDraft,
  OperationRecord,
  PendingUndo,
  Role,
  Scene,
  SceneStatus,
  Version
} from "../types";
import { actors, equipment, locations, talents } from "../data/catalog";
import { canUndo } from "../core/engine";
import {
  commit as serverCommit,
  injectWriteFailures,
  resetLedger,
  seedScenes,
  setLatency,
  snapshot as serverSnapshot,
  subscribeLedger,
  writeFailurePending
} from "../core/server";

const HISTORY_KEY = "pair-wise-yf-45/audit-history";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";
const PENDING_KEY = "pair-wise-yf-45/pending-undo";
const VERSION_KEY = "pair-wise-yf-45/versions";
const ACTOR_KEY = "pair-wise-yf-45/actor";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const useScheduleStore = defineStore("schedule", () => {
  const currentActorId = ref<string>(readJson(ACTOR_KEY, actors[0].id));
  const currentActor = computed<Actor>(() => actors.find((a) => a.id === currentActorId.value) ?? actors[0]);
  const role = computed<Role>(() => currentActor.value.role);

  const online = ref(navigator.onLine);
  const inflight = ref<Set<string>>(new Set());
  const lastFailure = ref<CommitFailure | null>(null);
  const notice = ref<string>("");

  /* 服务端日志回放结果（操作单元是真相来源） */
  const ledgerSeq = ref(serverSnapshot().seq);
  const scenes = ref<Scene[]>(serverSnapshot().scenes);
  const operations = ref<OperationRecord[]>(serverSnapshot().operations);
  const conflicts = ref<Conflict[]>(serverSnapshot().conflicts);

  function refreshFromLedger(): void {
    const snap = serverSnapshot();
    // 只有编号前进才整体替换，避免覆盖正在填写的本地表单（表单数据不在 store）
    if (snap.seq >= ledgerSeq.value) {
      ledgerSeq.value = snap.seq;
      scenes.value = snap.scenes;
      operations.value = snap.operations;
      conflicts.value = snap.conflicts;
    }
  }
  subscribeLedger(refreshFromLedger);

  const history = ref<HistoryEntry[]>(readJson(HISTORY_KEY, []));
  const versions = ref<Version[]>(readJson(VERSION_KEY, []));
  const draft = ref<OfflineDraft | null>(readJson(DRAFT_KEY, null));
  const pendingUndos = ref<PendingUndo[]>(readJson(PENDING_KEY, []));

  function persistPending(): void {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pendingUndos.value));
  }
  function persistHistory(): void {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value));
  }
  function persistVersions(): void {
    localStorage.setItem(VERSION_KEY, JSON.stringify(versions.value));
  }

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => a.order - b.order));

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  /* ---------- 审计日志（版本/草稿等非编排事件） ---------- */
  function audit(action: string, detail: string): void {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
    persistHistory();
  }

  /* ---------- 通用提交 ---------- */
  function newRequestId(kind: string, key: string): string {
    return `${kind}-${key}-${currentActor.value.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async function send(req: CommitRequest): Promise<CommitResult> {
    if (!online.value) {
      lastFailure.value = { ok: false, code: "write", message: "当前处于离线模式，操作未写入；请在待办清单中恢复后重试", latestSeq: ledgerSeq.value, conflicts: conflicts.value };
      return lastFailure.value;
    }
    if (inflight.value.has(req.requestId)) {
      return { ok: false, code: "write", message: "同一请求正在提交中，请勿重复点击", latestSeq: ledgerSeq.value, conflicts: conflicts.value };
    }
    inflight.value.add(req.requestId);
    let result: CommitResult;
    try {
      result = await serverCommit(req);
    } finally {
      inflight.value.delete(req.requestId);
    }
    refreshFromLedger();
    if (result.ok) {
      notice.value = result.replay ? "该请求已提交过，已返回原结果，未重复生成操作记录" : "已写入，冲突已按最新现场重算";
      lastFailure.value = null;
    } else {
      lastFailure.value = result;
      notice.value = result.message;
    }
    return result;
  }

  /* ---------- 正向操作 ---------- */

  function addScene(input: Omit<Scene, "id" | "status" | "order">): Promise<CommitResult> {
    // 新增场次：一次性创建操作单元
    const id = crypto.randomUUID();
    const order = scenes.value.length + 1;
    const after: FieldValues = {
      code: input.code,
      title: input.title,
      day: input.day,
      start: input.start,
      end: input.end,
      talentIds: input.talentIds,
      locationId: input.locationId,
      equipmentIds: input.equipmentIds,
      status: "草稿",
      order
    };
    const before: FieldValues = {};
    const requestId = newRequestId("add", id);
    // 新增场次不在种子中，服务端按变更集回放构造
    const req: CommitRequest = {
      kind: "modify",
      requestId,
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      sceneId: id,
      before,
      after
    };
    return send(req);
  }

  function modifyScene(sceneId: string, before: FieldValues, after: FieldValues): Promise<CommitResult> {
    const req: CommitRequest = {
      kind: "modify",
      requestId: newRequestId("modify", sceneId),
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      sceneId,
      before,
      after
    };
    return send(req);
  }

  function moveScene(sceneId: string, beforeOrder: number, afterOrder: number): Promise<CommitResult> {
    const req: CommitRequest = {
      kind: "reorder",
      requestId: newRequestId("reorder", `${sceneId}-${afterOrder}`),
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      sceneId,
      before: beforeOrder,
      after: afterOrder
    };
    return send(req);
  }

  function updateStatus(sceneId: string, before: SceneStatus, after: SceneStatus): Promise<CommitResult> {
    const req: CommitRequest = {
      kind: "status",
      requestId: newRequestId("status", `${sceneId}-${after}`),
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      sceneId,
      before,
      after
    };
    return send(req);
  }

  function setLock(sceneId: string, locked: boolean): Promise<CommitResult> {
    const req: CommitRequest = {
      kind: "lock",
      requestId: newRequestId(locked ? "lock" : "unlock", sceneId),
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      sceneId,
      locked
    };
    return send(req);
  }

  function exemptConflict(conflictKey: string): Promise<CommitResult> {
    const req: CommitRequest = {
      kind: "exempt",
      requestId: newRequestId("exempt", conflictKey),
      expectedSeq: ledgerSeq.value,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      conflictKey
    };
    return send(req);
  }

  /* ---------- 撤销（操作单元级） ---------- */

  function requestIdForUndo(targetSeq: number, actorId: string): string {
    // 确定性幂等键：同一人对同一操作的撤销（含失败重试）复用一条请求
    return `undo-op${targetSeq}-by-${actorId}`;
  }

  /**
   * 撤销一项操作单元：
   * - 只还原该操作影响的字段，其他已生效改动留在现场；
   * - 写入失败后留住待撤销清单，重试仍从原基线继续；
   * - requestId 固定，重复提交不会多出第二条操作记录。
   */
  async function requestUndo(targetSeq: number): Promise<CommitResult> {
    const target = operations.value.find((op) => op.seq === targetSeq);
    if (!target) {
      return { ok: false, code: "invalid", message: `找不到第 ${targetSeq} 号操作`, latestSeq: ledgerSeq.value, conflicts: conflicts.value };
    }
    const permission = canUndo(currentActor.value, target);
    if (!permission.allowed) {
      const failure: CommitFailure = {
        ok: false,
        code: "forbidden",
        message: permission.reason ?? "越权操作，已拒绝",
        requiredRole: permission.requiredRole,
        latestSeq: ledgerSeq.value,
        conflicts: conflicts.value
      };
      lastFailure.value = failure;
      notice.value = failure.message;
      return failure;
    }

    const requestId = requestIdForUndo(targetSeq, currentActor.value.id);
    const existing = pendingUndos.value.find((item) => item.requestId === requestId);
    // 原基线：发起撤销那一刻看到的编号；重试从原基线继续声明
    const baselineSeq = existing?.baselineSeq ?? ledgerSeq.value;

    if (!existing) {
      const item: PendingUndo = {
        requestId,
        targetSeq,
        baselineSeq,
        actorId: currentActor.value.id,
        note: target.note,
        createdAt: new Date().toISOString(),
        attempts: 0
      };
      pendingUndos.value.unshift(item);
      persistPending();
    }

    const req: CommitRequest = {
      kind: "undo",
      requestId,
      expectedSeq: baselineSeq,
      actor: { ...currentActor.value },
      time: new Date().toISOString(),
      targetSeq
    };
    const pending = pendingUndos.value.find((item) => item.requestId === requestId)!;
    pending.attempts += 1;
    persistPending();

    const result = await send(req);
    if (result.ok) {
      pendingUndos.value = pendingUndos.value.filter((item) => item.requestId !== requestId);
      persistPending();
      audit("撤销操作", `#${targetSeq} ${target.note}（${currentActor.value.name}）`);
    } else {
      pending.lastError = result.message;
      persistPending();
    }
    return result;
  }

  /** stale：后到者按最新操作编号重新对齐基线后，再试同一条撤销（requestId 不变） */
  async function rebaseAndRetry(pending: PendingUndo): Promise<CommitResult> {
    refreshFromLedger();
    const target = operations.value.find((op) => op.seq === pending.targetSeq);
    if (target?.undoneBySeq !== undefined) {
      pendingUndos.value = pendingUndos.value.filter((item) => item.requestId !== pending.requestId);
      persistPending();
      notice.value = `第 ${pending.targetSeq} 号操作已被撤销，待办已清除`;
      return { ok: false, code: "stale", message: notice.value, latestSeq: ledgerSeq.value, conflicts: conflicts.value };
    }
    pending.baselineSeq = ledgerSeq.value;
    pending.lastError = undefined;
    persistPending();
    return requestUndo(pending.targetSeq);
  }

  function discardPending(requestId: string): void {
    pendingUndos.value = pendingUndos.value.filter((item) => item.requestId !== requestId);
    persistPending();
  }

  /* ---------- 版本快照（只读参考；恢复请用操作单元撤销） ---------- */
  function snapshot(name = `版本 ${versions.value.length + 1}`): void {
    versions.value.unshift({ id: crypto.randomUUID(), name, time: new Date().toISOString(), scenes: structuredClone(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    persistVersions();
    audit("保存版本", name);
  }

  /* ---------- 离线草稿 ---------- */
  function saveDraft(): void {
    draft.value = { scenes: structuredClone(scenes.value), savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    audit("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft(): void {
    draft.value = readJson<OfflineDraft | null>(DRAFT_KEY, null);
  }

  /** 离线草稿只能作为"新增场次"逐条并入，不整体覆盖现场 */
  async function syncDraft(): Promise<void> {
    if (!draft.value) return;
    const remoteIds = new Set(scenes.value.map((s) => s.code));
    let added = 0;
    for (const item of draft.value.scenes) {
      if (remoteIds.has(item.code)) continue;
      // 串行并入，避免序号竞争
      // eslint-disable-next-line no-await-in-loop
      const result = await addScene({
        code: item.code,
        title: item.title,
        day: item.day,
        start: item.start,
        end: item.end,
        talentIds: item.talentIds,
        locationId: item.locationId,
        equipmentIds: item.equipmentIds
      });
      if (result.ok) added += 1;
    }
    audit("同步离线草稿", `并入 ${added} 个新场次，其余现场改动保持不变`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  function setOnline(value: boolean): void {
    online.value = value;
    if (value) refreshFromLedger();
  }

  function switchActor(id: string): void {
    currentActorId.value = id;
    localStorage.setItem(ACTOR_KEY, JSON.stringify(id));
    notice.value = `已切换为 ${currentActor.value.name}`;
  }

  function clearNotice(): void {
    notice.value = "";
    lastFailure.value = null;
  }

  function debugReset(): void {
    resetLedger();
    pendingUndos.value = [];
    versions.value = [];
    persistPending();
    persistVersions();
    refreshFromLedger();
  }

  return {
    // 身份 / 网络
    actors,
    currentActor,
    currentActorId,
    role,
    online,
    setOnline,
    switchActor,
    // 目录
    talents,
    locations,
    equipment,
    seedScenes,
    // 现场视图
    scenes,
    sortedScenes,
    conflicts,
    operations,
    ledgerSeq,
    lastFailure,
    notice,
    clearNotice,
    talentNames,
    equipmentNames,
    locationName,
    // 正向操作
    addScene,
    modifyScene,
    moveScene,
    updateStatus,
    setLock,
    exemptConflict,
    // 撤销
    requestUndo,
    rebaseAndRetry,
    discardPending,
    pendingUndos,
    // 版本 / 草稿 / 审计
    versions,
    snapshot,
    history,
    draft,
    saveDraft,
    loadDraft,
    syncDraft,
    audit,
    // 故障注入与调试
    injectWriteFailures,
    writeFailurePending,
    setLatency,
    debugReset
  };
});
