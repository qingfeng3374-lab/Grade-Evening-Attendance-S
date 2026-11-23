import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {beijingInput} from "../dist/assets/model.mjs";

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.ATTENDANCE_PLAYWRIGHT || "playwright");
const base = "http://127.0.0.1:" + (process.env.ATTENDANCE_TEST_PORT || "8792");
const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "upc-site-qa-"));
const fixtures = path.join(artifacts, "accounts");
execFileSync(process.env.ATTENDANCE_PYTHON || "python", ["-B",
  fileURLToPath(new URL("./create-login-fixtures.py", import.meta.url)), fixtures], {stdio: "ignore"});
const browser = await chromium.launch({headless: true, executablePath: process.env.ATTENDANCE_CHROMIUM});
const server = spawn(process.env.ATTENDANCE_PYTHON || "python", ["-B", fileURLToPath(new URL("../server/service.py", import.meta.url)),
  "--db", path.join(fixtures, "attendance.sqlite3"), "--pepper-file", path.join(fixtures, "pepper.bin"), "--site-dir",
  fileURLToPath(new URL("../dist", import.meta.url)), "--port", new URL(base).port], {stdio: "inherit", windowsHide: true});
const errors = [];
let sequence = 0;

async function context(options = {}) {
  const scope = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, ...options});
  await scope.addInitScript(() => { window.showSaveFilePicker = undefined; });
  return scope;
}

async function pageAt(scope, target) {
  const page = await scope.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() === 401 && response.url() === base + "/api/login") return;
    if (response.status() >= 400 && response.url().startsWith(base)) errors.push(response.url() + " " + response.status());
  });
  await page.goto(base + "/" + target);
  await page.locator("h1").waitFor();
  assert.doesNotMatch(await page.locator("h1").innerText(), /无法打开/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  return page;
}

function click(scope, name) {
  return scope.getByRole("button", {name, exact: true}).first().click();
}

async function download(scope, name) {
  const pending = scope.waitForEvent("download");
  await click(scope, name);
  const file = await pending;
  const result = path.join(artifacts, String(++sequence) + "-" + file.suggestedFilename());
  await file.saveAs(result);
  return result;
}

async function upload(scope, name, files, confirm = true) {
  const pending = scope.waitForEvent("filechooser");
  await click(scope, name);
  await (await pending).setFiles(files);
  if (confirm) {
    await click(scope.getByRole("dialog"), "确认导入");
    await scope.getByRole("dialog").waitFor({state: "hidden"});
  }
}

async function includes(scope, text) {
  await scope.getByText(text, {exact: false}).first().waitFor();
}

async function submitLogin(page, user, password) {
  await page.getByLabel("用户名", {exact: true}).fill(user);
  await page.getByLabel("密码", {exact: true}).fill(password);
  await click(page, "登录");
}

async function login(page, role, user, password) {
  await submitLogin(page, user, password);
  await page.waitForURL(new RegExp("/" + role + "\\.html"));
  await page.getByRole("button", {name: "退出登录"}).waitFor();
}

try {
  for (let i = 0; i < 25; i++) {
    if (await fetch(base + "/api/health").then(response => response.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  for (const [width, height] of [[1440, 980], [390, 844], [320, 700]]) {
    const scope = await context({viewport: {width, height}, isMobile: width < 800});
    for (const role of ["index", "student", "leader", "admin", "login"]) {
      const page = await pageAt(scope, role + ".html" + (role === "login" ? "" : "?demo=1"));
      const school = page.locator(".brand strong");
      assert.equal(await school.innerText(), "青岛软件学院、计算机科学与技术学院");
      assert.equal(await school.evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }), 1);
      if (role === "login" || role === "index") {
        await page.waitForURL("**/login.html");
        assert.equal(await page.getByText(/A 加姓名/).count(), 0);
        await includes(page, "用户名即姓名，密码即学号");
      }
      await page.screenshot({path: path.join(artifacts, role + "-" + width + ".png"), fullPage: true});
      if (role === "student" && width === 390) {
        await click(page, "去填报");
        await page.getByRole("dialog").waitFor();
        await click(page, "模拟校外");
        await includes(page.getByRole("dialog"), "当前位置超出任务允许区域");
        await click(page, "关闭");
      }
    }
    await scope.close();
  }

  const staffBrowser = await context();
  const leaderBrowser = await context();
  const studentBrowser = await context({permissions: ["geolocation"],
    geolocation: {longitude: 120.169487, latitude: 35.942592, accuracy: 19}});

  const admin = await pageAt(staffBrowser, "login.html");
  const leader = await pageAt(leaderBrowser, "login.html");
  const student = await pageAt(studentBrowser, "login.html");
  await student.locator(".login-panel").screenshot({path: path.join(artifacts, "guide-login.png")});
  assert.equal(await student.locator('input[type="file"]').count(), 0);
  await submitLogin(student, "测试甲", "999");
  await includes(student, "用户名或密码不正确");
  await login(student, "student", "测试甲", "001");
  await login(leader, "leader", "A测试甲", "001");
  await login(admin, "admin", "admin", "fixture-pass");
  await includes(admin, "3 名学生 · 2 个班级 · 1 条负责人记录");
  await includes(leader, "测试2401 · 晚点名进度与报送");
  await student.goto(base + "/admin.html");
  await student.waitForURL("**/student.html");
  assert.equal(await student.getByRole("button", {name: "编辑信息", exact: true}).count(), 0);

  const roster = {name: "测试学籍.csv", mimeType: "text/csv", buffer: Buffer.from(
    "姓名,班级,学号\n测试甲,测试2401,001\n测试乙,测试2401,002\n测试丙,测试2402,003\n")};
  await upload(admin, "导入学籍 CSV", roster);
  await includes(admin, "3 名学生 · 2 个班级");
  const staff = {name: "测试负责人.csv", mimeType: "text/csv", buffer: Buffer.from("姓名,班级,学号\n测试甲,测试2401,001\n")};
  await upload(admin, "导入负责人 CSV", staff);
  await includes(admin, "待核对负责人 测试2402");

  await includes(admin, "系统预设");
  const defaultBoundary = JSON.parse(await fs.readFile(new URL("../dist/assets/tangdaowan-boundary.geojson", import.meta.url), "utf8"));
  const callTasks = async (page, suffix = "", body) => {
    const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem("upc-attendance-online-session-v1")).token);
    return fetch(base + "/api/tasks" + suffix, {method: body ? "POST" : "GET",
      headers: {Authorization: "Bearer " + token, ...(body ? {"Content-Type": "application/json"} : {})}, body: JSON.stringify(body)});
  };

  await click(admin, "新建任务");
  assert.ok(await admin.getByRole("checkbox", {name: "唐岛湾校区", exact: true}).isChecked());
  await admin.getByLabel("任务标题").fill("多设备验收任务");
  await admin.getByLabel("任务说明").fill("请用北京时间完成报备。");
  await admin.getByLabel("开放时间（北京时间）").fill(beijingInput(Date.now() - 60000));
  await admin.getByLabel("截止时间（北京时间）").fill(beijingInput(Date.now() + 3600000));
  await click(admin, "保存草稿");
  await click(admin, "编辑并发布");
  await click(admin, "预览发布");
  await click(admin, "返回编辑");
  assert.equal(await admin.getByLabel("任务标题").inputValue(), "多设备验收任务");
  await click(admin, "预览发布");
  await includes(admin.getByRole("dialog"), "应报人数");
  await includes(leader, "暂无班级任务");
  await click(admin, "确认发布");
  await includes(admin, "任务已发布");
  assert.deepEqual(await admin.getByRole("button", {name: "下载发布文件", exact: true}).count(), 0);
  const published = (await (await callTasks(admin)).json()).items[0];
  const task = published.task;
  assert.deepEqual(task.fences, [{name: "唐岛湾校区", version: defaultBoundary.properties.version,
    buffer: 20, maxAccuracy: 70, geometry: defaultBoundary.geometry}]);
  assert.deepEqual(task.groups, ["测试2401", "测试2402"]);
  assert.equal(published.snapshots.length, 2);
  assert.equal((await callTasks(student, "", task)).status, 403);
  const restricted = {...task, id: "only-other-class", title: "其他班级专用任务", groups: ["测试2402"],
    opens: new Date(Date.now() + 1800000).toISOString()};
  assert.equal((await callTasks(admin, "", restricted)).status, 201);
  const studentTasks = (await (await callTasks(student)).json()).items;
  const leaderTasks = (await (await callTasks(leader)).json()).items;
  assert.deepEqual(studentTasks.map(item => item.task.id), [task.id]);
  assert.deepEqual(studentTasks[0].snapshots, []);
  assert.deepEqual(leaderTasks.map(item => item.task.id), [task.id]);
  assert.deepEqual(leaderTasks[0].snapshots.map(snapshot => snapshot.group), ["测试2401"]);
  const leaderStudents = leaderTasks[0].snapshots[0].students;
  const [firstReference, secondReference] = leaderStudents.map(student => student.id);
  assert.deepEqual(leaderStudents.map(student => student.name), ["测试甲", "测试乙"]);
  for (const reference of [firstReference, secondReference]) assert.match(reference, /^ref_[a-f0-9]{32}$/);
  assert.notEqual(firstReference, secondReference);
  assert.deepEqual(published.snapshots[0].students.map(student => [student.id, student.reportRef]),
    [["001", firstReference], ["002", secondReference]]);
  await includes(leader.locator("#student-rows"), "测试甲");
  await includes(student, "多设备验收任务");
  await includes(student, "填报会自动使用以上学籍信息。");
  await includes(admin, "全年级打卡总览");
  await includes(admin, "各班打卡进度");
  const attendancePath = "/" + task.id + "/attendance";
  const feedQuery = "?attendanceSince=0";
  assert.equal((await callTasks(student, attendancePath, {result: "present", longitude: 120.22,
    latitude: 35.98, accuracy: 19})).status, 400);

  await click(leader, "提醒");
  const text = await leader.getByLabel("提醒文案").inputValue();
  assert.ok(!text.includes("测试甲"));
  const url = text.split("\n").at(-1);
  await click(leader, "关闭");
  await student.goto(url);
  await student.getByRole("dialog").waitFor();
  await includes(student.getByRole("dialog"), "提交本次坐标和精度");
  await student.getByRole("button", {name: /^是，我在校/}).click();
  await includes(student.getByRole("dialog"), "在校打卡成功");
  const libraryLocation = "唐岛湾校区 · 图书馆总馆附近";
  await includes(student.getByRole("dialog"), libraryLocation);
  assert.equal(await student.getByRole("dialog").getByText("本次经纬度").count(), 0);
  await student.getByRole("dialog").screenshot({path: path.join(artifacts, "guide-student.png")});
  assert.equal(await student.getByRole("button", {name: "下载回执"}).count(), 0);
  const {attendance: studentFeed} = await (await callTasks(student, feedQuery)).json();
  const [record] = studentFeed.items;
  assert.equal(record.accuracy, 19);
  assert.equal(record.longitude, undefined);
  assert.equal(record.latitude, undefined);
  assert.equal(record.studentId, "001");
  assert.equal(record.name, "测试甲");
  assert.equal(record.result, "present");
  assert.equal(record.location, libraryLocation);

  const awayBrowser = await context();
  await awayBrowser.addInitScript(() => {
    const request = {calls: 0, userGesture: false, reject: null};
    window.testLocationRequest = request;
    Object.defineProperty(navigator.geolocation, "getCurrentPosition", {configurable: true, value(_resolve, reject) {
      request.calls++;
      request.userGesture = navigator.userActivation.isActive;
      request.reject = reject;
    }});
  });
  const away = await pageAt(awayBrowser, "login.html");
  await away.getByRole("checkbox", {name: /共享设备/}).check();
  await login(away, "student", "测试乙", "002");
  assert.deepEqual(await away.evaluate(() => indexedDB.databases()), []);
  await click(away, "去填报");
  const awayDialog = away.getByRole("dialog");
  const onsite = awayDialog.getByRole("button", {name: /^是，我在校/});
  assert.equal(await away.evaluate(() => window.testLocationRequest.calls), 0);
  await onsite.click();
  await includes(awayDialog.getByRole("status"), "系统会自动继续打卡");
  assert.deepEqual(await away.evaluate(() => {
    const {calls, userGesture} = window.testLocationRequest;
    return {calls, userGesture};
  }), {calls: 1, userGesture: true});
  await away.evaluate(() => window.testLocationRequest.reject({code: 1}));
  await includes(awayDialog, "尚未允许定位");

  await away.evaluate(() => { delete navigator.geolocation.getCurrentPosition; });
  await awayBrowser.grantPermissions([], {origin: base});
  await onsite.click();
  await includes(awayDialog, "请在浏览器的站点权限中允许访问位置");
  await away.getByRole("button", {name: /^否，我不在校/}).click();
  await away.getByLabel("离校原因").fill("在外参加活动\n次日返校。");
  await click(away, "确认报备");
  await includes(awayDialog, "离校报备已提交");
  assert.equal(await awayDialog.getByRole("button", {name: "下载回执"}).count(), 0);
  assert.equal((await callTasks(leader, attendancePath, {result: "away", reason: "无权提交"})).status, 403);
  assert.equal((await callTasks(away, "/only-other-class/attendance", {result: "away", reason: "不属于此班"})).status, 404);
  const retry = await callTasks(away, attendancePath, {result: "present", longitude: 120.17, latitude: 35.937, accuracy: 20});
  const {record: onlineAway} = await retry.json();
  assert.equal(onlineAway.studentId, "002");
  assert.equal(onlineAway.reason, "在外参加活动\n次日返校。");
  assert.deepEqual((await (await callTasks(student, feedQuery)).json()).attendance.items, [record]);
  assert.deepEqual((await (await callTasks(away, feedQuery)).json()).attendance.items, [onlineAway]);
  assert.deepEqual((await (await callTasks(leader, feedQuery)).json()).attendance.items,
    [{...record, studentId: firstReference}, {...onlineAway, studentId: secondReference}]);
  const otherLogin = await fetch(base + "/api/login", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({username: "测试丙", password: "003"})});
  const {token: otherToken} = await otherLogin.json();
  const otherFeed = await fetch(base + "/api/tasks" + feedQuery, {headers: {Authorization: "Bearer " + otherToken}});
  assert.deepEqual((await otherFeed.json()).attendance.items, []);
  await Promise.all([
    includes(leader, "完成报备率 100%"),
    includes(admin.locator(".chart-legend"), "离校报备 1"),
  ]);
  const rateBar = admin.getByRole("progressbar", {name: "测试2401在校打卡率"});
  assert.equal(await rateBar.getAttribute("value"), "1");
  assert.equal(await rateBar.getAttribute("max"), "2");
  await includes(admin.locator(".stats"), "33.3%");
  await includes(admin.locator(".stats"), "66.7%");
  for (const width of [320, 390, 1440]) {
    await admin.setViewportSize({width, height: 844});
    assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await admin.screenshot({path: path.join(artifacts, "attendance-dashboard-" + width + ".png"), fullPage: true});
  }
  await admin.setViewportSize({width: 390, height: 844});
  await admin.locator(".panel").filter({hasText: "全年级打卡总览"}).screenshot({path: path.join(artifacts, "guide-admin.png")});
  await admin.locator(".panel").filter({hasText: "各班打卡进度"}).screenshot({path: path.join(artifacts, "guide-admin-classes.png")});
  await admin.locator('[data-do="group-detail"][data-value="测试2401"]').click();
  await includes(admin.getByRole("dialog"), "本班报备分布");
  await click(admin.getByRole("dialog").locator(".list-row").filter({hasText: "测试甲"}), "查看记录");
  await includes(admin.getByRole("dialog"), libraryLocation);
  await click(admin.getByRole("dialog"), "返回本班明细");
  await click(admin.getByRole("dialog").locator('.list-row').filter({hasText: "测试乙"}), "查看记录");
  await includes(admin.getByRole("dialog"), "在外参加活动");
  await click(admin, "关闭");
  const onlineCSV = await download(admin, "导出学生明细");
  assert.match(await fs.readFile(onlineCSV, "utf8"), /"002","离校报备"/);
  const adminExport = await fs.readFile(onlineCSV, "utf8");
  assert.match(adminExport, /"001","在校打卡"/);
  assert.ok(adminExport.includes('"打卡地点"') && adminExport.includes(libraryLocation));
  await away.reload();
  await click(away, "查看");
  await includes(awayDialog, "离校报备已提交");
  assert.deepEqual(await away.evaluate(() => indexedDB.databases()), []);

  await leader.getByLabel("查找学生").fill("测试甲");
  await click(leader, "详情");
  await includes(leader.getByRole("dialog"), libraryLocation);
  await leader.getByRole("dialog").screenshot({path: path.join(artifacts, "guide-leader.png")});
  await click(leader, "关闭");
  const displayedReference = secondReference.slice(4, 16).toUpperCase();
  await leader.getByLabel("查找学生").fill(displayedReference);
  await click(leader, "详情");
  await includes(leader.getByRole("dialog"), "在外参加活动");
  await click(leader, "关闭");
  const classCSV = await download(leader, "导出本班 CSV");
  const leaderExport = await fs.readFile(classCSV, "utf8");
  assert.ok(leaderExport.includes('"本次名单编号"') && leaderExport.includes('"' + displayedReference + '","离校报备"'));
  assert.doesNotMatch(leaderExport, /"00[12]"/);
  assert.ok(leaderExport.includes(libraryLocation));
  await leader.evaluate(() => {
    window.showSaveFilePicker = async options => ({async createWritable() {
      return {async write(blob) { window.savedExport = {name: options.suggestedName, data: await blob.text()}; },
        async close() {}};
    }});
  });
  await click(leader, "导出本班 CSV");
  await leader.waitForFunction(() => window.savedExport);
  const localExport = await leader.evaluate(() => window.savedExport);
  assert.match(localExport.name, /\.csv$/);
  assert.ok(localExport.data.includes('"' + displayedReference + '","离校报备"'));
  await leader.evaluate(() => { window.showSaveFilePicker = undefined; });
  await includes(leader, "本班报备分布");
  await click(leader, "报送特殊情况");
  await leader.getByLabel("标题", {exact: true}).fill("定位需要复核");
  await leader.getByLabel("情况说明").fill("已核对本班回执。");
  await click(leader, "发送到特殊情况邮箱");
  await includes(leader, "已发送到管理员的特殊情况邮箱");
  await click(admin, "特殊情况邮箱");
  await includes(admin.getByRole("dialog"), "定位需要复核");
  await click(admin.getByRole("dialog"), "读消息");
  await includes(admin.getByRole("dialog"), "已核对本班回执。");
  await click(admin, "关闭");
  const reportFile = await download(leader, "导出班级统计");
  assert.deepEqual(JSON.parse(await fs.readFile(reportFile, "utf8")).data.rows.map(row => row.id),
    [firstReference, secondReference]);
  await upload(admin, "导入历史统计", reportFile);
  await includes(admin, "全年级打卡总览");
  assert.equal(await admin.getByText("未报送", {exact: true}).count(), 0);
  await admin.locator('[data-do="group-detail"][data-value="测试2402"]').click();
  await includes(admin.getByRole("dialog"), "统计详情");
  await click(admin, "关闭");
  const summary = await download(admin, "导出年级汇总");
  assert.match(await fs.readFile(summary, "utf8"), /"测试2401","2","1","1","0","0","100%"/);
  assert.match(await fs.readFile(summary, "utf8"), /"测试2402","1","0","0","1","0","0%"/);

  await click(admin, "延长截止");
  await click(admin, "保存新版本");
  await includes(admin, "截止时间已更新");
  const updated = (await (await callTasks(student)).json()).items[0].task;
  assert.equal(updated.revision, 2);
  assert.ok(updated.due > task.due);
  await click(admin, "撤销任务");
  await click(admin, "确认撤销");
  await admin.locator("#live").filter({hasText: "任务已撤销"}).waitFor();
  const cancellation = (await (await callTasks(student)).json()).items[0].task;
  assert.equal(cancellation.mode, "revoked");
  assert.equal(cancellation.revision, 3);
  assert.equal((await fetch(base + "/api/tasks" + attendancePath, {method: "POST",
    headers: {Authorization: "Bearer " + otherToken, "Content-Type": "application/json"},
    body: JSON.stringify({result: "away", reason: "任务已撤销"})})).status, 409);
  await click(student, "关闭");
  await click(student, "刷新任务");
  await includes(student, "任务已撤销");
  await click(student, "本机数据");
  const backup = await download(student, "下载本机备份");
  assert.equal(JSON.parse(await fs.readFile(backup, "utf8")).data.workspace.onlineAttendance.length, 1);
  await student.getByLabel("可清理的已结束任务").selectOption(task.id);
  await click(student, "选择清理任务");
  await click(student, "确认清理");
  await click(student, "关闭");
  await click(student, "查看");
  await includes(student.getByRole("dialog"), "已清理此任务的本机报备数据");
  await click(student, "关闭");
  await click(student, "退出登录");
  await student.waitForURL("**/login.html");
  await student.goto(base + "/student.html#task=" + task.id);
  await student.waitForURL("**/login.html?task=*");
  await login(student, "student", "测试甲", "001");
  await includes(student.getByRole("dialog"), "已撤销");
  await click(leader, "退出登录");
  await leader.waitForURL("**/login.html");
  await click(admin, "退出登录");
  await admin.waitForURL("**/login.html");
  assert.deepEqual(errors, []);
  console.log("Browser QA passed at 320, 390 and 1440px. Outputs: " + artifacts);
} finally {
  console.log("QA artifacts: " + artifacts);
  await browser.close();
  server.kill();
}
