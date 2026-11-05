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
