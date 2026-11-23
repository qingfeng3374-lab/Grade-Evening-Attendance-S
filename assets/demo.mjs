import {blank, importReceipt, reportRows, classRows} from "./model.mjs";

const people = [
  ["001001", "示例同学甲", "计算2401"], ["001002", "示例同学乙", "计算2401"],
  ["001003", "示例同学丙", "计算2401"], ["001004", "示例同学丁", "计算2401"],
  ["001005", "示例同学戊", "计算2401"], ["001006", "示例同学己", "计算2401"],
  ["001007", "示例同学庚", "软件2401"], ["001008", "示例同学辛", "软件2401"],
  ["001009", "示例同学壬", "智科2401"], ["001010", "示例同学癸", "智科2401"],
].map(([id, name, group]) => ({id, name, group}));
const groups = [...new Set(people.map(person => person.group))];
const testFence = {
  name: "唐岛湾校区", version: "demo-only", buffer: 100, maxAccuracy: 75, testOnly: true,
  geometry: {type: "Polygon", coordinates: [[[120.165, 35.934], [120.173, 35.934], [120.173, 35.941],
    [120.165, 35.941], [120.165, 35.934]]]},
};

export function demoState(role) {
  const state = blank();
  const now = Date.now();
  const date = hours => new Date(now + hours * 3600000).toISOString();
  const demoData = {revision: 1, mode: "published", groups, fences: [testFence]};
  const task = {...demoData, id: "demo-evening", title: "本周晚点名", opens: date(-1), due: date(5),
    description: "请在截止前完成在校打卡或离校报备，并将回执私发给本班负责人。"};
  const past = {...demoData, id: "demo-previous", title: "上周晚点名", opens: date(-172), due: date(-166),
    description: "本次任务已截止，可查看历史填报记录。"};
  state.tasks = [task, past];
  if (role === "student") {
    state.profile = people[0];
    state.receipts = [{record: {id: "demo-past", taskId: past.id, revision: 1, studentId: people[0].id,
      name: people[0].name, group: people[0].group, result: "present", campus: "唐岛湾校区", accuracy: 21,
      submittedAt: date(-170)}, state: "accepted"}];
    return state;
  }
  state.snapshots = state.tasks.flatMap(item => groups.map(group => ({taskId: item.id, group,
    students: people.filter(person => person.group === group)})));
  const recorded = [1, 2, 4, 5, 6, 9];
  recorded.forEach((index, order) => {
    const person = people[index];
    const result = order === 2 ? "away" : "present";
    importReceipt(state, {id: "demo-r" + index, taskId: task.id, revision: 1,
      studentId: person.id, name: person.name, group: person.group, submittedAt: date(-0.4), result,
      ...(result === "away" ? {reason: "周末离校，次日返校。"} : {campus: "唐岛湾校区", accuracy: 18 + order})});
  });
  if (role === "leader") {
    state.snapshots = state.snapshots.filter(item => item.group === groups[0]);
    state.receipts = state.receipts.filter(item => item.record.group === groups[0]);
    return state;
  }
  state.roster = people;
  state.staff = people.slice(0, 1);
  state.fences = [testFence];
  state.reports = state.snapshots.filter(item => item.taskId === task.id && item.group !== groups[2]).map((item, index) => ({
    receivedAt: date(-0.1), report: {id: "demo-report-" + index, version: 1, taskId: task.id, group: item.group,
      createdAt: date(-0.15), note: index === 0 ? "今晚已完成首轮提醒，稍后会再核对未提交同学。" : "",
      rows: reportRows(classRows(state, item))},
  }));
  state.receipts = [];
  return state;
}
