const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/datastore";
const MAX_ACCOUNT_BYTES = 600_000;
const ADMIN_SESSION_TTL_MS = 15 * 60 * 1000;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeTextBase64Url(value) {
  return encodeBase64Url(new TextEncoder().encode(value));
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemToBytes(value) {
  const body = value.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  return decodeBase64(body);
}

function firestoreValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite account value.");
    return Number.isSafeInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, firestoreValue(child)])
    ) } };
  }
  throw new Error("Unsupported account value.");
}

function fromFirestoreValue(value) {
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return Date.parse(value.timestampValue);
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in value) return fromFirestoreFields(value.mapValue.fields || {});
  return null;
}

function fromFirestoreFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

async function digestHex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function projectRoot(env) {
  return `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

function firestoreUrl(env, path = "") {
  return `https://firestore.googleapis.com/v1/${projectRoot(env)}${path}`;
}

async function googleAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error("Worker Firebase service-account secrets are not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  const unsignedToken = `${encodeTextBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encodeTextBase64Url(JSON.stringify({
    iss: env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
    scope: GOOGLE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }))}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );
  const assertion = `${unsignedToken}.${encodeBase64Url(new Uint8Array(signature))}`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const payload = await response.json();
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error("Could not obtain Firebase access token.");
  }
  return payload.access_token;
}

async function firebaseAuth(env, method, payload) {
  if (!env.FIREBASE_API_KEY) throw new Error("Firebase Web API key is not configured in the Worker.");
  const response = await fetch(`${FIREBASE_AUTH_URL}/accounts:${method}?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "Firebase Authentication request failed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

async function firebaseRequest(env, token, path, init = {}) {
  const response = await fetch(firestoreUrl(env, path), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? JSON_HEADERS : {}),
      ...init.headers
    }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || "Firestore request failed.");
    error.status = response.status;
    throw error;
  }
  return result;
}

async function getProfileDocument(env, uid, accessToken) {
  try {
    const document = await firebaseRequest(env, accessToken, `/users/${encodeURIComponent(uid)}`);
    return {
      profile: fromFirestoreFields(document.fields),
      updateTime: document.updateTime
    };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function getProfile(env, uid, accessToken) {
  const document = await getProfileDocument(env, uid, accessToken);
  return document?.profile || null;
}

function validateUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim();
  return /^[\p{L}\p{N}_-]{3,20}$/u.test(username) ? username : null;
}

function sanitizeGameState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const state = structuredClone(value);
  delete state.password;
  delete state.passwordHash;
  delete state.passwordSalt;
  delete state.refreshToken;
  delete state.idToken;
  delete state.cloudAuth;
  delete state.email;
  if (!Number.isSafeInteger(state.bestScore) || state.bestScore < 0 || state.bestScore > 1_000_000_000) {
    state.bestScore = 0;
  }
  if (!Array.isArray(state.ownedSkins)) state.ownedSkins = [];
  state.equippedBadges = Array.isArray(state.equippedBadges)
    ? [...new Set(state.equippedBadges.filter((id) => typeof id === "string" && /^[a-z0-9-]{1,60}$/i.test(id)))].slice(0, 3)
    : [];
  if (!state.badges || typeof state.badges !== "object" || Array.isArray(state.badges)) state.badges = {};
  state.badges = Object.fromEntries(Object.entries(state.badges)
    .filter(([id, earnedAt]) => /^[a-z0-9-]{1,60}$/i.test(id) &&
      Number.isSafeInteger(earnedAt) && earnedAt > 0));
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).length > MAX_ACCOUNT_BYTES) {
    throw new Error("Account data exceeds the allowed size.");
  }
  return state;
}

function publicProfile(profile) {
  return {
    uid: profile.uid,
    username: profile.username,
    adminRole: ["provisional", "permanent"].includes(profile.adminRole) ? profile.adminRole : null,
    adminApprovedAt: Number.isSafeInteger(profile.adminApprovedAt) ? profile.adminApprovedAt : null,
    bestScore: Number.isSafeInteger(profile.bestScore) ? profile.bestScore : 0,
    badges: profile.badges && typeof profile.badges === "object" ? profile.badges : {},
    equippedBadges: Array.isArray(profile.equippedBadges) ? profile.equippedBadges : [],
    region: typeof profile.region === "string" ? profile.region : "",
    createdAt: profile.createdAt
  };
}

async function writeProfile(env, profile, accessToken, create = false, options = {}) {
  const name = `${projectRoot(env)}/users/${encodeURIComponent(profile.uid)}`;
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name,
          fields: Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, firestoreValue(value)]))
        },
        ...(create ? { currentDocument: { exists: false } } :
          options.updateTime ? { currentDocument: { updateTime: options.updateTime } } : {}),
        ...(Array.isArray(options.updateMask) ? { updateMask: { fieldPaths: options.updateMask } } : {})
      }]
    })
  });
}

async function reserveUsername(env, username, uid, accessToken, state, createdAt) {
  const normalizedName = username.toLocaleLowerCase("pt-BR");
  const usernameDocumentId = await digestHex(normalizedName);
  const usernamePath = `${projectRoot(env)}/usernames/${usernameDocumentId}`;
  const userPath = `${projectRoot(env)}/users/${uid}`;
  const profile = {
    uid,
    username,
    normalizedName,
    bestScore: state.bestScore,
    badges: state.badges,
    equippedBadges: state.equippedBadges,
    leaderboardOptIn: state.leaderboardOptIn === true,
    region: typeof state.region === "string" ? state.region : "",
    state,
    createdAt,
    updatedAt: Date.now()
  };
  const response = await fetch(firestoreUrl(env, ":commit"), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, ...JSON_HEADERS },
    body: JSON.stringify({
      writes: [
        {
          update: {
            name: usernamePath,
            fields: { uid: firestoreValue(uid), username: firestoreValue(username) }
          },
          currentDocument: { exists: false }
        },
        {
          update: {
            name: userPath,
            fields: Object.fromEntries(Object.entries(profile)
              .map(([key, value]) => [key, firestoreValue(value)]))
          },
          currentDocument: { exists: false }
        }
      ]
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error?.message || "Could not reserve player name.");
    error.status = response.status === 409 || response.status === 400 ? 409 : response.status;
    throw error;
  }
  return profile;
}

async function register(request, env) {
  const body = await request.json();
  const username = validateUsername(body.username);
  if (!username || typeof body.email !== "string" || typeof body.password !== "string" ||
      body.password.length < 10 || body.password.length > 128) {
    return jsonResponse({ error: "Informe nome, e-mail e senha válidos (senha: 10 a 128 caracteres)." }, 400);
  }
  const auth = await firebaseAuth(env, "signUp", {
    email: body.email.trim(),
    password: body.password,
    returnSecureToken: true
  });
  let profile;
  try {
    const accessToken = await googleAccessToken(env);
    profile = await reserveUsername(
      env,
      username,
      auth.localId,
      accessToken,
      sanitizeGameState(body.state),
      Date.now()
    );
  } catch (error) {
    try {
      await firebaseAuth(env, "delete", { idToken: auth.idToken });
    } catch (rollbackError) {
      console.error("Firebase account rollback failed after profile creation error.");
    }
    if (error.status === 409) return jsonResponse({ error: "Esse nome de jogador já está em uso." }, 409);
    throw error;
  }
  return jsonResponse({
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    expiresIn: auth.expiresIn,
    profile: publicProfile(profile),
    state: profile.state
  }, 201);
}

async function login(request, env) {
  const body = await request.json();
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return jsonResponse({ error: "Informe e-mail e senha." }, 400);
  }
  const auth = await firebaseAuth(env, "signInWithPassword", {
    email: body.email.trim(),
    password: body.password,
    returnSecureToken: true
  });
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, auth.localId, accessToken);
  if (!profile) return jsonResponse({ error: "Perfil de jogo não encontrado; solicite a migração da conta." }, 404);
  if (profile.banned === true) return jsonResponse({ error: "Esta conta foi banida." }, 403);
  return jsonResponse({
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    expiresIn: auth.expiresIn,
    profile: publicProfile(profile),
    state: profile.state || {}
  });
}

async function refreshSession(request, env) {
  const body = await request.json();
  if (typeof body.refreshToken !== "string") return jsonResponse({ error: "Refresh token ausente." }, 400);
  const response = await fetch(`${FIREBASE_TOKEN_URL}/token?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: body.refreshToken
    })
  });
  const auth = await response.json();
  if (!response.ok) return jsonResponse({ error: "Sessão expirada; entre novamente." }, 401);
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, auth.user_id, accessToken);
  if (!profile) return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
  if (profile.banned === true) return jsonResponse({ error: "Esta conta foi banida." }, 403);
  return jsonResponse({
    idToken: auth.id_token,
    refreshToken: auth.refresh_token,
    expiresIn: auth.expires_in,
    profile: publicProfile(profile),
    state: profile.state || {}
  });
}

async function authenticate(request, env) {
  const idToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!idToken) return null;
  const result = await firebaseAuth(env, "lookup", { idToken });
  const user = result.users?.[0];
  if (!user?.localId || user.disabled) return null;
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, user.localId, accessToken);
  if (!profile || profile.banned === true) return null;
  return user.localId;
}

function adminSessionPath(env, sessionId) {
  return `${projectRoot(env)}/adminSessions/${sessionId}`;
}

async function getAdminSession(env, accessToken, sessionId) {
  try {
    const document = await firebaseRequest(env, accessToken, `/adminSessions/${sessionId}`);
    return { ...fromFirestoreFields(document.fields), updateTime: document.updateTime };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function writeAdminSession(env, accessToken, sessionId, session, updateTime = null) {
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name: adminSessionPath(env, sessionId),
          fields: Object.fromEntries(
            Object.entries(session).filter(([key]) => key !== "updateTime")
              .map(([key, value]) => [key, firestoreValue(value)])
          )
        },
        currentDocument: updateTime ? { updateTime } : { exists: false }
      }]
    })
  });
}

async function createAdminSession(env, role, uid = null) {
  const accessToken = await googleAccessToken(env);
  const token = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await digestHex(token);
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  try {
    await writeAdminSession(env, accessToken, tokenHash, {
      tokenHash,
      role,
      ...(uid ? { uid } : {}),
      expiresAt
    });
  } catch (error) {
    if (error.status === 409 || error.status === 400) {
      throw new Error("Could not create a unique admin session.");
    }
    throw error;
  }
  return jsonResponse({ token, expiresAt, role });
}

async function verifyMasterCode(request, env) {
  if (typeof env.ACCOUNT_SPECIAL_CODE !== "string" || !env.ACCOUNT_SPECIAL_CODE ||
      typeof env.MASTER_PASSWORD !== "string" || !env.MASTER_PASSWORD) {
    return jsonResponse({ error: "Painel mestre não configurado no Worker." }, 503);
  }
  const body = await request.json();
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const [submitted, expected] = await Promise.all([
    digestHex(code.toUpperCase()),
    digestHex(env.ACCOUNT_SPECIAL_CODE.toUpperCase())
  ]);
  if (submitted !== expected) return jsonResponse({ valid: false }, 401);
  return jsonResponse({ valid: true });
}

async function masterLogin(request, env) {
  if (typeof env.ACCOUNT_SPECIAL_CODE !== "string" || !env.ACCOUNT_SPECIAL_CODE ||
      typeof env.MASTER_PASSWORD !== "string" || !env.MASTER_PASSWORD) {
    return jsonResponse({ error: "Painel mestre não configurado no Worker." }, 503);
  }
  const body = await request.json();
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const [submittedCode, expectedCode, submittedPassword, expectedPassword] = await Promise.all([
    digestHex(code.toUpperCase()),
    digestHex(env.ACCOUNT_SPECIAL_CODE.toUpperCase()),
    digestHex(password),
    digestHex(env.MASTER_PASSWORD)
  ]);
  if (submittedCode !== expectedCode || submittedPassword !== expectedPassword) {
    return jsonResponse({ error: "Credenciais inválidas." }, 401);
  }
  return createAdminSession(env, "master");
}

async function adminLogin(request, env) {
  const uid = await authenticate(request, env);
  if (!uid) return jsonResponse({ error: "Autenticação necessária." }, 401);
  const accessToken = await googleAccessToken(env);
  const document = await getProfileDocument(env, uid, accessToken);
  const profile = document?.profile;
  if (!profile || !["provisional", "permanent"].includes(profile.adminRole)) {
    return jsonResponse({ error: "Esta conta não possui acesso ADM." }, 403);
  }
  let role = profile.adminRole;
  if (role === "provisional" && Number.isSafeInteger(profile.adminApprovedAt) &&
      profile.adminApprovedAt + 7 * 24 * 60 * 60 * 1000 <= Date.now()) {
    role = "permanent";
    await writeProfile(env, { ...profile, adminRole: role, updatedAt: Date.now() }, accessToken, false, {
      updateTime: document.updateTime,
      updateMask: ["adminRole", "updatedAt"]
    });
  }
  return createAdminSession(env, role, uid);
}

async function verifyAdminSession(request, env) {
  const token = request.headers.get("x-admin-session");
  if (!token) return null;
  const accessToken = await googleAccessToken(env);
  const tokenHash = await digestHex(token);
  const session = await getAdminSession(env, accessToken, tokenHash);
  if (!session || session.expiresAt <= Date.now() || session.tokenHash !== tokenHash) return null;
  if (session.role === "master") {
    return { accessToken, session: { ...session, sessionId: tokenHash } };
  }
  if (!session.uid || !["provisional", "permanent"].includes(session.role)) return null;
  const document = await getProfileDocument(env, session.uid, accessToken);
  const profile = document?.profile;
  if (!profile || profile.banned === true || !["provisional", "permanent"].includes(profile.adminRole)) return null;
  let role = profile.adminRole;
  if (role === "provisional" && Number.isSafeInteger(profile.adminApprovedAt) &&
      profile.adminApprovedAt + 7 * 24 * 60 * 60 * 1000 <= Date.now()) {
    role = "permanent";
    await writeProfile(env, { ...profile, adminRole: role, updatedAt: Date.now() }, accessToken, false, {
      updateTime: document.updateTime,
      updateMask: ["adminRole", "updatedAt"]
    });
  }
  return { accessToken, session: { ...session, role, sessionId: tokenHash } };
}

async function renewAdminSession(request, env) {
  const current = await verifyAdminSession(request, env);
  if (!current) return jsonResponse({ error: "Sessão ADM expirada. Entre novamente." }, 401);
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  const { sessionId, updateTime, ...sessionFields } = current.session;
  try {
    await writeAdminSession(env, current.accessToken, sessionId, {
      ...sessionFields,
      expiresAt
    }, updateTime);
  } catch (error) {
    if (error.status === 409 || error.status === 400) {
      return jsonResponse({ error: "A sessão ADM foi encerrada." }, 401);
    }
    throw error;
  }
  return jsonResponse({ expiresAt, role: current.session.role });
}

async function logoutAdmin(request, env) {
  const current = await verifyAdminSession(request, env);
  if (!current) return jsonResponse({ loggedOut: true });
  await firebaseRequest(env, current.accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        delete: adminSessionPath(env, current.session.sessionId),
        currentDocument: { updateTime: current.session.updateTime }
      }]
    })
  });
  return jsonResponse({ loggedOut: true });
}

async function submitAdminRequest(request, env) {
  const uid = await authenticate(request, env);
  if (!uid) return jsonResponse({ error: "Autenticação necessária." }, 401);
  const body = await request.json();
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 20 || reason.length > 500) {
    return jsonResponse({ error: "Explique sua solicitação em 20 a 500 caracteres." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, uid, accessToken);
  if (!profile || profile.adminRole) {
    return jsonResponse({ error: "Esta conta já possui ou não pode solicitar acesso ADM." }, 409);
  }
  const path = `/admRequests/${encodeURIComponent(uid)}`;
  let existing = null;
  try {
    const document = await firebaseRequest(env, accessToken, path);
    existing = fromFirestoreFields(document.fields);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (existing?.status === "pending") {
    return jsonResponse({ error: "Já existe uma solicitação aguardando análise." }, 409);
  }
  const createdAt = Date.now();
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name: `${projectRoot(env)}/admRequests/${encodeURIComponent(uid)}`,
          fields: {
            uid: firestoreValue(uid),
            username: firestoreValue(profile.username),
            reason: firestoreValue(reason),
            status: firestoreValue("pending"),
            createdAt: firestoreValue(createdAt)
          }
        },
        ...(existing ? {} : { currentDocument: { exists: false } })
      }]
    })
  });
  return jsonResponse({ status: "pending", createdAt }, 201);
}

async function listAdminRequests(env, accessToken) {
  const result = await firebaseRequest(env, accessToken, ":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "admRequests" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "status" },
            op: "EQUAL",
            value: { stringValue: "pending" }
          }
        },
        limit: 100
      }
    })
  });
  return jsonResponse({
    requests: result.filter((entry) => entry.document?.fields)
      .map((entry) => fromFirestoreFields(entry.document.fields))
      .filter((entry) => typeof entry.uid === "string" && typeof entry.username === "string")
  });
}

async function reviewAdminRequest(request, env, uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return jsonResponse({ error: "Solicitação inválida." }, 400);
  const body = await request.json();
  if (!["approve", "deny"].includes(body.action)) {
    return jsonResponse({ error: "Ação de análise inválida." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  const requestPath = `/admRequests/${encodeURIComponent(uid)}`;
  const [requestDocument, profileDocument] = await Promise.all([
    firebaseRequest(env, accessToken, requestPath),
    getProfileDocument(env, uid, accessToken)
  ]);
  const admRequest = fromFirestoreFields(requestDocument.fields);
  if (admRequest.status !== "pending" || !profileDocument) {
    return jsonResponse({ error: "A solicitação não está mais pendente." }, 409);
  }
  const reviewedAt = Date.now();
  const approved = body.action === "approve";
  const fields = {
    status: firestoreValue(approved ? "approved" : "denied"),
    reviewedAt: firestoreValue(reviewedAt)
  };
  const writes = [{
    update: { name: `${projectRoot(env)}/admRequests/${encodeURIComponent(uid)}`, fields },
    currentDocument: { updateTime: requestDocument.updateTime },
    updateMask: { fieldPaths: ["status", "reviewedAt"] }
  }];
  if (approved) {
    const profile = {
      ...profileDocument.profile,
      adminRole: "provisional",
      adminApprovedAt: reviewedAt,
      adminGiftHistory: [],
      updatedAt: reviewedAt
    };
    writes.push({
      update: {
        name: `${projectRoot(env)}/users/${encodeURIComponent(uid)}`,
        fields: Object.fromEntries(
          Object.entries(profile).map(([key, value]) => [key, firestoreValue(value)])
        )
      },
      currentDocument: { updateTime: profileDocument.updateTime }
    });
  }
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({ writes })
  });
  return jsonResponse({ status: approved ? "approved" : "denied" });
}

async function adminTarget(env, accessToken, uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return { error: jsonResponse({ error: "Jogador inválido." }, 400) };
  const document = await getProfileDocument(env, uid, accessToken);
  if (!document) return { error: jsonResponse({ error: "Jogador não encontrado." }, 404) };
  return document;
}

async function updateAdminTarget(env, accessToken, uid, updateMask, mutate) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await adminTarget(env, accessToken, uid);
    if (target.error) return target;
    const profile = mutate(target.profile);
    try {
      await writeProfile(env, profile, accessToken, false, {
        updateTime: target.updateTime,
        updateMask
      });
      return { profile };
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw new Error("Could not update player after concurrent changes.");
}

function adminPublicTarget(profile) {
  return {
    uid: profile.uid,
    username: profile.username,
    bestScore: Number.isSafeInteger(profile.bestScore) ? profile.bestScore : 0,
    banned: profile.banned === true,
    leaderboardOptIn: profile.leaderboardOptIn === true,
    adminRole: ["provisional", "permanent"].includes(profile.adminRole) ? profile.adminRole : null,
    badges: profile.badges && typeof profile.badges === "object" ? profile.badges : {},
    equippedBadges: Array.isArray(profile.equippedBadges) ? profile.equippedBadges : [],
    region: typeof profile.region === "string" ? profile.region : ""
  };
}

async function listBannedPlayers(env, accessToken) {
  const result = await firebaseRequest(env, accessToken, ":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "banned" },
            op: "EQUAL",
            value: { booleanValue: true }
          }
        },
        limit: 100
      }
    })
  });
  return jsonResponse({
    players: result.filter((entry) => entry.document?.fields)
      .map((entry) => fromFirestoreFields(entry.document.fields))
      .map(adminPublicTarget)
  });
}

async function recordAdminGiftRecipient(env, accessToken, adminUid, recipientUid) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adminDocument = await getProfileDocument(env, adminUid, accessToken);
    const profile = adminDocument?.profile;
    if (!profile || profile.adminRole !== "provisional") {
      return jsonResponse({ error: "A permissão ADM provisória foi revogada." }, 403);
    }
    const now = Date.now();
    const history = (Array.isArray(profile.adminGiftHistory) ? profile.adminGiftHistory : [])
      .filter((entry) => entry && typeof entry.uid === "string" &&
        Number.isSafeInteger(entry.createdAt) && entry.createdAt > now - 24 * 60 * 60 * 1000);
    const recipients = new Set(history.map((entry) => entry.uid));
    if (!recipients.has(recipientUid)) {
      recipients.add(recipientUid);
      history.push({ uid: recipientUid, createdAt: now });
    }
    const exceeded = recipients.size > 5;
    const updated = {
      ...profile,
      adminRole: exceeded ? null : "provisional",
      adminGiftHistory: history,
      updatedAt: now
    };
    try {
      await writeProfile(env, updated, accessToken, false, {
        updateTime: adminDocument.updateTime,
        updateMask: ["adminRole", "adminGiftHistory", "updatedAt"]
      });
      return exceeded
        ? jsonResponse({ error: "A permissão ADM provisória foi removida por exceder 5 destinatários em 24 horas." }, 401)
        : null;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw new Error("Could not update provisional administrator gift history.");
}

async function giftPlayer(request, env, admin, uid) {
  const body = await request.json();
  const type = body.type;
  const amount = body.amount;
  if (!["coins", "diamonds"].includes(type) ||
      !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
    return jsonResponse({ error: "Informe um presente válido entre 1 e 1.000.000." }, 400);
  }
  const reward = {
    id: encodeBase64Url(crypto.getRandomValues(new Uint8Array(12))),
    type,
    amount,
    source: "admin",
    createdAt: Date.now(),
    claimed: false
  };
  const existingTarget = await adminTarget(env, admin.accessToken, uid);
  if (existingTarget.error) return existingTarget.error;
  if (admin.session.role === "provisional") {
    const quotaError = await recordAdminGiftRecipient(
      env, admin.accessToken, admin.session.uid, uid
    );
    if (quotaError) return quotaError;
  }
  const result = await updateAdminTarget(env, admin.accessToken, uid, ["state.inbox.rewards", "updatedAt"], (current) => {
    const state = current.state && typeof current.state === "object" ? current.state : {};
    const inbox = state.inbox && typeof state.inbox === "object" ? state.inbox : {};
    const rewards = Array.isArray(inbox.rewards) ? inbox.rewards : [];
    return {
      ...current,
      state: { ...state, inbox: { ...inbox, rewards: [...rewards, reward].slice(-100) } },
      updatedAt: Date.now()
    };
  });
  if (result.error) return result.error;
  return jsonResponse({ profile: adminPublicTarget(result.profile), reward });
}

async function removePlayerFromLeaderboard(env, accessToken, uid) {
  const result = await updateAdminTarget(env, accessToken, uid,
    ["leaderboardOptIn", "state.leaderboardOptIn", "updatedAt"], (current) => {
      const state = current.state && typeof current.state === "object" ? current.state : {};
      return {
        ...current,
        leaderboardOptIn: false,
        state: { ...state, leaderboardOptIn: false },
        updatedAt: Date.now()
      };
    });
  if (result.error) return result.error;
  return jsonResponse({ profile: adminPublicTarget(result.profile) });
}

async function setPlayerBan(env, accessToken, uid, banned) {
  const result = await updateAdminTarget(env, accessToken, uid, ["banned", "updatedAt"], (current) => ({
    ...current,
    banned,
    updatedAt: Date.now()
  }));
  if (result.error) return result.error;
  return jsonResponse({ profile: adminPublicTarget(result.profile) });
}

async function currentUser(request, env, uid) {
  const accessToken = await googleAccessToken(env);
  const document = await getProfileDocument(env, uid, accessToken);
  if (!document || document.profile.banned === true) return null;
  return { accessToken, ...document };
}

function mergeAdminGiftRewards(currentState, nextState) {
  const currentInbox = currentState?.inbox && typeof currentState.inbox === "object"
    ? currentState.inbox
    : {};
  const nextInbox = nextState.inbox && typeof nextState.inbox === "object"
    ? nextState.inbox
    : {};
  const isProtectedGift = (reward) => ["admin", "friend-gift"].includes(reward?.source);
  const currentGifts = Array.isArray(currentInbox.rewards)
    ? currentInbox.rewards.filter(isProtectedGift)
    : [];
  const incomingRewards = Array.isArray(nextInbox.rewards) ? nextInbox.rewards : [];
  const incomingById = new Map(incomingRewards
    .filter((reward) => reward && typeof reward.id === "string")
    .map((reward) => [reward.id, reward]));
  const preservedGifts = currentGifts.map((reward) => {
    const incoming = incomingById.get(reward.id);
    return incoming?.claimed === true
      ? {
        ...reward,
        claimed: true,
        claimedAt: Number.isSafeInteger(incoming.claimedAt) ? incoming.claimedAt : Date.now()
      }
      : reward;
  });
  return {
    ...nextState,
    inbox: {
      ...nextInbox,
      rewards: [...incomingRewards.filter((reward) => !isProtectedGift(reward)), ...preservedGifts].slice(-100)
    }
  };
}

function mergeFriendGiftState(currentState, nextState) {
  const state = { ...nextState };
  const giftCount = Number.isSafeInteger(currentState?.friendPassGiftCount) &&
    currentState.friendPassGiftCount >= 0
    ? currentState.friendPassGiftCount
    : 0;
  const acknowledgedGiftCount = Number.isSafeInteger(nextState.friendPassGiftCount) &&
    nextState.friendPassGiftCount >= 0
    ? nextState.friendPassGiftCount
    : 0;
  const pendingGiftCount = Math.max(0, giftCount - acknowledgedGiftCount);
  if (pendingGiftCount) {
    const diamonds = Number.isSafeInteger(state.diamonds) && state.diamonds >= 0 ? state.diamonds : 0;
    state.diamonds = Math.max(0, diamonds - pendingGiftCount * 600);
  }
  state.friendPassGiftCount = giftCount;

  for (const [currency, counter] of [
    ["coins", "friendGiftCoinsSpent"],
    ["diamonds", "friendGiftDiamondsSpent"]
  ]) {
    const spent = Number.isSafeInteger(currentState?.[counter]) && currentState[counter] >= 0
      ? currentState[counter]
      : 0;
    const acknowledgedSpent = Number.isSafeInteger(nextState[counter]) && nextState[counter] >= 0
      ? nextState[counter]
      : 0;
    const pendingSpend = Math.max(0, spent - acknowledgedSpent);
    if (pendingSpend) {
      const balance = Number.isSafeInteger(state[currency]) && state[currency] >= 0 ? state[currency] : 0;
      state[currency] = Math.max(0, balance - pendingSpend);
    }
    state[counter] = spent;
  }
  state.friendResourceGiftCount = Number.isSafeInteger(currentState?.friendResourceGiftCount) &&
    currentState.friendResourceGiftCount >= 0
    ? currentState.friendResourceGiftCount
    : 0;

  const currentPass = currentState?.battlePass && typeof currentState.battlePass === "object"
    ? currentState.battlePass
    : {};
  const nextPass = nextState.battlePass && typeof nextState.battlePass === "object"
    ? nextState.battlePass
    : {};
  if (currentPass.premium === true) {
    state.battlePass = { ...nextPass, premium: true };
  }

  const currentMessages = Array.isArray(currentState?.inbox?.messages)
    ? currentState.inbox.messages.filter((message) => message?.source === "friend-pass-gift")
    : [];
  if (currentMessages.length) {
    const incomingMessages = Array.isArray(nextState.inbox?.messages) ? nextState.inbox.messages : [];
    const incomingById = new Map(incomingMessages
      .filter((message) => message && typeof message.id === "string")
      .map((message) => [message.id, message]));
    const preservedMessages = currentMessages.map((message) => ({
      ...message,
      read: incomingById.get(message.id)?.read === true
    }));
    const preservedIds = new Set(preservedMessages.map((message) => message.id));
    state.inbox = {
      ...(nextState.inbox && typeof nextState.inbox === "object" ? nextState.inbox : {}),
      messages: [...incomingMessages.filter((message) => !preservedIds.has(message?.id)), ...preservedMessages].slice(-100)
    };
  }
  return state;
}

async function saveCurrentUser(request, env, uid) {
  const body = await request.json();
  const accessToken = await googleAccessToken(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await getProfileDocument(env, uid, accessToken);
    if (!document || document.profile.banned === true) {
      return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
    }
    const current = document.profile;
    const state = mergeFriendGiftState(
      current.state,
      mergeAdminGiftRewards(current.state, sanitizeGameState(body.state))
    );
    const equippedBadges = Array.isArray(current.equippedBadges) ? current.equippedBadges : [];
    state.equippedBadges = equippedBadges;
    const profile = {
      ...current,
      bestScore: Math.max(current.bestScore || 0, state.bestScore),
      badges: { ...(current.badges || {}), ...state.badges },
      equippedBadges,
      leaderboardOptIn: state.leaderboardOptIn === true,
      region: typeof state.region === "string" ? state.region : "",
      state,
      updatedAt: Date.now()
    };
    try {
      await writeProfile(env, profile, accessToken, false, { updateTime: document.updateTime });
      return jsonResponse({ profile: publicProfile(profile), state });
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw new Error("Could not save player data after concurrent changes.");
}

async function saveEquippedBadges(request, env, uid) {
  const { accessToken, profile: current, updateTime } = await currentUser(request, env, uid);
  if (!current) return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
  const body = await request.json();
  if (!Array.isArray(body.equippedBadges) || body.equippedBadges.length > 3 ||
      body.equippedBadges.some((id) => typeof id !== "string" || !/^[a-z0-9-]{1,60}$/i.test(id)) ||
      new Set(body.equippedBadges).size !== body.equippedBadges.length) {
    return jsonResponse({ error: "Selecione até três emblemas válidos." }, 400);
  }
  const earnedBadges = current.badges && typeof current.badges === "object" ? current.badges : {};
  if (body.equippedBadges.some((id) =>
    !Number.isSafeInteger(earnedBadges[id]) || earnedBadges[id] <= 0)) {
    return jsonResponse({ error: "Só é possível equipar emblemas registrados na conta." }, 403);
  }
  const equippedBadges = body.equippedBadges;
  const state = {
    ...(current.state && typeof current.state === "object" ? current.state : {}),
    equippedBadges
  };
  const profile = { ...current, equippedBadges, state, updatedAt: Date.now() };
  await writeProfile(env, profile, accessToken, false, {
    updateTime,
    updateMask: ["equippedBadges", "state.equippedBadges", "updatedAt"]
  });
  return jsonResponse({ profile: publicProfile(profile), state });
}

async function deleteCurrentUser(request, env, uid) {
  const body = await request.json();
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return jsonResponse({ error: "Informe e-mail e senha para confirmar a exclusão." }, 400);
  }
  const auth = await firebaseAuth(env, "signInWithPassword", {
    email: body.email.trim(),
    password: body.password,
    returnSecureToken: true
  });
  if (auth.localId !== uid) return jsonResponse({ error: "A conta confirmada não corresponde à sessão atual." }, 403);
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, uid, accessToken);
  if (!profile) return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
  const username = profile.normalizedName || profile.username.toLocaleLowerCase("pt-BR");
  const usernameDocumentId = await digestHex(username);
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [
        { delete: `${projectRoot(env)}/usernames/${usernameDocumentId}` },
        { delete: `${projectRoot(env)}/users/${encodeURIComponent(uid)}` }
      ]
    })
  });
  await firebaseAuth(env, "delete", { idToken: auth.idToken });
  return jsonResponse({ deleted: true });
}

async function listLeaderboard(request, env) {
  const url = new URL(request.url);
  const isWeekly = url.searchParams.get("mode") === "weekly";
  const weekId = url.searchParams.get("week") || "";
  if (isWeekly && !/^\d{4}-\d{2}-\d{2}$/.test(weekId)) {
    return jsonResponse({ players: [] });
  }
  const isStateScope = url.searchParams.get("scope") === "state";
  const region = (url.searchParams.get("region") || "").trim();
  if (isStateScope && (!region || region.length > 80)) {
    return jsonResponse({ players: [] });
  }
  const filters = [
    {
      fieldFilter: {
        field: { fieldPath: "leaderboardOptIn" },
        op: "EQUAL",
        value: { booleanValue: true }
      }
    }
  ];
  if (!isWeekly) filters.push({
      fieldFilter: {
        field: { fieldPath: "bestScore" },
        op: "GREATER_THAN",
        value: { integerValue: "0" }
      }
  });
  if (isStateScope) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: "region" },
        op: "EQUAL",
        value: { stringValue: region }
      }
    });
  }
  const accessToken = await googleAccessToken(env);
  const result = await firebaseRequest(env, accessToken, ":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters
          }
        },
        ...(isWeekly ? {} : {
          orderBy: [{ field: { fieldPath: "bestScore" }, direction: "DESCENDING" }]
        }),
        limit: isWeekly ? 500 : 100
      }
    })
  });
  let players = result
    .filter((entry) => entry.document?.fields)
    .map((entry) => fromFirestoreFields(entry.document.fields));
  if (isWeekly) {
    players = players.flatMap((profile) => {
      const state = profile.state && typeof profile.state === "object" ? profile.state : {};
      const current = state.weeklyCompetition?.weekId === weekId ? state.weeklyCompetition : null;
      const historical = Array.isArray(state.weeklyHistory)
        ? state.weeklyHistory.find((week) => week?.weekId === weekId)
        : null;
      const score = Number(current?.score ?? historical?.score);
      return Number.isSafeInteger(score) && score > 0
        ? [{ ...profile, bestScore: score }]
        : [];
    }).sort((left, right) =>
      right.bestScore - left.bestScore || left.username.localeCompare(right.username)
    ).slice(0, 100);
  }
  return jsonResponse({
    players: players.filter((profile) => profile.banned !== true).map((profile) => ({
      ...publicProfile(profile),
      uid: profile.uid || profile.name?.split("/").at(-1)
    }))
  });
}

async function getPublicProfile(env, uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return jsonResponse({ error: "Perfil inválido." }, 400);
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, uid, accessToken);
  if (!profile || profile.banned === true || profile.leaderboardOptIn !== true) return jsonResponse({ error: "Jogador não encontrado." }, 404);
  return jsonResponse({ profile: publicProfile(profile) });
}

function profileArray(profile, key) {
  return Array.isArray(profile[key]) ? profile[key] : [];
}

async function findProfileByUsername(env, accessToken, username) {
  const normalizedName = username.toLocaleLowerCase("pt-BR");
  const result = await firebaseRequest(env, accessToken, ":runQuery", {
    method: "POST",
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "normalizedName" },
            op: "EQUAL",
            value: firestoreValue(normalizedName)
          }
        },
        limit: 1
      }
    })
  });
  const document = result.find((entry) => entry.document?.fields)?.document;
  return document ? {
    profile: fromFirestoreFields(document.fields),
    updateTime: document.updateTime
  } : null;
}

async function writeSocialProfiles(env, accessToken, documents) {
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: documents.map(({ profile, updateTime }) => ({
        update: {
          name: `${projectRoot(env)}/users/${encodeURIComponent(profile.uid)}`,
          fields: Object.fromEntries(
            Object.entries(profile).map(([key, value]) => [key, firestoreValue(value)])
          )
        },
        currentDocument: { updateTime }
      }))
    })
  });
}

async function mutateFriendProfiles(env, accessToken, firstUid, secondUid, mutate) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [first, second] = await Promise.all([
      getProfileDocument(env, firstUid, accessToken),
      getProfileDocument(env, secondUid, accessToken)
    ]);
    if (!first || !second || first.profile.banned === true || second.profile.banned === true) {
      return jsonResponse({ error: "Jogador não encontrado." }, 404);
    }
    const updated = mutate(first.profile, second.profile);
    if (updated instanceof Response) return updated;
    try {
      await writeSocialProfiles(env, accessToken, [
        { profile: { ...first.profile, ...updated.first }, updateTime: first.updateTime },
        { profile: { ...second.profile, ...updated.second }, updateTime: second.updateTime }
      ]);
      return null;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
  throw new Error("Could not update friends after concurrent changes.");
}

async function listFriends(env, uid) {
  const accessToken = await googleAccessToken(env);
  const current = await getProfileDocument(env, uid, accessToken);
  if (!current) return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
  const friendUids = profileArray(current.profile, "friends");
  const friends = (await Promise.all(friendUids.map((friendUid) => getProfile(env, friendUid, accessToken))))
    .filter((profile) => profile && profile.banned !== true)
    .map((profile) => ({ uid: profile.uid, username: profile.username, bestScore: profile.bestScore || 0 }));
  return jsonResponse({
    friends,
    incoming: profileArray(current.profile, "friendRequestsReceived"),
    outgoing: profileArray(current.profile, "friendRequestsSent")
  });
}

async function sendFriendRequest(request, env, uid) {
  const body = await request.json();
  if (!["id", "username"].includes(body.identifierType) || typeof body.identifier !== "string") {
    return jsonResponse({ error: "Informe um ID ou nome de conta válido." }, 400);
  }
  const identifier = body.identifier.trim();
  if (!identifier || identifier.length > 128 ||
      (body.identifierType === "username" && !validateUsername(identifier))) {
    return jsonResponse({ error: "Informe um ID ou nome de conta válido." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  const target = body.identifierType === "id"
    ? await getProfileDocument(env, identifier, accessToken)
    : await findProfileByUsername(env, accessToken, identifier);
  if (!target || target.profile.banned === true) {
    return jsonResponse({ error: "Jogador não encontrado." }, 404);
  }
  const targetUid = target.profile.uid;
  if (!targetUid || targetUid === uid) return jsonResponse({ error: "Não é possível adicionar a própria conta." }, 400);
  const requestId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const createdAt = Date.now();
  const incoming = { id: requestId, uid, username: "", createdAt };
  const outgoing = { id: requestId, uid: targetUid, username: target.profile.username, createdAt };
  const result = await mutateFriendProfiles(env, accessToken, uid, targetUid, (sender, recipient) => {
    if (profileArray(sender, "friends").includes(targetUid)) {
      return jsonResponse({ error: "Essa conta já está na sua lista de amigos." }, 409);
    }
    const sentRequests = profileArray(sender, "friendRequestsSent");
    const receivedRequests = profileArray(recipient, "friendRequestsReceived");
    if (sentRequests.some((entry) => entry.uid === targetUid) ||
        receivedRequests.some((entry) => entry.uid === uid) ||
        profileArray(recipient, "friendRequestsSent").some((entry) => entry.uid === uid)) {
      return jsonResponse({ error: "Já existe uma solicitação de amizade entre essas contas." }, 409);
    }
    incoming.username = sender.username;
    return {
      first: { friendRequestsSent: [...sentRequests, outgoing] },
      second: { friendRequestsReceived: [...receivedRequests, incoming] }
    };
  });
  if (result) return result;
  return jsonResponse({ request: outgoing }, 201);
}

async function answerFriendRequest(env, uid, requestId, accept) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
    return jsonResponse({ error: "Solicitação inválida." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  const current = await getProfileDocument(env, uid, accessToken);
  const incoming = profileArray(current?.profile || {}, "friendRequestsReceived")
    .find((entry) => entry.id === requestId);
  if (!current || !incoming?.uid) return jsonResponse({ error: "Solicitação não encontrada." }, 404);
  const senderUid = incoming.uid;
  const result = await mutateFriendProfiles(env, accessToken, uid, senderUid, (recipient, sender) => {
    const pending = profileArray(recipient, "friendRequestsReceived")
      .find((entry) => entry.id === requestId && entry.uid === senderUid);
    const sent = profileArray(sender, "friendRequestsSent")
      .find((entry) => entry.id === requestId && entry.uid === uid);
    if (!pending || !sent) return jsonResponse({ error: "A solicitação não está mais disponível." }, 409);
    const recipientFields = {
      friendRequestsReceived: profileArray(recipient, "friendRequestsReceived")
        .filter((entry) => entry.id !== requestId)
    };
    const senderFields = {
      friendRequestsSent: profileArray(sender, "friendRequestsSent")
        .filter((entry) => entry.id !== requestId)
    };
    if (accept) {
      recipientFields.friends = [...new Set([...profileArray(recipient, "friends"), senderUid])];
      senderFields.friends = [...new Set([...profileArray(sender, "friends"), uid])];
    }
    return { first: recipientFields, second: senderFields };
  });
  if (result) return result;
  return jsonResponse({ accepted: accept });
}

async function removeFriend(env, uid, friendUid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(friendUid) || friendUid === uid) {
    return jsonResponse({ error: "Amigo inválido." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  const result = await mutateFriendProfiles(env, accessToken, uid, friendUid, (current, friend) => {
    if (!profileArray(current, "friends").includes(friendUid)) {
      return jsonResponse({ error: "Essa conta não está na sua lista de amigos." }, 404);
    }
    return {
      first: { friends: profileArray(current, "friends").filter((entry) => entry !== friendUid) },
      second: { friends: profileArray(friend, "friends").filter((entry) => entry !== uid) }
    };
  });
  if (result) return result;
  return jsonResponse({ removed: true });
}

async function friendProfile(env, uid, friendUid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(friendUid)) return jsonResponse({ error: "Perfil inválido." }, 400);
  const accessToken = await googleAccessToken(env);
  const current = await getProfile(env, uid, accessToken);
  if (!profileArray(current || {}, "friends").includes(friendUid)) {
    return jsonResponse({ error: "Esse perfil está disponível apenas para amigos." }, 403);
  }
  const friend = await getProfile(env, friendUid, accessToken);
  if (!friend || friend.banned === true) return jsonResponse({ error: "Jogador não encontrado." }, 404);
  const state = friend.state && typeof friend.state === "object" ? friend.state : {};
  const battlePass = state.battlePass && typeof state.battlePass === "object" ? state.battlePass : {};
  return jsonResponse({
    profile: {
      ...publicProfile(friend),
      ownedSkins: Array.isArray(state.ownedSkins) ? state.ownedSkins : [],
      equippedSkins: state.equippedSkins && typeof state.equippedSkins === "object" ? state.equippedSkins : {},
      battlePass: {
        level: Number.isSafeInteger(battlePass.level) ? battlePass.level : 1,
        premium: battlePass.premium === true
      }
    }
  });
}

async function giftBattlePass(request, env, uid, friendUid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(friendUid) || friendUid === uid) {
    return jsonResponse({ error: "Amigo inválido." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  let giftReceipt;
  const result = await mutateFriendProfiles(env, accessToken, uid, friendUid, (sender, recipient) => {
    if (!profileArray(sender, "friends").includes(friendUid) ||
        !profileArray(recipient, "friends").includes(uid)) {
      return jsonResponse({ error: "Só é possível enviar presentes a um amigo." }, 403);
    }
    const senderState = sender.state && typeof sender.state === "object" ? sender.state : {};
    const senderDiamonds = Number.isSafeInteger(senderState.diamonds) ? senderState.diamonds : 0;
    if (senderDiamonds < 600) return jsonResponse({ error: "Você precisa de 600 diamantes para presentear o Passe." }, 409);
    const friendPassGiftCount = Number.isSafeInteger(senderState.friendPassGiftCount) &&
      senderState.friendPassGiftCount >= 0
      ? senderState.friendPassGiftCount + 1
      : 1;
    const recipientState = recipient.state && typeof recipient.state === "object" ? recipient.state : {};
    const recipientPass = recipientState.battlePass && typeof recipientState.battlePass === "object"
      ? recipientState.battlePass
      : {};
    if (recipientPass.premium === true) {
      return jsonResponse({ error: "Seu amigo já possui o Passe Neon Ouro." }, 409);
    }
    const senderInbox = senderState.inbox && typeof senderState.inbox === "object" ? senderState.inbox : {};
    const recipientInbox = recipientState.inbox && typeof recipientState.inbox === "object"
      ? recipientState.inbox
      : {};
    const now = Date.now();
    const giftMessage = {
      id: encodeBase64Url(crypto.getRandomValues(new Uint8Array(12))),
      title: { "pt-BR": "Passe Neon Ouro recebido!", en: "Neon Gold Pass received!" },
      body: {
        "pt-BR": `Você recebeu o Passe Neon Ouro de ${sender.username}.`,
        en: `You received the Neon Gold Pass from ${sender.username}.`
      },
      createdAt: now,
      read: false,
      source: "friend-pass-gift"
    };
    giftReceipt = { diamonds: senderDiamonds - 600, friendPassGiftCount };
    return {
      first: {
        state: {
          ...senderState,
          diamonds: senderDiamonds - 600,
          friendPassGiftCount,
          inbox: { ...senderInbox }
        },
        updatedAt: now
      },
      second: {
        state: {
          ...recipientState,
          battlePass: { ...recipientPass, premium: true },
          inbox: {
            ...recipientInbox,
            messages: [...(Array.isArray(recipientInbox.messages) ? recipientInbox.messages : []), giftMessage].slice(-100)
          }
        },
        updatedAt: now
      }
    };
  });
  if (result) return result;
  return jsonResponse({ gifted: true, cost: 600, ...giftReceipt });
}

async function giftFriendResource(request, env, uid, friendUid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(friendUid) || friendUid === uid) {
    return jsonResponse({ error: "Amigo inválido." }, 400);
  }
  const body = await request.json();
  if (!["coins", "diamonds"].includes(body.type) ||
      !Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 1_000_000) {
    return jsonResponse({ error: "Informe uma quantidade válida entre 1 e 1.000.000." }, 400);
  }
  const accessToken = await googleAccessToken(env);
  let giftReceipt;
  const result = await mutateFriendProfiles(env, accessToken, uid, friendUid, (sender, recipient) => {
    if (!profileArray(sender, "friends").includes(friendUid) ||
        !profileArray(recipient, "friends").includes(uid)) {
      return jsonResponse({ error: "Só é possível enviar presentes a um amigo." }, 403);
    }
    const senderState = sender.state && typeof sender.state === "object" ? sender.state : {};
    const balance = Number.isSafeInteger(senderState[body.type]) && senderState[body.type] >= 0
      ? senderState[body.type]
      : 0;
    if (balance < body.amount) {
      return jsonResponse({ error: "Saldo insuficiente para enviar esse presente." }, 409);
    }
    const giftCount = Number.isSafeInteger(senderState.friendResourceGiftCount) &&
      senderState.friendResourceGiftCount >= 0
      ? senderState.friendResourceGiftCount
      : 0;
    const spentKey = body.type === "coins" ? "friendGiftCoinsSpent" : "friendGiftDiamondsSpent";
    const spent = Number.isSafeInteger(senderState[spentKey]) && senderState[spentKey] >= 0
      ? senderState[spentKey]
      : 0;
    const spentCoins = Number.isSafeInteger(senderState.friendGiftCoinsSpent) && senderState.friendGiftCoinsSpent >= 0
      ? senderState.friendGiftCoinsSpent
      : 0;
    const spentDiamonds = Number.isSafeInteger(senderState.friendGiftDiamondsSpent) && senderState.friendGiftDiamondsSpent >= 0
      ? senderState.friendGiftDiamondsSpent
      : 0;
    if (!Number.isSafeInteger(giftCount + 1) || !Number.isSafeInteger(spent + body.amount)) {
      return jsonResponse({ error: "O limite de presentes desta conta foi atingido." }, 409);
    }
    const recipientState = recipient.state && typeof recipient.state === "object" ? recipient.state : {};
    const recipientInbox = recipientState.inbox && typeof recipientState.inbox === "object"
      ? recipientState.inbox
      : {};
    const reward = {
      id: encodeBase64Url(crypto.getRandomValues(new Uint8Array(12))),
      type: body.type,
      amount: body.amount,
      source: "friend-gift",
      senderUsername: sender.username,
      createdAt: Date.now(),
      claimed: false
    };
    const now = reward.createdAt;
    giftReceipt = {
      type: body.type,
      amount: body.amount,
      balance: balance - body.amount,
      friendResourceGiftCount: giftCount + 1,
      friendGiftCoinsSpent: body.type === "coins" ? spent + body.amount : spentCoins,
      friendGiftDiamondsSpent: body.type === "diamonds" ? spent + body.amount : spentDiamonds
    };
    return {
      first: {
        state: {
          ...senderState,
          [body.type]: balance - body.amount,
          friendResourceGiftCount: giftCount + 1,
          [spentKey]: spent + body.amount
        },
        updatedAt: now
      },
      second: {
        state: {
          ...recipientState,
          inbox: {
            ...recipientInbox,
            rewards: [...(Array.isArray(recipientInbox.rewards) ? recipientInbox.rewards : []), reward].slice(-100)
          }
        },
        updatedAt: now
      }
    };
  });
  if (result) return result;
  return jsonResponse({ gifted: true, ...giftReceipt });
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  const allowList = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!origin || !allowList.includes(origin)) return null;
  return origin;
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const corsHeaders = origin ? {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-admin-session",
      "access-control-max-age": "86400",
      vary: "origin"
    } : {};
    if (request.method === "OPTIONS") {
      return origin ? new Response(null, { status: 204, headers: corsHeaders }) : jsonResponse({ error: "Origin not allowed." }, 403);
    }
    if (request.headers.has("origin") && !origin) return jsonResponse({ error: "Origin not allowed." }, 403);
    const url = new URL(request.url);
    try {
      let response;
      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        response = await register(request, env);
      } else if (request.method === "POST" && url.pathname === "/api/auth/login") {
        response = await login(request, env);
      } else if (request.method === "POST" && url.pathname === "/api/master/verify-code") {
        response = await verifyMasterCode(request, env);
      } else if (request.method === "POST" && url.pathname === "/api/master/login") {
        response = await masterLogin(request, env);
      } else if (request.method === "POST" && url.pathname === "/api/admin/login") {
        response = await adminLogin(request, env);
      } else if (url.pathname === "/api/admin/session" && request.method === "POST") {
        response = await renewAdminSession(request, env);
      } else if (url.pathname === "/api/admin/logout" && request.method === "POST") {
        response = await logoutAdmin(request, env);
      } else if (url.pathname === "/api/adm/requests" && request.method === "POST") {
        response = await submitAdminRequest(request, env);
      } else if (url.pathname.startsWith("/api/master/")) {
        const master = await verifyAdminSession(request, env);
        if (!master || master.session.role !== "master") {
          response = jsonResponse({ error: "Sessão do painel mestre inválida ou expirada." }, 401);
        } else if (request.method === "GET" && url.pathname === "/api/master/requests") {
          response = await listAdminRequests(env, master.accessToken);
        } else {
          const match = url.pathname.match(/^\/api\/master\/requests\/([^/]+)$/);
          if (!match || request.method !== "PUT") {
            response = jsonResponse({ error: "Rota não encontrada." }, 404);
          } else {
            response = await reviewAdminRequest(request, env, decodeURIComponent(match[1]));
          }
        }
      } else if (url.pathname.startsWith("/api/admin/")) {
        const admin = await verifyAdminSession(request, env);
        if (!admin) {
          response = jsonResponse({ error: "Sessão ADM inválida ou expirada." }, 401);
        } else if (request.method === "GET" && url.pathname === "/api/admin/banned") {
          response = await listBannedPlayers(env, admin.accessToken);
        } else {
          const match = url.pathname.match(/^\/api\/admin\/players\/([^/]+)(?:\/(gift|ranking|ban))?$/);
          if (!match) {
            response = jsonResponse({ error: "Rota não encontrada." }, 404);
          } else {
            const uid = decodeURIComponent(match[1]);
            if (request.method === "GET" && !match[2]) {
              const target = await adminTarget(env, admin.accessToken, uid);
              response = target.error
                ? target.error
                : jsonResponse({ profile: adminPublicTarget(target.profile) });
            } else if (request.method === "POST" && match[2] === "gift") {
              response = await giftPlayer(request, env, admin, uid);
            } else if (request.method === "DELETE" && match[2] === "ranking") {
              response = await removePlayerFromLeaderboard(env, admin.accessToken, uid);
            } else if (request.method === "PUT" && match[2] === "ban") {
              const body = await request.json();
              if (typeof body.banned !== "boolean") {
                response = jsonResponse({ error: "Informe um estado de banimento válido." }, 400);
              } else {
                response = await setPlayerBan(env, admin.accessToken, uid, body.banned);
              }
            } else {
              response = jsonResponse({ error: "Método não permitido." }, 405);
            }
          }
        }
      } else if (url.pathname.startsWith("/api/friends")) {
        const uid = await authenticate(request, env);
        if (!uid) {
          response = jsonResponse({ error: "Autenticação necessária." }, 401);
        } else if (request.method === "GET" && url.pathname === "/api/friends") {
          response = await listFriends(env, uid);
        } else if (request.method === "POST" && url.pathname === "/api/friends/requests") {
          response = await sendFriendRequest(request, env, uid);
        } else {
          const actionMatch = url.pathname.match(/^\/api\/friends\/requests\/([^/]+)\/(accept|decline)$/);
          const friendMatch = url.pathname.match(/^\/api\/friends\/([^/]+)(?:\/(profile|gift-pass|gift))?$/);
          if (actionMatch && request.method === "POST") {
            response = await answerFriendRequest(
              env, uid, decodeURIComponent(actionMatch[1]), actionMatch[2] === "accept"
            );
          } else if (friendMatch && friendMatch[1] !== "requests" &&
              request.method === "GET" && friendMatch[2] === "profile") {
            response = await friendProfile(env, uid, decodeURIComponent(friendMatch[1]));
          } else if (friendMatch && friendMatch[1] !== "requests" &&
              request.method === "POST" && friendMatch[2] === "gift-pass") {
            response = await giftBattlePass(request, env, uid, decodeURIComponent(friendMatch[1]));
          } else if (friendMatch && friendMatch[1] !== "requests" &&
              request.method === "POST" && friendMatch[2] === "gift") {
            response = await giftFriendResource(request, env, uid, decodeURIComponent(friendMatch[1]));
          } else if (friendMatch && friendMatch[1] !== "requests" &&
              request.method === "DELETE" && !friendMatch[2]) {
            response = await removeFriend(env, uid, decodeURIComponent(friendMatch[1]));
          } else {
            response = jsonResponse({ error: "Rota não encontrada." }, 404);
          }
        }
      } else if (request.method === "POST" && url.pathname === "/api/auth/refresh") {
        response = await refreshSession(request, env);
      } else if (request.method === "GET" && url.pathname === "/api/leaderboard") {
        response = await listLeaderboard(request, env);
      } else if (request.method === "PUT" && url.pathname === "/api/me/equipped-badges") {
        const uid = await authenticate(request, env);
        response = uid
          ? await saveEquippedBadges(request, env, uid)
          : jsonResponse({ error: "Autenticação necessária." }, 401);
      } else if (url.pathname === "/api/me" && ["GET", "PUT", "DELETE"].includes(request.method)) {
        const uid = await authenticate(request, env);
        if (!uid) response = jsonResponse({ error: "Autenticação necessária." }, 401);
        else if (request.method === "GET") {
          const current = await currentUser(request, env, uid);
          response = current
            ? jsonResponse({ profile: publicProfile(current.profile), state: current.profile.state || {} })
            : jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
        } else {
          response = request.method === "DELETE"
            ? await deleteCurrentUser(request, env, uid)
            : await saveCurrentUser(request, env, uid);
        }
      } else if (request.method === "GET" && url.pathname.startsWith("/api/profiles/")) {
        response = await getPublicProfile(env, decodeURIComponent(url.pathname.slice("/api/profiles/".length)));
      } else if (request.method === "GET" && url.pathname === "/") {
        response = jsonResponse({
          status: "Neon Void API pronta.",
          endpoints: [
            "/api/auth/register", "/api/auth/login", "/api/auth/refresh",
            "/api/master/verify-code", "/api/master/login", "/api/master/requests",
            "/api/adm/requests", "/api/admin/login", "/api/admin/session", "/api/admin/logout",
            "/api/admin/banned", "/api/admin/players/:uid (GET)",
            "/api/admin/players/:uid/gift (POST)",
            "/api/admin/players/:uid/ranking (DELETE)",
            "/api/admin/players/:uid/ban (PUT)",
            "/api/friends (GET)", "/api/friends/requests (POST)",
            "/api/friends/requests/:id/accept|decline (POST)",
            "/api/friends/:uid/profile (GET)", "/api/friends/:uid/gift-pass (POST)",
            "/api/friends/:uid/gift (POST)",
            "/api/friends/:uid (DELETE)",
            "/api/leaderboard", "/api/me (GET, PUT, DELETE)",
            "/api/me/equipped-badges (PUT)", "/api/profiles/:uid"
          ]
        });
      } else {
        response = jsonResponse({ error: "Rota não encontrada." }, 404);
      }
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      console.error("Neon Void Worker request failed:", error.message);
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const message = status === 401 ? "E-mail ou senha incorretos." : "Não foi possível concluir a operação no servidor.";
      const response = jsonResponse({ error: message }, status);
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    }
  }
};
