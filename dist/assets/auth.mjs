import {need, validatePerson} from "./model.mjs?v=10";

const roles = ["student", "leader", "admin"];
const sessionKey = "upc-attendance-online-session-v1";
const logoutKey = "upc-attendance-online-logout:";
const local = ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = local ? new URL("/api", location.href).href : "https://47.104.168.245/attendance-api";
const reminderId = /^[a-zA-Z0-9_-]{1,80}$/;

function sessionInfo() {
  try {
    const session = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
    if (!session || Date.now() >= session.expires) return null;
    try {
      if (localStorage.getItem(logoutKey + session.marker)) return null;
    } catch {
      // The session can still be used in the current tab.
    }
    return session;
  } catch {
    return null;
  }
}

async function fetchAPI(path, {method = "GET", body, token, keepalive = false} = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let response;
    try {
      response = await fetch(apiBase + path, {method, headers, body: JSON.stringify(body),
        credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal, keepalive});
    } catch {
      throw new Error("暂时无法连接账号服务，请检查网络后重试。");
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "服务暂时不可用，请稍后重试。");
      error.status = response.status;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function verifiedProfile(profile) {
  need(profile && roles.includes(profile.role) && /^[a-f0-9]{32}$/.test(profile.accountId), "账户资料校验失败。");
  if (profile.role === "admin") {
    need(Array.isArray(profile.roster) && Array.isArray(profile.staff)
      && typeof profile.directoryVersion === "string", "管理账户缺少名单。");
    profile.roster = profile.roster.map(validatePerson);
    profile.staff = profile.staff.map(validatePerson);
  } else profile.person = validatePerson(profile.person);
  return profile;
}

export async function authenticate(username, password, sharedDevice = false) {
  need(username.trim() && password, "请输入用户名和密码。");
  const data = await fetchAPI("/login", {method: "POST", body: {username, password}});
  const profile = verifiedProfile(data.profile);
  need(/^[a-f0-9]{64}$/.test(data.token) && data.expires > Date.now(), "无法建立登录会话。");
  sessionStorage.setItem(sessionKey, JSON.stringify({
    token: data.token, expires: data.expires, marker: crypto.randomUUID(), sharedDevice,
  }));
  return profile;
}

export function hasSession(token) {
  return sessionInfo()?.marker === token;
}

export async function signedIn() {
  const session = sessionInfo();
  if (!session) return null;
  try {
    const {profile} = await fetchAPI("/session", {token: session.token});
    const verified = verifiedProfile(profile);
    return {profile: verified, marker: verified.directoryVersion, token: session.marker, sharedDevice: session.sharedDevice === true};
  } catch (error) {
    if (error.status !== 401) throw error;
    sessionStorage.removeItem(sessionKey);
    return null;
  }
}

export async function request(path, options) {
  const session = need(sessionInfo(), "请先登录。");
  return fetchAPI(path, {...options, token: session.token});
}

export function signOut() {
  const session = sessionInfo();
  sessionStorage.removeItem(sessionKey);
  if (!session) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(logoutKey) && Number(localStorage.getItem(key)) <= Date.now()) localStorage.removeItem(key);
    }
    localStorage.setItem(logoutKey + session.marker, String(session.expires));
  } catch {
    // The current tab has already signed out.
  }
  void fetchAPI("/logout", {method: "POST", token: session.token, keepalive: true}).catch(() => {});
}

export function onOtherSignOut(token, fn) {
  window.addEventListener("storage", event => {
    if (event.key === logoutKey + token && event.newValue) fn();
  });
}

export function loginURL(role = "", hash = "") {
  const url = new URL("./login.html", location.href);
  if (role === "student") {
    const task = new URLSearchParams(hash.slice(1)).get("task") ?? "";
    if (reminderId.test(task)) url.searchParams.set("task", task);
  }
  return url.href;
}

export function roleURL(role, task = "") {
  need(roles.includes(role), "无法识别账户角色。");
  const url = new URL("./" + role + ".html", location.href);
  if (role === "student" && reminderId.test(task ?? "")) url.hash = new URLSearchParams({task}).toString();
  return url.href;
}
