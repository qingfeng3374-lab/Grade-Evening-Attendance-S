import {accountIssuer} from "./account-public.mjs";
import {need, validatePerson} from "./model.mjs";
import {openWorkspace} from "./storage.mjs";

const roles = ["student", "leader", "admin"];
const sessionKey = "upc-attendance-session-v1";
const logoutKey = "upc-attendance-logout-v1";
const format = "upc-attendance-account";
const encoder = new TextEncoder();
const text = new TextDecoder("utf-8", {fatal: true});
const hexId = /^[0-9a-f]{32}$/;
let directory;
let issuer;

const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const base64 = value => btoa(String.fromCharCode(...value));
const normalizeUsername = value => value.normalize("NFKC").trim().toLowerCase();

function accounts() {
  return directory ??= openWorkspace("static-account-directory", () => ({records: []}));
}

async function accountLookup(username) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalizeUsername(username)));
  return Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, "0")).join("");
}

function validEncoding(value, max) {
  return typeof value === "string" && value.length >= 4 && value.length <= max
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

async function verified(envelope) {
  need(envelope?.format === format && envelope.version === 1 && validEncoding(envelope.payload, 900000)
    && validEncoding(envelope.signature, 88), "请选择系统发放的账户文件。");
  issuer ??= crypto.subtle.importKey("jwk", accountIssuer, {name: "ECDSA", namedCurve: "P-256"}, false, ["verify"]);
  const payload = bytes(envelope.payload);
  const signature = bytes(envelope.signature);
  need(signature.length === 64 && await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"},
    await issuer, signature, payload), "账户文件未通过签发校验。");
  const body = JSON.parse(text.decode(payload));
  need(hexId.test(body.id) && /^[0-9a-f]{64}$/.test(body.lookup) && bytes(body.salt).length === 16
    && bytes(body.iv).length === 12 && validEncoding(body.ciphertext, 750000), "账户文件内容不完整。");
  return body;
}

async function derive(body, password) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name: "PBKDF2",
    salt: bytes(body.salt), iterations: 300000, hash: "SHA-256"}, material, 256));
}

async function decrypt(body, rawKey) {
  need(rawKey.length === 32, "登录会话无效。");
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytes(body.iv), additionalData: encoder.encode(body.id)},
      key, bytes(body.ciphertext));
  } catch {
    return null;
  }
  const profile = JSON.parse(text.decode(plain));
  need(profile.accountId === body.id && roles.includes(profile.role) && typeof profile.username === "string"
    && await accountLookup(profile.username) === body.lookup, "账户资料校验失败。");
  if (profile.role === "admin") {
    need(Array.isArray(profile.roster) && Array.isArray(profile.staff), "管理账户缺少名单。");
    profile.roster = profile.roster.map(validatePerson);
    profile.staff = profile.staff.map(validatePerson);
  } else profile.person = validatePerson(profile.person);
  return profile;
}

async function readEnvelope(file) {
  need(file.size > 0 && file.size <= 1000000, "请选择系统发放的账户 JSON 文件。");
  let envelope;
  try { envelope = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
  catch { throw new Error("无法读取账户文件，请重新选择。"); }
  return {format: envelope?.format, version: envelope?.version, payload: envelope?.payload, signature: envelope?.signature};
}

export async function authenticate(username, password, file) {
  need(normalizeUsername(username) && password, "请输入用户名和密码。");
  const lookup = await accountLookup(username);
  const store = await accounts();
  let candidates;
  if (file) {
    const signed = await readEnvelope(file);
    const body = await verified(signed);
    need(body.lookup === lookup, "所选账户文件与用户名不符。");
    candidates = [{id: body.id, lookup, signed}];
  } else {
    candidates = (await store.read()).records.filter(record => record.lookup === lookup);
    need(candidates.length, "首次在此浏览器登录，请选择发给你的账户文件。");
  }
  for (const item of candidates) {
    const body = await verified(item.signed);
    const key = await derive(body, password);
    const profile = await decrypt(body, key);
    if (!profile) continue;
    if (file) await store.edit(state => {
      state.records = state.records.filter(record => record.id !== body.id);
      state.records.push(item);
    });
    const session = {accountId: body.id, key: base64(key), marker: item.signed.signature,
      token: crypto.randomUUID(), expires: Date.now() + 8 * 3600000};
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    return profile;
  }
  throw new Error("用户名或密码不正确，请核对后重试。");
}

function sessionInfo() {
  try {
    const session = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
    if (!session || Date.now() >= session.expires) return null;
    try {
      if (localStorage.getItem(logoutKey) === session.token) return null;
    } catch {
      // Some embedded browsers allow session storage but block cross-tab notifications.
    }
    return session;
  } catch {
    return null;
  }
}

export function hasSession(token) {
  return sessionInfo()?.token === token;
}

export async function signedIn() {
  const session = sessionInfo();
  if (!session) return null;
  try {
    const store = await accounts();
    const item = (await store.read()).records.find(record => record.id === session.accountId
      && record.signed.signature === session.marker);
    if (!item) return null;
    const profile = await decrypt(await verified(item.signed), bytes(session.key));
    return profile ? {profile, marker: session.marker, token: session.token} : null;
  } catch {
    return null;
  }
}

export function signOut() {
  const session = sessionInfo();
  sessionStorage.removeItem(sessionKey);
  try {
    if (session?.token) localStorage.setItem(logoutKey, session.token);
  } catch {
    // The current tab has already signed out.
  }
}

export function onOtherSignOut(token, fn) {
  window.addEventListener("storage", event => {
    if (event.key === logoutKey && event.newValue === token) fn();
  });
}

const validReminderTask = /^[a-zA-Z0-9_-]{1,80}$/;

export function loginURL(role = "", hash = "") {
  const url = new URL("./login.html", location.href);
  if (role === "student") {
    const task = new URLSearchParams(hash.slice(1)).get("task") ?? "";
    if (validReminderTask.test(task)) url.searchParams.set("task", task);
  }
  return url.href;
}

export function roleURL(role, reminderTask = "") {
  need(roles.includes(role), "无法识别账户角色。");
  const url = new URL("./" + role + ".html", location.href);
  if (role === "student" && validReminderTask.test(reminderTask ?? "")) {
    url.hash = new URLSearchParams({task: reminderTask}).toString();
  }
  return url.href;
}
