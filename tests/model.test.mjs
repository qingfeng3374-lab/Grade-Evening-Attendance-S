import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {judgePosition, validateFence, validateGeometry} from "../dist/assets/geo.mjs";
import {archiveTask, beijingInput, blank, classRoster, classRows, csvText, importReceipt, importRoster, importTask,
  parseCSV, readBeijing, resolveReceipt, summarize} from "../dist/assets/model.mjs";

const outer = [[120.16, 35.93], [120.18, 35.93], [120.18, 35.95], [120.16, 35.95], [120.16, 35.93]];
const hole = [[120.169, 35.939], [120.171, 35.939], [120.171, 35.941], [120.169, 35.941], [120.169, 35.939]];
const fence = {name: "唐岛湾校区", version: "test", buffer: 20, maxAccuracy: 50,
  geometry: {type: "Polygon", coordinates: [outer, hole]}};

test("围栏内、外、孔洞、周边、边界误差与低精度各自判断", () => {
  const status = (longitude, latitude, accuracy) => judgePosition([fence], {longitude, latitude, accuracy}).status;
  assert.equal(status(120.165, 35.938, 10), "pass");
  assert.equal(status(120.20, 35.95, 10), "outside");
  assert.equal(status(120.17, 35.94, 10), "outside");
  assert.equal(status(120.1599, 35.936, 5), "pass");
  assert.equal(status(120.1598, 35.936, 20), "uncertain");
  assert.equal(status(120.165, 35.936, 60), "uncertain");
  assert.throws(() => validateGeometry({type: "Polygon", coordinates: [outer.slice(0, 4)]}), /首尾/);
});

test("唐岛湾预设覆盖校内和门口，排除校外测点", () => {
  const feature = JSON.parse(readFileSync(new URL("../dist/assets/tangdaowan-boundary.geojson", import.meta.url), "utf8"));
  const actual = validateFence({name: feature.properties.name, version: feature.properties.version,
    buffer: 30, maxAccuracy: 100, geometry: feature});
  const result = (longitude, latitude, accuracy) => judgePosition([actual], {longitude, latitude, accuracy});
  assert.equal(result(120.16533, 35.94322, 15).status, "pass");
  assert.equal(result(120.1757398, 35.9434644, 14).status, "pass");
  assert.equal(result(120.185, 35.946, 15).status, "outside");
  assert.equal(result(120.1698165, 35.9430351, 100).status, "pass");
  assert.equal(result(120.1698165, 35.9430351, 101).status, "uncertain");
});

test("北京时间在不同时区保持一致，并拒绝无效日期", () => {
  assert.equal(readBeijing("2026-11-23T20:15"), "2026-11-23T12:15:00.000Z");
  assert.equal(beijingInput("2026-11-23T12:15:00.000Z"), "2026-11-23T20:15");
  assert.throws(() => readBeijing("2026-02-30T20:15"), /北京时间/);
});

const alice = {id: "0001", group: "测试2401", name: "测试甲"};
const task = {id: "test-evening", revision: 1, mode: "published", title: "晚点名",
  opens: "2026-01-02T10:00:00.000Z", due: "2026-01-02T11:00:00.000Z",
  groups: [alice.group], fences: [fence], description: ""};
const receipt = {id: "receipt-1", taskId: task.id, revision: 1, studentId: alice.id, name: alice.name, group: alice.group,
  submittedAt: "2026-01-02T10:30:00.000Z", result: "away", reason: "示例"};

test("班级名单锁定，重复回执不重复计数，冲突可核验，撤销阻止旧包覆盖", () => {
  const state = blank();
  importTask(state, task);
  importRoster(state, {taskId: task.id, group: alice.group, students: [alice]});
  const snapshot = classRoster(state, task.id, alice.group);
  assert.equal(importReceipt(state, receipt, Date.parse(task.due)), "已导入");
  assert.equal(importReceipt(state, receipt, Date.parse(task.due)), "重复");
  assert.equal(importReceipt(state, {...receipt, id: "receipt-2", reason: "更正"}, Date.parse(task.due)), "待核验");
  assert.equal(summarize(classRows(state, snapshot)).pending, 1);
  resolveReceipt(state, "receipt-2", false);
  assert.equal(summarize(classRows(state, snapshot)).done, 1);
  assert.throws(() => importRoster(state, {taskId: task.id, group: alice.group, students: []}), /快照冲突/);
  importTask(state, {...task, mode: "revoked", revision: 2});
  importTask(state, task);
  assert.equal(state.tasks[0].mode, "revoked");
  archiveTask(state, task.id);
  assert.equal(state.receipts.length, 0);
  assert.equal(state.snapshots.length, 0);
  assert.equal(state.tasks[0].mode, "revoked");
});

test("CSV 保留学号前导零，识别引号，导出转义公式前缀", () => {
  const data = parseCSV('\uFEFF学号,姓名,班级\r\n0001,"示例,甲",测试2401');
  assert.equal(data[0].id, "0001");
  assert.equal(data[0].name, "示例,甲");
  assert.match(csvText([["0001", "=1+1", "原话\"引号"]]), /"0001","'=1\+1","原话""引号"/);
});
