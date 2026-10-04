export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

/** 操作单元类型：场次修改 / 顺序拖动 / 状态流转 / 锁定解锁 / 冲突豁免 */
export type OperationType = "场次修改" | "顺序调整" | "状态流转" | "锁定" | "解锁" | "冲突豁免";

/** 场次上可被操作单元覆盖的字段，撤销时按字段回退，不牵连其他字段 */
export type SceneField =
  | "code"
  | "title"
  | "day"
  | "start"
  | "end"
  | "talentIds"
  | "locationId"
  | "equipmentIds"
  | "status"
  | "order";

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

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
  /** 拖动顺序的持久化依据，排序键，与时间字段分离 */
  order: number;
}

export interface Conflict {
  /** 稳定冲突键，与豁免操作记录引用的键一致 */
  key: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export type FieldValues = Partial<Pick<Scene, SceneField>>;

/** 可检查的操作单元 */
export interface OperationRecord {
  /** 全局单调递增的操作编号，乐观并发控制的版本依据 */
  seq: number;
  id: string;
  type: OperationType;
  /** 提交人（操作单元的所有人） */
  actorId: string;
  actorName: string;
  actorRole: Role;
  time: string;
  sceneId?: string;
  sceneCode?: string;
  /** 仅记录本次操作触及的字段：旧值/新值，撤销按此回退 */
  changes?: { field: SceneField; before: unknown; after: unknown }[];
  /** 豁免冲突键（冲突豁免操作） */
  conflictKey?: string;
  note: string;
  /** 撤销该操作单元的撤销记录序号；存在即表示该单元已被撤销 */
  undoneBySeq?: number;
  undoActorId?: string;
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

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

/* ---------- 服务端提交协议 ---------- */

export interface CommitBase {
  /** 幂等键：同一键重复提交不能产生第二条操作记录 */
  requestId: string;
  /** 提交人看到该列表时的操作编号基线（乐观并发） */
  expectedSeq: number;
  actor: Actor;
  time: string;
}

export interface ModifyCommit extends CommitBase {
  kind: "modify";
  sceneId: string;
  before: FieldValues;
  after: FieldValues;
}

export interface ReorderCommit extends CommitBase {
  kind: "reorder";
  sceneId: string;
  before: number;
  after: number;
}

export interface StatusCommit extends CommitBase {
  kind: "status";
  sceneId: string;
  before: SceneStatus;
  after: SceneStatus;
}

export interface LockCommit extends CommitBase {
  kind: "lock";
  sceneId: string;
  locked: boolean;
}

export interface ExemptCommit extends CommitBase {
  kind: "exempt";
  conflictKey: string;
}

export interface UndoCommit extends CommitBase {
  kind: "undo";
  /** 待撤销操作单元的编号 */
  targetSeq: number;
}

export type CommitRequest =
  | ModifyCommit
  | ReorderCommit
  | StatusCommit
  | LockCommit
  | ExemptCommit
  | UndoCommit;

export interface CommitSuccess {
  ok: true;
  /** 提交后最新操作编号 */
  seq: number;
  operation: OperationRecord;
  conflicts: Conflict[];
  /** 幂等重放：没有新增操作记录 */
  replay?: boolean;
  /** 撤销时实际回退的字段说明 */
  restoredFields?: string[];
}

export interface CommitFailure {
  ok: false;
  /** forbidden：越权拒绝；stale：基线过期；invalid：业务校验失败；write：写入失败 */
  code: "forbidden" | "stale" | "invalid" | "write";
  message: string;
  /** stale 时返回最新操作编号与冲突说明，供后到者核对 */
  latestSeq: number;
  conflicts: Conflict[];
  /** 越权时的权限说明 */
  requiredRole?: Role;
}

export type CommitResult = CommitSuccess | CommitFailure;

/** 写入失败后留住的待撤销项：从原基线继续重试 */
export interface PendingUndo {
  requestId: string;
  targetSeq: number;
  /** 发起撤销时的原始基线，重试仍从它开始声明 */
  baselineSeq: number;
  actorId: string;
  note: string;
  createdAt: string;
  lastError?: string;
  attempts: number;
}
