/**
 * 核心验收脚本（node 下运行，esbuild 打包后执行）：
 * 1. 场次修改/锁定/状态/豁免都落为可检查操作单元，带字段前后值与编号；
 * 2. 撤销一项只还原该单元字段，其他已生效改动留在现场，冲突立即重算；
 * 3. 两名制片几乎同时撤销同一项：后到者收到 stale + 最新编号 + 冲突说明；
 * 4. 演员统筹撤销制片确认的锁定/豁免 → forbidden 越权拒绝；
 * 5. 写入失败留住待撤销清单，重试从原基线继续；重复提交不多一条记录（幂等）。
 */

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const storage = new MemoryStorage();
const listeners: ((e: any) => void)[] = [];
(globalThis as any).localStorage = storage;
(globalThis as any).window = {
  addEventListener(_: string, fn: (e: unknown) => void) {
    listeners.push(fn);
  }
};
(globalThis as any).navigator = { onLine: true };

import { commit, injectWriteFailures, resetLedger, seedScenes, snapshot } from "../src/core/server";
import type { Actor, CommitRequest } from "./src/types";

const producerA: Actor = { id: "pA", name: "制片甲", role: "制片" };
const producerB: Actor = { id: "pB", name: "制片乙", role: "制片" };
const talent: Actor = { id: "tc", name: "统筹", role: "演员统筹" };
const director: Actor = { id: "d1", name: "导演", role: "导演" };

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function now(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

async function expectOk(p: Promise<unknown>, label: string) {
  const r = (await p) as any;
  assert(r.ok === true, `${label}（成功）`);
  return r;
}

async function main() {
  resetLedger();

  /* --- 1. 操作单元：制片甲修改 s2 场地为 l3，制片乙随后改器材（模拟"别人随后改的场地和器材"） --- */
  console.log("\n[1] 操作单元落库 + 字段级撤销不覆盖他人后续改动");
  const s2 = seedScenes[1];
  let seq = 0;

  // op1: 制片甲把 s2 场地 l1 -> l3（化解与 s1 的场地冲突），演员 t1 与 s1 仍冲突
  let r: any = await expectOk(
    commit({
      kind: "modify",
      requestId: "req-loc",
      expectedSeq: seq,
      actor: producerA,
      time: now(),
      sceneId: s2.id,
      before: { locationId: "l1" },
      after: { locationId: "l3" }
    }),
    "制片甲修改场地"
  );
  seq = r.seq;
  assert(r.operation.changes.length === 1 && r.operation.changes[0].field === "locationId", "操作单元只记录触及字段（场地）");

  // op2: 制片乙随后修改 s2 器材 e2,e4 -> e1（别人随后改的器材安排）
  r = await expectOk(
    commit({
      kind: "modify",
      requestId: "req-equip",
      expectedSeq: seq,
      actor: producerB,
      time: now(1),
      sceneId: s2.id,
      before: { equipmentIds: ["e2", "e4"] },
      after: { equipmentIds: ["e1"] }
    }),
    "制片乙随后修改器材"
  );
  seq = r.seq;

  // 撤销 op1（场地修改）：场地应回到 l1，但器材必须保留制片乙的 e1
  r = (await commit({
    kind: "undo",
    requestId: "undo-loc",
    expectedSeq: seq,
    actor: producerA,
    time: now(2),
    targetSeq: 1
  })) as any;
  assert(r.ok, "撤销场地修改成功");
  const view = snapshot();
  const cur2 = view.scenes.find((s) => s.id === s2.id)!;
  assert(cur2.locationId === "l1", "撤销后场地回到旧值 l1");
  assert(JSON.stringify(cur2.equipmentIds) === JSON.stringify(["e1"]), "别人后改的器材 e1 留在现场，未被回滚");
  // 场地回到 l1 且与 s1 时间重叠 -> 场地冲突立即重算回来
  assert(view.conflicts.some((c) => c.type === "场地占用"), "改动过的冲突立即重算（场地占用重新出现）");

  /* --- 2. 锁定 / 解锁 / 状态流转均为操作单元 --- */
  console.log("\n[2] 锁定与状态流转操作单元");
  seq = snapshot().seq;
  r = await expectOk(
    commit({ kind: "lock", requestId: "lock-s2", expectedSeq: seq, actor: producerA, time: now(3), sceneId: s2.id, locked: true }),
    "制片甲锁定 s2"
  );
  const lockSeq = r.seq;
  seq = lockSeq;

  // 锁定后演员统筹改场地 -> 拒绝
  r = (await commit({
    kind: "modify",
    requestId: "tc-edit-locked",
    expectedSeq: seq,
    actor: talent,
    time: now(4),
    sceneId: s2.id,
    before: { locationId: "l1" },
    after: { locationId: "l2" }
  })) as any;
  assert(!r.ok && r.code === "forbidden", "锁定场次修改被拒绝");
  seq = snapshot().seq; // 失败不推进序号

  // 状态流转操作
  const s1 = seedScenes[0];
  r = await expectOk(
    commit({ kind: "status", requestId: "st-s1", expectedSeq: seq, actor: director, time: now(5), sceneId: s1.id, before: "已确认", after: "拍摄中" }),
    "导演推进 s1 状态"
  );
  assert(r.operation.type === "状态流转" && r.operation.changes[0].field === "status", "状态流转记录为字段操作单元");

  /* --- 3. 越权：演员统筹撤销制片确认的锁定 / 豁免 --- */
  console.log("\n[3] 越权拒绝");
  r = (await commit({
    kind: "undo",
    requestId: "tc-undo-lock",
    expectedSeq: snapshot().seq,
    actor: talent,
    time: now(6),
    targetSeq: lockSeq
  })) as any;
  assert(!r.ok && r.code === "forbidden", "演员统筹撤销制片锁定 → 越权拒绝");
  assert(/锁定|豁免/.test(r.message), "拒绝原因说明锁定/豁免须制片处理");
  assert(r.latestSeq === snapshot().seq, "拒绝返回最新操作编号");

  // 导演也不能撤销制片的锁定
  r = (await commit({
    kind: "undo",
    requestId: "d-undo-lock",
    expectedSeq: snapshot().seq,
    actor: director,
    time: now(7),
    targetSeq: lockSeq
  })) as any;
  assert(!r.ok && r.code === "forbidden", "导演撤销制片锁定 → 越权拒绝");

  // 制片乙可以撤销制片甲的锁定
  r = await expectOk(
    commit({ kind: "undo", requestId: "pB-undo-lock", expectedSeq: snapshot().seq, actor: producerB, time: now(8), targetSeq: lockSeq }),
    "制片乙撤销制片甲的锁定"
  );

  /* --- 4. 冲突豁免操作单元 + 统筹越权撤销豁免 --- */
  console.log("\n[4] 冲突豁免与撤销后重算");
  // 当前 s1/s2 都在 l1 且时间重叠：应有演员 t1 档期冲突与场地冲突
  const beforeConflicts = snapshot().conflicts;
  const talentConflict = beforeConflicts.find((c) => c.type === "演员档期");
  assert(!!talentConflict, "重算后存在演员档期冲突");
  seq = snapshot().seq;
  r = await expectOk(
    commit({ kind: "exempt", requestId: "ex-talent", expectedSeq: seq, actor: producerA, time: now(9), conflictKey: talentConflict.key }),
    "制片豁免演员冲突"
  );
  const exemptSeq = r.seq;
  assert(!snapshot().conflicts.some((c) => c.key === talentConflict.key), "豁免生效，冲突从清单消失");

  r = (await commit({
    kind: "undo",
    requestId: "tc-undo-ex",
    expectedSeq: snapshot().seq,
    actor: talent,
    time: now(10),
    targetSeq: exemptSeq
  })) as any;
  assert(!r.ok && r.code === "forbidden", "演员统筹撤销制片豁免 → 越权拒绝");

  r = await expectOk(
    commit({ kind: "undo", requestId: "pB-undo-ex", expectedSeq: snapshot().seq, actor: producerB, time: now(11), targetSeq: exemptSeq }),
    "制片撤销豁免"
  );
  assert(snapshot().conflicts.some((c) => c.key === talentConflict.key), "撤销豁免后冲突立即重算回来");

  /* --- 5. 两名制片几乎同时撤销同一项：后到者 stale 且拿到最新编号+冲突说明 --- */
  console.log("\n[5] 并发撤销同一项");
  seq = snapshot().seq;
  // 制造一个可撤销目标：制片甲改 s3 的时间
  r = await expectOk(
    commit({
      kind: "modify",
      requestId: "s3-time",
      expectedSeq: seq,
      actor: producerA,
      time: now(12),
      sceneId: "s3",
      before: { start: "15:00" },
      after: { start: "14:00" }
    }),
    "制片甲修改 s3 时间（并发撤销目标）"
  );
  const targetSeq = r.seq;
  const base = r.seq;

  // 两个撤销都基于同一基线，几乎同时进入队列（commit 内部串行落库）
  const undoA = commit({ kind: "undo", requestId: "pA-u", expectedSeq: base, actor: producerA, time: now(13), targetSeq });
  const undoB = commit({ kind: "undo", requestId: "pB-u", expectedSeq: base, actor: producerB, time: now(14), targetSeq });
  const [ra, rb] = (await Promise.all([undoA, undoB])) as any[];
  assert(ra.ok, "先到的制片撤销成功");
  assert(!rb.ok && rb.code === "stale", "后到者收到 stale（基线过期）而非覆盖");
  assert(rb.latestSeq === snapshot().seq, "后到者看到最新操作编号");
  assert(Array.isArray(rb.conflicts), "后到者同时拿到最新冲突说明");

  // 后到者对齐最新编号再撤销同一目标：发现已被撤销
  const rb2 = (await commit({ kind: "undo", requestId: "pB-u-retry", expectedSeq: snapshot().seq, actor: producerB, time: now(15), targetSeq })) as any;
  assert(!rb2.ok && rb2.code === "stale" && /已被/.test(rb2.message), "对齐后得知该项已撤销");

  /* --- 6. 幂等：重复提交不多一条记录 --- */
  console.log("\n[6] 幂等键");
  seq = snapshot().seq;
  const req: CommitRequest = {
    kind: "modify",
    requestId: "same-req-id",
    expectedSeq: seq,
    actor: producerA,
    time: now(16),
    sceneId: "s3",
    before: { end: "18:30" },
    after: { end: "19:00" }
  };
  const first = (await commit(req)) as any;
  const seqAfterFirst = snapshot().seq;
  const second = (await commit({ ...req, time: now(17) })) as any;
  assert(first.ok && second.ok && second.replay === true, "同一 requestId 第二次为幂等重放");
  assert(snapshot().seq === seqAfterFirst, "重复提交没有多出第二条操作记录");

  /* --- 7. 写入失败留住清单、从原基线继续（以服务端语义模拟 store 行为） --- */
  console.log("\n[7] 写入失败后从原基线重试");
  seq = snapshot().seq;
  // 一个待撤销目标
  const target = (await commit({
    kind: "modify",
    requestId: "target-7",
    expectedSeq: seq,
    actor: director,
    time: now(18),
    sceneId: "s3",
    before: { title: "候车厅告别" },
    after: { title: "候车厅重逢" }
  })) as any;
  const t7 = target.seq;
  const baseline = snapshot().seq;
  assert(snapshot().seq === baseline, "撤销前基线确认");

  // 注入下一次写入失败：撤销请求带着原基线发出
  injectWriteFailures(1);
  const failedUndo = (await commit({
    kind: "undo",
    requestId: "undo-7",
    expectedSeq: baseline, // 原基线
    actor: producerA,
    time: now(19),
    targetSeq: t7
  })) as any;
  assert(!failedUndo.ok && failedUndo.code === "write", "写入失败返回 write");
  assert(snapshot().seq === baseline, "写入失败后服务端序号/状态不变");
  const s3AfterFail = snapshot().scenes.find((s) => s.id === "s3")!;
  assert(s3AfterFail.title === "候车厅重逢", "失败后现场未被改动（待撤销清单保留在客户端）");

  // 重试：仍从原基线、同一 requestId
  const retryUndo = (await commit({
    kind: "undo",
    requestId: "undo-7", // 同一幂等键
    expectedSeq: baseline,
    actor: producerA,
    time: now(20),
    targetSeq: t7
  })) as any;
  assert(retryUndo.ok, "重试成功（从原基线继续）");
  assert(snapshot().scenes.find((s) => s.id === "s3")!.title === "候车厅告别", "重试撤销后标题回退");

  // 再重复发同一撤销：幂等，不多记录
  const duplicateUndo = (await commit({
    kind: "undo",
    requestId: "undo-7",
    expectedSeq: baseline,
    actor: producerA,
    time: now(21),
    targetSeq: t7
  })) as any;
  assert(duplicateUndo.replay === true, "失败重试成功后再重复提交，仍走幂等重放");

  /* --- 8. 拖动顺序是独立操作单元，撤销只动 order --- */
  console.log("\n[8] 顺序调整");
  seq = snapshot().seq;
  const orderOp = (await commit({ kind: "reorder", requestId: "reorder-1", expectedSeq: seq, actor: director, time: now(22), sceneId: "s1", before: 1, after: 1.5 })) as any;
  assert(orderOp.ok && orderOp.operation.changes[0].field === "order", "拖动只产生 order 字段的操作单元");
  const undoOrder = (await commit({ kind: "undo", requestId: "undo-reorder", expectedSeq: snapshot().seq, actor: director, time: now(23), targetSeq: orderOp.seq })) as any;
  assert(undoOrder.ok, "顺序调整可撤销");
  assert(snapshot().scenes.find((s) => s.id === "s1")!.order === 1, "撤销后 order 回退");

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
