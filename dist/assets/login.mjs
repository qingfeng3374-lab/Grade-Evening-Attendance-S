import {authenticate, roleURL, signedIn} from "./auth.mjs?v=3";

const form = document.querySelector("#login-form");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const toggle = document.querySelector("#password-toggle");
const sharedDevice = document.querySelector("#shared-device");
const errorLine = document.querySelector("#login-error");
const submit = form.querySelector('button[type="submit"]');
const task = new URLSearchParams(location.search).get("task");

function forward(profile) {
  location.replace(roleURL(profile.role, task));
}

function showError(message) {
  errorLine.textContent = message;
  errorLine.hidden = false;
}

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.textContent = show ? "隐藏" : "显示";
  toggle.setAttribute("aria-pressed", String(show));
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submit.disabled) return;
  errorLine.hidden = true;
  submit.disabled = true;
  submit.textContent = "正在登录…";
  try {
    if (!isSecureContext || !crypto.subtle) throw new Error("请在 HTTPS 或本机预览地址打开后登录。");
    const account = await authenticate(username.value, password.value, sharedDevice.checked);
    password.value = "";
    forward(account);
  } catch (error) {
    password.value = "";
    showError(error.message || "暂时无法登录，请重试。");
    submit.disabled = false;
    submit.textContent = "登录";
    password.focus();
  }
});

try {
  const current = await signedIn();
  if (current) forward(current.profile);
  else submit.disabled = false;
} catch (error) {
  showError(error.message);
  submit.disabled = false;
}
