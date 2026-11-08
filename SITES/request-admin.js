const apiBaseUrl = (window.NEON_VOID_CONFIG?.apiBaseUrl || "").replace(/\/+$/, "");
const statusElement = document.querySelector("#status");

async function getCloudSession() {
  const raw = localStorage.getItem("neonVoid.cloudSession");
  if (!raw) throw new Error("Entre primeiro em uma conta migrada no jogo.");
  const session = JSON.parse(raw);
  if (session.expiresAt <= Date.now() + 30_000) {
    if (!session.refreshToken || !apiBaseUrl) throw new Error("Entre novamente no jogo para renovar a sessão.");
    const response = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Não foi possível renovar a sessão.");
    Object.assign(session, {
      uid: payload.profile.uid,
      idToken: payload.idToken,
      refreshToken: payload.refreshToken,
      expiresAt: Date.now() + Number(payload.expiresIn) * 1000
    });
    localStorage.setItem("neonVoid.cloudSession", JSON.stringify(session));
  }
  if (!session.idToken) throw new Error("Entre novamente no jogo.");
  return session;
}

document.querySelector("#request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  statusElement.textContent = "";
  try {
    if (!apiBaseUrl) throw new Error("Configure a URL pública do Worker em js/config.js.");
    const session = await getCloudSession();
    const response = await fetch(`${apiBaseUrl}/api/adm/requests`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.idToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ reason: new FormData(event.currentTarget).get("reason") })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Não foi possível enviar a solicitação.");
    statusElement.textContent = "Solicitação enviada. Aguarde a análise da conta mestre.";
    event.currentTarget.reset();
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
