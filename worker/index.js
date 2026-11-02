const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const FIREBASE_AUTH_URL = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/datastore";
const MAX_ACCOUNT_BYTES = 600_000;

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

async function getProfile(env, uid, accessToken) {
  try {
    const document = await firebaseRequest(env, accessToken, `/users/${encodeURIComponent(uid)}`);
    return fromFirestoreFields(document.fields);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
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
    bestScore: Number.isSafeInteger(profile.bestScore) ? profile.bestScore : 0,
    badges: profile.badges && typeof profile.badges === "object" ? profile.badges : {},
    region: typeof profile.region === "string" ? profile.region : "",
    createdAt: profile.createdAt
  };
}

async function writeProfile(env, profile, accessToken, create = false) {
  const name = `${projectRoot(env)}/users/${encodeURIComponent(profile.uid)}`;
  await firebaseRequest(env, accessToken, ":commit", {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name,
          fields: Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, firestoreValue(value)]))
        },
        ...(create ? { currentDocument: { exists: false } } : {})
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
  return user.localId;
}

async function currentUser(request, env, uid) {
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, uid, accessToken);
  if (!profile) return null;
  return { accessToken, profile };
}

async function saveCurrentUser(request, env, uid) {
  const { profile: current } = await currentUser(request, env, uid);
  if (!current) return jsonResponse({ error: "Perfil de jogo não encontrado." }, 404);
  const body = await request.json();
  const state = sanitizeGameState(body.state);
  const profile = {
    ...current,
    bestScore: Math.max(current.bestScore || 0, state.bestScore),
    badges: { ...(current.badges || {}), ...state.badges },
    leaderboardOptIn: state.leaderboardOptIn === true,
    region: typeof state.region === "string" ? state.region : "",
    state,
    updatedAt: Date.now()
  };
  const accessToken = await googleAccessToken(env);
  await writeProfile(env, profile, accessToken);
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
    },
    {
      fieldFilter: {
        field: { fieldPath: "bestScore" },
        op: "GREATER_THAN",
        value: { integerValue: "0" }
      }
    }
  ];
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
        orderBy: [{ field: { fieldPath: "bestScore" }, direction: "DESCENDING" }],
        limit: 100
      }
    })
  });
  const players = result
    .filter((entry) => entry.document?.fields)
    .map((entry) => fromFirestoreFields(entry.document.fields));
  return jsonResponse({
    players: players.map((profile) => ({
      ...publicProfile(profile),
      uid: profile.uid || profile.name?.split("/").at(-1)
    }))
  });
}

async function getPublicProfile(env, uid) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return jsonResponse({ error: "Perfil inválido." }, 400);
  const accessToken = await googleAccessToken(env);
  const profile = await getProfile(env, uid, accessToken);
  if (!profile || profile.leaderboardOptIn !== true) return jsonResponse({ error: "Jogador não encontrado." }, 404);
  return jsonResponse({ profile: publicProfile(profile) });
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
      "access-control-allow-headers": "authorization, content-type",
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
      } else if (request.method === "POST" && url.pathname === "/api/auth/refresh") {
        response = await refreshSession(request, env);
      } else if (request.method === "GET" && url.pathname === "/api/leaderboard") {
        response = await listLeaderboard(request, env);
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
          endpoints: ["/api/auth/register", "/api/auth/login", "/api/auth/refresh", "/api/leaderboard", "/api/me (GET, PUT, DELETE)", "/api/profiles/:uid"]
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
