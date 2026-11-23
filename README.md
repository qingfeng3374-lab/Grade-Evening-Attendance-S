# 青岛软件学院、计算机科学与技术学院晚点名报备系统

面向中国石油大学（华东）青岛软件学院、计算机科学与技术学院。系统首页直接进入登录页，登录后按账号角色进入对应工作台。

[打开晚点名报备系统](https://qingfeng3374-lab.github.io/Grade-Evening-Attendance-S/)

## 登录与办理

首次登录可直接输入账号和密码。各端顶部均有「退出登录」。

| 角色 | 登录方式 | 办理事项 |
| --- | --- | --- |
| 学生 | 用户名为学籍姓名，密码为学号 | 在校时授权定位，校验通过后自动提交并显示地点。离校时填写原因并提交。在任务详情查看提交结果。 |
| 班级负责人 | 用户名为大写 `A` 加学籍姓名，密码为学号 | 查看本班打卡进度和学生明细，复制提醒链接，导出本班数据，在线报送特殊情况。 |
| 管理员 | 使用部署时配置的账号 | 发布、延期或撤销任务，查看年级总览、各班打卡率和学生明细，导出年级汇总和学生明细，在站内「特殊情况邮箱」查收报送。 |

管理端新建任务时选择适用班级、北京时间截止时间和允许打卡的校区。系统根据服务端名册生成应报名单，默认使用内置的唐岛湾校区边界。学生端和负责人端登录后自动同步本班任务。前台页面约每 15 秒检查更新，也可手动刷新。发布、延期和撤销均通过服务同步。

负责人将提醒链接转发至班群或私聊。学生每项任务提交一条在校打卡或离校报备，结果同步到负责人端和管理端。进度以任务应报名单为准。完成报备率包含在校打卡和离校报备，在校打卡率只统计在校打卡。负责人和管理员可将导出文件保存到本机。支持保存对话框的浏览器可选择位置，其他浏览器使用常规下载。旧版文件可从历史导入入口处理。需要管理员单独处理的事项可通过「报送特殊情况」提交。

## 数据与隐私

- GitHub Pages 发布 `dist/` 中的网页、脚本和公开校园素材。账号、在线任务、打卡和报备数据保存在服务端的私有数据库中。负责人只可查看本班填报，学生只可查看自己的记录。
- 负责人端的线上名单、打卡记录与导出使用任务内名单编号。负责人可按姓名或编号搜索。管理员可以导入带编号的班级统计，并在有权限的管理端核对学号。旧版历史文件和已下载的文件可能含有完整学号，应按登录凭据保管。
- 浏览器默认使用 IndexedDB 保存当前账号的工作记录，退出后仍保留。登录时勾选「共享设备」可将本次工作记录仅保留在当前页面，刷新后会重新同步线上记录。此前的浏览器缓存和手动下载的文件需单独清理。各端仍可从「本机数据」下载备份，并清理已截止或撤销任务的本机记录。
- 选择在校打卡后，浏览器获取位置并按任务围栏初步判定。服务端通过 HTTPS 接收本次坐标，复核后在本地校园地名数据中查找附近的楼宇、校门、地标或道路。地图覆盖不足时显示校区官方地址。
- 三端详情均可查看保存的地点名称，负责人导出的本班明细和管理员导出的学生明细包含「打卡地点」列。数据库保存地点名称、校区和定位精度。早期打卡记录只保留当时已有的校区信息。
- 名册、账号文件、数据库、密钥、部署配置、回执、报送内容、统计导出和本机备份均应存放在源码仓库及发布目录之外。涉及个人信息的文件只在办理所需的人员之间私下交接。
- `.gitignore` 覆盖常见私有数据目录和导出文件。提交前可用 `git diff --cached --name-only` 核对暂存文件。`.gitignore` 仅对未跟踪文件生效。

## 本地预览

在仓库根目录运行以下命令，打开 `http://localhost:8765/`，然后在登录页底部点击「查看演示」。演示使用内置示例数据，可模拟校内和校外定位。

```powershell
python -m http.server 8765 --directory dist
```

## 服务部署

静态站点通过 HTTPS 发布 `dist/`。账号、任务与报送服务绑定回环地址，通过 HTTPS 反向代理提供 API，并使用 `--origin` 配置允许访问的站点来源。前端生产 API 地址由 `dist/assets/auth.mjs` 配置。更换 API 主机时应同步更新登录页和各角色页面的内容安全策略。

公网部署时，反向代理应覆盖 `X-Real-IP`，例如在直接面对客户端的 nginx 中设置 `proxy_set_header X-Real-IP $remote_addr;`。完成配置后，启动服务时添加 `--trust-proxy-ip`，按真实地址限速。默认按直连地址限速。日志应排除请求体和认证头。

登录信息经 HTTPS 发送。服务端使用随机盐和服务端私有密钥，再通过 scrypt 生成密码校验值。学号同时保存在学籍和点名记录中，因此应限制 SQLite、备份和导出文件的访问权限，并启用存储加密。学生和负责人继续使用学号登录，知道姓名和学号的人仍可能冒用账号。

从旧版升级时先发布新版静态页面，再更新 API 服务，并沿用现有数据库和 `pepper.bin`。新版页面可读取旧 API 返回的数据。API 更新之后，旧版负责人页面需要刷新才能处理新的名单编号。

首次部署使用 Python 3.9 或更高版本运行初始化工具。学生表与负责人表均需包含「姓名」「班级」「学号」三列。已有历史账号时，使用原签发密钥保留账号标识。以下为示例路径。请将源文件与新建的数据目录放在仓库之外，按终端提示输入管理员密码。已有数据库应继续使用原数据目录。

```powershell
python -m pip install openpyxl cryptography
python tools/seed_server.py --students "../private/students.xlsx" --leaders "../private/leaders.xlsx" --signing-key "../private/account-signing-key.pem" --output "../private/attendance" --admin-username "<管理员用户名>"
python server/service.py --db "../private/attendance/attendance.sqlite3" --pepper-file "../private/attendance/pepper.bin" --site-dir dist
```

运行服务后，通过 `http://localhost:8791/` 联调。正式部署时通过私有渠道把服务所需的数据库和密码校验密钥复制到服务端，并限制服务数据目录的访问权限。账号签发私钥保存在管理方的私有目录。

## 目录与测试

| 路径 | 用途 |
| --- | --- |
| `dist/` | 静态页面、应用模块和公开校园素材 |
| `server/service.py` | 登录会话、任务 API 和特殊情况邮箱 |
| `server/task_service.py` | 任务发布、班级可见范围和版本同步 |
| `server/campus-places.json` | 服务端随代码部署的公开校园地名数据 |
| `tools/seed_server.py` | 从工作簿初始化服务端名册和账号 |
| `tests/` | 业务规则测试和三端浏览器测试 |

运行 `node --test tests/model.test.mjs` 检查统计、定位和导入规则。准备好 Python 依赖、Playwright 与 Chromium 后，运行 `node tests/browser.mjs` 检查三端登录、任务同步和办理流程。浏览器测试会生成临时账号和测试数据，可通过 `ATTENDANCE_PLAYWRIGHT`、`ATTENDANCE_CHROMIUM` 指定测试环境。

## 校园素材

- 徽标来自学院官网页头。 [青岛软件学院、计算机科学与技术学院](https://computer.upc.edu.cn/)
- 校园夜景为图说石大中的《夜间石大》，摄影肖鸿伟。 [靓丽风景](https://photo.upc.edu.cn/jlfj.htm)
- 唐岛湾校区定位边界取自 OpenStreetMap way 222840628（v22），由 © OpenStreetMap contributors 提供，数据按 ODbL 1.0 分发。 [边界文件](dist/assets/tangdaowan-boundary.geojson) · [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) · [学校平面图](https://upce.upc.edu.cn/2018/0404/c8300a143081/pagem.htm)
- 校园地名数据来自 © OpenStreetMap contributors，按 ODbL 1.0 分发。文件以 OSM 要素编号标注来源。校区地址来自学校官网。 [校园地名数据](server/campus-places.json) · [OpenStreetMap 许可](https://www.openstreetmap.org/copyright) · [学校官网](https://www.upc.edu.cn/)
- 校区名称参照学校公开资料。 [学校简介](https://www.upc.edu.cn/info/1012/1002.htm)
