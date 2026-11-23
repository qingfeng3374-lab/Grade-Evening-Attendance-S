import {validateFence} from "./geo.mjs";

export const roleNames = {student: "学生端", leader: "班级负责人端", admin: "管理端"};
export const statuses = {draft: ["草稿", "neutral"], waiting: ["未开始", "neutral"],
  active: ["进行中", "blue"], ended: ["已截止", "neutral"], revoked: ["已撤销", "red"],
  present: ["在校打卡", "green"], away: ["离校报备", "amber"],
  missing: ["未提交", "neutral"], pending: ["待核验", "red"]};

export function need(value, message) {
  if (!value) throw new Error(message);
  return value;
}

export function field(value, label, max = 80) {
  const result = typeof value === "string" ? value.trim() : "";
  need(result && result.length <= max, label + " 缺失或超过 " + max + " 字。");
  return result;
}

const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export function studentId(value) {
  const result = field(value, "学号", 24);
  need(/^[0-9]{1,24}$/.test(result), "学号须为数字文本。");
  return result;
}

export function newId() {
  return crypto.randomUUID();
}

export function blank() {
  return {profile: null, roster: [], staff: [], fences: [], tasks: [], snapshots: [],
    receipts: [], reports: [], sentReports: [], archives: [], imports: []};
}

export function recordImport(state, label, results) {
  state.imports = [{label, results, at: new Date().toISOString()}, ...(state.imports ?? [])].slice(0, 50);
}

export function archived(state, taskId) {
  return (state.archives ?? []).includes(taskId);
}

export function archiveTask(state, taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  need(task && ["ended", "revoked"].includes(statusOf(task)), "仅可清理已截止或已撤销的任务。");
  need(!archived(state, taskId), "该任务的本机数据已经清理。");
  state.archives = [...(state.archives ?? []), taskId];
  state.snapshots = state.snapshots.filter(item => item.taskId !== taskId);
  state.receipts = state.receipts.filter(item => item.record.taskId !== taskId);
  state.reports = state.reports.filter(item => item.report.taskId !== taskId);
  state.sentReports = state.sentReports.filter(item => item.taskId !== taskId);
}

export function statusOf(task, now = Date.now()) {
  if (task.mode !== "published") return task.mode;
  if (now < Date.parse(task.opens)) return "waiting";
  return now < Date.parse(task.due) ? "active" : "ended";
}

export function readBeijing(text) {
  need(/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(text), "请填写有效的北京时间。");
  const value = Date.parse(text + ":00+08:00");
  need(Number.isFinite(value) && beijingInput(value) === text, "请检查北京时间。");
  return new Date(value).toISOString();
}

export function beijingInput(value) {
  const milliseconds = typeof value === "number" ? value : Date.parse(value);
  return new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 16);
}

const timeSource = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"});

export function displayTime(value) {
  return value ? timeSource.format(new Date(value)).replaceAll("/", ".") : "—";
}

function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

export function validatePerson(row) {
  return {id: studentId(row?.id), name: field(row?.name, "姓名", 40), group: field(row?.group, "班级", 50)};
}

export function packet(type, data, demo) {
  return {schemaVersion: 1, type, demo, data};
}

export function unpack(value, type, demo) {
  need(value?.schemaVersion === 1 && typeof value.demo === "boolean" && value.data, "文件格式或版本不受支持。");
  need(value.demo === demo, "演示文件和正式文件分开使用。");
  need((Array.isArray(type) ? type : [type]).includes(value.type), "请导入当前操作需要的文件。");
  return value;
}

export function cleanTask(raw) {
  need(validId(raw?.id) && Number.isSafeInteger(raw.revision) && raw.revision > 0, "任务编号或版本有误。");
  need(["published", "revoked"].includes(raw.mode), "任务状态无效。");
  const title = field(raw.title, "任务标题", 70);
  need(validTime(raw.opens) && validTime(raw.due) && raw.opens < raw.due, "任务时间有误。");
  need(Array.isArray(raw.groups) && raw.groups.length >= 1 && raw.groups.length <= 100, "任务适用班级有误。");
  const groups = [...new Set(raw.groups.map(group => field(group, "班级", 50)))];
  need(Array.isArray(raw.fences) && raw.fences.length >= 1 && raw.fences.length <= 3, "任务未配置打卡校区。");
  const fences = raw.fences.map(validateFence);
  need(new Set(fences.map(fence => fence.name)).size === fences.length, "任务有重复的校区围栏。");
  const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 2000) : "";
  return {id: raw.id, title, description, opens: raw.opens, due: raw.due, groups, fences,
    revision: raw.revision, mode: raw.mode};
}

const comparable = item => JSON.stringify(item);

export function importTask(state, raw) {
  const incoming = cleanTask(raw);
  const index = state.tasks.findIndex(task => task.id === incoming.id);
  if (index < 0) {
    state.tasks.push(incoming);
    return "已导入任务";
  }
  const previous = state.tasks[index];
  if (previous.revision > incoming.revision || (previous.mode === "revoked" && incoming.mode !== "revoked")) {
    return "已保留本机较新的任务状态";
  }
  if (previous.revision === incoming.revision) {
    need(comparable(previous) === comparable(incoming), "同一任务版本的内容冲突。");
    return "该任务版本已导入";
  }
  need(incoming.opens === previous.opens && incoming.due >= previous.due
    && comparable(incoming.groups) === comparable(previous.groups)
    && comparable(incoming.fences) === comparable(previous.fences), "任务更新试图改变已锁定的时间或范围。");
  if (incoming.mode === "published" && archived(state, incoming.id) && statusOf(incoming) !== "ended") {
    state.archives = state.archives.filter(id => id !== incoming.id);
  }
  state.tasks[index] = incoming;
  return incoming.mode === "revoked" ? "已导入撤销通知" : "已更新任务";
}

export function classRoster(state, taskId, group) {
  return state.snapshots.find(item => item.taskId === taskId && item.group === group);
}

export function importRoster(state, raw) {
  const task = need(state.tasks.find(item => item.id === raw?.taskId), "请先导入对应的任务包。");
  need(!archived(state, task.id), "此任务的本机报备数据已清理。");
  const group = field(raw.group, "班级", 50);
  need(task.groups.includes(group) && Array.isArray(raw.students) && raw.students.length <= 1500, "任务名单范围不符。");
  const students = raw.students.map(validatePerson);
  need(students.every(student => student.group === group), "名单包含其他班的学生。");
  need(new Set(students.map(student => student.id)).size === students.length, "名单包含重复学号。");
  const existing = classRoster(state, task.id, group);
  if (existing) {
    const sorted = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    need(comparable(sorted(existing.students)) === comparable(sorted(students)), "应报名单与已导入的快照冲突。");
    return "本班应报名单已导入";
  }
  state.snapshots.push({taskId: task.id, group, students});
  return "已导入 " + group + " 应报名单";
}

export function cleanReceipt(raw) {
  need(validId(raw?.id) && validId(raw?.taskId) && validTime(raw.submittedAt)
    && Number.isSafeInteger(raw.revision) && raw.revision >= 1, "回执编号、任务版本或提交时间有误。");
  const {id: number, name, group} = validatePerson({id: raw.studentId, name: raw.name, group: raw.group});
  const value = {id: raw.id, taskId: raw.taskId, revision: raw.revision,
    studentId: number, name, group, submittedAt: raw.submittedAt, result: raw.result};
  if (raw.result === "present") {
    value.campus = field(raw.campus, "校区", 40);
    need(Number.isFinite(raw.accuracy) && raw.accuracy > 0 && raw.accuracy <= 1000, "回执定位精度有误。");
    value.accuracy = raw.accuracy;
  } else {
    need(raw.result === "away", "未知的填报结果。");
    value.reason = field(raw.reason, "离校原因", 500);
  }
  return value;
}

export function importReceipt(state, raw, now = Date.now()) {
  const record = cleanReceipt(raw);
  const task = need(state.tasks.find(item => item.id === record.taskId), "回执对应的任务尚未导入。");
  need(!archived(state, task.id), "此任务的本机报备数据已清理。");
  const snapshot = need(classRoster(state, task.id, record.group), "请先导入这项任务的本班应报名单。");
  const student = need(snapshot.students.find(item => item.id === record.studentId), "回执学号不在应报名单内。");
  const existing = state.receipts.find(item => item.record.id === record.id);
  if (existing) {
    need(comparable(existing.record) === comparable(record), "相同回执编号包含不同内容。");
    return "重复";
  }
  need(task.mode !== "revoked", "任务已撤销，停止导入新的回执。");
  const previous = state.receipts.filter(item => item.record.taskId === task.id && item.record.studentId === record.studentId);
  const outOfTime = record.submittedAt < task.opens || record.submittedAt >= task.due || Date.parse(record.submittedAt) > now + 300000;
  const invalidFence = record.result === "present" && !task.fences.some(fence =>
    fence.name === record.campus && record.accuracy <= fence.maxAccuracy);
  const issue = [student.name !== record.name && "姓名与应报名单不一致",
    record.revision > task.revision && "本机任务版本落后，请先导入最新任务包",
    outOfTime && "填报时间待核对", invalidFence && "定位信息与任务规则不符",
    previous.some(item => item.state !== "rejected") && "该学生已有其他回执"].filter(Boolean).join("、");
  state.receipts.push({record, state: issue ? "pending" : "accepted", issue});
  return issue ? "待核验" : "已导入";
}

export function resolveReceipt(state, recordId, accept) {
  const item = need(state.receipts.find(entry => entry.record.id === recordId && entry.state === "pending"), "该记录已处理。");
  if (accept) {
    const task = need(state.tasks.find(entry => entry.id === item.record.taskId), "任务已不存在。");
    need(item.record.revision <= task.revision, "请先导入最新的任务包。");
    for (const entry of state.receipts) {
      if (entry !== item && entry.record.taskId === item.record.taskId && entry.record.studentId === item.record.studentId) {
        entry.state = "rejected";
      }
    }
  }
  item.state = accept ? "accepted" : "rejected";
}

export function classRows(state, snapshot) {
  if (!snapshot) return [];
  const entries = new Map();
  for (const item of state.receipts) {
    if (item.record.taskId !== snapshot.taskId || item.record.group !== snapshot.group || item.state === "rejected") continue;
    const list = entries.get(item.record.studentId) ?? [];
    list.push(item);
    entries.set(item.record.studentId, list);
  }
  return snapshot.students.map(person => {
    const list = entries.get(person.id) ?? [];
    const accepted = list.find(item => item.state === "accepted");
    return {...person, status: list.some(item => item.state === "pending") ? "pending" : accepted?.record.result ?? "missing",
      record: accepted?.record ?? null, entries: list};
  });
}

export function summarize(rows) {
  const counts = {total: rows.length, present: 0, away: 0, missing: 0, pending: 0};
  for (const row of rows) counts[row.status]++;
  counts.done = counts.present + counts.away;
  return counts;
}

export function rate(part, total) {
  if (!total) return "—";
  return new Intl.NumberFormat("zh-CN", {style: "percent", maximumFractionDigits: 1}).format(part / total);
}

export function reportRows(rows) {
  return rows.map(row => {
    const result = {id: row.id, status: row.status};
    if (["present", "away"].includes(row.status)) result.record = row.record;
    return result;
  });
}

export function importReport(state, raw, now = new Date().toISOString()) {
  need(validId(raw?.id) && Number.isSafeInteger(raw.version) && raw.version >= 1
    && validTime(raw.createdAt), "报送编号、版本或时间无效。");
  const task = need(state.tasks.find(item => item.id === raw.taskId && item.mode !== "draft"), "管理端找不到这项任务。");
  need(!archived(state, task.id), "此任务的本机报备数据已清理。");
  need(task.mode !== "revoked", "任务已撤销，停止接收新的班级报送。");
  const snapshot = need(classRoster(state, task.id, raw.group), "班级与该任务的应报名单不符。");
  need(Array.isArray(raw.rows) && raw.rows.length === snapshot.students.length, "报送人数与该班应报名单不符。");
  const registered = new Set(snapshot.students.map(student => student.id));
  const rows = raw.rows.map(row => {
    need(registered.delete(row?.id) && ["present", "away", "pending", "missing"].includes(row.status),
      "报送包含重复学号、未知学号或无效状态。");
    if (["missing", "pending"].includes(row.status)) return {id: row.id, status: row.status};
    const record = cleanReceipt(row.record);
    need(record.studentId === row.id && record.group === raw.group && record.taskId === task.id
      && record.result === row.status && record.revision <= task.revision, "报送中的回执与任务或学生不符。");
    return {id: row.id, status: row.status, record};
  });
  const report = {id: raw.id, version: raw.version, taskId: task.id, group: raw.group,
    createdAt: raw.createdAt, note: typeof raw.note === "string" ? raw.note.trim().slice(0, 1200) : "", rows};
  const index = state.reports.findIndex(item => item.report.taskId === task.id && item.report.group === raw.group);
  if (index < 0) {
    state.reports.push({report, receivedAt: now});
    return "已导入班级报送";
  }
  const previous = state.reports[index].report;
  if (previous.version > report.version) return "已保留较新班级报送";
  if (previous.version === report.version) {
    need(comparable(previous) === comparable(report), "同一报送版本的内容冲突。");
    return "该班级报送已导入";
  }
  state.reports[index] = {report, receivedAt: now};
  return "已更新班级报送";
}

export function adminRows(snapshot, report) {
  const byId = new Map(report?.rows.map(row => [row.id, row]) ?? []);
  return snapshot.students.map(person => ({...person, status: byId.get(person.id)?.status ?? "missing",
    record: byId.get(person.id)?.record ?? null}));
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let value = "";
  let mode = "start";
  text = text.replace(/^\uFEFF/, "");
  function push() {
    row.push(value);
    value = "";
    mode = "start";
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (mode === "quoted") {
      if (char !== '"') value += char;
      else if (text[i + 1] === '"') { value += '"'; i++; }
      else mode = "closed";
    } else if (char === ",") push();
    else if (char === "\n" || char === "\r") {
      push();
      if (row.some(Boolean)) rows.push(row);
      row = [];
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (mode === "start" && char === '"') mode = "quoted";
    else {
      need(mode !== "closed" && char !== '"', "CSV 中有格式错误的引号。");
      value += char;
      mode = "plain";
    }
  }
  need(mode !== "quoted", "CSV 有未闭合的引号。");
  push();
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map(text => text.trim()) ?? [];
  const indexes = ["学号", "姓名", "班级"].map(name => headers.indexOf(name));
  need(indexes.every(index => index >= 0), "CSV 需包含学号、姓名、班级三列。");
  const data = rows.map(row => validatePerson({id: row[indexes[0]], name: row[indexes[1]], group: row[indexes[2]]}));
  need(data.length > 0 && data.length <= 6000, "名单应有 1 至 6000 行。");
  need(new Set(data.map(row => row.id)).size === data.length, "名单包含重复学号。");
  return data;
}

export function csvText(rows) {
  const cell = value => {
    const text = String(value ?? "");
    const safe = /^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n");
}
