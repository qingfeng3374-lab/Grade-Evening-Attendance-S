import {adminRows, archived, beijingInput, classRoster, cleanTask, displayTime, field, importException, importReport, need, newId, parseCSV, rate,
  readBeijing, recordImport, statusOf, summarize, unpack} from "./model.mjs";
import {campusNames, validateFence} from "./geo.mjs";
import {area, button, checklist, empty, escape, form, hero, input, keys, layout, note, panel, receiptKeys,
  completionBar, distribution, select, serializeDetails, stats, submit, tag, taskCard, taskOrder} from "./ui.mjs";

export function build(ctx) {
  const ui = ctx.ui;
  let listPreview;
  let reportFiles = [];
  let detailGroup;
  let onlineMessages = [];

  const groups = () => [...new Set(ctx.state.roster.map(person => person.group))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const taskFor = id => need(ctx.state.tasks.find(task => task.id === id), "找不到任务。");

  function classData(task, state = ctx.state) {
    const byGroup = new Map(state.reports.filter(item => item.report.taskId === task.id).map(item => [item.report.group, item]));
    return task.groups.map(group => {
      const snapshot = classRoster(state, task.id, group);
      const item = byGroup.get(group);
      const rows = snapshot ? adminRows(snapshot, item?.report) : [];
      return {group, item, rows, counts: summarize(rows)};
    });
  }

  function renderBoard(task) {
    if (!task) return "";
    if (archived(ctx.state, task.id)) return panel(task.title, tag(statusOf(task)) + note("已清理此任务的本机报备数据。"));
    if (task.mode === "draft") {
      return panel(task.title, note("任务保存在本地草稿箱。发布时会固定应报名单和围栏配置。")
        + keys([["开放时间", displayTime(task.opens)], ["截止时间", displayTime(task.due)], ["适用班级", task.groups.join("、")]])
        + '<div class="actions">' + button("编辑并发布", "edit-task", "", task.id)
        + button("删除草稿", "delete", "danger", task.id) + '</div>');
    }
    const classes = classData(task);
    const seen = classes.filter(item => item.item);
    const coverage = seen.length === classes.length ? "全年级完成率" : "汇总范围完成率";
    const total = seen.reduce((sum, row) => sum + row.counts.total, 0);
    const done = seen.reduce((sum, row) => sum + row.counts.done, 0);
    const last = seen.map(row => row.item.receivedAt).sort().at(-1);
    const status = statusOf(task);
    const rows = seen.map(row => '<article class="list-row"><div><strong>' + escape(row.group)
      + '</strong><p class="tiny">应报 ' + row.counts.total + ' · 已完成 ' + row.counts.done + '</p>'
      + completionBar(row.counts, row.group + "完成报备率") + '</div>'
      + button("详情", "group-detail", "quiet compact", row.group) + '</article>').join("");
    return panel(task.title, '<div class="actions">' + tag(status) + '<span class="meta">截止 ' + escape(displayTime(task.due)) + '</span></div>'
      + stats([["已汇总班级", seen.length + "/" + classes.length], ["应报人数", classes.reduce((sum, row) => sum + row.counts.total, 0)],
        ["已完成报备", done], [coverage, rate(done, total)]])
      + (seen.length ? distribution(summarize(seen.flatMap(row => row.rows)), "已汇总班级报备分布")
        + '<p class="meta">最新导入 ' + escape(displayTime(last)) + ' · 北京时间</p>' : '<p class="meta">导入班级统计后显示完成率和分布。</p>')
      + '<div class="actions">' + button("下载发布文件", "downloads", "secondary", task.id)
      + (status !== "revoked" ? button("延长截止", "extend", "secondary", task.id)
        + button("撤销任务", "revoke", "danger", task.id) : "") + '</div>'
      + '<div class="actions">' + button("导出年级汇总", "csv-summary", "secondary")
      + button("导出学生明细", "csv-detail", "secondary") + '</div><div class="rows">' + rows + '</div>');
  }

  function inboxMessages() {
    const messages = new Map((ctx.state.exceptions ?? []).map(item => [item.id, item]));
    for (const item of onlineMessages) messages.set(item.id, item);
    return [...messages.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  }

  function inbox() {
    const messages = inboxMessages();
    const unread = messages.filter(item => !item.readAt).length;
    const entries = messages.slice(0, 6).map(item => '<article class="list-row"><div><strong>' + escape(item.title)
      + '</strong><p class="tiny">' + escape(item.group + ' · ' + displayTime(item.receivedAt))
      + '</p></div><div class="actions">' + (item.readAt ? "" : tag("未读"))
      + button("查看", "open-message", "quiet compact", item.id) + '</div></article>').join("");
    const controls = ctx.online ? button("刷新邮箱", "refresh-inbox", "secondary compact")
      : button("导入特殊情况", "import-exception", "secondary compact");
    return panel("特殊情况邮箱", '<div class="actions">' + controls + (unread ? tag(unread + " 条未读") : "") + '</div>'
      + (entries ? '<div class="rows">' + entries + '</div>' : '<p class="meta">暂无特殊情况。</p>')
      + (messages.length > 6 ? '<div class="actions">' + button("查看全部", "all-messages", "quiet compact") + '</div>' : ""));
  }

  function sortedTasks() {
    return taskOrder(ctx.state.tasks.map(task => ({...task, current: statusOf(task)})));
  }

  function render() {
    const tasks = sortedTasks();
    const task = tasks.find(item => item.id === ui.task) ?? tasks[0];
    ui.task = task?.id;
    const missing = groups().filter(group => !ctx.state.staff.some(person => person.group === group
      && ctx.state.roster.some(item => item.id === person.id && item.group === group && item.name === person.name)));
    const roster = '<p class="meta">' + ctx.state.roster.length + ' 名学生 · ' + groups().length + ' 个班级 · '
      + ctx.state.staff.length + ' 条负责人记录</p>'
      + (ctx.state.staff.length && missing.length ? '<p class="tiny">待核对负责人 ' + escape(missing.join("、")) + '</p>' : "")
      + '<div class="actions">' + button("导入学籍 CSV", "students", "secondary") + button("导入负责人 CSV", "staff", "secondary") + '</div>'
      + '<p class="tiny">CSV 需含姓名、班级和学号，以 UTF-8 保存。</p>';
    const fences = ctx.state.fences.length
      ? '<div class="rows">' + ctx.state.fences.map(item => '<div class="list-row"><div><strong>' + escape(item.name)
        + '</strong><p class="tiny">周边 ' + item.buffer + ' 米 · 误差上限 ' + item.maxAccuracy + ' 米</p></div>'
        + button("编辑", "fence", "quiet compact", item.name) + '</div>').join("") + '</div>'
      : '<p class="meta">发布前请导入经核实的校园范围。</p>';
    const aside = inbox() + panel("名单维护", roster) + panel("打卡范围", fences + '<div class="actions">'
      + button("配置校区围栏", "fence", "secondary") + '</div>');
    const cards = tasks.length ? '<div class="mobile-task-switch">' + select("task-switch", "切换任务", tasks.map(item => [item.id, item.title]), task.id)
      + '</div><div class="task-list desktop-task-list">' + tasks.map(item => taskCard(item, item.current,
      button(task?.id === item.id ? "当前查看" : "详情", "task", "secondary", item.id), task?.id === item.id,
      item.mode === "draft" ? "" : item.groups.length + " 个班级 · 版本 " + item.revision)).join("") + '</div>'
      : empty("暂无晚点名任务", "导入学籍并配置校园围栏后，即可发布任务。", button("新建任务", "edit-task", "secondary"));
    return hero("晚点名管理", "发布晚点名任务，查看年级进度与特殊情况。",
      button("新建任务", "edit-task", "light") + button("导入班级统计", "import", "outline-light") + button("特殊情况邮箱", "all-messages", "outline-light"))
      + layout(panel("点名任务", cards, "", "task-switch-panel") + renderBoard(task), aside);
  }

  function taskEdit(id, edits = null) {
    const task = edits ?? (id ? taskFor(id) : null);
    const classes = groups();
    const fences = ctx.state.fences.map(item => item.name);
    const now = Date.now();
    ctx.show(task ? "编辑草稿" : "新建点名任务", form("task", (!classes.length || !fences.length
      ? note("发布需要学籍名单和至少一个已配置的校区。可先保存草稿。", true) : "")
      + input("title", "任务标题", task?.title, 'required maxlength="70" placeholder="例如 本周晚点名"')
      + area("description", "任务说明", task?.description, 'maxlength="2000" placeholder="填写提交要求或特殊说明"')
      + '<div class="field-grid">' + input("opens", "开放时间（北京时间）", beijingInput(task?.opens ?? now), 'type="datetime-local" required')
      + input("due", "截止时间（北京时间）", beijingInput(task?.due ?? now + 3 * 3600000), 'type="datetime-local" required') + '</div>'
      + (classes.length ? checklist("groups", "适用班级", classes, task?.groups?.filter(group => classes.includes(group)) ?? classes) : "")
      + (fences.length ? checklist("fences", "允许打卡校区", fences, task?.fenceNames ?? fences.slice(0, 1)) : "")
      + '<div class="actions"><button type="submit" class="button secondary" value="draft">保存草稿</button>'
      + '<button type="submit" class="button" value="publish">预览发布</button></div>', id));
  }

  function downloads(id) {
    const task = taskFor(id);
    const classes = task.groups.map(group => [group, group]);
    ctx.show(task.mode === "revoked" ? "下载撤销通知" : "下载发布文件",
      '<p class="meta">' + escape(task.mode === "revoked" ? "请将撤销通知转发给学生和负责人，导入后生效。"
        : "将任务包发到班群。各班应报名单请单独私发给对应负责人。") + '</p><div class="actions">'
      + button(task.mode === "revoked" ? "下载撤销通知" : "下载任务包", "task-file", "", id) + '</div>'
      + (task.mode !== "revoked" ? form("roster-file", select("group", "应报名单班级", classes, classes[0]?.[0])
        + '<div class="actions">' + submit("下载该班应报名单", "secondary") + '</div>', id) : ""));
  }

  let publication;
  function applyReports(state, items) {
    return items.map(item => {
      if (item.error) return {name: item.name, text: item.error};
      try { return {name: item.name, text: item.type === "exception" ? importException(state, item.data) : importReport(state, item.data), ok: true}; }
      catch (error) { return {name: item.name, text: error.message}; }
    });
  }

  async function rosterPreview(key) {
    const [file] = await ctx.pick(".csv,text/csv");
    if (!file) return;
    const data = parseCSV(await ctx.read(file, false));
    listPreview = {key, data};
    ctx.show("名单导入预览", form("list", keys([["文件", file.name], ["记录数", data.length],
      ["班级数", new Set(data.map(person => person.group)).size]])
      + (ctx.state[key].length ? note("确认后将替换本机现有名单。已发布任务继续使用原应报名单。", true) : "")
      + '<div class="rows">' + data.slice(0, 5).map(person =>
        '<div class="list-row"><span>' + escape(person.name + " · " + person.group) + '</span><span class="tiny">'
        + escape(person.id) + '</span></div>').join("") + '</div><div class="actions">' + submit("确认导入") + '</div>'));
  }

  function currentGroup(group) {
    const task = taskFor(ui.task);
    return need(classData(task).find(item => item.group === group && item.item), "该班还没有统计数据。");
  }

  function classDetail(group, page = 0) {
    detailGroup = group;
    const item = currentGroup(group);
    const c = item.counts;
    const maxPage = Math.max(0, Math.ceil(item.rows.length / 15) - 1);
    const contents = keys([["生成时间", displayTime(item.item.report.createdAt)],
      ["最近导入", displayTime(item.item.receivedAt)], ["应报 / 已完成", c.total + " / " + c.done],
      ["在校 / 离校", c.present + " / " + c.away], ["未提交 / 待核验", c.missing + " / " + c.pending]])
      + '<div class="rows">' + item.rows.slice(page * 15, (page + 1) * 15).map(row =>
        '<article class="list-row"><div><strong>' + escape(row.name) + '</strong><p class="tiny">' + escape(row.id)
        + '</p></div><div class="actions">' + tag(row.status)
        + (row.record ? button("回执", "row-detail", "quiet compact", row.id) : "") + '</div></article>').join("") + '</div>';
    ctx.show(group + " · 统计详情", contents + (maxPage > 0 ? '<div class="actions"><span class="meta">第 ' + (page + 1)
      + ' / ' + (maxPage + 1) + ' 页</span>' + (page > 0 ? button("上一页", "class-page", "secondary", page - 1) : "")
      + (page < maxPage ? button("下一页", "class-page", "secondary", page + 1) : "") + '</div>' : ""));
  }

  async function refreshInbox({quiet = false} = {}) {
    if (!ctx.online) return;
    try {
      const {messages} = await ctx.request("/special");
      if (JSON.stringify(messages) !== JSON.stringify(onlineMessages)) {
        onlineMessages = messages;
        ctx.draw();
      }
    } catch (error) {
      if (!quiet) ctx.toast(error.message, true);
    }
  }

  async function openImport(type, heading) {
    const files = await ctx.pick(".json,application/json", true);
    if (!files.length) return;
    need(files.length <= 100, "每批最多导入 100 份文件。");
    reportFiles = [];
    for (const file of files) {
      try { reportFiles.push({...unpack(await ctx.read(file), type, ctx.demo), name: file.name}); }
      catch (error) { reportFiles.push({name: file.name, error: error.message}); }
    }
    const results = applyReports(structuredClone(ctx.state), reportFiles);
    const items = '<div class="rows">' + results.map(item => '<div class="list-row"><div><strong>' + escape(item.name)
      + '</strong><p class="meta">' + escape(item.text) + '</p></div>' + tag(item.ok ? "可导入" : "需处理")
      + '</div>').join("") + '</div>';
    ctx.show(heading, results.some(item => item.ok) ? form("import", items + '<div class="actions">'
      + submit("确认导入") + '</div>') : items);
  }

  return {render, start() {
    if (!ctx.online) return;
    void refreshInbox();
    setInterval(() => {
      if (document.visibilityState === "visible" && !ctx.dialog.open) void refreshInbox({quiet: true});
    }, 30000);
  }, actions: {
    task(id) { ui.task = id; ctx.draw(); },
    "edit-task"(id) { taskEdit(id); },
    "restore-task"() {
      taskEdit(publication.fromDraft ? publication.task.id : "", ui.draftEditing);
    },
    students() { return rosterPreview("roster"); },
    staff() { return rosterPreview("staff"); },
    fence(name) {
      const existing = ctx.state.fences.find(item => item.name === name);
      ctx.show("配置校区围栏", form("fence", select("name", "校区", campusNames.map(item => [item, item]), name || campusNames[0])
        + '<p class="meta">使用经校方核实的 WGS 84 GeoJSON。文件支持 Polygon 或 MultiPolygon，可用 Feature 包装。</p>'
        + '<label class="field"><span>校园边界文件</span><input type="file" name="geometry" accept=".geojson,.json,application/geo+json,application/json"'
        + (!existing ? " required" : "") + '></label><div class="field-grid">'
        + input("buffer", "校园周边距离（米）", existing?.buffer ?? 100, 'type="number" min="0" max="2000" step="1" required')
        + input("accuracy", "最大定位误差（米）", existing?.maxAccuracy ?? 70, 'type="number" min="1" max="1000" step="1" required')
        + '</div><div class="actions">' + submit("保存围栏") + '</div>', existing?.name));
    },
    downloads,
    "task-file"(id) {
      const task = taskFor(id);
      const kind = task.mode === "revoked" ? "撤销" : "晚点名任务";
      ctx.json(kind + "-" + task.title + "-v" + task.revision, "task", cleanTask(task));
    },
    extend(id) {
      const task = taskFor(id);
      ctx.show("延长截止时间", form("extend", keys([["任务", task.title], ["当前截止", displayTime(task.due)]])
        + input("due", "新截止时间（北京时间）", beijingInput(Math.max(Date.now(), Date.parse(task.due)) + 3600000),
          'type="datetime-local" required') + '<p class="meta">保存后会生成新版本，需重新转发给学生和负责人。</p><div class="actions">'
        + submit("保存新版本") + '</div>', id));
    },
    delete(id) {
      const task = taskFor(id);
      ctx.show("删除草稿", form("delete", note("将从本机删除「" + task.title + "」草稿。", true)
        + '<div class="actions">' + submit("删除草稿", "danger") + '</div>', id));
    },
    revoke(id) {
      const task = taskFor(id);
      ctx.show("撤销任务", form("revoke", note("撤销「" + task.title + "」后保留已导入的数据。请将撤销通知转发给学生和负责人。", true)
        + '<div class="actions">' + submit("确认撤销", "danger") + '</div>', id));
    },
    import() { return openImport(["statistics", "report"], "班级统计导入预览"); },
    "import-exception"() { return openImport("exception", "特殊情况导入预览"); },
    "refresh-inbox": refreshInbox,
    async "all-messages"() {
      await refreshInbox();
      const messages = inboxMessages();
      ctx.show("特殊情况邮箱", messages.length ? '<div class="rows">' + messages.map(item => '<div class="list-row"><div><strong>'
        + escape(item.title) + '</strong><p class="tiny">' + escape(item.group + ' · ' + displayTime(item.receivedAt))
        + '</p></div>' + button(item.readAt ? "查看" : "读消息", "open-message", "secondary compact", item.id) + '</div>').join("") + '</div>'
        : '<p class="meta">暂无特殊情况。</p>');
    },
    async "open-message"(id) {
      const item = need(inboxMessages().find(message => message.id === id), "找不到此消息。");
      if (!item.readAt) {
        if (onlineMessages.some(message => message.id === id)) {
          item.readAt = (await ctx.request("/special/" + encodeURIComponent(id) + "/read", {method: "POST"})).readAt;
          ctx.draw();
        } else await ctx.edit(state => {
          const stored = state.exceptions.find(message => message.id === id);
          stored.readAt ??= new Date().toISOString();
        });
      }
      const task = ctx.state.tasks.find(entry => entry.id === item.taskId);
      ctx.show(item.title, keys([["班级", item.group], ["任务", task?.title ?? item.taskTitle ?? item.taskId],
        ["接收时间", displayTime(item.receivedAt)], ...(item.sender ? [["报送人", item.sender]] : [])])
        + '<h3>情况说明</h3><p class="inbox-preview">' + escape(item.note) + '</p><div class="actions">'
        + button("返回邮箱", "all-messages", "secondary") + '</div>');
    },
    "group-detail"(group) { classDetail(group); },
    "class-page"(page) { classDetail(detailGroup, Number(page)); },
    "row-detail"(id) {
      const {rows} = currentGroup(detailGroup);
      const row = need(rows.find(item => item.id === id && item.record), "回执不存在。");
      ctx.show(row.name + " · 回执", keys([["学号", row.id], ["班级", row.group], ...receiptKeys(row.record)])
        + '<div class="actions">' + button("返回本班明细", "group-detail", "secondary", detailGroup) + '</div>');
    },
    "csv-summary"() {
      const task = taskFor(ui.task);
      const classes = classData(task);
      const data = classes.filter(item => item.item);
      const coverage = data.length + "/" + classes.length;
      ctx.csv(task.title + "-年级汇总", [["任务", "班级", "应报", "在校", "离校", "未提交", "待核验", "完成报备率",
        "在校打卡率", "导入时间（北京时间）", "班级覆盖率"],
      ...data.map(({group, item, counts: c}) => [task.title, group, c.total, c.present, c.away, c.missing, c.pending,
        rate(c.done, c.total), rate(c.present, c.total), displayTime(item.receivedAt), coverage])]);
    },
    "csv-detail"() {
      const task = taskFor(ui.task);
      const data = classData(task).filter(item => item.item);
      ctx.csv(task.title + "-学生明细", serializeDetails(data.flatMap(item => item.rows), task.title));
    },
  }, forms: {
    async list() {
      await ctx.edit(state => {
        state[listPreview.key] = listPreview.data;
        recordImport(state, listPreview.key === "roster" ? "学籍名单" : "负责人名单", "导入 " + listPreview.data.length + " 条记录");
      });
      ctx.close();
      ctx.toast("名单已导入。");
    },
    async fence(data, original) {
      const file = data.get("geometry");
      const name = data.get("name");
      const existing = ctx.state.fences.find(item => item.name === original && item.name === name);
      const geometry = file?.size ? await ctx.read(file) : existing?.geometry;
      const fence = validateFence({name, version: newId(), buffer: Number(data.get("buffer")),
        maxAccuracy: Number(data.get("accuracy")), geometry, testOnly: !file?.size && existing?.testOnly === true});
      await ctx.edit(state => { state.fences = state.fences.filter(item => item.name !== fence.name); state.fences.push(fence); });
      ctx.close();
      ctx.toast("校区围栏已保存。");
    },
    async task(data, id, mode) {
      const now = Date.now();
      const row = {id: id || newId(), revision: 1, mode: "draft", title: field(data.get("title"), "任务标题", 70),
        description: String(data.get("description") ?? "").trim(), opens: readBeijing(data.get("opens")), due: readBeijing(data.get("due")),
        groups: data.getAll("groups"), fenceNames: data.getAll("fences")};
      need(row.opens < row.due, "截止时间必须晚于开放时间。");
      if (mode === "publish") {
        need(Date.parse(row.due) > now, "截止时间须晚于当前时间。");
        const fences = ctx.state.fences.filter(item => row.fenceNames.includes(item.name));
        const task = cleanTask({...row, mode: "published", fences});
        const students = ctx.state.roster.filter(person => task.groups.includes(person.group));
        need(students.length > 0 && task.groups.every(group => students.some(item => item.group === group)), "适用班级的学籍名单为空。");
        publication = {fromDraft: Boolean(id), task, students};
        ctx.show("发布预览", form("publish", keys([["任务", task.title], ["截止时间", displayTime(task.due)],
          ["适用班级", task.groups.join("、")], ["应报人数", students.length], ["允许校区", task.fences.map(item => item.name).join("、")]])
          + note("发布后将锁定名单与定位校验范围。")
          + '<div class="actions">' + submit("确认发布") + button("返回编辑", "restore-task", "secondary") + '</div>'));
        ui.draftEditing = row;
      } else {
        await ctx.edit(state => {
          const existing = state.tasks.find(item => item.id === row.id);
          need(!existing || existing.mode === "draft", "此任务已发布。");
          state.tasks = state.tasks.filter(item => item.id !== row.id);
          state.tasks.push(row);
        }, {redraw: false});
        ui.task = row.id;
        ctx.draw();
        ctx.close();
        ctx.toast("草稿已保存。");
      }
    },
    async publish() {
      const {task, students, fromDraft} = publication;
      await ctx.edit(state => {
        const existing = state.tasks.find(item => item.id === task.id);
        need((!existing && !fromDraft) || existing?.mode === "draft", "该任务已变更。");
        need(Date.parse(task.due) > Date.now(), "任务截止时间已到。");
        state.tasks = state.tasks.filter(item => item.id !== task.id);
        state.tasks.push(task);
        for (const group of task.groups) state.snapshots.push({taskId: task.id, group,
          students: students.filter(person => person.group === group)});
      }, {redraw: false});
      ui.task = task.id;
      ctx.draw();
      downloads(task.id);
      ctx.toast("任务已发布到本机，请下载并转发。");
    },
    "roster-file"(data, id) {
      const item = need(classRoster(ctx.state, id, data.get("group")), "该班应报名单不存在。");
      ctx.json("应报名单-" + item.group + "-" + taskFor(id).title, "roster", item);
    },
    async extend(data, id) {
      const due = readBeijing(data.get("due"));
      await ctx.edit(state => {
        const task = need(state.tasks.find(item => item.id === id && item.mode === "published"), "任务不可延长。");
        need(due > task.due && Date.parse(due) > Date.now(), "请把截止时间延至当前时间之后。");
        task.due = due;
        task.revision++;
      });
      downloads(id);
    },
    async delete(_, id) {
      await ctx.edit(state => {
        need(state.tasks.some(item => item.id === id && item.mode === "draft"), "草稿不存在或已发布。");
        state.tasks = state.tasks.filter(item => item.id !== id);
      });
      ctx.close();
      ctx.toast("已删除草稿。");
    },
    async revoke(_, id) {
      await ctx.edit(state => {
        const task = need(state.tasks.find(item => item.id === id && item.mode === "published"), "任务不可撤销。");
        task.mode = "revoked";
        task.revision++;
      });
      downloads(id);
    },
    async import() {
      let results;
      await ctx.edit(state => {
        results = applyReports(state, reportFiles);
        const count = results.filter(item => item.ok).length;
        recordImport(state, "管理端导入", "处理 " + count + " 份文件 · 需处理 " + (results.length - count) + " 份");
      });
      ctx.close();
      ctx.toast("已处理 " + results.filter(item => item.ok).length + " 份文件。");
    },
  }, change(control) {
    if (control.name === "task-switch") { ui.task = control.value; ctx.draw(); }
  }};
}
