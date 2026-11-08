const apiBaseUrl = (window.NEON_VOID_CONFIG?.apiBaseUrl || "").replace(/\/+$/, "");
const sessionKey = "neonVoid.masterSession";
const codeKey = "neonVoid.masterCode";
const statusElement = document.querySelector("#status");
const loginForm = document.querySelector("#login-form");
const panel = document.querySelector("#panel");
const requestList = document.querySelector("#requests");
const storedCode = sessionStorage.getItem(codeKey);
if (storedCode) {
  document.querySelector("#special-code").value = storedCode;
  sessionStorage.removeItem(codeKey);
}

async function apiRequest(path, options = {}) {
  if (!apiBaseUrl) throw new Error("Configure a URL pública do Worker em js/config.js.");
  const token = sessionStorage.getItem(sessionKey);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-admin-session": token } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const payload = await response.json();
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(sessionKey);
    throw new Error(payload.error || "A solicitação falhou.");
  }
  return payload;
}

function renderRequests(requests) {
  requestList.replaceChildren();
  if (!requests.length) {
    requestList.textContent = "Nenhuma solicitação pendente.";
    return;
  }
  for (const entry of requests) {
    const card = document.createElement("article");
    card.className = "request-card";
    const title = document.createElement("h2");
    title.textContent = entry.username;
    const reason = document.createElement("p");
    reason.textContent = entry.reason;
    const created = document.createElement("small");
    created.textContent = `Solicitado em ${new Date(entry.createdAt).toLocaleString("pt-BR")}`;
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [action, label, className] of [
      ["approve", "Aprovar por 7 dias", ""],
      ["deny", "Recusar", "danger"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.className = className;
      button.addEventListener("click", () => void review(entry.uid, action, button));
      actions.append(button);
    }
    card.append(title, reason, created, actions);
    requestList.append(card);
  }
}

async function refreshRequests() {
  statusElement.textContent = "";
  try {
    const result = await apiRequest("/api/master/requests");
    renderRequests(result.requests);
  } catch (error) {
    statusElement.textContent = error.message;
    if (!sessionStorage.getItem(sessionKey)) {
      loginForm.hidden = false;
      panel.hidden = true;
    }
  }
}

async function review(uid, action, button) {
  button.disabled = true;
  try {
    await apiRequest(`/api/master/requests/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: { action }
    });
    await refreshRequests();
  } catch (error) {
    statusElement.textContent = error.message;
    button.disabled = false;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  button.disabled = true;
  statusElement.textContent = "";
  try {
    const credentials = Object.fromEntries(new FormData(loginForm));
    const result = await apiRequest("/api/master/login", { method: "POST", body: credentials });
    sessionStorage.setItem(sessionKey, result.token);
    loginForm.hidden = true;
    panel.hidden = false;
    await refreshRequests();
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#refresh-requests").addEventListener("click", () => void refreshRequests());
document.querySelector("#logout").addEventListener("click", async () => {
  try {
    await apiRequest("/api/admin/logout", { method: "POST" });
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    sessionStorage.removeItem(sessionKey);
    panel.hidden = true;
    loginForm.hidden = false;
    requestList.replaceChildren();
  }
});
