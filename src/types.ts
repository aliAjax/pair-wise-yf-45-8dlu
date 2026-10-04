export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type OperationKind = "场次修改" | "锁定" | "状态流转" | "冲突豁免" | "撤销";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
  order: number;
}

/** 字段级变更单元：撤销时只还原 before 中的字段 */
export interface FieldChange {
  sceneId?: string;
  conflictId?: string;
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

/** 可检查的操作单元 */
export interface Operation {
  id: string;
  /** 操作编号，全局单调递增，后到者据此判断是否过期 */
  seq: number;
  kind: OperationKind;
  actor: Role;
  time: string;
  sceneId?: string;
  sceneCode?: string;
  summary: string;
  changes: FieldChange[];
  undone: boolean;
  undoneAt?: string;
  /** 撤销操作所针对的原操作 id */
  undoOf?: string;
  /** 该操作提交时基于的最新操作编号 */
  baseline: number;
}

/** 写入失败后留住的待撤销项，重试从原基线继续 */
export interface PendingUndo {
  /** 幂等键，重复提交不会产生第二条撤销记录 */
  id: string;
  targetOpId: string;
  baseline: number;
  changes: FieldChange[];
  attempts: number;
  lastError: string;
  createdAt: string;
}

export type UndoErrorType = "conflict" | "unauthorized" | "missing" | "pending" | "in-flight" | "write-failed";

export interface UndoError {
  type: UndoErrorType;
  message: string;
  latestSeq?: number;
  latestSummary?: string;
  pending?: PendingUndo;
}

export interface UndoResult {
  ok: boolean;
  op?: Operation;
  error?: UndoError;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}
