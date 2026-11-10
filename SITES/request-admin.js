const apiBaseUrl = (window.NEON_VOID_CONFIG?.apiBaseUrl || "").replace(/\/+$/, "");
const statusElement = document.querySelector("#status");

async function getCloudSession() {
  let raw;
  try {
    raw = localStorage.getItem("neonVoid.cloudSession");
  } catch {
    throw new Error("O navegador bloqueou o acesso à sessão. Abra o jogo e esta página na mesma origem.");
  }
  if (!raw) throw new Error("Entre primeiro em uma conta migrada no jogo.");
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    throw new Error("A sessão da conta está inválida. Entre novamente no jogo.");
  }
  if (!session || typeof session !== "object") {
    throw new Error("A sessão da conta está inválida. Entre novamente no jogo.");
  }
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() + 30_000) {
    if (!session.refreshToken || !apiBaseUrl) throw new Error("Entre novamente no jogo para renovar a sessão.");
    const response = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Não foi possível renovar a sessão.");
    if (!payload.profile?.uid || !payload.idToken || !payload.refreshToken ||
        !Number.isFinite(Number(payload.expiresIn))) {
      throw new Error("A renovação da sessão retornou dados inválidos. Entre novamente no jogo.");
    }
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Não foi possível enviar a solicitação.");
    statusElement.textContent = "Solicitação enviada. Aguarde a análise da conta mestre.";
    event.currentTarget.reset();
  } catch (error) {
    statusElement.textContent = error instanceof TypeError
      ? "Não foi possível conectar ao Worker. Confira se a origem deste site está autorizada na configuração ALLOWED_ORIGINS."
      : error.message;
  } finally {
    button.disabled = false;
  }
});
