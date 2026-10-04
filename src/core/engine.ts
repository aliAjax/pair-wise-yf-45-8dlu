import { actors, equipment, locations, talents } from "../data/catalog";
import type {
  Actor,
  CommitRequest,
  Conflict,
  FieldValues,
  OperationRecord,
  Scene,
  SceneField,
  SceneStatus
} from "../types";

/* ---------------- 字段展示 ---------------- */

export const fieldLabels: Record<SceneField, string> = {
  code: "场次编号",
  title: "场次名称",
  day: "拍摄日",
  start: "开始时间",
  end: "结束时间",
  talentIds: "演员档期",
  locationId: "场地",
  equipmentIds: "器材",
  status: "状态",
  order: "拍摄顺序"
};

export function fieldValueText(field: SceneField, value: unknown): string {
  if (value === undefined || value === null) return "—";
  switch (field) {
    case "talentIds":
      return (value as string[]).map((id) => talents.find((t) => t.id === id)?.name ?? id).join("、") || "空";
    case "equipmentIds":
      return (value as string[]).map((id) => equipment.find((e) => e.id === id)?.name ?? id).join("、") || "无";
    case "locationId":
      return locations.find((l) => l.id === value)?.name ?? String(value);
    default:
      return String(value);
  }
}

/* ---------------- 类型小工具 ---------------- */

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export function fieldOf(scene: Scene | undefined, field: SceneField): unknown {
  return scene ? asRecord(scene)[field] : undefined;
}

/* ---------------- 冲突计算 ---------------- */

function minutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export function overlaps(a: Scene, b: Scene): boolean {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function names(ids: string[]): string {
  return ids.map((id) => talents.find((t) => t.id === id)?.name ?? id).join("、");
}

/** 两个时间重叠场次的稳定冲突键；豁免操作引用同一键 */
export function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().join("::");
}

export function conflictKey(pair: string, type: Conflict["type"]): string {
  return `${pair}::${type}`;
}

/**
 * 依据当前场次重算全部冲突。撤销/修改后调用，保证"改动过的冲突立即重算"。
 * activeExemptions：仍然生效的豁免冲突键集合。
 */
export function computeConflicts(scenes: Scene[], activeExemptions: Set<string>): Conflict[] {
  const result: Conflict[] = [];
  for (let i = 0; i < scenes.length; i += 1) {
    for (let j = i + 1; j < scenes.length; j += 1) {
      const a = scenes[i];
      const b = scenes[j];
      if (!overlaps(a, b)) continue;
      // 场次对按 id 归一化，保证遍历顺序变化时冲突键稳定（豁免引用不会失效）
      const [firstId, secondId] = [a.id, b.id].sort();
      const first = firstId === a.id ? a : b;
      const second = firstId === a.id ? b : a;
      const pair = pairKey(a.id, b.id);
      const ids = [firstId, secondId];
      const sharedTalents = first.talentIds.filter((v) => second.talentIds.includes(v));
      const sharedEquip = first.equipmentIds.filter((v) => second.equipmentIds.includes(v));
      const candidates: Conflict[] = [];
      if (sharedTalents.length) {
        candidates.push({ key: conflictKey(pair, "演员档期"), type: "演员档期", sceneIds: ids, message: `${names(sharedTalents)} 在两场戏中档期重叠`, severity: "高" });
      }
      if (first.locationId === second.locationId) {
        candidates.push({ key: conflictKey(pair, "场地占用"), type: "场地占用", sceneIds: ids, message: `${locations.find((l) => l.id === first.locationId)?.name ?? first.locationId} 被同时占用`, severity: "高" });
      }
      if (sharedEquip.length) {
        candidates.push({ key: conflictKey(pair, "器材借用"), type: "器材借用", sceneIds: ids, message: `${names(sharedEquip)} 发生借用重叠`, severity: "中" });
      }
      if (first.locationId !== second.locationId) {
        const earlier = first.end <= second.end ? first : second;
        const later = earlier === first ? second : first;
        if (minutes(later.start) - minutes(earlier.end) < 30) {
          candidates.push({ key: conflictKey(pair, "转场时间"), type: "转场时间", sceneIds: ids, message: "两个场地之间转场时间不足30分钟", severity: "中" });
        }
      }
      for (const c of candidates) if (!activeExemptions.has(c.key)) result.push(c);
    }
  }
  return result;
}

/* ---------------- 操作日志回放（操作单元真相来源） ---------------- */

export interface Projection {
  /** 场次当前生效值，由全部未撤销操作回放得到 */
  scenes: Scene[];
  /** 每个场次每个字段当前归属的操作序号；选择性撤销按它决定回退到哪一版 */
  owners: Map<string, Map<SceneField, number>>;
  /** 当前生效的豁免冲突键 -> 豁免操作序号 */
  exemptions: Map<string, number>;
  /** 每个场次的创建操作序号（新建场次携带全部字段），撤销即让场次离场 */
  creators: Map<string, number>;
}

export function isUndone(op: OperationRecord): boolean {
  return op.undoneBySeq !== undefined;
}

/** 从锁定/解锁操作单元派生场次当前锁定状态（种子场次默认未锁） */
export function isSceneLocked(sceneId: string | undefined, operations: OperationRecord[]): boolean {
  if (!sceneId) return false;
  let locked = false;
  for (const op of [...operations].filter((o) => !isUndone(o) && o.sceneId === sceneId).sort((a, b) => a.seq - b.seq)) {
    if (op.type === "锁定") locked = true;
    else if (op.type === "解锁") locked = false;
  }
  return locked;
}

/** 按操作编号顺序回放未撤销的操作单元，得到当前生效状态 */
export function project(operations: OperationRecord[], seedScenes: Scene[]): Projection {
  const scenes = new Map<string, Scene>();
  const owners = new Map<string, Map<SceneField, number>>();

  for (const seed of seedScenes) {
    scenes.set(seed.id, structuredClone(seed));
    const fieldOwner = new Map<SceneField, number>();
    for (const key of ["code", "title", "day", "start", "end", "talentIds", "locationId", "equipmentIds", "status", "order"] as SceneField[]) {
      fieldOwner.set(key, 0); // 0 = 初始基线
    }
    owners.set(seed.id, fieldOwner);
  }

  const exemptions = new Map<string, number>();
  const creators = new Map<string, number>();
  const active = operations.filter((op) => !isUndone(op)).sort((a, b) => a.seq - b.seq);

  for (const op of active) {
    if (op.type === "冲突豁免" && op.conflictKey) {
      // 撤销豁免的补偿记录本身也是"冲突豁免"类型，但以"撤销 #"开头，不产生豁免效力
      if (op.note.startsWith("撤销 #")) {
        exemptions.delete(op.conflictKey);
      } else {
        exemptions.set(op.conflictKey, op.seq);
      }
      continue;
    }
    if (!op.sceneId || !op.changes) continue;
    const isSeed = seedScenes.some((s) => s.id === op.sceneId);
    let scene = scenes.get(op.sceneId);
    if (!scene) {
      scene = {
        id: op.sceneId,
        code: op.sceneCode ?? "",
        title: "",
        day: "",
        start: "00:00",
        end: "00:00",
        talentIds: [],
        locationId: "",
        equipmentIds: [],
        status: "草稿",
        order: scenes.size + 1
      };
      scenes.set(op.sceneId, scene);
      owners.set(op.sceneId, new Map());
    }
    // 创建场次的操作单元（非种子 + 携带全部字段）
    if (!isSeed && op.changes.some((c) => c.field === "code") && !creators.has(op.sceneId)) {
      creators.set(op.sceneId, op.seq);
    }
    for (const change of op.changes) {
      asRecord(scene)[change.field] = structuredClone(change.after);
      owners.get(op.sceneId)!.set(change.field, op.seq);
    }
  }

  // 创建操作被撤销：新建场次整体离场（种子场次不受影响）
  for (const [sceneId, createSeq] of creators) {
    const createOp = operations.find((op) => op.seq === createSeq);
    if (createOp?.undoneBySeq !== undefined) {
      scenes.delete(sceneId);
      owners.delete(sceneId);
    }
  }

  return { scenes: [...scenes.values()], owners, exemptions, creators };
}

/**
 * 选择性撤销：只还原 targetOp 影响的字段。
 * 若某字段之后又被其他生效操作改过，则保留后续改动（不回到旧值）；
 * 否则回退到 targetOp 之前上一个生效版本的值。
 */
export function buildUndoPatch(
  operations: OperationRecord[],
  seedScenes: Scene[],
  targetOp: OperationRecord
): { patch: FieldValues; restored: { field: SceneField; from: unknown; to: unknown }[] } {
  const patch: FieldValues = {};
  const restored: { field: SceneField; from: unknown; to: unknown }[] = [];

  // 当前生效值
  const current = project(operations, seedScenes);

  if (targetOp.type === "冲突豁免") {
    return { patch, restored };
  }
  if (!targetOp.sceneId || !targetOp.changes) return { patch, restored };

  const earlier = operations
    .filter((op) => !isUndone(op) && op.seq < targetOp.seq && op.sceneId === targetOp.sceneId && op.changes)
    .sort((a, b) => b.seq - a.seq);
  const scene = current.scenes.find((s) => s.id === targetOp.sceneId);

  for (const change of targetOp.changes) {
    const ownerSeq = current.owners.get(targetOp.sceneId)?.get(change.field);
    // 该字段当前归属不是被撤销操作：后续改动保持现场，不动
    if (ownerSeq !== targetOp.seq) continue;
    const prev = earlier.find((op) => op.changes!.some((c) => c.field === change.field));
    const prevValue = prev
      ? prev.changes!.find((c) => c.field === change.field)!.after
      : fieldOf(seedScenes.find((s) => s.id === targetOp.sceneId), change.field);
    (patch as Record<string, unknown>)[change.field] = prevValue === undefined ? change.before : structuredClone(prevValue);
    restored.push({ field: change.field, from: fieldOf(scene, change.field), to: (patch as Record<string, unknown>)[change.field] });
  }
  return { patch, restored };
}

/* ---------------- 权限 ---------------- */

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiredRole?: Actor["role"];
}

/** 正向操作的权限 */
export function canCommit(req: Omit<CommitRequest, "requestId" | "expectedSeq" | "time">): PermissionResult {
  const { actor, kind } = req;
  if (actor.role === "场记") {
    return { allowed: false, reason: "场记只有查看权限，不能编排通告", requiredRole: "制片" };
  }
  if (actor.role === "演员统筹") {
    if (kind === "lock" || kind === "exempt" || kind === "reorder") {
      return { allowed: false, reason: "演员统筹只能修改场次信息与推进状态，锁定、顺序与豁免须由制片/导演处理", requiredRole: "制片" };
    }
  }
  return { allowed: true };
}

/**
 * 撤销权限：
 * - 制片可撤销任何操作；
 * - 导演可撤销导演/演员统筹/场记发起的操作，但撤销制片确认过的锁定或豁免按越权拒绝；
 * - 演员统筹只能撤销自己的场次修改/状态流转；
 * - 场记无撤销权。
 */
export function canUndo(actor: Actor, target: OperationRecord): PermissionResult {
  if (actor.role === "场记") {
    return { allowed: false, reason: "场记无撤销权限", requiredRole: "制片" };
  }
  if (actor.role === "演员统筹") {
    if (target.actorId === actor.id && (target.type === "场次修改" || target.type === "状态流转" || target.type === "顺序调整")) {
      return { allowed: true };
    }
    if (target.type === "锁定" || target.type === "解锁" || target.type === "冲突豁免") {
      return { allowed: false, reason: "演员统筹无权撤销制片确认过的锁定或豁免", requiredRole: "制片" };
    }
    return { allowed: false, reason: "演员统筹只能撤销本人提交的场次修改或状态流转", requiredRole: "制片" };
  }
  if (actor.role === "导演") {
    if (target.actorRole === "制片" && (target.type === "锁定" || target.type === "解锁" || target.type === "冲突豁免")) {
      return { allowed: false, reason: "制片确认过的锁定或豁免只能由制片本人撤销", requiredRole: "制片" };
    }
    if (target.actorRole === "制片" && (target.type === "状态流转" || target.type === "场次修改" || target.type === "顺序调整")) {
      return { allowed: false, reason: "制片提交的编排改动只能由制片撤销", requiredRole: "制片" };
    }
  }
  return { allowed: true };
}

/* ---------------- 操作摘要 ---------------- */

export function describeChange(field: SceneField, after: unknown): string {
  return `${fieldLabels[field]} → ${fieldValueText(field, after)}`;
}

export function statusFlowNote(code: string, before: SceneStatus, after: SceneStatus): string {
  return `${code} 状态 ${before} → ${after}`;
}
