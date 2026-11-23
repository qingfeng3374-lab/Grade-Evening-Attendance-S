"""Attendance API served over an HTTPS reverse proxy."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
from ipaddress import ip_address
import json
import mimetypes
from pathlib import Path
import re
import secrets
import sqlite3
from socketserver import ThreadingMixIn
from threading import BoundedSemaphore
import time
import unicodedata
from urllib.parse import urlsplit
import task_service

ID = re.compile(r"[a-zA-Z0-9_-]{1,80}")
TOKEN = re.compile(r"[0-9a-f]{64}")
WINDOW = 600

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL,
 student_id TEXT, class_name TEXT, salt BLOB NOT NULL, verifier BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS account_username ON accounts(username);
CREATE TABLE IF NOT EXISTS configuration (name TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(key, window));
CREATE INDEX IF NOT EXISTS attempt_expiry ON attempts(window);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, task_title TEXT NOT NULL, account_id TEXT NOT NULL,
 class_name TEXT NOT NULL, sender TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL,
 received_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS inbox_order ON messages(received_at DESC, id DESC);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalized(value):
    return unicodedata.normalize("NFKC", value).strip().lower()


def verifier(pepper, password, salt):
    secret = hmac.new(pepper, password.encode(), hashlib.sha256).digest()
    return hashlib.scrypt(secret, salt=salt, n=16384, r=8, p=1, dklen=32)


def connect(path):
    db = sqlite3.connect(str(path), timeout=8)
    db.row_factory = sqlite3.Row
    return db


def initialize(path):
    with closing(connect(path)) as db:
        db.executescript(SCHEMA)
        task_service.initialize(db)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def person(row):
    return {"id": row["student_id"], "name": row["display_name"], "group": row["class_name"]}


def identity(db, account):
    role = account["role"]
    profile = {"accountId": account["id"], "role": role, "username": account["display_name"]}
    if role == "admin":
        for key, kind in (("roster", "student"), ("staff", "leader")):
            profile[key] = [person(row) for row in db.execute("SELECT * FROM accounts WHERE role=? ORDER BY class_name,student_id", (kind,))]
        profile["directoryVersion"] = db.execute("SELECT value FROM configuration WHERE name='directory_version'").fetchone()[0]
    else:
        profile["person"] = person(account)
    return profile


class RequestError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def field(data, key, limit, label):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise RequestError(400, "请填写有效的" + label + "。")
    return value.strip()


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    password_workers = BoundedSemaphore(6)

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(12)
        return sock, address


class Handler(BaseHTTPRequestHandler):
    server_version = "Attendance"
    sys_version = ""

    def log_message(self, *_):
        return

    def respond(self, status, data=None):
        body = b"" if data is None else json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Vary", "Origin")
        origin = self.headers.get("Origin")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def body(self, maximum=8192):
        size = self.headers.get("Content-Length", "")
        if not size.isdecimal() or not 0 < int(size) <= maximum or self.headers.get_content_type() != "application/json":
            raise RequestError(400, "请求格式无效。")
        try:
            data = json.loads(self.rfile.read(int(size)))
        except (ValueError, UnicodeError) as error:
            raise RequestError(400, "请求格式无效。") from error
        if not isinstance(data, dict):
            raise RequestError(400, "请求格式无效。")
        return data

    def limits(self, db, username):
        window = int(time.time()) // WINDOW
        address = self.client_address[0]
        if self.server.trust_proxy_ip:
            try:
                address = str(ip_address(self.headers.get("X-Real-IP", "")))
            except ValueError:
                pass
        scopes = [("ip:" + address, 600), ("name:" + username, 40), ("pair:" + address + ":" + username, 8)]
        limited = False
        with db:
            db.execute("DELETE FROM attempts WHERE window < ?", (window - 1,))
            for scope, limit in scopes:
                key = digest(scope)
                db.execute("""INSERT INTO attempts VALUES (?, ?, 1)
                    ON CONFLICT(key, window) DO UPDATE SET count=count+1""", (key, window))
                count = db.execute("SELECT count FROM attempts WHERE key=? AND window=?", (key, window)).fetchone()[0]
                limited |= count > limit
        if limited:
            raise RequestError(429, "尝试次数过多，请稍后再试。")

    def login(self, db):
        data = self.body()
        username = normalized(field(data, "username", 80, "用户名"))
        password = data.get("password")
        if not isinstance(password, str) or not 0 < len(password) <= 128:
            raise RequestError(400, "请输入用户名和密码。")
        self.limits(db, username)
        accounts = db.execute("SELECT * FROM accounts WHERE username=?", (username,)).fetchall()
        match = None
        with self.server.password_workers:
            for account in accounts or [None]:
                guess = verifier(self.server.pepper, password, account["salt"] if account else bytes(16))
                if account and hmac.compare_digest(account["verifier"], guess):
                    match = account
        if match is None:
            raise RequestError(401, "用户名或密码不正确。")
        now = int(time.time())
        expires = now + 8 * 3600
        token = secrets.token_hex(32)
        with db:
            db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", (digest(token), match["id"], expires))
        return {"token": token, "expires": expires * 1000, "profile": identity(db, match)}

    def session(self, db):
        auth = self.headers.get("Authorization", "")
        token = auth[7:]
        if not auth.startswith("Bearer ") or not TOKEN.fullmatch(token):
            raise RequestError(401, "请先登录。")
        hashed = digest(token)
        account = db.execute("""SELECT accounts.* FROM sessions JOIN accounts ON accounts.id=sessions.account_id
            WHERE sessions.hash=? AND expires_at>?""", (hashed, int(time.time()))).fetchone()
        if account is None:
            raise RequestError(401, "登录已过期，请重新登录。")
        return account, hashed

    def send_special(self, db, account):
        data = self.body()
        message_id, task_id = data.get("id"), data.get("taskId")
        if not all(isinstance(value, str) and ID.fullmatch(value) for value in (message_id, task_id)):
            raise RequestError(400, "消息或任务编号无效。")
        values = (task_id, field(data, "taskTitle", 70, "任务名称"), account["id"], account["class_name"],
                  account["display_name"], field(data, "title", 80, "标题"), field(data, "note", 1200, "情况说明"))
        with db:
            result = db.execute("""INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(id) DO NOTHING""", (message_id, *values, now_iso()))
            if not result.rowcount:
                existing = db.execute("""SELECT task_id, task_title, account_id, class_name, sender, title, note
                    FROM messages WHERE id=?""", (message_id,)).fetchone()
                if tuple(existing) != values:
                    raise RequestError(409, "消息编号已存在。")
        return {"id": message_id}

    def api(self, path, method, query):
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.origins:
            raise RequestError(403, "访问来源未获授权。")
        if method == "OPTIONS":
            return 204, None
        if path == "/health" and method == "GET":
            return 200, {"status": "ok"}
        with closing(connect(self.server.database)) as db:
            if path == "/login" and method == "POST":
                return 200, self.login(db)
            account, hashed = self.session(db)
            if path == "/session" and method == "GET":
                return 200, {"profile": identity(db, account)}
            if path == "/logout" and method == "POST":
                with db:
                    db.execute("DELETE FROM sessions WHERE hash=?", (hashed,))
                return 204, None
            if path == "/tasks" and method == "GET":
                return 200, task_service.feed(db, account, query, self.server.reference_key)
            if path == "/tasks" and method == "POST":
                if account["role"] != "admin":
                    raise RequestError(403, "仅管理员可发布点名任务。")
                return 201, task_service.publish(db, account, self.body(1_000_000), now_iso(), self.server.reference_key)
            task_action = re.fullmatch(r"/tasks/([a-zA-Z0-9_-]{1,80})/(extend|revoke)", path)
            if task_action and method == "POST":
                if account["role"] != "admin":
                    raise RequestError(403, "仅管理员可更改点名任务。")
                return 200, task_service.update(db, account, task_action.group(1), task_action.group(2), self.body(),
                                                now_iso(), self.server.reference_key)
            submission = re.fullmatch(r"/tasks/([a-zA-Z0-9_-]{1,80})/(attendance|away)", path)
            if submission and method == "POST":
                if account["role"] != "student":
                    raise RequestError(403, "仅学生可提交本人填报。")
                data = self.body()
                if submission.group(2) == "away":
                    data["result"] = "away"
                return 200, {"record": task_service.submit_attendance(db, account, submission.group(1), data, now_iso)}
            if path == "/special" and method == "POST":
                if account["role"] != "leader":
                    raise RequestError(403, "仅班级负责人可报送特殊情况。")
                return 201, self.send_special(db, account)
            if account["role"] != "admin":
                raise RequestError(403, "仅管理员可访问特殊情况邮箱。")
            if path == "/special" and method == "GET":
                messages = db.execute("""SELECT id, task_id AS taskId, task_title AS taskTitle, class_name AS "group",
                    sender, title, note, received_at AS receivedAt, read_at AS readAt FROM messages
                    ORDER BY received_at DESC, id DESC""").fetchall()
                return 200, {"messages": [dict(row) for row in messages]}
            mark = re.fullmatch(r"/special/([a-zA-Z0-9_-]{1,80})/read", path)
            if mark and method == "POST":
                message_id = mark.group(1)
                with db:
                    db.execute("UPDATE messages SET read_at=COALESCE(read_at, ?) WHERE id=?", (now_iso(), message_id))
                    row = db.execute("SELECT read_at FROM messages WHERE id=?", (message_id,)).fetchone()
                if not row:
                    raise RequestError(404, "消息不存在。")
                return 200, {"readAt": row[0]}
            raise RequestError(404, "接口不存在。")

    def static(self, path):
        root = self.server.site_dir
        if root and re.fullmatch(r"/(?:[a-z]+\.html|assets/[a-z.-]+\.(css|mjs|webp|geojson))?", path):
            file = root / (path.lstrip("/") or "index.html")
            if file.is_file():
                body = file.read_bytes()
                kind = {".mjs": "text/javascript", ".geojson": "application/geo+json"}.get(file.suffix) or mimetypes.guess_type(str(file))[0]
                self.send_response(200)
                self.send_header("Content-Type", kind + ("; charset=utf-8" if file.suffix != ".webp" else ""))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        raise RequestError(404, "页面不存在。")

    def dispatch(self, method):
        try:
            url = urlsplit(self.path)
            path = url.path
            marker = next((item for item in ("/attendance-api/", "/api/") if path.startswith(item)), None)
            if marker:
                self.respond(*self.api(path[len(marker)-1:], method, url.query))
            elif method == "GET":
                self.static(path)
            else:
                raise RequestError(404, "接口不存在。")
        except (RequestError, task_service.TaskError) as error:
            self.respond(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, sqlite3.Error):
            self.respond(503, {"error": "服务暂时不可用，请稍后重试。"})

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_OPTIONS(self):
        self.dispatch("OPTIONS")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=8791, type=int)
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--pepper-file", required=True, type=Path)
    parser.add_argument("--origin", action="append", default=[])
    parser.add_argument("--trust-proxy-ip", action="store_true",
                        help="Only use behind a trusted local proxy that always overwrites X-Real-IP.")
    parser.add_argument("--site-dir", type=Path)
    args = parser.parse_args()
    pepper = args.pepper_file.read_bytes()
    if len(pepper) != 32:
        parser.error("The pepper must contain 32 random bytes.")
    initialize(args.db)
    with Server(("127.0.0.1", args.port), Handler) as server:
        server.database = args.db
        server.pepper = pepper
        server.reference_key = hmac.digest(pepper, b"attendance-roster-key:v1", "sha256")
        server.trust_proxy_ip = args.trust_proxy_ip
        server.site_dir = args.site_dir
        server.origins = set(args.origin)
        if args.site_dir:
            server.origins.update("http://{}:{}".format(host, args.port) for host in ("localhost", "127.0.0.1"))
        server.serve_forever()


if __name__ == "__main__":
    main()
