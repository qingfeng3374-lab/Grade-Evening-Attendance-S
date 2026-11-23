import {archived, classRoster, classRows, cleanException, displayTime, field, importReceipt, importRoster, importTask, need, newId,
  rate, recordImport, reportRows, resolveReceipt, statusOf, summarize, unpack} from "./model.mjs";
import {area, button, empty, escape, form, hero, input, keys, layout, note, panel, receiptKeys, select,
  distribution, serializeDetails, stats, submit, tag, taskCard, taskOrder} from "./ui.mjs";

const pageSize = 15;
const filterItems = [["", "全部状态"], ["missing", "未提交"], ["present", "在校打卡"], ["away", "离校报备"], ["pending", "待核验"]];

export function build(ctx) {
  const ui = ctx.ui;
  let prepared = [];
  let person;

  function context() {
    const assigned = ctx.account?.person.group;
    const groups = assigned ? [assigned] : [...new Set(ctx.state.snapshots.map(item => item.group))];
    if (!groups.includes(ui.group)) ui.group = groups[0] ?? "";
    const tasks = taskOrder(ctx.state.tasks.filter(task => !ui.group || task.groups.includes(ui.group))
      .map(task => ({...task, current: statusOf(task)})));
    const task = tasks.find(item => item.id === ui.task) ?? tasks[0];
    ui.task = task?.id;
    const snapshot = task && classRoster(ctx.state, task.id, ui.group);
    return {groups, tasks, task, snapshot};
  }

  function rowMarkup(rows) {
    const term = (ui.search ?? "").toLowerCase();
    const filtered = rows.filter(row => (!ui.filter || row.status === ui.filter)
      && (!term || row.name.toLowerCase().includes(term) || row.id.includes(term)));
    const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
    ui.page = Math.min(ui.page ?? 0, maxPage);
    if (!filtered.length) return '<p class="meta">当前筛选下没有学生。</p>';
    const content = filtered.slice(ui.page * pageSize, (ui.page + 1) * pageSize).map(row =>
      '<article class="list-row"><div><strong>' + escape(row.name) + '</strong><p class="tiny">' + escape(row.id)
      + '</p></div><div class="actions">' + tag(row.status) + button("详情", "detail", "quiet compact", row.id) + '</div></article>').join("");
    return content + (maxPage > 0 ? '<div class="actions"><span class="meta">第 ' + (ui.page + 1) + ' / ' + (maxPage + 1)
      + ' 页</span>' + (ui.page > 0 ? button("上一页", "page", "secondary compact", ui.page - 1) : "")
      + (ui.page < maxPage ? button("下一页", "page", "secondary compact", ui.page + 1) : "") + '</div>' : "");
  }

  function board(task, snapshot) {
    if (!task) return "";
    if (archived(ctx.state, task.id)) return panel(task.title, tag(task.current) + note("已清理此任务的本机报备数据。"));
    if (!snapshot) return panel("本班打卡情况", empty("请先导入本班应报名单", "名单由管理员按任务单独发给班级负责人。",
      button("导入文件", "import", "secondary")));
    const rows = classRows(ctx.state, snapshot);
    const c = summarize(rows);
    const last = ctx.state.sentReports.find(item => item.taskId === task.id && item.group === snapshot.group);
    return panel(task.title + " · " + snapshot.group, '<div class="actions">' + tag(task.current)
      + '<span class="meta">截止 ' + escape(displayTime(task.due)) + '</span></div>'
      + stats([["应报", c.total], ["在校打卡", c.present], ["离校报备", c.away], ["未提交", c.missing]])
      + '<p class="meta">完成报备率 <strong>' + rate(c.done, c.total) + '</strong> · 在校打卡率 ' + rate(c.present, c.total)
      + ' · 待核验 ' + c.pending + '</p>' + distribution(c, "本班报备分布")
      + '<div class="actions">' + (task.current === "active" ? button("提醒", "remind", "secondary") : "")
      + button("导出本班 CSV", "csv", "secondary") + (task.mode !== "revoked" ? button("导出班级统计", "statistics", "secondary") : "")
      + button("报送特殊情况", "exception") + '</div>'
      + (last ? '<p class="tiny">上次生成班级统计 ' + escape(displayTime(last.createdAt)) + ' · 第 ' + last.version + ' 版</p>' : "")
      + '<div class="filters">' + input("search", "查找学生", ui.search, 'type="search" placeholder="姓名或学号" autocomplete="off"')
      + select("filter", "状态", filterItems, ui.filter ?? "") + '</div><div class="rows" id="student-rows" aria-live="polite">'
      + rowMarkup(rows) + '</div>');
  }

  function render() {
    const {groups, tasks, task, snapshot} = context();
    const aside = panel("操作指南", '<ol class="side-rule"><li>导入任务、本班名单和学生回执。</li><li>导出班级统计，供年级汇总。</li><li>需要管理员处理时，报送特殊情况。</li></ol>', "", "soft");
    const classChoice = groups.length > 1 ? select("group", "当前班级", groups.map(group => [group, group]), ui.group) : "";
    const cards = tasks.length ? '<div class="mobile-task-switch">' + select("task-switch", "切换任务", tasks.map(item => [item.id, item.title]), task.id)
      + '</div><div class="task-list desktop-task-list">' + tasks.map(item => taskCard(item, item.current,
      button(task?.id === item.id ? "当前查看" : "查看进度", "task", "secondary", item.id), task?.id === item.id)).join("") + '</div>' :
      empty("暂无班级任务", "收到管理端文件后，先导入任务包和本班应报名单。", button("导入文件", "import", "secondary"));
    return hero("班级负责人端", ui.group ? ui.group + " · 晚点名进度与报送" : "核对本班晚点名进度，提醒学生并汇总报送。", button("导入文件", "import", "light"))
      + layout(panel("本班任务", classChoice + cards, "", "task-switch-panel") + board(task, snapshot), aside);
  }

  function refreshRows() {
    const root = ctx.root.querySelector("#student-rows");
    if (root) root.innerHTML = rowMarkup(classRows(ctx.state, context().snapshot));
  }

  function detail(id) {
    const {task, snapshot} = context();
    const row = need(classRows(ctx.state, snapshot).find(item => item.id === id), "找不到该学生。");
    person = id;
    const pending = row.entries.filter(item => item.state === "pending");
    ctx.show(row.name + " · 打卡详情", tag(row.status) + keys([["学号", row.id], ["班级", row.group],
      ...receiptKeys(row.record)]) + pending.map(item => '<div class="note warn"><strong>待核验</strong><p>'
        + escape(item.issue) + '</p>' + keys([["回执姓名", item.record.name], ...receiptKeys(item.record)])
        + '<div class="actions">' + button("采纳回执", "accept", "secondary compact", item.record.id)
        + button("驳回", "reject", "danger compact", item.record.id) + '</div></div>').join("")
      + (task?.current === "active" && row.status === "missing" ? '<div class="actions">' + button("提醒该学生", "remind",
        "secondary", row.name) + '</div>' : ""));
  }

  const operations = {task: importTask, roster: importRoster, receipt: importReceipt};

  function applyImports(state, items) {
    const result = [];
    const assigned = ctx.account?.person.group;
    for (const item of items) {
      if (item.error) { result.push({name: item.name, text: item.error}); continue; }
      try {
        if (assigned) {
          need(item.type === "task" ? Array.isArray(item.data.groups) && item.data.groups.includes(assigned)
            : item.data.group === assigned, "该文件不属于你负责的班级。");
        }
        result.push({name: item.name, text: operations[item.type](state, item.data), ok: true});
      } catch (error) {
        result.push({name: item.name, text: error.message});
      }
    }
    return result;
  }

  const resultsMarkup = items => '<div class="rows">' + items.map(item =>
    '<div class="list-row"><div><strong>' + escape(item.name) + '</strong><p class="meta">' + escape(item.text)
      + '</p></div>' + tag(item.ok ? "可导入" : "需处理") + '</div>').join("") + '</div>';

  return {render, actions: {
    task(id) {
      ui.task = id;
      ui.page = 0;
      ctx.draw();
    },
    page(number) {
      ui.page = Number(number);
      refreshRows();
    },
    detail,
    async import() {
      const files = await ctx.pick(".json,application/json", true);
      if (!files.length) return;
      need(files.length <= 100, "每批最多导入 100 份文件。");
      const order = {task: 0, roster: 1, receipt: 2};
      prepared = [];
      for (const file of files) {
        try {
          const data = unpack(await ctx.read(file), Object.keys(operations), ctx.demo);
          prepared.push({...data, name: file.name});
        } catch (error) {
          prepared.push({name: file.name, error: error.message});
        }
      }
      prepared.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
      const results = applyImports(structuredClone(ctx.state), prepared);
      ctx.show("导入预览", (results.some(item => item.ok) ? form("import", resultsMarkup(results)
        + '<div class="actions">' + submit("确认导入") + '</div>') : resultsMarkup(results)));
    },
    remind(name) {
      const {task, snapshot} = context();
      need(task?.current === "active" && snapshot, "当前任务无法发送提醒。");
      const url = new URL("./student.html", location.href);
      if (ctx.demo) url.searchParams.set("demo", "1");
      url.hash = new URLSearchParams({task: task.id, reminder: newId(), at: new Date().toISOString()}).toString();
      const parts = [(name ? name + "，请" : "请") + "在 " + displayTime(task.due) + "（北京时间）前完成「" + task.title
        + "」，并将个人回执私发给班级负责人。", "如尚未导入任务，请先使用班群里的任务包。", url.href];
      ctx.show(name ? "提醒 " + name : "本班打卡提醒", '<p class="meta">复制文案后，通过班群或私聊转发。链接会打开对应任务。</p>'
        + area("reminder", "提醒文案", parts.join("\n"), "readonly rows=\"5\"")
        + '<div class="actions">' + button("复制提醒", "copy") + '</div>');
    },
    copy() {
      const textarea = ctx.dialog.querySelector('textarea[name="reminder"]');
      return ctx.shareText(textarea.value, textarea);
    },
    csv() {
      const {task, snapshot} = context();
      need(task && snapshot, "请先导入任务和应报名单。");
      ctx.csv(task.title + "-" + snapshot.group + "-打卡明细", serializeDetails(classRows(ctx.state, snapshot), task.title));
    },
    async statistics() {
      const {task, snapshot} = context();
      need(task && snapshot && task.mode !== "revoked", "当前任务无法导出统计。");
      let output;
      await ctx.edit(state => {
        const current = need(state.tasks.find(item => item.id === task.id && item.mode !== "revoked"), "任务已不可汇总。");
        const group = need(classRoster(state, current.id, snapshot.group), "应报名单已不可用。");
        const previous = state.sentReports.find(item => item.taskId === task.id && item.group === group.group);
        output = {id: newId(), taskId: task.id, group: group.group, version: (previous?.version ?? 0) + 1,
          createdAt: new Date().toISOString(), rows: reportRows(classRows(state, group))};
        state.sentReports = state.sentReports.filter(item => item.taskId !== task.id || item.group !== group.group);
        state.sentReports.push(output);
      });
      ctx.json("晚点名班级统计-" + snapshot.group + "-v" + output.version, "statistics", output);
      ctx.toast("班级统计已下载，请发给管理员汇总。");
    },
    exception() {
      const {task, snapshot} = context();
      need(task && snapshot, "请先导入任务及本班名单。");
      ctx.show("报送特殊情况", form("exception", keys([["任务", task.title], ["班级", snapshot.group]])
        + input("title", "标题", "", 'required maxlength="80" placeholder="例如 学生定位异常"')
        + area("note", "情况说明", "", 'required maxlength="1200"')
        + '<div class="actions">' + submit(ctx.online ? "发送到特殊情况邮箱" : "下载特殊情况文件") + '</div>', newId()));
    },
    async accept(id) {
      await ctx.edit(state => resolveReceipt(state, id, true));
      ctx.toast("已采纳回执。");
      detail(person);
    },
    async reject(id) {
      await ctx.edit(state => resolveReceipt(state, id, false));
      ctx.toast("已驳回回执。");
      detail(person);
    },
  }, forms: {
    async import() {
      let results;
      await ctx.edit(state => {
        results = applyImports(state, prepared);
        const count = results.filter(item => item.ok).length;
        recordImport(state, "班级文件", "处理 " + count + " 份文件 · 需处理 " + (results.length - count) + " 份");
      });
      ctx.close();
      const count = results.filter(item => item.ok).length;
      ctx.toast("已处理 " + count + " 份文件" + (count < results.length ? "，其余文件请按预览提示修正。" : "。"));
    },
    async exception(data, id) {
      const {task, snapshot} = context();
      need(task && snapshot, "任务或本班名单已不可用。");
      const exception = cleanException(ctx.state, {id, taskId: task.id, group: snapshot.group,
        createdAt: new Date().toISOString(), title: data.get("title"), note: data.get("note")});
      if (ctx.online) {
        await ctx.request("/special", {method: "POST", body: {...exception, taskTitle: task.title}});
      } else {
        ctx.json("晚点名特殊情况-" + exception.group + "-" + exception.id.slice(0, 8), "exception", exception);
      }
      ctx.close();
      ctx.toast(ctx.online ? "已发送到管理员的特殊情况邮箱。" : "特殊情况文件已下载，请发给管理员导入。");
    },
  }, input(control) {
    if (control.name === "search") {
      ui.search = control.value.trim();
      ui.page = 0;
      refreshRows();
    }
  }, change(control) {
    if (control.name === "filter") { ui.filter = control.value; ui.page = 0; refreshRows(); }
    if (control.name === "group") { ui.group = control.value; ui.page = 0; ctx.draw(); }
    if (control.name === "task-switch") { ui.task = control.value; ui.page = 0; ctx.draw(); }
  }};
}
