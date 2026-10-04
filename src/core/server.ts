import type {
  CommitFailure,
  CommitRequest,
  CommitResult,
  CommitSuccess,
  Conflict,
  FieldValues,
  OperationRecord,
  Scene,
  SceneField
} from "../types";
import { canCommit, canUndo, computeConflicts, fieldLabels, fieldOf, isSceneLocked, isUndone, project } from "./engine";

/**
 * 模拟编排服务端：
 * - 操作日志（操作单元）是唯一真相，场次状态由日志回放得到；
 * - 提交按 expectedSeq 做乐观并发校验，两名制片几乎同时撤销同一项时，
 *   后到者拿到最新操作编号与冲突说明（stale），而不是覆盖生效结果；
 * - requestId 幂等：重复提交不产生第二条操作记录；
 * - 写入失败（可注入）后服务端状态不变，由客户端留住待撤销清单后从原基线重试。
 */

const SERVER_KEY = "pair-wise-yf-45/server-ledger-v2";
export const SERVER_EVENT = "pair-wise-yf-45/ledger-updated";

interface ServerState {
  operations: OperationRecord[];
  seq: number;
  idempotency: Record<string, { result: CommitSuccess }>;
  writtenAt: string;
}

export const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", order: 1 },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", order: 2 },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", order: 3 }
];

function load(): ServerState {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) return JSON.parse(raw) as ServerState;
  } catch {
    /* 损坏则重新初始化 */
  }
  return { operations: [], seq: 0, idempotency: {}, writtenAt: new Date(0).toISOString() };
}

let state: ServerState = load();

/* 跨标签页：任一标签写入后，其他标签读到最新日志 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === SERVER_KEY && event.newValue) {
      try {
        const next = JSON.parse(event.newValue) as ServerState;
        if (next.seq >= state.seq) {
          state = next;
          listeners.forEach((fn) => fn());
        }
      } catch {
        /* 忽略半截写入 */
      }
    }
  });
}

const listeners = new Set<() => void>();
export function subscribeLedger(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): ServerState {
  return state;
}

/** 当前生效视图（服务端口径） */
export function snapshot(): { scenes: Scene[]; operations: OperationRecord[]; conflicts: Conflict[]; seq: number; exemptions: Map<string, number> } {
  const view = project(state.operations, seedScenes);
  return {
    scenes: view.scenes.sort((a, b) => a.order - b.order),
    operations: [...state.operations].sort((a, b) => b.seq - a.seq),
    conflicts: computeConflicts(view.scenes, new Set(view.exemptions.keys())),
    seq: state.seq,
    exemptions: view.exemptions
  };
}

/* ---------- 故障与延迟注入（演示写入失败后留住待撤销清单） ---------- */

let latencyMs = 260;
let failNextWrites = 0;

export function setLatency(ms: number): void {
  latencyMs = ms;
}

/** 接下来 n 次写入抛"服务端写入失败" */
export function injectWriteFailures(n: number): void {
  failNextWrites = n;
}

export function writeFailurePending(): boolean {
  return failNextWrites > 0;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* 提交队列：同标签内并发提交也必须串行落库，保证序号单调 */
let queue: Promise<unknown> = Promise.resolve();

function persist(next: ServerState): void {
  if (failNextWrites > 0) {
    failNextWrites -= 1;
    throw new Error("服务端写入失败，请保留待撤销清单稍后重试");
  }
  localStorage.setItem(SERVER_KEY, JSON.stringify(next));
  state = next;
}

function fail(code: CommitFailure["code"], message: string, requiredRole?: CommitFailure["requiredRole"]): CommitFailure {
  const view = snapshot();
  return { ok: false, code, message, latestSeq: view.seq, conflicts: view.conflicts, requiredRole };
}

function successFor(operation: OperationRecord, extra?: Partial<CommitSuccess>): CommitSuccess {
  const view = snapshot();
  return { ok: true, seq: view.seq, operation, conflicts: view.conflicts, ...extra };
}

function appendOperation(input: Omit<OperationRecord, "seq" | "id">): OperationRecord {
  const seq = state.seq + 1;
  const record: OperationRecord = { ...input, seq, id: `op-${seq}-${Math.random().toString(36).slice(2, 8)}` };
  const next: ServerState = {
    ...state,
    seq,
    operations: [...state.operations, record],
    idempotency: state.idempotency,
    writtenAt: input.time
  };
  persist(next); // 写入失败在此抛出，state 保持旧值
  return record;
}

function sceneCodeOf(sceneId: string): string {
  return snapshot().scenes.find((s) => s.id === sceneId)?.code ?? sceneId;
}

function changesOf(req: CommitRequest): { field: SceneField; before: unknown; after: unknown }[] | undefined {
  const view = snapshot();
  const scene = view.scenes.find((s) => s.id === (req as { sceneId?: string }).sceneId);
  switch (req.kind) {
    case "modify": {
      const out: { field: SceneField; before: unknown; after: unknown }[] = [];
      (Object.keys(req.after) as SceneField[]).forEach((field) => {
        const after = req.after[field];
        const before = field in req.before ? req.before[field] : fieldOf(scene, field);
        if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ field, before, after });
      });
      return out;
    }
    case "reorder":
      return req.before !== req.after ? [{ field: "order", before: req.before, after: req.after }] : [];
    case "status":
      return req.before !== req.after ? [{ field: "status", before: req.before, after: req.after }] : [];
    default:
      return undefined;
  }
}

function noteFor(req: CommitRequest, changes: { field: SceneField; before: unknown; after: unknown }[] | undefined): string {
  switch (req.kind) {
    case "modify":
      return `${sceneCodeOf(req.sceneId)} 修改 ${(changes ?? []).map((c) => fieldLabels[c.field]).join("、") || "字段"}`;
    case "reorder":
      return `${sceneCodeOf(req.sceneId)} 拖动至第 ${req.after} 位`;
    case "status":
      return `${sceneCodeOf(req.sceneId)} 状态 ${req.before} → ${req.after}`;
    case "lock":
      return `${sceneCodeOf(req.sceneId)} ${req.locked ? "锁定" : "解锁"}`;
    case "exempt": {
      const conflict = snapshot().conflicts.find((c) => c.key === req.conflictKey);
      return conflict ? `豁免冲突：${conflict.type}（${conflict.sceneIds.map(sceneCodeOf).join(" ↔ ")}）` : `豁免冲突 ${req.conflictKey}`;
    }
    case "undo":
      return "";
  }
}

async function handle(req: CommitRequest): Promise<CommitResult> {
  await delay(latencyMs);

  /* 1. 幂等：同一 requestId 直接重放首次结果，绝不产生第二条记录 */
  const cached = state.idempotency[req.requestId];
  if (cached) {
    return { ...cached.result, replay: true };
  }

  /* 2. 乐观并发：基线落后即拒绝，并把最新编号和冲突说明带回给后到者 */
  if (req.expectedSeq !== state.seq) {
    return fail("stale", `操作基线已过期：你看到的是第 ${req.expectedSeq} 号操作，现场已到第 ${state.seq} 号，请核对最新冲突后再提交`);
  }

  /* 3. 撤销：越权校验优先于业务校验 */
  if (req.kind === "undo") {
    const target = state.operations.find((op) => op.seq === req.targetSeq);
    if (!target) return fail("invalid", `第 ${req.targetSeq} 号操作不存在，无法撤销`);
    if (isUndone(target)) {
      return fail("stale", `第 ${req.targetSeq} 号操作已被第 ${target.undoneBySeq} 号操作撤销，现场已有新变化`);
    }
    const permission = canUndo(req.actor, target);
    if (!permission.allowed) return fail("forbidden", permission.reason ?? "越权操作，已拒绝", permission.requiredRole);

    const view = project(state.operations, seedScenes);
    try {
      const seq = state.seq + 1;
      const restoredFields: string[] = [];
      const markedTarget: OperationRecord = { ...target, undoneBySeq: seq, undoActorId: req.actor.id };
      const working = structuredClone(state);
      working.operations = state.operations.map((op) => (op.seq === target.seq ? markedTarget : op));
      working.seq = seq;

      const baseRecord = {
        seq,
        id: `op-${seq}-undo`,
        actorId: req.actor.id,
        actorName: req.actor.name,
        actorRole: req.actor.role,
        time: req.time,
        sceneId: target.sceneId,
        sceneCode: target.sceneCode,
        conflictKey: target.conflictKey
      };

      if (target.type === "冲突豁免") {
        // 豁免撤销：无字段回退；回放后豁免集合移除该项，被豁免的冲突立即重算回来
        working.operations.push({
          ...baseRecord,
          type: "冲突豁免",
          note: `撤销 #${target.seq}：恢复冲突检查（${target.note}）`
        });
      } else if (target.type === "锁定" || target.type === "解锁") {
        // 锁定/解锁本身不改场次字段：撤销后按剩余锁定操作重放即可得到旧锁定状态
        working.operations.push({
          ...baseRecord,
          type: target.type,
          note: `撤销 #${target.seq}：${target.type === "锁定" ? "恢复为未锁定" : "恢复为锁定"}（${target.note}）`
        });
        restoredFields.push(target.type === "锁定" ? "锁定标记 → 未锁定" : "锁定标记 → 已锁定");
      } else if (target.sceneId && target.changes) {
        // 只还原本次操作影响、且当前仍归属该操作的字段；后续生效改动保留在现场
        const earlier = state.operations
          .filter((op) => !isUndone(op) && op.seq < target.seq && op.sceneId === target.sceneId && op.changes)
          .sort((a, b) => b.seq - a.seq);
        const currentScene = view.scenes.find((s) => s.id === target.sceneId);
        const patch: FieldValues = {};
        for (const change of target.changes) {
          if (view.owners.get(target.sceneId)?.get(change.field) !== target.seq) continue;
          const prev = earlier.find((op) => op.changes!.some((c) => c.field === change.field));
          const seedValue = fieldOf(seedScenes.find((s) => s.id === target.sceneId), change.field);
          const prevValue = prev ? prev.changes!.find((c) => c.field === change.field)!.after : seedValue;
          (patch as Record<string, unknown>)[change.field] = prevValue === undefined ? change.before : structuredClone(prevValue);
          restoredFields.push(
            `${fieldLabels[change.field]} → ${formatValue(change.field, (patch as Record<string, unknown>)[change.field])}`
          );
        }
        if (Object.keys(patch).length && currentScene) {
          // 用一条"字段回退"补偿操作承接现场值，同时把目标操作标记为已撤销
          const undoChanges = (Object.keys(patch) as SceneField[]).map((field) => ({
            field,
            before: fieldOf(currentScene, field),
            after: (patch as Record<string, unknown>)[field]
          }));
          working.operations.push({
            ...baseRecord,
            type: "场次修改",
            changes: undoChanges,
            note: `撤销 #${target.seq}：${target.note}`
          });
        } else {
          // 目标字段均已被后续操作接管（或创建操作撤销导致场次离场）：只标记撤销，冲突照常用新现场重算
          working.operations.push({
            ...baseRecord,
            type: "场次修改",
            note: `撤销 #${target.seq}（涉及字段已被后续改动接管，其他改动保持不变）`
          });
        }
      } else {
        return fail("invalid", `第 ${req.targetSeq} 号操作缺少字段快照，无法撤销`);
      }

      persist(working);
      const record = state.operations.find((op) => op.seq === seq)!;
      const result = successFor(record, { restoredFields });
      state.idempotency[req.requestId] = { result };
      persist({ ...state, idempotency: state.idempotency });
      listeners.forEach((fn) => fn());
      return result;
    } catch (error) {
      // 写入失败：服务端状态不变，交由客户端留住待撤销清单从原基线重试
      return fail("write", error instanceof Error ? error.message : "写入失败");
    }
  }

  /* 4. 正向操作：先查权限 */
  const permission = canCommit(req);
  if (!permission.allowed) return fail("forbidden", permission.reason ?? "越权操作，已拒绝", permission.requiredRole);

  const view = snapshot();
  const targetScene = view.scenes.find((s) => s.id === (req as { sceneId?: string }).sceneId);

  if (req.kind === "exempt") {
    if (view.exemptions.has(req.conflictKey) || !snapshot().conflicts.some((c) => c.key === req.conflictKey)) {
      // 允许对"重算后仍存在"的冲突做豁免；已豁免或已消失的冲突直接返回当前状态
      if (view.exemptions.has(req.conflictKey)) return fail("invalid", "该冲突已豁免，无需重复豁免");
      return fail("invalid", "该冲突已不存在（可能已被其他改动化解），无需豁免");
    }
  } else if (!targetScene) {
    // 新建场次：before 为空表示创建
    if (req.kind !== "modify" || Object.keys(req.before).length !== 0) {
      return fail("invalid", "目标场次不存在或已被移除");
    }
  } else if (req.kind === "reorder") {
    if (targetScene.status === "已完成") return fail("invalid", `${targetScene.code} 已完成，不能再调整顺序`);
    if (isSceneLocked(req.sceneId, state.operations)) return fail("invalid", `${targetScene.code} 已锁定，不能拖动顺序`);
  } else if (req.kind === "status") {
    if (isSceneLocked(req.sceneId, state.operations)) {
      return fail("forbidden", `${targetScene.code} 已锁定，状态流转须先由制片解锁`, "制片");
    }
    if (req.before !== targetScene.status) {
      return fail("stale", `状态基线已过期：${targetScene.code} 当前为 ${targetScene.status}，请刷新后再流转`);
    }
  } else if (req.kind === "modify") {
    if (isSceneLocked(req.sceneId, state.operations)) {
      return fail("forbidden", `${targetScene.code} 已锁定，解锁后才能修改场次安排`, "制片");
    }
    for (const field of Object.keys(req.before) as SceneField[]) {
      if (JSON.stringify(req.before[field]) !== JSON.stringify(fieldOf(targetScene, field))) {
        return fail("stale", `${targetScene.code} 的${fieldLabels[field]}已被其他人改动，请按最新值重新编辑`);
      }
    }
    if (!Object.keys(req.after).length) return fail("invalid", "没有检测到字段变更");
  }

  const changes = changesOf(req);
  if (changes && !changes.length && req.kind !== "lock") {
    return fail("invalid", "没有检测到变更，未生成操作记录");
  }

  try {
    const base = {
      actorId: req.actor.id,
      actorName: req.actor.name,
      actorRole: req.actor.role,
      time: req.time
    };
    let record: OperationRecord;
    if (req.kind === "modify") {
      const code = targetScene?.code ?? String(req.after.code ?? "新场次");
      const isCreate = !targetScene;
      record = appendOperation({ ...base, type: "场次修改", sceneId: req.sceneId, sceneCode: code, changes, note: isCreate ? `新建场次 ${code}` : noteFor(req, changes) });
    } else if (req.kind === "reorder") {
      record = appendOperation({ ...base, type: "顺序调整", sceneId: req.sceneId, sceneCode: targetScene!.code, changes, note: noteFor(req, changes) });
    } else if (req.kind === "status") {
      record = appendOperation({ ...base, type: "状态流转", sceneId: req.sceneId, sceneCode: targetScene!.code, changes, note: noteFor(req, changes) });
    } else if (req.kind === "lock") {
      record = appendOperation({ ...base, type: req.locked ? "锁定" : "解锁", sceneId: req.sceneId, sceneCode: targetScene!.code, note: noteFor(req, undefined) });
    } else {
      const conflict = snapshot().conflicts.find((c) => c.key === req.conflictKey)!;
      record = appendOperation({ ...base, type: "冲突豁免", conflictKey: req.conflictKey, note: noteFor(req, undefined), sceneCode: conflict.sceneIds.map(sceneCodeOf).join("/") });
    }
    const result = successFor(record);
    state.idempotency[req.requestId] = { result };
    persist({ ...state, idempotency: state.idempotency });
    listeners.forEach((fn) => fn());
    return result;
  } catch (error) {
    return fail("write", error instanceof Error ? error.message : "写入失败");
  }
}

function formatValue(field: SceneField, value: unknown): string {
  if (Array.isArray(value)) return value.length ? `${value.length} 项` : "空";
  return String(value);
}

/** 提交入口：串行化，重复提交（同 requestId）不会多出第二条操作记录 */
export function commit(req: CommitRequest): Promise<CommitResult> {
  const run = queue.then(() => handle(req));
  // 队列不因单次失败中断
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 开发/演示用：清空服务端日志 */
export function resetLedger(): void {
  state = { operations: [], seq: 0, idempotency: {}, writtenAt: new Date(0).toISOString() };
  localStorage.removeItem(SERVER_KEY);
  listeners.forEach((fn) => fn());
}
