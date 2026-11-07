import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const source = await readFile(new URL("./index.js", import.meta.url), "utf8");
const { default: worker } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("admin sessions can coexist, renew, and log out independently", async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64");
  const sessions = new Map();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "test-access-token" });
    }

    if (url.hostname !== "firestore.googleapis.com") {
      throw new Error(`Unexpected request: ${url.href}`);
    }
    if (url.pathname.endsWith("/documents:commit")) {
      const { writes } = JSON.parse(init.body);
      for (const write of writes) {
        const sessionId = write.update?.name.split("/").at(-1) || write.delete.split("/").at(-1);
        if (write.delete) {
          sessions.delete(sessionId);
        } else {
          const current = sessions.get(sessionId);
          if (write.currentDocument?.exists === false && current) {
            return Response.json({ error: { message: "Already exists." } }, { status: 409 });
          }
          if (write.currentDocument?.updateTime && write.currentDocument.updateTime !== current?.updateTime) {
            return Response.json({ error: { message: "Update time mismatch." } }, { status: 409 });
          }
          const updateTime = String((Number(current?.updateTime) || 0) + 1);
          sessions.set(sessionId, {
            fields: write.update.fields,
            updateTime
          });
        }
      }
      return Response.json({});
    }

    const sessionId = url.pathname.split("/").at(-1);
    const session = sessions.get(sessionId);
    if (!session) return Response.json({ error: { message: "Not found." } }, { status: 404 });
    return Response.json({ name: url.pathname, ...session });
  };

  const env = {
    ADM_PASSWORD: "test-password",
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT_EMAIL: "worker@test-project.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`
  };
  const send = (path, method, body, token) => worker.fetch(new Request(`https://game.test${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-admin-session": token } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);

  try {
    const firstLogin = await send("/api/admin/login", "POST", { username: "NV ADM", password: "test-password" });
    const secondLogin = await send("/api/admin/login", "POST", { username: "NV ADM", password: "test-password" });
    const first = await firstLogin.json();
    const second = await secondLogin.json();

    assert.equal(firstLogin.status, 200);
    assert.equal(secondLogin.status, 200);
    assert.notEqual(first.token, second.token);
    assert.equal(sessions.size, 2);

    assert.equal((await send("/api/admin/session", "POST", null, first.token)).status, 200);
    assert.equal((await send("/api/admin/session", "POST", null, second.token)).status, 200);
    assert.equal((await send("/api/admin/logout", "POST", null, first.token)).status, 200);
    assert.equal(sessions.size, 1);
    assert.equal((await send("/api/admin/session", "POST", null, first.token)).status, 401);
    assert.equal((await send("/api/admin/session", "POST", null, second.token)).status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("friends can accept requests, view collections, and gift the premium pass atomically", async () => {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  }, true, ["sign", "verify"]);
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)).toString("base64");
  const encodeValue = (value) => {
    if (value === null) return { nullValue: null };
    if (typeof value === "string") return { stringValue: value };
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") return { integerValue: String(value) };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
    return { mapValue: { fields: Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeValue(child)])
    ) } };
  };
  const decodeValue = (value) => {
    if ("nullValue" in value) return null;
    if ("stringValue" in value) return value.stringValue;
    if ("booleanValue" in value) return value.booleanValue;
    if ("integerValue" in value) return Number(value.integerValue);
    if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
    if ("mapValue" in value) {
      return Object.fromEntries(Object.entries(value.mapValue.fields).map(([key, child]) => [key, decodeValue(child)]));
    }
    return null;
  };
  const encodeFields = (profile) => Object.fromEntries(
    Object.entries(profile).map(([key, value]) => [key, encodeValue(value)])
  );
  const profiles = new Map([
    ["alice", {
      profile: {
        uid: "alice",
        username: "Alice",
        normalizedName: "alice",
        bestScore: 20,
        banned: false,
        friends: [],
        friendRequestsReceived: [],
        friendRequestsSent: [],
        state: { diamonds: 1200, battlePass: { level: 1, premium: false }, inbox: { messages: [], rewards: [] } }
      },
      updateTime: "1"
    }],
    ["bob", {
      profile: {
        uid: "bob",
        username: "Bob",
        normalizedName: "bob",
        bestScore: 40,
        banned: false,
        friends: [],
        friendRequestsReceived: [],
        friendRequestsSent: [],
        state: {
          diamonds: 0,
          ownedSkins: ["ship-common", "ship-special-flame"],
          battlePass: { level: 7, premium: false },
          inbox: { messages: [], rewards: [] }
        }
      },
      updateTime: "1"
    }]
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.hostname === "identitytoolkit.googleapis.com") {
      const { idToken } = JSON.parse(init.body);
      return Response.json({ users: [{ localId: idToken.split("-")[0] }] });
    }
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "test-access-token" });
    }
    if (url.hostname !== "firestore.googleapis.com") {
      throw new Error(`Unexpected request: ${url.href}`);
    }
    if (url.pathname.endsWith("/documents:runQuery")) {
      const query = JSON.parse(init.body);
      const normalizedName = query.structuredQuery.where.fieldFilter.value.stringValue;
      const match = [...profiles.values()].find(({ profile }) => profile.normalizedName === normalizedName);
      return Response.json(match
        ? [{ document: { fields: encodeFields(match.profile), updateTime: match.updateTime } }]
        : []);
    }
    if (url.pathname.endsWith("/documents:commit")) {
      const { writes } = JSON.parse(init.body);
      const updates = writes.map((write) => {
        const uid = decodeURIComponent(write.update.name.split("/").at(-1));
        const current = profiles.get(uid);
        if (!current || write.currentDocument?.updateTime !== current.updateTime) return null;
        return { uid, current, fields: write.update.fields };
      });
      if (updates.some((update) => !update)) {
        return Response.json({ error: { message: "Update time mismatch." } }, { status: 409 });
      }
      for (const { uid, current, fields } of updates) {
        profiles.set(uid, { profile: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, decodeValue(value)])
        ), updateTime: String(Number(current.updateTime) + 1) });
      }
      return Response.json({});
    }
    const uid = decodeURIComponent(url.pathname.split("/").at(-1));
    const document = profiles.get(uid);
    return document
      ? Response.json({ fields: encodeFields(document.profile), updateTime: document.updateTime })
      : Response.json({ error: { message: "Not found." } }, { status: 404 });
  };

  const env = {
    FIREBASE_API_KEY: "test-api-key",
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT_EMAIL: "worker@test-project.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`
  };
  const send = (path, method, body, uid) => worker.fetch(new Request(`https://game.test${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${uid}-token`
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env);

  try {
    const sent = await send("/api/friends/requests", "POST", {
      identifierType: "username",
      identifier: "Bob"
    }, "alice");
    assert.equal(sent.status, 201);
    const requestId = (await sent.json()).request.id;

    const pending = await send("/api/friends", "GET", null, "bob");
    assert.equal((await pending.json()).incoming[0].username, "Alice");
    assert.equal((await send(`/api/friends/requests/${requestId}/accept`, "POST", {}, "bob")).status, 200);

    const friends = await send("/api/friends", "GET", null, "alice");
    assert.equal((await friends.json()).friends[0].uid, "bob");
    const inventory = await send("/api/friends/bob/profile", "GET", null, "alice");
    assert.ok((await inventory.json()).profile.ownedSkins.includes("ship-special-flame"));

    const staleRecipientState = structuredClone(profiles.get("bob").profile.state);
    const gift = await send("/api/friends/bob/gift-pass", "POST", {}, "alice");
    assert.equal(gift.status, 200);
    const receipt = await gift.json();
    assert.equal(receipt.diamonds, 600);
    assert.equal(receipt.friendPassGiftCount, 1);
    assert.equal(profiles.get("alice").profile.state.diamonds, 600);
    assert.equal(profiles.get("bob").profile.state.battlePass.premium, true);
    assert.equal(profiles.get("bob").profile.state.inbox.messages.length, 1);

    const staleSenderSave = await send("/api/me", "PUT", {
      state: {
        diamonds: 1200,
        friendPassGiftCount: 0,
        battlePass: { level: 1, premium: false },
        inbox: { messages: [], rewards: [] }
      }
    }, "alice");
    assert.equal(staleSenderSave.status, 200);
    assert.equal((await staleSenderSave.json()).state.diamonds, 600);
    assert.equal(profiles.get("alice").profile.state.friendPassGiftCount, 1);

    const staleRecipientSave = await send("/api/me", "PUT", { state: staleRecipientState }, "bob");
    assert.equal(staleRecipientSave.status, 200);
    const savedRecipientState = (await staleRecipientSave.json()).state;
    assert.equal(savedRecipientState.battlePass.premium, true);
    assert.equal(savedRecipientState.inbox.messages.length, 1);

    assert.equal((await send("/api/friends/bob/gift-pass", "POST", {}, "alice")).status, 409);
    assert.equal(profiles.get("alice").profile.state.diamonds, 600);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
