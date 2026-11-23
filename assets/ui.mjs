import {displayTime, rate, statuses} from "./model.mjs?v=2";

export const escape = value => String(value ?? "").replace(/[&<>"']/g, char =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);

export function button(name, action, css = "", value = "") {
  return '<button type="button" class="button ' + css + '" data-do="' + action
    + '" data-value="' + escape(value) + '">' + escape(name) + '</button>';
}

export function submit(name, css = "") {
  return '<button type="submit" class="button ' + css + '">' + escape(name) + '</button>';
}

export function tag(status) {
  const [name, color] = statuses[status] ?? [status, "neutral"];
  return '<span class="tag ' + color + '">' + escape(name) + '</span>';
}

export const photo = '<picture class="campus-photo"><source media="(max-width: 600px)" srcset="./assets/campus-mobile.webp">'
  + '<img src="./assets/campus.webp" width="1050" height="640" alt=""></picture>';

export function hero(title, caption, actions, imagery = false) {
  return '<section class="hero desk-hero' + (imagery ? " with-photo" : "") + '">' + (imagery ? photo : "")
    + '<div><p class="hero-kicker">晚点名报备 · 24 级</p><h1>' + escape(title)
    + '</h1><p class="hero-description">' + escape(caption) + '</p></div><div class="actions">' + actions + '</div></section>';
}

export function panel(title, contents, actions = "", style = "") {
  return '<section class="panel ' + style + '"><div class="panel-title"><h2>' + escape(title)
    + '</h2>' + actions + '</div>' + contents + '</section>';
}

export function layout(main, aside) {
  return '<div class="desk-layout"><div class="stack">' + main + '</div><aside class="stack">' + aside + '</aside></div>';
}

export function empty(title, description, action = "") {
  return '<div class="empty"><h3>' + escape(title) + '</h3><p class="meta">' + escape(description)
    + '</p>' + (action ? '<div class="actions">' + action + '</div>' : "") + '</div>';
}

export const note = (text, warning = false) => '<p class="note' + (warning ? " warn" : "") + '" role="status">' + escape(text) + '</p>';

export function taskCard(task, condition, action, selected = false, extra = "") {
  return '<article class="task" data-selected="' + selected + '"><div><div class="task-name"><h3>' + escape(task.title)
    + '</h3>' + tag(condition) + '</div><p class="meta">截止 ' + escape(displayTime(task.due))
    + '（北京时间）</p>' + (extra ? '<p class="tiny">' + escape(extra) + '</p>' : "") + '</div>' + action + '</article>';
}

export function stats(items) {
  return '<dl class="stats">' + items.map(([name, count]) => '<div class="stat"><dt>'
    + escape(name) + '</dt><dd>' + escape(count) + '</dd></div>').join("") + '</dl>';
}

export function distribution(counts, title) {
  const groups = ["present", "away", "pending", "missing"];
  const segments = groups.filter(key => counts[key] > 0).map(key =>
    '<span class="segment ' + key + '" style="--share:' + (counts[key] / counts.total) + '"></span>').join("");
  return '<figure class="metric-chart"><figcaption>' + escape(title) + '</figcaption>'
    + '<div class="segment-track" aria-hidden="true">' + segments + '</div>'
    + '<ul class="chart-legend">' + groups.map(key => '<li><span class="swatch ' + key + '" aria-hidden="true"></span>'
      + statuses[key][0] + ' <strong>' + counts[key] + '</strong></li>').join("") + '</ul></figure>';
}

export function completionBar(counts, label) {
  return '<div class="class-progress"><progress class="progress" aria-label="' + escape(label)
    + '" max="' + (counts.total || 1) + '" value="' + counts.done + '"></progress><strong>'
    + rate(counts.done, counts.total) + '</strong></div>';
}

export function keys(items) {
  return '<dl class="key-values">' + items.map(([name, value]) => '<dt>' + escape(name) + '</dt><dd>'
    + escape(value) + '</dd>').join("") + '</dl>';
}

export function form(name, contents, hiddenId = "") {
  return '<form data-form="' + name + '" data-id="' + escape(hiddenId) + '">' + contents
    + '<p class="form-error" role="alert" hidden></p></form>';
}

export function input(name, label, value = "", attrs = "") {
  return '<label class="field"><span>' + escape(label) + '</span><input name="' + name + '" value="'
    + escape(value) + '" ' + attrs + '></label>';
}

export function area(name, label, value = "", attrs = "") {
  return '<label class="field"><span>' + escape(label) + '</span><textarea name="' + name
    + '" ' + attrs + '>' + escape(value) + '</textarea></label>';
}

export function select(name, label, items, selected, attributes = "") {
  return '<label class="field"><span>' + escape(label) + '</span><select name="' + name + '" ' + attributes + '>'
    + items.map(([id, title]) => '<option value="' + escape(id) + '"' + (id === selected ? " selected" : "")
      + '>' + escape(title) + '</option>').join("") + '</select></label>';
}

export function checklist(name, label, items, checked) {
  return '<fieldset class="form-options"><legend>' + escape(label) + '</legend><div class="check-grid">'
    + items.map(item => '<label class="check"><input type="checkbox" name="' + name + '" value="' + escape(item)
      + '"' + (checked.includes(item) ? " checked" : "") + '>' + escape(item) + '</label>').join("") + '</div></fieldset>';
}

export function receiptKeys(record) {
  if (!record) return [];
  return [["填报时间", displayTime(record.submittedAt)], ["填报类型", statuses[record.result][0]],
    ...(record.result === "present" ? [["判定校区", record.campus], ["定位精度", Math.round(record.accuracy) + " 米"]]
      : [["离校原因", record.reason]])];
}

export function serializeDetails(rows, title) {
  return [["任务", "班级", "姓名", "学号", "状态", "填报时间（北京时间）", "判定校区", "定位精度（米）", "离校原因"],
    ...rows.map(row => [title, row.group, row.name, row.id, statuses[row.status]?.[0] ?? row.status,
      row.record ? displayTime(row.record.submittedAt) : "", row.record?.campus, row.record?.accuracy,
      row.record?.reason])];
}

export function taskOrder(tasks) {
  const weight = {active: 0, waiting: 1, draft: 2, ended: 3, revoked: 4};
  return [...tasks].sort((a, b) => weight[a.current] - weight[b.current] || b.due.localeCompare(a.due));
}
