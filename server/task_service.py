"""Published tasks and class-scoped roster snapshots."""

from datetime import datetime
import hmac
import json
import math
from pathlib import Path
import re
from urllib.parse import parse_qs


SCHEMA = """
CREATE TABLE IF NOT EXISTS published_tasks (
 id TEXT PRIMARY KEY, payload TEXT NOT NULL, original TEXT NOT NULL, sync_version INTEGER NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS published_task_groups (
 task_id TEXT NOT NULL REFERENCES published_tasks(id), class_name TEXT NOT NULL, students TEXT NOT NULL,
 PRIMARY KEY(task_id, class_name)
);
CREATE INDEX IF NOT EXISTS published_task_groups_class ON published_task_groups(class_name, task_id);
CREATE TABLE IF NOT EXISTS away_submissions (
 sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES published_tasks(id), student_id TEXT NOT NULL,
 class_name TEXT NOT NULL, student_name TEXT NOT NULL, revision INTEGER NOT NULL, submitted_at TEXT NOT NULL,
 reason TEXT NOT NULL, UNIQUE(task_id, student_id)
);
CREATE INDEX IF NOT EXISTS away_submissions_class ON away_submissions(class_name, sequence);
CREATE TABLE IF NOT EXISTS attendance_submissions (
 sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES published_tasks(id), student_id TEXT NOT NULL,
 class_name TEXT NOT NULL, student_name TEXT NOT NULL, revision INTEGER NOT NULL, submitted_at TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('away', 'present')), reason TEXT, campus TEXT, accuracy REAL,
 location TEXT,
 UNIQUE(task_id, student_id)
);
CREATE INDEX IF NOT EXISTS attendance_submissions_class ON attendance_submissions(class_name, sequence);
INSERT OR IGNORE INTO attendance_submissions
 (sequence,task_id,student_id,class_name,student_name,revision,submitted_at,result,reason)
 SELECT sequence,task_id,student_id,class_name,student_name,revision,submitted_at,'away',reason FROM away_submissions;
"""
CAMPUS_NAMES = ("唐岛湾校区", "古镇口校区", "东营科教园区")
CAMPUS_ADDRESSES = {
    "唐岛湾校区": "青岛市黄岛区长江西路66号",
    "古镇口校区": "青岛市黄岛区三沙路1006号",
    "东营科教园区": "东营市东营区北一路739号",
}
with Path(__file__).with_name("campus-places.json").open(encoding="utf-8") as source:
    CAMPUS_PLACES = json.load(source)["campuses"]


def initialize(db):
    db.executescript(SCHEMA)
    with db:
        db.execute("BEGIN IMMEDIATE")
        if not any(column["name"] == "location" for column in db.execute("PRAGMA table_info(attendance_submissions)")):
            db.execute("ALTER TABLE attendance_submissions ADD COLUMN location TEXT")


class TaskError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def require(condition, message, status=400):
    if not condition:
        raise TaskError(status, message)


def task_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value), "任务编号无效。")
    return value


def text(value, length, message, empty=False):
    require(isinstance(value, str) and (empty or value.strip()) and len(value) <= length, message)
    return value.strip()


def timestamp(value):
    require(isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value), "任务时间有误。")
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as error:
        raise TaskError(400, "任务时间有误。") from error
    return value


def number(value, lower, upper):
    return type(value) in (int, float) and lower <= value <= upper and math.isfinite(value)


def clean_fence(raw):
    require(isinstance(raw, dict) and raw.get("name") in CAMPUS_NAMES, "打卡校区无效。")
    name = raw["name"]
    version = text(raw.get("version"), 80, "围栏版本无效。")
    buffer, accuracy = raw.get("buffer"), raw.get("maxAccuracy")
    require(number(buffer, 0, 2000) and number(accuracy, 1, 1000), "围栏距离或精度无效。")
    geometry = raw.get("geometry")
    require(isinstance(geometry, dict) and geometry.get("type") in ("Polygon", "MultiPolygon"), "围栏必须是多边形。")
    coordinates = geometry.get("coordinates")
    polygons = [coordinates] if geometry["type"] == "Polygon" else coordinates
    require(isinstance(polygons, list) and 1 <= len(polygons) <= 50, "围栏多边形无效。")
    total = 0
    for polygon in polygons:
        require(isinstance(polygon, list) and 1 <= len(polygon) <= 50, "围栏多边形无效。")
        for ring in polygon:
            require(isinstance(ring, list) and len(ring) >= 4 and ring[0] == ring[-1], "围栏环线无效。")
            total += len(ring)
            require(total <= 10000, "围栏坐标过多。")
            for point in ring:
                require(isinstance(point, list) and len(point) == 2 and number(point[0], -180, 180)
                        and number(point[1], -90, 90), "打卡坐标无效。")
            x, y = ring[0]
            area = sum((a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y) for a, b in zip(ring, ring[1:]))
            require(abs(area) > 1e-12, "围栏环线面积无效。")
    return {"name": name, "version": version, "buffer": buffer, "maxAccuracy": accuracy,
            "geometry": {"type": geometry["type"], "coordinates": coordinates}}


def clean_new_task(raw):
    identifier = task_id(raw.get("id"))
    title = text(raw.get("title"), 70, "任务标题无效。")
    description = text(raw.get("description", ""), 2000, "任务说明最多 2000 字。", empty=True)
    opens, due = timestamp(raw.get("opens")), timestamp(raw.get("due"))
    require(opens < due, "截止时间须晚于开放时间。")
    groups = raw.get("groups")
    require(isinstance(groups, list) and 1 <= len(groups) <= 100, "请至少选择一个班级。")
    groups = list(dict.fromkeys(text(value, 50, "班级名称无效。") for value in groups))
    raw_fences = raw.get("fences")
    require(isinstance(raw_fences, list) and 1 <= len(raw_fences) <= 3, "请至少选择一个校区。")
    fences = [clean_fence(fence) for fence in raw_fences]
    require(len({fence["name"] for fence in fences}) == len(fences), "打卡校区重复。")
    return {"id": identifier, "title": title, "description": description, "opens": opens, "due": due,
            "groups": groups, "fences": fences, "revision": 1, "mode": "published"}


def dump(data):
    return json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def roster_reference(key, task_id, group, student_id):
    payload = dump(["attendance-roster:v1", task_id, group, student_id]).encode()
    return "ref_" + hmac.digest(key, payload, "sha256").hex()[:32]


def read_item(db, row, account, reference_key):
    task = json.loads(row["payload"])
    role = account["role"]
    snapshots = []
    if role in ("admin", "leader"):
        sql = "SELECT class_name,students FROM published_task_groups WHERE task_id=?"
        args = (task["id"],)
        if role == "leader":
            sql += " AND class_name=?"
            args += (account["class_name"],)
        for snap in db.execute(sql + " ORDER BY class_name", args):
            group = snap["class_name"]
            students = json.loads(snap["students"])
            for student in students:
                reference = roster_reference(reference_key, task["id"], group, student["id"])
                student["id" if role == "leader" else "reportRef"] = reference
            snapshots.append({"taskId": task["id"], "group": group, "students": students})
    return {"task": task, "snapshots": snapshots}


def feed_cursor(query, name):
    raw = query.get(name, ["0"])[0]
    require(re.fullmatch(r"[0-9]{1,15}", raw), "同步游标无效。")
    return int(raw)


def attendance_record(row, leader_reference_key=None):
    result = row["result"]
    details = {"reason": row["reason"]} if result == "away" else {"campus": row["campus"], "accuracy": row["accuracy"]}
    if result == "present" and row["location"]:
        details["location"] = row["location"]
    task, group, student = row["task_id"], row["class_name"], row["student_id"]
    if leader_reference_key is not None:
        student = roster_reference(leader_reference_key, task, group, student)
    return {"id": "online-" + result + "-" + str(row["sequence"]), "taskId": task,
            "studentId": student, "group": group, "name": row["student_name"],
            "revision": row["revision"], "submittedAt": row["submitted_at"], "result": result, **details}


def attendance_feed(db, account, since, task_since, reference_key, away_only=False):
    sql = """SELECT * FROM attendance_submissions WHERE (sequence>? OR task_id IN
             (SELECT id FROM published_tasks WHERE sync_version>?))"""
    args = (since, task_since)
    if away_only:
        sql += " AND result='away'"
    if account["role"] != "admin":
        sql += " AND class_name=?"
        args += (account["class_name"],)
    if account["role"] == "student":
        sql += " AND student_id=?"
        args += (account["student_id"],)
    rows = db.execute(sql + " ORDER BY sequence", args).fetchall()
    leader_key = reference_key if account["role"] == "leader" else None
    return {"cursor": max(since, rows[-1]["sequence"]) if rows else since,
            "items": [attendance_record(row, leader_key) for row in rows]}


def feed(db, account, query, reference_key):
    params = parse_qs(query)
    since = feed_cursor(params, "since")
    db.execute("BEGIN")
    cursor = db.execute("SELECT COALESCE(MAX(sync_version),0) FROM published_tasks").fetchone()[0]
    sql = "SELECT t.* FROM published_tasks t"
    args = ()
    if account["role"] != "admin":
        sql += " JOIN published_task_groups g ON g.task_id=t.id AND g.class_name=?"
        args = (account["class_name"],)
    rows = db.execute(sql + " WHERE t.sync_version>? ORDER BY t.sync_version", args + (since,)).fetchall()
    items = [read_item(db, row, account, reference_key) for row in rows]
    result = {"cursor": max(cursor, since), "items": items}
    if "attendanceSince" in params:
        result["attendance"] = attendance_feed(db, account, feed_cursor(params, "attendanceSince"), since, reference_key)
    elif "awaySince" in params:
        result["away"] = attendance_feed(db, account, feed_cursor(params, "awaySince"), since, reference_key, away_only=True)
    return result


def ring_distance(ring, longitude, latitude):
    meters_per_degree = 6371008.8 * math.pi / 180
    scale_x = meters_per_degree * math.cos(math.radians(latitude))
    points = [((lon - longitude) * scale_x, (lat - latitude) * meters_per_degree) for lon, lat in ring]
    if len(points) == 1:
        return False, math.hypot(*points[0])
    inside, minimum = False, float("inf")
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        fraction = max(0, min(1, -(ax * dx + ay * dy) / length)) if length else 0
        minimum = min(minimum, math.hypot(ax + fraction * dx, ay + fraction * dy))
        if (ay > 0) != (by > 0) and ax - dx * ay / dy > 0:
            inside = not inside
    return inside, minimum


def campus_for(fences, longitude, latitude, accuracy):
    # Use the same signed boundary distance as the browser, including polygon holes.
    for fence in fences:
        if accuracy > fence["maxAccuracy"]:
            continue
        geometry = fence["geometry"]
        coordinates = geometry["coordinates"]
        for polygon in [coordinates] if geometry["type"] == "Polygon" else coordinates:
            shell, *holes = [ring_distance(ring, longitude, latitude) for ring in polygon]
            inside = shell[0] and not any(hole[0] for hole in holes)
            distance = min(item[1] for item in [shell] + holes)
            if (distance if inside else -distance) + fence["buffer"] >= accuracy:
                return fence["name"]
    return None


def location_for(campus, longitude, latitude):
    candidates = []
    for name, kind, path in CAMPUS_PLACES[campus].values():
        inside, distance = ring_distance(path, longitude, latitude)
        if kind == "area" and inside:
            distance = 0
        if distance <= (35 if kind == "road" else 50):
            candidates.append((distance, kind == "road", name))
    if candidates:
        return campus + " · " + min(candidates)[2] + "附近"
    return campus + " · 校区地址 " + CAMPUS_ADDRESSES[campus]


def submission_details(task, raw):
    if raw.get("result") == "away":
        reason = text(raw.get("reason"), 500, "请填写离校原因，最多 500 字。")
        require(not any(0xD800 <= ord(char) <= 0xDFFF for char in reason)
                and len(reason.encode("utf-16-le")) <= 1000, "请填写有效的离校原因，最多 500 字。")
        return "away", reason, None, None, None
    require(raw.get("result") == "present", "填报类型无效。")
    longitude, latitude, accuracy = (raw.get(key) for key in ("longitude", "latitude", "accuracy"))
    require(number(longitude, -180, 180) and number(latitude, -90, 90)
            and number(accuracy, 0, 1000) and accuracy > 0, "定位信息无效，请重新定位。")
    campus = campus_for(task["fences"], longitude, latitude, accuracy)
    require(campus, "定位范围或精度未通过校验，请重新定位。")
    return "present", None, campus, accuracy, location_for(campus, longitude, latitude)


def submit_attendance(db, account, identifier, raw, clock):
    group, student_id = account["class_name"], account["student_id"]
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("""SELECT t.payload,g.students FROM published_tasks t
                         JOIN published_task_groups g ON g.task_id=t.id
                         WHERE t.id=? AND g.class_name=?""", (identifier, group)).fetchone()
        require(row, "这项线上任务不适用于你的班级。", 404)
        student = next((item for item in json.loads(row["students"]) if item["id"] == student_id), None)
        require(student, "你的学号不在该任务的应报名单内。", 403)
        existing = db.execute("SELECT * FROM attendance_submissions WHERE task_id=? AND student_id=?",
                              (identifier, student_id)).fetchone()
        if existing:
            return attendance_record(existing)
        task = json.loads(row["payload"])
        now = clock()
        require(task["mode"] == "published" and task["opens"] <= now < task["due"],
                "该任务当前不接受报备，请刷新任务列表。", 409)
        details = submission_details(task, raw)
        result = db.execute("""INSERT INTO attendance_submissions
                            (task_id,student_id,class_name,student_name,revision,submitted_at,result,reason,campus,accuracy,location)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (identifier, student_id, group, student["name"],
                                                              task["revision"], now, *details))
        return attendance_record(db.execute("SELECT * FROM attendance_submissions WHERE sequence=?", (result.lastrowid,)).fetchone())


def next_version(db):
    return db.execute("SELECT COALESCE(MAX(sync_version),0)+1 FROM published_tasks").fetchone()[0]


def publish(db, admin, raw, now, reference_key):
    task = clean_new_task(raw)
    payload = dump(task)
    with db:
        db.execute("BEGIN IMMEDIATE")
        current = db.execute("SELECT * FROM published_tasks WHERE id=?", (task["id"],)).fetchone()
        if current:
            require(current["original"] == payload, "该任务编号已使用，请刷新任务列表。", 409)
            return read_item(db, current, admin, reference_key)
        require(task["due"] > now, "任务截止时间已到。")
        snapshots = []
        for group in task["groups"]:
            students = [{"id": row["student_id"], "name": row["display_name"], "group": group}
                        for row in db.execute("""SELECT student_id,display_name FROM accounts
                        WHERE role='student' AND class_name=? ORDER BY student_id""", (group,))]
            require(students, "班级「" + group + "」没有可发布任务的学生。")
            snapshots.append((task["id"], group, dump(students)))
        db.execute("INSERT INTO published_tasks VALUES (?,?,?,?)", (task["id"], payload, payload, next_version(db)))
        db.executemany("INSERT INTO published_task_groups VALUES (?,?,?)", snapshots)
        row = db.execute("SELECT * FROM published_tasks WHERE id=?", (task["id"],)).fetchone()
        return read_item(db, row, admin, reference_key)


def update(db, admin, identifier, action, raw, now, reference_key):
    revision = raw.get("revision")
    require(type(revision) is int and revision > 0, "任务版本无效。")
    due = timestamp(raw.get("due")) if action == "extend" else None
    with db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM published_tasks WHERE id=?", (identifier,)).fetchone()
        require(row, "找不到这项线上任务。", 404)
        task = json.loads(row["payload"])
        if (action == "revoke" and task["mode"] == "revoked") or (action == "extend" and task["due"] == due and task["mode"] == "published"):
            return read_item(db, row, admin, reference_key)
        require(task["revision"] == revision and task["mode"] == "published", "任务已更新，请刷新后重试。", 409)
        if action == "extend":
            require(due > task["due"] and due > now, "新的截止时间必须晚于原截止时间和当前时间。")
            task["due"] = due
        else:
            task["mode"] = "revoked"
        task["revision"] += 1
        db.execute("UPDATE published_tasks SET payload=?,sync_version=? WHERE id=?",
                   (dump(task), next_version(db), identifier))
        row = db.execute("SELECT * FROM published_tasks WHERE id=?", (identifier,)).fetchone()
        return read_item(db, row, admin, reference_key)
