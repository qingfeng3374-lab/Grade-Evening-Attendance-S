import {archived, cleanReceipt, displayTime, field, importTask, isSharedTask, need, newId, recordImport, statusOf, unpack, validatePerson} from "./model.mjs?v=5";
import {judgePosition} from "./geo.mjs";
import {area, button, empty, escape, form, hero, input, keys, layout, note, panel, receiptKeys,
  select, submit, tag, taskCard, taskOrder} from "./ui.mjs";

export function build(ctx) {
  const ui = ctx.ui;
  function readReminder() {
    const id = new URLSearchParams(location.hash.slice(1)).get("task");
    ui.reminder = /^[A-Za-z0-9_-]{1,80}$/.test(id ?? "") ? id : null;
  }
  readReminder();
  let selectedTask;
  let prepared;

  const getTask = id => need(ctx.state.tasks.find(task => task.id === id), "当前任务不可用。");
  const taskControl = () => ctx.online ? button("刷新任务", "refresh-tasks", "light") : button("导入任务", "import", "light");
  const current = task => ctx.state.receipts.find(item => item.record.taskId === task.id
    && item.record.studentId === ctx.state.profile?.id)?.record;
  const groups = () => [...new Set(ctx.state.tasks.flatMap(task => task.groups))];
  const isMyTask = task => ctx.state.profile && task.groups.includes(ctx.state.profile.group);
  const available = task => isMyTask(task) && statusOf(task) === "active" && !current(task);

  function render() {
    const profile = ctx.state.profile;
    const list = taskOrder(ctx.state.tasks.filter(isMyTask).map(task => ({...task, current: statusOf(task)})));
    const remaining = list.filter(available);
    const history = list.filter(task => current(task) || ["ended", "revoked"].includes(task.current));
    const upcoming = list.filter(task => task.current === "waiting");
    const reminder = list.find(task => task.id === ui.reminder);
    const alerts = ui.reminder ? (reminder
      ? note("收到晚点名提醒，请查看对应任务。") + '<div class="actions">' + button("查看提醒任务", "task", "secondary", reminder.id) + '</div>'
      : note(profile && ctx.state.tasks.some(task => task.id === ui.reminder)
        ? "该提醒任务未包含当前班级。请核对学生信息。"
        : ctx.online ? "正在同步提醒对应的任务。若未出现，可刷新任务列表。" : "收到晚点名提醒，请先导入对应任务包。")) : "";
    const main = (alerts ? panel("任务提醒", alerts) : "") + panel("待办理任务", remaining.length
      ? '<div class="task-list">' + remaining.map(task => taskCard(task, "active", button("去填报", "task", "", task.id))).join("") + '</div>'
      : empty(!profile ? "先填写学生信息" : "暂无待办", !profile ? "填写姓名、学号和班级，即可查看适用任务。"
        : ctx.online ? "管理端发布后，本班的待办任务会出现在这里。"
          : ctx.state.tasks.length ? "当前班级没有需要填报的任务。" : "请导入管理员发来的任务包。",
        !profile ? button("填写学生信息", "profile", "secondary") : ctx.online ? "" : button("导入任务", "import", "secondary")))
      + (upcoming.length ? panel("即将开始", '<div class="task-list">' + upcoming.map(task =>
        taskCard(task, "waiting", button("详情", "task", "secondary", task.id), false, "开放 " + displayTime(task.opens))).join("") + '</div>') : "")
      + (history.length ? panel("历史任务", '<div class="task-list">' + history.map(task =>
        taskCard(task, current(task)?.result ?? task.current, button("查看", "task", "secondary", task.id), false,
          task.current === "revoked" ? "任务已撤销" : current(task) ? "回执保存在本机" : "")).join("") + '</div>') : "");
    const sidebar = panel("学生信息", profile
      ? '<p class="student-info">' + escape(profile.name) + '</p><p class="meta">' + escape(profile.group)
        + ' · ' + escape(profile.id) + '</p>' + (ctx.demo ? '<div class="actions">' + button("编辑信息", "profile", "secondary") + '</div>'
          : '<p class="tiny">打卡回执会自动使用以上学籍信息。</p>')
      : '<p class="meta">请使用学籍表中的班级和学号。</p><div class="actions">' + button("填写信息", "profile", "secondary") + '</div>')
      + panel("如何提交", '<ol class="side-rule"><li>' + (ctx.online ? "打开本班发布的任务。" : "导入班群发来的任务包。")
        + '</li><li>在截止前完成在校打卡或离校报备。</li><li>下载回执，私发给本班负责人。</li></ol>', "", "soft");
    return hero("晚点名打卡", remaining.length ? "有 " + remaining.length + " 项任务待填写。"
      : "在校定位打卡，离校填写报备。", taskControl(), true) + layout(main, sidebar);
  }

  function profileDialog() {
    need(ctx.demo, "正式填报使用登录账户的学籍信息。");
    const p = ctx.state.profile;
    const choices = groups();
    if (p?.group && !choices.includes(p.group)) choices.unshift(p.group);
    ctx.show("学生信息", form("profile", '<p class="meta">请按学籍填写。已保存的个人回执随原学号保留。</p>'
      + input("name", "姓名", p?.name, 'required maxlength="40" autocomplete="name"')
      + input("id", "学号", p?.id, 'required maxlength="24" inputmode="numeric" pattern="[0-9]+"')
      + (choices.length ? select("group", "班级", [["", "请选择班级"], ...choices.map(item => [item, item])], p?.group ?? "", "required")
        : input("group", "班级", p?.group, 'required maxlength="50" placeholder="例如 计算2401"'))
      + '<div class="actions">' + submit("保存学生信息") + '</div>'));
  }

  function openTask(id, message = "", coords = null) {
    const task = getTask(id);
    need(isMyTask(task), "该任务未包含当前班级。");
    selectedTask = id;
    const record = current(task);
    const phase = statusOf(task);
    let content = tag(phase) + keys([["开放时间", displayTime(task.opens)], ["截止时间", displayTime(task.due)],
      ["打卡校区", task.fences.map(fence => fence.name).join("、")]]);
    if (task.description) content += '<p class="task-description">' + escape(task.description) + '</p>';
    if (archived(ctx.state, id)) {
      content += note("已清理此任务的本机报备数据。");
    } else if (record) {
      content += note(record.result === "present" ? "在校打卡成功，请下载回执并私发给本班负责人。"
        : "离校报备已保存，请下载回执并私发给本班负责人。") + keys(receiptKeys(record));
      if (coords) content += keys([["本次经纬度", coords.longitude.toFixed(5) + ", " + coords.latitude.toFixed(5)]]);
      content += '<div class="actions">' + button("下载回执", "receipt", "", task.id) + '</div>';
    } else if (phase === "active") {
      if (message) {
        content += note(message, true);
        if (coords) content += keys([["本次经纬度", coords.longitude.toFixed(5) + ", " + coords.latitude.toFixed(5)],
          ["定位精度", Math.round(coords.accuracy) + " 米"]]);
      }
      content += '<h3>你现在是否在校？</h3><div class="choice-grid">'
        + '<button type="button" class="choice" data-do="locate"><span class="icon pin" aria-hidden="true"></span><span><strong>是，我在校</strong><small>获取定位并校验</small></span></button>'
        + '<button type="button" class="choice" data-do="away"><span class="icon memo" aria-hidden="true"></span><span><strong>否，我不在校</strong><small>填写离校原因</small></span></button></div>';
      if (ctx.demo) content += '<div class="actions">' + button("模拟校内", "simulate-pass", "quiet compact")
        + button("模拟校外", "simulate-outside", "quiet compact") + '</div>';
    } else content += note(phase === "waiting" ? "任务尚未开放。" : "此任务已停止接受新的填报。");
    ctx.show(task.title, content);
  }

  async function save(id, fields) {
    if (ctx.online && isSharedTask(ctx.state, id)) await ctx.syncTasks();
    await ctx.edit(state => {
      const task = need(state.tasks.find(item => item.id === id), "任务不存在。");
      const p = ctx.account?.person ?? state.profile;
      need(p && task.groups.includes(p.group) && statusOf(task) === "active", "任务已截止或当前班级不适用。");
      need(!state.receipts.some(item => item.record.taskId === id && item.record.studentId === p.id), "该任务已填报，请下载原回执。");
      const record = cleanReceipt({id: newId(), taskId: task.id, revision: task.revision, studentId: p.id,
        name: p.name, group: p.group, submittedAt: new Date().toISOString(), ...fields});
      state.receipts.push({record, state: "accepted"});
    });
  }

  async function check(id, coords) {
    const task = getTask(id);
    const result = judgePosition(task.fences, coords);
    if (result.status === "pass") {
      await save(id, {result: "present", campus: result.campus, accuracy: coords.accuracy});
      openTask(id, "", coords);
    } else openTask(id, result.status === "outside"
      ? "当前位置超出任务允许区域，请核对位置后重新选择。"
      : "定位精度不足或靠近范围边界，请到开阔处重试。", Number.isFinite(coords?.accuracy) ? coords : null);
  }

  async function locate() {
    const id = selectedTask;
    const task = getTask(id);
    need(available(task), "此任务当前无法填报。");
    if (!navigator.geolocation || !isSecureContext) {
      openTask(id, "定位需要在支持定位的浏览器中使用 HTTPS 网址。");
      return;
    }
    ctx.show(task.title, note("正在定位，请在浏览器提示中允许访问位置。"));
    const waiting = ctx.dialog.querySelector(".note");
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {enableHighAccuracy: true, maximumAge: 0, timeout: 15000}));
      if (ctx.dialog.open && waiting.isConnected) await check(id, position.coords);
    } catch (error) {
      if (ctx.dialog.open && waiting.isConnected) openTask(id, ({1: "位置权限未开启，请在浏览器和系统设置中允许定位后重试。",
        2: "暂时无法取得位置，请确认手机定位已开启，移至开阔处重试。", 3: "定位超时，请移至开阔处再试。"})[error.code]
        ?? error.message ?? "无法获取位置，请重试。");
    }
  }

  function openReminder() {
    const task = ctx.state.tasks.find(item => item.id === ui.reminder);
    if (task && isMyTask(task)) openTask(task.id);
  }

  let openedReminder;
  function promptReminder() {
    if (ui.reminder && openedReminder !== ui.reminder && !ctx.dialog.open && ctx.state.tasks.some(task => task.id === ui.reminder && isMyTask(task))) {
      openedReminder = ui.reminder;
      openReminder();
    }
  }

  return {render, onTasksSynced: promptReminder, start() {
    promptReminder();
    window.addEventListener("hashchange", () => {
      readReminder();
      openedReminder = null;
      ctx.draw();
      promptReminder();
    });
  }, actions: {
    profile: profileDialog, task(id) { openTask(id); }, locate,
    async import() {
      const [file] = await ctx.pick(".json,application/json");
      if (!file) return;
      prepared = unpack(await ctx.read(file), "task", ctx.demo).data;
      const preview = structuredClone(ctx.state);
      importTask(preview, prepared);
      if (ctx.account) {
        need(prepared.groups.includes(ctx.account.person.group), "这项任务未包含你的班级。");
      }
      ctx.show("导入任务预览", form("import", keys([["任务", prepared.title], ["适用班级", prepared.groups.join("、")],
        ["截止时间", displayTime(prepared.due)], ["状态", prepared.mode === "revoked" ? "撤销通知" : "第 " + prepared.revision + " 版"]])
        + '<div class="actions">' + submit("确认导入") + '</div>'));
    },
    away() {
      const task = getTask(selectedTask);
      need(available(task), "此任务当前无法填报。");
      ctx.show("离校报备", form("away", '<p class="meta">' + escape(task.title) + '</p>'
        + area("reason", "离校原因", "", 'required maxlength="500" placeholder="请简要说明离校情况"')
        + '<div class="actions">' + submit("确认报备") + button("返回选择", "task", "secondary", task.id) + '</div>', task.id));
    },
    receipt(id) {
      const task = getTask(id);
      const receipt = need(current(task), "未找到个人回执。");
      ctx.json("晚点名回执-" + receipt.studentId + "-" + task.title, "receipt", receipt);
      ctx.toast("请将下载的回执私发给本班负责人。");
    },
    "simulate-pass"() { return check(selectedTask, {longitude: 120.169, latitude: 35.938, accuracy: 18}); },
    "simulate-outside"() { return check(selectedTask, {longitude: 120.22, latitude: 35.98, accuracy: 18}); },
  }, forms: {
    async profile(data) {
      need(ctx.demo, "正式填报使用登录账户的学籍信息。");
      const p = validatePerson({id: data.get("id"), name: data.get("name"), group: data.get("group")});
      await ctx.edit(state => { state.profile = p; });
      ctx.close();
      ctx.toast("学生信息已保存。");
      openReminder();
    },
    async import() {
      let result;
      await ctx.edit(state => {
        result = importTask(state, prepared);
        recordImport(state, "点名任务", result);
      });
      ctx.close();
      ctx.toast(result);
      openReminder();
    },
    async away(data, id) {
      await save(id, {result: "away", reason: field(data.get("reason"), "离校原因", 500)});
      openTask(id);
    },
  }};
}
