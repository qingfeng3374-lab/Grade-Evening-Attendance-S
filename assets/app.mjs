import {applyOnlineAttendance, applySharedTask, archiveTask, archived, blank, csvText, displayTime, need, packet, roleNames, statusOf} from "./model.mjs?v=8";
import {openWorkspace, readWorkspace} from "./storage.mjs";
import {button, escape, form, note, select, submit} from "./ui.mjs?v=2";

const root = document.querySelector("main");
const dialog = document.querySelector("#dialog");
const fileInput = document.querySelector("#files");
const live = document.querySelector("#live");
const role = document.body.dataset.role;
const demo = new URLSearchParams(location.search).get("demo") === "1";
const routes = {student: "./student.mjs?v=8", leader: "./leader.mjs?v=8", admin: "./admin.mjs?v=8"};
const ui = {};
let storage;
let workspace;
let screen;
let lastFocus;
let timer;
let taskPhases;
let auth;
let session;
let taskCursor = 0;
let attendanceCursor = 0;
let pendingTaskSync;
let deferredTaskDraw = false;

function toast(message, failure = false) {
  clearTimeout(timer);
  live.hidden = false;
  live.classList.toggle("failure", failure);
  live.textContent = message;
  timer = setTimeout(() => { live.hidden = true; }, failure ? 7600 : 4200);
}

function draw() {
  deferredTaskDraw = false;
  const demoMark = demo
    ? '<div class="demo-bar"><span><strong>演示模式</strong> · 示例记录独立保存</span><a href="./' + role + '.html">退出演示</a></div>' : "";
  root.innerHTML = demoMark + screen.render();
  taskPhases = workspace.tasks.map(task => statusOf(task)).join("/");
}

async function edit(update, {redraw = true} = {}) {
  workspace = await storage.edit(update);
  if (redraw) draw();
}

function show(title, content) {
  if (!dialog.open) lastFocus = document.activeElement;
  dialog.innerHTML = '<div class="dialog-box"><div class="dialog-heading"><h2 id="dialog-title">' + escape(title)
    + '</h2>' + button("关闭", "close", "quiet compact") + '</div>' + content + '</div>';
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("input:not([type=checkbox]), textarea, select")?.focus();
}

function close() {
  dialog.close();
}

function dataDialog() {
  const active = workspace.tasks.filter(task =>
    ["ended", "revoked"].includes(statusOf(task)) && !archived(workspace, task.id));
  const audits = (workspace.imports ?? []).slice(0, 8);
  show("本机数据", '<p class="meta">备份可能包含学籍或个人回执，请妥善保管。</p><div class="actions">'
    + button("下载本机备份", "data-backup", "secondary") + '</div>'
    + (active.length ? form("data-clean", select("task", "可清理的已结束任务", [["", "请选择任务"],
      ...active.map(task => [task.id, task.title])], "", "required") + '<div class="actions">'
      + submit("选择清理任务", "danger") + '</div>') : "")
    + (audits.length ? '<h3>最近导入</h3><div class="rows">' + audits.map(item => '<div class="list-row"><div><strong>'
      + escape(item.label) + '</strong><p class="meta">' + escape(item.results) + '</p></div><span class="tiny">'
      + escape(displayTime(item.at)) + '</span></div>').join("") + '</div>' : ""));
}

const commonActions = {
  "logout"() {
    auth.signOut();
    leave();
  },
  "data-tools": dataDialog,
  async "refresh-tasks"() {
    await syncTasks();
    toast("任务列表已刷新。");
  },
  "data-backup"() {
    json("晚点名本机备份-" + roleNames[role] + "-" + new Date().toISOString().slice(0, 10), "backup",
      {role, createdAt: new Date().toISOString(), workspace});
  },
};

const commonForms = {
  "data-clean"(data) {
    const task = need(workspace.tasks.find(item => item.id === data.get("task")), "请选择任务。");
    show("清理本机报备数据", form("data-confirm",
      note("清理后将保留「" + task.title + "」的任务状态，并移除此设备的相关名单快照、回执及报送数据。", true)
      + '<div class="actions">' + submit("确认清理", "danger") + button("返回", "data-tools", "secondary") + '</div>', task.id));
  },
  async "data-confirm"(_, id) {
    await edit(state => archiveTask(state, id));
    dataDialog();
    toast("已清理此任务在本机的报备数据。");
  },
};

dialog.addEventListener("close", () => {
  if (dialog.open) return;
  if (deferredTaskDraw && screen) draw();
  if (lastFocus?.isConnected) lastFocus.focus();
  else {
    root.tabIndex = -1;
    root.focus({preventScroll: true});
  }
});

function pick(accept, multiple = false) {
  return new Promise(resolve => {
    fileInput.value = "";
    fileInput.accept = accept;
    fileInput.multiple = multiple;
    fileInput.onchange = () => resolve([...fileInput.files]);
    fileInput.oncancel = () => resolve([]);
    fileInput.click();
  });
}

async function read(file, json = true) {
  need(file?.size > 0 && file.size <= 5_000_000, "请选择小于 5 MB 的有效文件。");
  const content = (await file.text()).replace(/^\uFEFF/, "");
  if (!json) return content;
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("无法读取 " + file.name + "，请检查 JSON 格式。");
  }
}

const safeFilename = file => file.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-");

function download(file, data, mime) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([data], {type: mime}));
  link.download = safeFilename(file);
  document.body.append(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 10000);
}

async function saveExport(file, data, mime) {
  let handle;
  if (typeof window.showSaveFilePicker === "function") {
    try {
      handle = await window.showSaveFilePicker({suggestedName: safeFilename(file),
        types: [{accept: {[mime]: [file.slice(file.lastIndexOf("."))]}}]});
    } catch (error) {
      if (error.name === "AbortError") return false;
      if (error.name !== "SecurityError" && error.name !== "NotSupportedError") throw error;
    }
  }
  if (handle) {
    const writer = await handle.createWritable();
    await writer.write(new Blob([data], {type: mime}));
    await writer.close();
  } else download(file, data, mime);
  return true;
}

function json(file, type, data, chooseLocation = false) {
  const contents = JSON.stringify(packet(type, data, demo), null, 2);
  return (chooseLocation ? saveExport : download)(file + ".json", contents, "application/json");
}

function csv(file, rows) {
  return saveExport(file + ".csv", csvText(rows), "text/csv");
}

async function shareText(text, source) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制，请通过班群或私聊发送。");
  } catch {
    source.focus();
    source.select();
    toast("请长按选中的文字复制。");
  }
}

const ctx = {
  role, demo, online: !demo, ui, get state() { return workspace; },
  get account() { return session?.profile ?? null; },
  syncTasks,
  async request(path, options) {
    try {
      return await auth.request(path, options);
    } catch (error) {
      if (error.status === 401) {
        auth.signOut();
        leave();
      }
      throw error;
    }
  },
  root, dialog, draw, edit, show, close, toast, pick, read, json, csv, shareText,
};

function syncTasks() {
  if (demo) return Promise.resolve();
  return pendingTaskSync ??= (async () => {
    const {items, cursor, attendance} = await ctx.request("/tasks?since=" + taskCursor + "&attendanceSince=" + attendanceCursor);
    if (items.length || attendance?.items.length) {
      await edit(state => {
        for (const item of items) applySharedTask(state, item);
        if (attendance?.items.length) applyOnlineAttendance(state, attendance.items);
      }, {redraw: false});
      if (dialog.open) deferredTaskDraw = true;
      else {
        draw();
        screen.onTasksSynced?.();
      }
    }
    taskCursor = cursor;
    attendanceCursor = attendance?.cursor ?? attendanceCursor;
  })().finally(() => { pendingTaskSync = null; });
}

function refreshTasksInBackground() {
  void syncTasks().catch(() => {});
}

function leave() {
  root.replaceChildren();
  dialog.close();
  location.replace(auth.loginURL());
}

function canContinue() {
  if (demo || (session && auth.hasSession(session.token))) return true;
  if (auth) leave();
  return false;
}

function migrateLegacy(old, account) {
  const state = blank();
  if (!old) return state;
  const {id, group} = account.person;
  state.tasks = old.tasks.filter(task => task.groups.includes(group));
  const ids = new Set(state.tasks.map(task => task.id));
  state.archives = (old.archives ?? []).filter(taskId => ids.has(taskId));
  state.receipts = old.receipts.filter(({record}) => record.group === group && ids.has(record.taskId)
    && (account.role === "leader" || record.studentId === id));
  if (account.role === "leader") {
    state.snapshots = old.snapshots.filter(item => item.group === group && ids.has(item.taskId));
    state.sentReports = old.sentReports.filter(item => item.group === group && ids.has(item.taskId));
  }
  return state;
}

function showAccount(profile) {
  const nav = document.querySelector(".nav");
  nav.classList.add("signed-nav");
  const description = profile.person ? profile.person.group + " · " + profile.person.name : "管理端 · " + profile.username;
  nav.innerHTML = '<span class="signed-user">' + escape(description) + '</span>' + button("退出登录", "logout", "secondary compact");
}

async function init() {
  if (demo) {
    document.querySelectorAll("a[href$='.html']").forEach(link => {
      const target = new URL(link.href);
      target.searchParams.set("demo", "1");
      link.href = target.href;
    });
    const {demoState} = await import("./demo.mjs");
    storage = await openWorkspace("demo-" + role, () => demoState(role));
  } else {
    auth = await import("./auth.mjs?v=2");
    session = await auth.signedIn();
    if (!session) {
      location.replace(auth.loginURL(role, location.hash));
      return;
    }
    const profile = session.profile;
    if (profile.role !== role) {
      location.replace(auth.roleURL(profile.role));
      return;
    }
    const privateKey = role === "admin" ? "live-admin" : "live-" + role + "-" + profile.accountId;
    const old = role !== "admin" && !await readWorkspace(privateKey) ? await readWorkspace("live-" + role) : null;
    storage = await openWorkspace(privateKey, () => migrateLegacy(old, profile));
    if (role === "student") {
      await storage.edit(state => { state.profile = profile.person; });
    } else if (role === "admin") {
      await storage.edit(state => {
        if (state.accountDirectoryMarker === session.marker) return;
        state.roster = profile.roster;
        state.staff = profile.staff;
        state.accountDirectoryMarker = session.marker;
      });
    }
    showAccount(profile);
    auth.onOtherSignOut(session.token, leave);
  }
  workspace = await storage.read();
  screen = await (await import(routes[role])).build(ctx);
  document.querySelector(".nav").hidden = false;
  draw();
  const footer = document.querySelector(".footer-inner");
  const schoolLink = footer.querySelector("a");
  const footerLinks = document.createElement("div");
  footerLinks.className = "footer-links";
  footerLinks.innerHTML = button("本机数据", "data-tools", "quiet compact");
  footerLinks.append(schoolLink);
  footer.append(footerLinks);
  screen.start?.();
  refreshTasksInBackground();
  window.addEventListener("pageshow", async event => {
    if (event.persisted && canContinue() && !dialog.open) {
      workspace = await storage.read();
      draw();
      refreshTasksInBackground();
    }
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && canContinue() && !dialog.open) {
      workspace = await storage.read();
      draw();
      refreshTasksInBackground();
    }
  });
  setInterval(() => {
    if (document.visibilityState === "visible" && canContinue() && !dialog.open
        && workspace.tasks.map(task => statusOf(task)).join("/") !== taskPhases) draw();
  }, 30000);
  if (!demo) setInterval(() => {
    if (document.visibilityState === "visible" && canContinue()) refreshTasksInBackground();
  }, 15000);
}

document.addEventListener("click", async event => {
  const trigger = event.target.closest("[data-do]");
  if (!trigger || trigger.disabled) return;
  const {do: action, value} = trigger.dataset;
  if (action === "close") { close(); return; }
  if (!screen || !canContinue()) return;
  const handler = commonActions[action] ?? screen.actions[action];
  if (!handler) return;
  trigger.disabled = true;
  try {
    await handler(value, trigger);
  } catch (error) {
    toast(error.message, true);
  } finally {
    trigger.disabled = false;
  }
});

document.addEventListener("submit", async event => {
  const form = event.target.closest("form[data-form]");
  if (!form || !screen || !canContinue()) return;
  event.preventDefault();
  const method = commonForms[form.dataset.form] ?? screen.forms[form.dataset.form];
  if (!method) return;
  const errorBox = form.querySelector(".form-error");
  if (errorBox) errorBox.hidden = true;
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    await method(new FormData(form), form.dataset.id, submit?.value);
  } catch (error) {
    if (errorBox?.isConnected) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } else toast(error.message, true);
  } finally {
    if (submit) submit.disabled = false;
  }
});

document.addEventListener("input", event => { screen?.input?.(event.target); });
document.addEventListener("change", event => { screen?.change?.(event.target); });

init().catch(error => {
  root.innerHTML = '<div class="error-block"><h1>' + roleNames[role]
    + '暂时无法打开</h1><p>' + escape(error.message) + '</p><div class="actions"><a class="button secondary" href="./login.html">返回登录</a></div></div>';
});
