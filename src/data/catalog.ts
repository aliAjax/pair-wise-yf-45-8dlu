import type { Actor, Equipment, Location, Talent } from "../types";

/** 工作台里的固定参与人：身份含角色，越权判断按身份的角色进行 */
export const actors: Actor[] = [
  { id: "u-producer-1", name: "制片·陆征", role: "制片" },
  { id: "u-producer-2", name: "制片·韩露", role: "制片" },
  { id: "u-director-1", name: "导演·沈彻", role: "导演" },
  { id: "u-talent-1", name: "演员统筹·苏绮", role: "演员统筹" },
  { id: "u-logger-1", name: "场记·小满", role: "场记" }
];

export const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

export const locations: Location[] = [
  { id: "l1", name: "老码头" },
  { id: "l2", name: "玻璃厂房" },
  { id: "l3", name: "南站候车厅" }
];

export const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

/** 状态流转允许的下一步 */
export const nextStatus: Record<string, string> = {
  "草稿": "已确认",
  "已确认": "拍摄中",
  "拍摄中": "已完成",
  "已完成": "已完成"
};
