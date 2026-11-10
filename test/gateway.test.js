// Test suite for the etsy-gateway Worker. Runs with node --test.
// Fetch is mocked and Durable Object storage is an in-memory stub.
// The fetch mock fails closed: any URL a handler does not explicitly
// answer throws, so unexpected external access fails the test.
// No network access happens here and no real credential is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import worker, { EtsyTokenStore, pkceChallenge } from "../index.js";

const GATEWAY_KEY = "test-gateway-key";
const SETUP_SECRET = "test-setup-secret";
const KEYSTRING = "test-keystring";
const SHARED_SECRET = "test-shared-secret";
const HOST = "https://etsy-gateway.lawrencemurry.workers.dev";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const API = "https://api.etsy.com/v3/application";

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : undefined;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list(options) {
    const prefix = (options && options.prefix) || "";
    const out = new Map();
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) out.set(k, v);
    }
    return out;
  }
  // Transactional storage with snapshot-and-rollback: the callback runs
  // against the live map, and a throw restores the deep-cloned snapshot,
  // mirroring the atomicity contract of Durable Object storage
  // transactions. The map object identity is preserved on rollback
  // because tests hold references to it.
  async transaction(fn) {
    const snapshot = new Map();
    for (const [k, v] of this.map) snapshot.set(k, structuredClone(v));
    const self = this;
    const txn = {
      get: (key) => self.get(key),
      put: (key, value) => self.put(key, value),
      delete: (key) => self.delete(key),
      list: (options) => self.list(options),
    };
    try {
      return await fn(txn);
    } catch (err) {
      this.map.clear();
      for (const [k, v] of snapshot) this.map.set(k, v);
      throw err;
    }
  }
}

// Wraps a storage object so every operation waits first. Used to widen
// race windows in the concurrency tests: correctness must come from the
// transactional design, not from operations happening to be fast.
function withDelays(storage, delays) {
  const wait = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms || 0));
  const wrapTxn = (txn) => ({
    get: async (key) => {
      await wait(delays.get);
      return txn.get(key);
    },
    put: async (key, value) => {
      await wait(delays.put);
      return txn.put(key, value);
    },
    delete: async (key) => {
      await wait(delays.delete);
      return txn.delete(key);
    },
    list: (options) => txn.list(options),
  });
  return {
    map: storage.map,
    get: async (key) => {
      await wait(delays.get);
      return storage.get(key);
    },
    put: async (key, value) => {
      await wait(delays.put);
      return storage.put(key, value);
    },
    delete: async (key) => {
      await wait(delays.delete);
      return storage.delete(key);
    },
    list: (options) => storage.list(options),
    transaction: (fn) =>
      storage.transaction(async (txn) => fn(wrapTxn(txn))),
  };
}

function makeStore(storage, env) {
  return new EtsyTokenStore(storage, env);
}

function makeEnv(storage, overrides) {
  const base = {
    ETSY_KEYSTRING: KEYSTRING,
    ETSY_SHARED_SECRET: SHARED_SECRET,
    GATEWAY_API_KEY: GATEWAY_KEY,
    SETUP_SECRET: SETUP_SECRET,
  };
  const env = Object.assign({}, base, overrides || {});
  const store = makeStore(storage, env);
  env.TOKEN_STORE = {
    idFromName(name) {
      return name;
    },
    get(id) {
      // Mirror the real Durable Object stub, whose fetch accepts a URL
      // string plus init as well as a Request.
      return {
        fetch: (url, init) =>
          store.fetch(url instanceof Request ? url : new Request(url, init)),
      };
    },
  };
  env.__store = store;
  return env;
}

function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const call = { url: String(url), init: init || {} };
    calls.push(call);
    const result = await handler(call.url, call.init, calls);
    if (result === undefined) {
      // Fail closed: a test handler that does not explicitly answer a
      // URL has not mocked it, and the request must not silently pass.
      throw new Error("unmocked fetch call: " + call.url);
    }
    if (result instanceof Response) return result;
    const bodyText =
      result.text !== undefined ? result.text : JSON.stringify(result.json);
    return new Response(bodyText, {
      status: result.status || 200,
      headers: Object.assign(
        { "content-type": "application/json" },
        result.headers || {}
      ),
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function gatewayRequest(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.auth !== false && !("x-gateway-key" in headers)) {
    headers["x-gateway-key"] = GATEWAY_KEY;
  }
  return new Request(HOST + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body,
  });
}

function jsonRequest(path, obj, options) {
  const opts = options || {};
  return gatewayRequest(path, {
    method: opts.method || "POST",
    headers: Object.assign(
      { "content-type": "application/json" },
      opts.headers || {}
    ),
    body: typeof obj === "string" ? obj : JSON.stringify(obj),
    auth: opts.auth,
  });
}

async function seedTokens(storage, overrides) {
  const record = Object.assign(
    {
      access_token: "999999999.fresh-token",
      refresh_token: "refresh-1",
      expires_at: Date.now() + 3600 * 1000,
      user_id: "999999999",
      shop_id: 555,
      scope: "listings_r listings_w shops_r shops_w transactions_r",
      // Token records now carry an explicit granted-scope status
      // (Correction 3). A seeded record represents a verified grant.
      scope_status: "verified",
      scopes_confirmed_at: null,
    },
    overrides || {}
  );
  await storage.put("tokens:current", record);
  return record;
}

async function seedState(storage, state, verifier, expiresAt) {
  await storage.put("oauth_state:" + state, {
    verifier: verifier || "verifier-abc",
    expires_at: expiresAt || Date.now() + 60000,
  });
}

const VALID_DRAFT = {
  quantity: 1,
  title: "Printable Planner",
  description: "A planner PDF.",
  price: 9.99,
  who_made: "i_did",
  when_made: "made_to_order",
  taxonomy_id: 123,
  type: "download",
};

test("PKCE challenge matches the RFC 7636 test vector", async () => {
  const challenge = await pkceChallenge(
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
  );
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("source scan: no console logging and only the reduced scope string", async () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.ok(!source.includes("console."), "no console calls anywhere");
  assert.ok(!source.includes("env.TOKENS"), "no KV binding remains");
  const scopeMatch = source.match(/const SCOPES = "([^"]+)"/);
  assert.ok(scopeMatch, "SCOPES constant present");
  assert.equal(
    scopeMatch[1],
    "listings_r listings_w shops_r shops_w transactions_r",
    "least-privilege scope string, nothing broader"
  );
  assert.ok(
    !source.includes('method === "DELETE"'),
    "no DELETE handling remains in the Worker"
  );
  assert.ok(
    source.includes(".transaction("),
    "Durable Object operations run through transactional storage"
  );
  const helper = readFileSync(
    new URL(
      "../../custom-connectors/custom.etsy/bin/etsy_api.py",
      import.meta.url
    ),
    "utf8"
  );
  assert.ok(
    !helper.includes("SETUP_SECRET"),
    "the setup secret is never referenced by the Muse helper"
  );
});

test("health endpoint answers without auth", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(
    gatewayRequest("/health", { auth: false }),
    makeEnv(storage)
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "etsy-gateway" });
});

function authorizePost(options) {
  const opts = options || {};
  return new Request(HOST + "/oauth/authorize", {
    method: "POST",
    headers: opts.headers || {},
    body: opts.body,
  });
}

test("GET /oauth/authorize serves the owner initiation form and creates no state", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(
    new Request(HOST + "/oauth/authorize"),
    makeEnv(storage)
  );
  assert.equal(res.status, 200);
  assert.ok(
    (res.headers.get("content-type") || "").startsWith("text/html")
  );
  const page = await res.text();
  assert.ok(page.includes("<form"), "the page carries the initiation form");
  assert.ok(page.includes("name=\"setup_secret\""));
  assert.ok(page.includes("method=\"POST\""));
  assert.ok(!/<script/i.test(page), "no script elements on the page");
  assert.ok(!/\son\w+\s*=/i.test(page), "no inline event handlers");
  assert.ok(!page.includes(SETUP_SECRET), "the page never contains the secret");
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    0,
    "serving the form creates no OAuth state"
  );
});

test("POST /oauth/authorize with the setup secret in a header redirects to Etsy with a DO-stored state", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(
    authorizePost({ headers: { "x-setup-secret": SETUP_SECRET } }),
    makeEnv(storage)
  );
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location.startsWith("https://www.etsy.com/oauth/connect?"));
  const params = new URL(location).searchParams;
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("client_id"), KEYSTRING);
  assert.equal(params.get("redirect_uri"), HOST + "/oauth/callback");
  assert.equal(
    params.get("scope"),
    "listings_r listings_w shops_r shops_w transactions_r"
  );
  assert.equal(params.get("code_challenge_method"), "S256");
  const state = params.get("state");
  assert.equal(state.length, 43, "state carries 256 bits as 43 base64url chars");
  const record = storage.map.get("oauth_state:" + state);
  assert.ok(record, "state record stored in the Durable Object storage");
  assert.ok(record.expires_at > Date.now());
  assert.ok(record.expires_at <= Date.now() + 600 * 1000 + 1000);
  assert.equal(record.verifier.length, 43);
  assert.equal(params.get("code_challenge"), await pkceChallenge(record.verifier));
});

test("POST /oauth/authorize with the setup secret in the form body redirects to Etsy", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(
    authorizePost({
      body: new URLSearchParams({ setup_secret: SETUP_SECRET }),
    }),
    makeEnv(storage)
  );
  assert.equal(res.status, 302);
  assert.ok(
    (res.headers.get("location") || "").startsWith(
      "https://www.etsy.com/oauth/connect?"
    )
  );
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    1
  );
});

test("unauthorized authorization initiation: wrong setup secret returns 403 and creates no state", async () => {
  const storage = new MemoryStorage();
  const env = makeEnv(storage);
  const byHeader = await worker.fetch(
    authorizePost({ headers: { "x-setup-secret": "wrong-secret-value" } }),
    env
  );
  assert.equal(byHeader.status, 403);
  const body = await byHeader.text();
  assert.ok(!body.includes("wrong-secret-value"), "the attempt is never echoed");
  assert.ok(!body.includes(SETUP_SECRET));
  const byForm = await worker.fetch(
    authorizePost({
      body: new URLSearchParams({ setup_secret: "also-wrong" }),
    }),
    env
  );
  assert.equal(byForm.status, 403);
  const missing = await worker.fetch(authorizePost({}), env);
  assert.equal(missing.status, 403);
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    0,
    "no state is created by any failed attempt"
  );
});

test("a setup secret in the query string is rejected, even when correct", async () => {
  const storage = new MemoryStorage();
  const env = makeEnv(storage);
  const post = await worker.fetch(
    new Request(HOST + "/oauth/authorize?setup_secret=" + SETUP_SECRET, {
      method: "POST",
    }),
    env
  );
  assert.equal(post.status, 400);
  assert.equal((await post.json()).error, "setup_secret_in_query_not_allowed");
  const get = await worker.fetch(
    new Request(HOST + "/oauth/authorize?setup_secret=" + SETUP_SECRET),
    env
  );
  assert.equal(get.status, 400);
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    0
  );
});

test("repeated failed authorization attempts are rate limited", async () => {
  const storage = new MemoryStorage();
  const env = makeEnv(storage);
  for (let i = 0; i < 5; i++) {
    const res = await worker.fetch(
      authorizePost({ headers: { "x-setup-secret": "wrong-" + i } }),
      env
    );
    assert.equal(res.status, 403, "failure " + (i + 1) + " is a plain 403");
  }
  const sixth = await worker.fetch(
    authorizePost({ headers: { "x-setup-secret": "wrong-6" } }),
    env
  );
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers.get("retry-after")) >= 1);
  const correctButLimited = await worker.fetch(
    authorizePost({ headers: { "x-setup-secret": SETUP_SECRET } }),
    env
  );
  assert.equal(
    correctButLimited.status,
    429,
    "the limiter runs before verification, so even a correct secret waits"
  );
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    0
  );
});

test("authorization initiation fails closed when no setup secret is configured", async () => {
  const storage = new MemoryStorage();
  const env = makeEnv(storage, { SETUP_SECRET: undefined });
  const res = await worker.fetch(
    authorizePost({ headers: { "x-setup-secret": SETUP_SECRET } }),
    env
  );
  assert.equal(res.status, 403);
  assert.equal(
    [...storage.map.keys()].filter((k) => k.startsWith("oauth_state:")).length,
    0
  );
});

test("callback exchanges the code with the stored verifier and stores tokens privately", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-abc");
  const mock = mockFetch(async (url, init) => {
    assert.equal(url, TOKEN_URL);
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("client_id"), KEYSTRING);
    assert.equal(form.get("code"), "the-code");
    assert.equal(form.get("code_verifier"), "verifier-abc");
    assert.equal(form.get("redirect_uri"), HOST + "/oauth/callback");
    return {
      json: {
        access_token: "123456789.access-value",
        refresh_token: "refresh-value",
        expires_in: 3600,
        scope: "listings_r listings_w",
      },
    };
  });
  try {
    const res = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=the-code&state=state-abc"),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.ok(!page.includes("123456789.access-value"));
    assert.ok(!page.includes("refresh-value"));
    const stored = storage.map.get("tokens:current");
    assert.equal(stored.access_token, "123456789.access-value");
    assert.equal(stored.refresh_token, "refresh-value");
    assert.equal(stored.user_id, "123456789");
    assert.equal(storage.map.has("oauth_state:state-abc"), false);
  } finally {
    mock.restore();
  }
});

test("callback with unknown state fails and never calls the token endpoint", async () => {
  const storage = new MemoryStorage();
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=x&state=nope"),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal(mock.calls.length, 0);
    assert.equal(storage.map.has("tokens:current"), false);
  } finally {
    mock.restore();
  }
});

test("callback with expired state is rejected and the state is consumed", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-old", "verifier-old", Date.now() - 1000);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=x&state=state-old"),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal(mock.calls.length, 0);
    assert.equal(storage.map.has("oauth_state:state-old"), false);
  } finally {
    mock.restore();
  }
});

test("replayed callback fails: the same state cannot be used twice", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-once");
  let tokenCalls = 0;
  const mock = mockFetch(async () => {
    tokenCalls += 1;
    return {
      json: {
        access_token: "123456789.access-value",
        refresh_token: "refresh-value",
        expires_in: 3600,
      },
    };
  });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=c1&state=state-once"),
      env
    );
    assert.equal(first.status, 200);
    const second = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=c1&state=state-once"),
      env
    );
    assert.equal(second.status, 400);
    assert.equal(tokenCalls, 1, "token endpoint hit only for the first callback");
  } finally {
    mock.restore();
  }
});

test("callback without a code is rejected before any token call", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-nocode");
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      new Request(HOST + "/oauth/callback?state=state-nocode"),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("callback with an Etsy error parameter is rejected", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(
    new Request(HOST + "/oauth/callback?error=access_denied&state=whatever"),
    makeEnv(storage)
  );
  assert.equal(res.status, 400);
});

test("PKCE failure at Etsy returns 502, stores nothing, and consumes the state", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-badpkce");
  const mock = mockFetch(async () => ({
    status: 400,
    json: { error: "invalid_grant" },
  }));
  try {
    const env = makeEnv(storage);
    const res = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=bad&state=state-badpkce"),
      env
    );
    assert.equal(res.status, 502);
    assert.equal(storage.map.has("tokens:current"), false);
    const again = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=bad&state=state-badpkce"),
      env
    );
    assert.equal(again.status, 400);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("api routes reject a missing or wrong gateway key with 401", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const env = makeEnv(storage);
  const missing = await worker.fetch(
    gatewayRequest("/api/shop", { auth: false }),
    env
  );
  assert.equal(missing.status, 401);
  const wrong = await worker.fetch(
    gatewayRequest("/api/shop", { headers: { "x-gateway-key": "wrong" } }),
    env
  );
  assert.equal(wrong.status, 401);
  const body = await wrong.text();
  assert.ok(!body.includes("fresh-token"), "401 body must not leak token values");
});

test("unknown api route returns 404 and wrong method returns 405", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const env = makeEnv(storage);
  const unknown = await worker.fetch(gatewayRequest("/api/nope"), env);
  assert.equal(unknown.status, 404);
  const del = await worker.fetch(
    gatewayRequest("/api/listings/123", { method: "DELETE" }),
    env
  );
  assert.equal(del.status, 405, "no DELETE route exists under the reduced scopes");
  const putListings = await worker.fetch(
    gatewayRequest("/api/listings", { method: "PUT" }),
    env
  );
  assert.equal(putListings.status, 405);
  const postHealth = await worker.fetch(
    gatewayRequest("/health", { method: "POST", auth: false }),
    env
  );
  assert.equal(postHealth.status, 405);
});

test("non-numeric listing id is rejected", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const res = await worker.fetch(
    gatewayRequest("/api/listings/abc"),
    makeEnv(storage)
  );
  assert.equal(res.status, 404);
});

test("api shop with a fresh token calls Etsy with the correct headers", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    assert.equal(url, API + "/shops/555");
    assert.equal(init.headers["x-api-key"], KEYSTRING + ":" + SHARED_SECRET);
    assert.equal(init.headers["Authorization"], "Bearer 999999999.fresh-token");
    return { json: { shop_id: 555, shop_name: "FultonPrintables" } };
  });
  try {
    const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).shop_name, "FultonPrintables");
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("shop_id is resolved through getMe and cached in the token record", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, { shop_id: null });
  const mock = mockFetch(async (url) => {
    if (url.endsWith("/users/me")) {
      return { json: { user_id: 999999999, shop_id: 777 } };
    }
    assert.equal(url, API + "/shops/777");
    return { json: { shop_id: 777, shop_name: "FultonPrintables" } };
  });
  try {
    const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
    assert.equal(res.status, 200);
    const stored = storage.map.get("tokens:current");
    assert.equal(stored.shop_id, 777);
  } finally {
    mock.restore();
  }
});

test("Durable Object storage persists across a simulated restart", async () => {
  const storage = new MemoryStorage();
  const env = makeEnv(storage);
  await seedTokens(storage);
  const restarted = new EtsyTokenStore(storage, env);
  const res = await restarted.fetch(
    new Request("https://token-store/tokens/get", {
      method: "POST",
      body: "{}",
    })
  );
  const body = await res.json();
  assert.equal(body.record.access_token, "999999999.fresh-token");
  assert.equal(body.record.refresh_token, "refresh-1");
});

test("expired token triggers exactly one refresh and stores the rotated tokens", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, {
    expires_at: Date.now() - 1000,
    refresh_token: "refresh-old",
  });
  let tokenCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === TOKEN_URL) {
      tokenCalls += 1;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "refresh-old");
      return {
        json: {
          access_token: "999999999.rotated-token",
          refresh_token: "refresh-new",
          expires_in: 3600,
        },
      };
    }
    assert.equal(init.headers["Authorization"], "Bearer 999999999.rotated-token");
    return { json: { shop_id: 555, shop_name: "FultonPrintables" } };
  });
  try {
    const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
    assert.equal(res.status, 200);
    assert.equal(tokenCalls, 1);
    const stored = storage.map.get("tokens:current");
    assert.equal(stored.access_token, "999999999.rotated-token");
    assert.equal(stored.refresh_token, "refresh-new");
  } finally {
    mock.restore();
  }
});

test("concurrent requests with an expired token trigger exactly one refresh", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, {
    expires_at: Date.now() - 1000,
    refresh_token: "refresh-old",
  });
  let tokenCalls = 0;
  const mock = mockFetch(async (url) => {
    if (url === TOKEN_URL) {
      tokenCalls += 1;
      await new Promise((r) => setTimeout(r, 25));
      return {
        json: {
          access_token: "999999999.rotated-token",
          refresh_token: "refresh-new",
          expires_in: 3600,
        },
      };
    }
    return { json: { shop_id: 555, shop_name: "FultonPrintables" } };
  });
  try {
    const env = makeEnv(storage);
    const [a, b] = await Promise.all([
      worker.fetch(gatewayRequest("/api/shop"), env),
      worker.fetch(gatewayRequest("/api/shop"), env),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(tokenCalls, 1, "two concurrent callers share one refresh");
    const stored = storage.map.get("tokens:current");
    assert.equal(stored.refresh_token, "refresh-new");
  } finally {
    mock.restore();
  }
});

test("failed refresh returns 409 not_authorized", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, { expires_at: Date.now() - 1000 });
  const mock = mockFetch(async () => ({
    status: 400,
    json: { error: "invalid_grant" },
  }));
  try {
    const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "not_authorized");
  } finally {
    mock.restore();
  }
});

test("missing tokens returns 409 not_authorized with the authorize path", async () => {
  const storage = new MemoryStorage();
  const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, "not_authorized");
  assert.equal(body.authorize_url, "/oauth/authorize");
});

test("rate limit returns 429 with retry-after after the configured limit", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: { shop_id: 555 } }));
  try {
    const env = makeEnv(storage, { RATE_LIMIT_PER_MINUTE: "3" });
    for (let i = 0; i < 3; i++) {
      const ok = await worker.fetch(gatewayRequest("/api/shop"), env);
      assert.equal(ok.status, 200);
    }
    const limited = await worker.fetch(gatewayRequest("/api/shop"), env);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await limited.json()).error, "rate_limited");
  } finally {
    mock.restore();
  }
});

test("oversized JSON body returns 413 before any Etsy call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      jsonRequest(
        "/api/shop",
        { announcement: "x".repeat(300 * 1000) },
        { method: "PUT" }
      ),
      makeEnv(storage)
    );
    assert.equal(res.status, 413);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("malformed JSON returns 400 before any Etsy call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      jsonRequest("/api/shop", "{not json", { method: "PUT" }),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "malformed_json");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("updateShop sends a form-encoded body with only allowlisted fields", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    assert.equal(url, API + "/shops/555");
    assert.equal(init.method, "PUT");
    assert.equal(
      init.headers["content-type"],
      "application/x-www-form-urlencoded"
    );
    assert.equal(init.body, "announcement=Hello+shop");
    return { json: { shop_id: 555 } };
  });
  try {
    const res = await worker.fetch(
      jsonRequest("/api/shop", { announcement: "Hello shop" }, { method: "PUT" }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("updateShop rejects a non-allowlisted field without calling Etsy", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      jsonRequest("/api/shop", { policy_welcome: "x" }, { method: "PUT" }),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "field_not_allowed:policy_welcome");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("draft creation sends form-encoded fields to Etsy and returns 201", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    assert.equal(url, API + "/shops/555/listings");
    assert.equal(
      init.headers["content-type"],
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("title"), "Printable Planner");
    assert.equal(form.get("type"), "download");
    assert.equal(form.get("taxonomy_id"), "123");
    return { status: 201, json: { listing_id: 42, state: "draft" } };
  });
  try {
    const res = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0001" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 201);
    assert.equal((await res.json()).listing_id, 42);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("draft creation without an idempotency key returns 400 and calls nothing", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "idempotency_key_required");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("draft creation with missing required fields returns 400 and calls nothing", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const res = await worker.fetch(
      jsonRequest(
        "/api/listings/draft",
        { title: "Only a title" },
        { headers: { "idempotency-key": "draft-key-0002" } }
      ),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "missing_field:quantity");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("draft creation for a physical listing without shipping fields returns 400", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const body = Object.assign({}, VALID_DRAFT, { type: "physical" });
    const res = await worker.fetch(
      jsonRequest("/api/listings/draft", body, {
        headers: { "idempotency-key": "draft-key-0003" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "missing_field:shipping_profile_id");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("idempotent draft replay returns the stored response with one Etsy call total", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let etsyCalls = 0;
  const mock = mockFetch(async () => {
    etsyCalls += 1;
    return { status: 201, json: { listing_id: 42, state: "draft" } };
  });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0004" },
      }),
      env
    );
    assert.equal(first.status, 201);
    const second = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0004" },
      }),
      env
    );
    assert.equal(second.status, 201);
    assert.equal(second.headers.get("x-idempotent-replay"), "true");
    assert.equal((await second.json()).listing_id, 42);
    assert.equal(etsyCalls, 1);
  } finally {
    mock.restore();
  }
});

test("idempotency key reused with a different body returns 409", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let etsyCalls = 0;
  const mock = mockFetch(async () => {
    etsyCalls += 1;
    return { status: 201, json: { listing_id: 42 } };
  });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0005" },
      }),
      env
    );
    assert.equal(first.status, 201);
    const changed = Object.assign({}, VALID_DRAFT, { title: "Another Title" });
    const second = await worker.fetch(
      jsonRequest("/api/listings/draft", changed, {
        headers: { "idempotency-key": "draft-key-0005" },
      }),
      env
    );
    assert.equal(second.status, 409);
    assert.equal(etsyCalls, 1);
  } finally {
    mock.restore();
  }
});

test("a failed draft creation is not stored as an idempotent success", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let etsyCalls = 0;
  const mock = mockFetch(async () => {
    etsyCalls += 1;
    if (etsyCalls === 1) return { status: 400, json: { error: "bad_listing" } };
    return { status: 201, json: { listing_id: 43 } };
  });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0006" },
      }),
      env
    );
    assert.equal(first.status, 400);
    const second = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0006" },
      }),
      env
    );
    assert.equal(second.status, 201);
    assert.equal(etsyCalls, 2, "the retry reached Etsy instead of replaying the failure");
  } finally {
    mock.restore();
  }
});

test("updateListing rejects a disallowed field and an invalid state", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const env = makeEnv(storage);
    const bad = await worker.fetch(
      jsonRequest("/api/listings/123", { bogus_field: 1 }, { method: "PATCH" }),
      env
    );
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "field_not_allowed:bogus_field");
    const badState = await worker.fetch(
      jsonRequest("/api/listings/123", { state: "removed" }, { method: "PATCH" }),
      env
    );
    assert.equal(badState.status, 400);
    assert.equal((await badState.json()).error, "invalid_field:state");
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("publishing an already active listing makes no publish call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const methods = [];
  const mock = mockFetch(async (url, init) => {
    methods.push(init.method + " " + url);
    return { json: { listing_id: 123, state: "active", title: "Live" } };
  });
  try {
    const res = await worker.fetch(
      jsonRequest("/api/listings/123", { state: "active" }, { method: "PATCH" }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.already_active, true);
    assert.equal(methods.length, 1);
    assert.ok(methods[0].startsWith("GET "), "only the pre-read happened");
  } finally {
    mock.restore();
  }
});

test("publishing a draft listing issues the PATCH with form-encoded state", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const seen = [];
  const mock = mockFetch(async (url, init) => {
    seen.push({ url, init });
    if (init.method === "GET") {
      return { json: { listing_id: 123, state: "draft" } };
    }
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("state"), "active");
    assert.equal(
      init.headers["content-type"],
      "application/x-www-form-urlencoded"
    );
    return { json: { listing_id: 123, state: "active" } };
  });
  try {
    const res = await worker.fetch(
      jsonRequest("/api/listings/123", { state: "active" }, { method: "PATCH" }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, "active");
    // Pre-read, post-lock re-read (lease correction: the state is
    // always re-read after the publish lock is acquired), then PATCH.
    assert.equal(seen.length, 3);
    assert.equal(seen[0].init.method, "GET");
    assert.equal(seen[1].init.method, "GET");
    assert.equal(seen[2].init.method, "PATCH");
  } finally {
    mock.restore();
  }
});

test("listings and receipts query parameters are validated against allowlists", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url) => {
    assert.ok(!url.includes("bogus"), "unvalidated params never reach Etsy");
    return { json: { results: [] } };
  });
  try {
    const env = makeEnv(storage);
    const badListings = await worker.fetch(
      gatewayRequest("/api/listings?bogus=1"),
      env
    );
    assert.equal(badListings.status, 400);
    const badState = await worker.fetch(
      gatewayRequest("/api/listings?state=weird"),
      env
    );
    assert.equal(badState.status, 400);
    const good = await worker.fetch(
      gatewayRequest("/api/listings?state=active&limit=25&offset=0"),
      env
    );
    assert.equal(good.status, 200);
    const badReceipts = await worker.fetch(
      gatewayRequest("/api/receipts?was_paid=yes"),
      env
    );
    assert.equal(badReceipts.status, 400);
    const goodReceipts = await worker.fetch(
      gatewayRequest("/api/receipts?was_paid=true&limit=10"),
      env
    );
    assert.equal(goodReceipts.status, 200);
  } finally {
    mock.restore();
  }
});

function multipartRequest(path, formData) {
  return new Request(HOST + path, {
    method: "POST",
    headers: { "x-gateway-key": GATEWAY_KEY },
    body: formData,
  });
}

test("digital file upload forwards a valid multipart body to the files endpoint", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    assert.equal(url, API + "/shops/555/listings/123/files");
    assert.ok(
      (init.headers["content-type"] || "").startsWith("multipart/form-data")
    );
    return { status: 201, json: { listing_file_id: 900 } };
  });
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob(["fake pdf bytes"], { type: "application/pdf" }),
      "planner.pdf"
    );
    form.append("name", "planner.pdf");
    const res = await worker.fetch(
      multipartRequest("/api/listings/123/file", form),
      makeEnv(storage)
    );
    assert.equal(res.status, 201);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("image upload forwards a valid multipart body to the images endpoint", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url) => {
    assert.equal(url, API + "/shops/555/listings/123/images");
    return { status: 201, json: { listing_image_id: 901 } };
  });
  try {
    const form = new FormData();
    form.append(
      "image",
      new Blob(["fake png bytes"], { type: "image/png" }),
      "cover.png"
    );
    const res = await worker.fetch(
      multipartRequest("/api/listings/123/image", form),
      makeEnv(storage)
    );
    assert.equal(res.status, 201);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("multipart with neither binary nor id, or with both, returns 400", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const env = makeEnv(storage);
    const neither = new FormData();
    neither.append("name", "only-a-name.pdf");
    const resNeither = await worker.fetch(
      multipartRequest("/api/listings/123/file", neither),
      env
    );
    assert.equal(resNeither.status, 400);
    const both = new FormData();
    both.append("file", new Blob(["x"]), "a.pdf");
    both.append("listing_file_id", "12345");
    const resBoth = await worker.fetch(
      multipartRequest("/api/listings/123/file", both),
      env
    );
    assert.equal(resBoth.status, 400);
    const unknownField = new FormData();
    unknownField.append("file", new Blob(["x"]), "a.pdf");
    unknownField.append("surprise", "field");
    const resUnknown = await worker.fetch(
      multipartRequest("/api/listings/123/file", unknownField),
      env
    );
    assert.equal(resUnknown.status, 400);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("malformed multipart returns 400", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const req = new Request(HOST + "/api/listings/123/file", {
      method: "POST",
      headers: {
        "x-gateway-key": GATEWAY_KEY,
        "content-type": "multipart/form-data; boundary=zzz",
      },
      body: "this is not a multipart body at all",
    });
    const res = await worker.fetch(req, makeEnv(storage));
    assert.equal(res.status, 400);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test("oversized multipart returns 413 before any Etsy call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async () => ({ json: {} }));
  try {
    const big = "x".repeat(20 * 1024 * 1024 + 1024);
    const req = new Request(HOST + "/api/listings/123/file", {
      method: "POST",
      headers: {
        "x-gateway-key": GATEWAY_KEY,
        "content-type": "multipart/form-data; boundary=zzz",
        "content-length": String(big.length),
      },
      body: big,
    });
    const res = await worker.fetch(req, makeEnv(storage));
    assert.equal(res.status, 413);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

for (const status of [400, 401, 403, 404, 429, 500]) {
  test("Etsy " + status + " passes through with its status intact", async () => {
    const storage = new MemoryStorage();
    await seedTokens(storage);
    const mock = mockFetch(async () => ({
      status,
      text: JSON.stringify({ error: "etsy_error_" + status }),
      headers:
        status === 429 ? { "retry-after": "30" } : {},
    }));
    try {
      const res = await worker.fetch(
        gatewayRequest("/api/shop"),
        makeEnv(storage)
      );
      assert.equal(res.status, status);
      assert.equal((await res.json()).error, "etsy_error_" + status);
      if (status === 429) {
        assert.equal(res.headers.get("retry-after"), "30");
      }
    } finally {
      mock.restore();
    }
  });
}

test("an Etsy 403 (insufficient scope style) is passed through, never converted to success", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, {
    scope: "listings_r shops_r transactions_r",
  });
  const mock = mockFetch(async () => ({
    status: 403,
    json: { error: "Insufficient permissions" },
  }));
  try {
    const res = await worker.fetch(
      jsonRequest("/api/listings/draft", VALID_DRAFT, {
        headers: { "idempotency-key": "draft-key-0007" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Insufficient permissions");
  } finally {
    mock.restore();
  }
});

test("token values never appear in gateway error responses", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, { expires_at: Date.now() - 1000 });
  const mock = mockFetch(async () => ({
    status: 400,
    json: { error: "invalid_grant" },
  }));
  try {
    const res = await worker.fetch(gatewayRequest("/api/shop"), makeEnv(storage));
    assert.equal(res.status, 409);
    const body = await res.text();
    assert.ok(!body.includes("999999999.fresh-token"));
    assert.ok(!body.includes("refresh-1"));
    assert.ok(!body.includes(SHARED_SECRET));
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Correction pass tests: transactional Durable Object operations, granted
// scope verification and gating, and the per-listing publish lock. The
// concurrency tests interleave operations deliberately; correctness must
// come from the transactional design, not from timing luck.
// ---------------------------------------------------------------------------

const FULL_SCOPE_STRING =
  "listings_r listings_w shops_r shops_w transactions_r";

function apiRequest(method, path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  let body = opts.body;
  if (body !== undefined && typeof body !== "string") {
    if (!headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    body = JSON.stringify(body);
  }
  return gatewayRequest(path, { method, headers, body });
}

function doFetch(store, path, body) {
  return store
    .fetch(
      new Request("https://token-store" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    )
    .then((r) => r.json());
}

// Durable Object operations are addressed to ONE object instance in
// production; concurrent calls in a test must likewise share one
// EtsyTokenStore instance per storage, or the comparison is meaningless.
// Instances are cached per storage object. Pass { fresh: true } to force
// a new instance (the reconstruction test).
const storeInstanceCache = new WeakMap();
function storePost(storage, env, path, body, options) {
  let store;
  if (options && options.fresh) {
    store = new EtsyTokenStore(storage, env || {});
  } else {
    store = storeInstanceCache.get(storage);
    if (!store) {
      store = new EtsyTokenStore(storage, env || {});
      storeInstanceCache.set(storage, store);
    }
  }
  return doFetch(store, path, body);
}

test("two simultaneous callbacks with the same state: exactly one succeeds", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-race");
  let tokenCalls = 0;
  const mock = mockFetch(async (url) => {
    if (url === TOKEN_URL) {
      tokenCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        json: {
          access_token: "race-access",
          refresh_token: "race-refresh",
          expires_in: 3600,
          scope: FULL_SCOPE_STRING,
        },
      };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const callback = () =>
      worker.fetch(
        new Request(HOST + "/oauth/callback?code=c&state=state-race"),
        env
      );
    const [a, b] = await Promise.all([callback(), callback()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 400], "one success, one rejection");
    assert.equal(tokenCalls, 1, "the token endpoint is called exactly once");
    assert.equal(storage.map.get("tokens:current").refresh_token, "race-refresh");
    assert.equal(storage.map.get("tokens:current").scope_status, "verified");
  } finally {
    mock.restore();
  }
});

test("Durable Object: two simultaneous state consumes yield the verifier exactly once", async () => {
  const storage = new MemoryStorage();
  await storage.put("oauth_state:do-race", {
    verifier: "v-once",
    expires_at: Date.now() + 60000,
  });
  const consume = () =>
    storePost(storage, {}, "/state/consume", { state: "do-race" });
  const [a, b] = await Promise.all([consume(), consume()]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1);
  assert.equal(oks[0].verifier, "v-once");
});

test("Durable Object operations survive object reconstruction over the same storage", async () => {
  const storage = new MemoryStorage();
  const first = await storePost(storage, {}, "/state/create", {
    state: "persist-state",
    verifier: "v-persist",
    expires_at: Date.now() + 60000,
  });
  assert.equal(first.ok, true);
  // A new EtsyTokenStore instance over the same storage (the object was
  // evicted and rebuilt) sees the record written transactionally by the
  // previous instance, and the state is still consumed exactly once.
  const rebuilt = new EtsyTokenStore(storage, {});
  const consumed = await doFetch(rebuilt, "/state/consume", {
    state: "persist-state",
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.verifier, "v-persist");
  const again = await doFetch(rebuilt, "/state/consume", {
    state: "persist-state",
  });
  assert.equal(again.ok, false);
});

test("two simultaneous draft requests with the same idempotency key create exactly one listing", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let createCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555") {
      return { json: { shop_id: 555 } };
    }
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      createCalls++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { status: 201, json: { listing_id: 7001 } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const draft = () =>
      worker.fetch(
        apiRequest("POST", "/api/listings/draft", {
          headers: { "idempotency-key": "race-key-0001" },
          body: { ...VALID_DRAFT },
        }),
        env
      );
    const [a, b] = await Promise.all([draft(), draft()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [201, 409], "one create, one in-progress");
    const loser = a.status === 409 ? a : b;
    assert.equal((await loser.json()).error, "request_in_progress");
    assert.equal(createCalls, 1, "exactly one Etsy create call");
  } finally {
    mock.restore();
  }
});

test("Durable Object: simultaneous idempotency begins yield exactly one owner", async () => {
  const storage = new MemoryStorage();
  const begin = (hash) =>
    storePost(storage, {}, "/idem/begin", { key: "race-key", hash });
  const [a, b] = await Promise.all([begin("hash-1"), begin("hash-1")]);
  const actions = [a.action, b.action].sort();
  assert.deepEqual(actions, ["in_progress", "proceed"]);
  const owner = a.action === "proceed" ? a : b;
  assert.ok(owner.op_id, "the owner carries an operation id");
});

test("Durable Object: a conflicting hash under concurrency returns conflict, never a second owner", async () => {
  const storage = new MemoryStorage();
  const [a, b] = await Promise.all([
    storePost(storage, {}, "/idem/begin", { key: "race-key-2", hash: "h-a" }),
    storePost(storage, {}, "/idem/begin", { key: "race-key-2", hash: "h-b" }),
  ]);
  const actions = [a.action, b.action].sort();
  assert.deepEqual(actions, ["conflict", "proceed"]);
});

test("Durable Object: idempotency complete and abort are rejected for a non-owner", async () => {
  const storage = new MemoryStorage();
  const begin = await storePost(storage, {}, "/idem/begin", {
    key: "owner-key",
    hash: "h",
  });
  assert.equal(begin.action, "proceed");
  const badComplete = await storePost(storage, {}, "/idem/complete", {
    key: "owner-key",
    op_id: "someone-else",
    status: 201,
    body: "{}",
  });
  assert.equal(badComplete.ok, false);
  assert.equal(badComplete.error, "not_operation_owner");
  const badAbort = await storePost(storage, {}, "/idem/abort", {
    key: "owner-key",
    op_id: "someone-else",
  });
  assert.equal(badAbort.ok, false);
  // The record is unchanged: still in progress for the same hash.
  const recheck = await storePost(storage, {}, "/idem/begin", {
    key: "owner-key",
    hash: "h",
  });
  assert.equal(recheck.action, "in_progress");
  const goodComplete = await storePost(storage, {}, "/idem/complete", {
    key: "owner-key",
    op_id: begin.op_id,
    status: 201,
    body: "{\"listing_id\":42}",
  });
  assert.equal(goodComplete.ok, true);
  const replay = await storePost(storage, {}, "/idem/begin", {
    key: "owner-key",
    hash: "h",
  });
  assert.equal(replay.action, "replay");
  assert.equal(replay.status, 201);
});

function seedIdemRecord(storage, key, overrides) {
  const now = Date.now();
  const record = Object.assign(
    {
      version: 2,
      hash: "h",
      fingerprint: {
        title: "Printable Planner",
        price: 9.99,
        quantity: 1,
        taxonomy_id: 123,
      },
      state: "in_progress",
      op_id: "original-op",
      attempts: 1,
      created_at: now,
      first_created_at: now,
      updated_at: now,
      stored_at: now,
      lease_expires_at: now + 120 * 1000,
      history: [{ event: "begin", attempt: 1, at: now }],
    },
    overrides || {}
  );
  return storage.put("idem:" + key, record).then(() => record);
}

test("Durable Object: an in-progress record with a live lease cannot be taken over", async () => {
  const storage = new MemoryStorage();
  await seedIdemRecord(storage, "fresh-key");
  const early = await storePost(storage, {}, "/idem/begin", {
    key: "fresh-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(early.action, "in_progress");
});

test("Durable Object: an expired lease transitions to uncertain and is never taken over", async () => {
  const storage = new MemoryStorage();
  const past = Date.now() - 121 * 1000;
  await seedIdemRecord(storage, "stale-key", {
    op_id: "crashed-op",
    created_at: past,
    first_created_at: past,
    updated_at: past,
    stored_at: past,
    lease_expires_at: Date.now() - 1000,
  });
  const late = await storePost(storage, {}, "/idem/begin", {
    key: "stale-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(late.action, "uncertain");
  assert.equal(late.op_id, undefined, "no new owner is ever issued");
  const record = storage.map.get("idem:stale-key");
  assert.equal(record.state, "uncertain");
  assert.equal(
    record.op_id,
    "crashed-op",
    "execution ownership survives lease expiry"
  );
  assert.equal(record.hash, "h");
  assert.equal(record.fingerprint.title, "Printable Planner");
  assert.equal(typeof record.uncertain_at, "number");
  // A second begin, at any later time, still returns uncertain.
  const again = await storePost(storage, {}, "/idem/begin", {
    key: "stale-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(again.action, "uncertain");
  // A different request body against the uncertain record conflicts.
  const other = await storePost(storage, {}, "/idem/begin", {
    key: "stale-key",
    hash: "different-hash",
    fingerprint: { title: "Other" },
  });
  assert.equal(other.action, "conflict");
  assert.equal(storage.map.get("idem:stale-key").state, "uncertain");
});

test("simultaneous rate-limit checks at the threshold admit exactly the limit", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url) => {
    if (url === API + "/shops/555") return { json: { shop_id: 555 } };
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage, { RATE_LIMIT_PER_MINUTE: "5" });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        worker.fetch(apiRequest("GET", "/api/shop"), env)
      )
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    assert.equal(ok, 5);
    assert.equal(limited, 7);
  } finally {
    mock.restore();
  }
});

test("Durable Object: concurrent rate checks at the threshold admit exactly the limit", async () => {
  const storage = new MemoryStorage();
  const checks = await Promise.all(
    Array.from({ length: 10 }, () =>
      storePost(storage, {}, "/rate/check", {
        identity: "burst",
        limit: 3,
        windowMs: 60000,
      })
    )
  );
  assert.equal(checks.filter((r) => r.allowed).length, 3);
  assert.equal(checks.filter((r) => !r.allowed).length, 7);
});

test("a transaction that throws mid-operation leaves storage unchanged", async () => {
  const storage = new MemoryStorage();
  await storage.put("fault:a", 1);
  await storage.put("fault:b", 2);
  const store = new EtsyTokenStore(storage, {});
  await assert.rejects(
    store.runTransaction(async (txn) => {
      await txn.put("fault:a", 99);
      await txn.put("fault:c", 3);
      await txn.delete("fault:b");
      throw new Error("injected fault");
    }),
    /injected fault/
  );
  assert.equal(await storage.get("fault:a"), 1);
  assert.equal(await storage.get("fault:b"), 2);
  assert.equal(await storage.get("fault:c"), undefined);
});

test("token refresh concurrent with a shop metadata update keeps the rotated refresh token and the new shop id", async () => {
  const inner = new MemoryStorage();
  await inner.put("tokens:current", {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: Date.now() - 1000,
    scope: FULL_SCOPE_STRING,
    scope_status: "verified",
    scopes_confirmed_at: null,
  });
  // Delay reads and writes so the refresh and the metadata update
  // interleave. Under the old whole-record write-back, the metadata
  // update would resurrect the spent refresh token.
  const delayed = withDelays(inner, { get: 5, put: 10, delete: 1 });
  let releaseTokenResponse;
  const tokenGate = new Promise((resolve) => {
    releaseTokenResponse = resolve;
  });
  const mock = mockFetch(async (url) => {
    if (url === TOKEN_URL) {
      await tokenGate;
      return {
        json: {
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          scope: FULL_SCOPE_STRING,
        },
      };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(inner);
    // Both operations go to one store instance over the delayed
    // storage, matching the single Durable Object instance in
    // production.
    const ensurePromise = storePost(delayed, env, "/tokens/ensure", {});
    const metaPromise = (async () => {
      // Start while the refresh is parked on the token gate.
      await new Promise((resolve) => setTimeout(resolve, 15));
      const result = await storePost(delayed, env, "/tokens/shop-meta", {
        shop_id: 777,
      });
      releaseTokenResponse();
      return result;
    })();
    const [ensured, meta] = await Promise.all([ensurePromise, metaPromise]);
    assert.equal(meta.ok, true);
    const record = await inner.get("tokens:current");
    assert.equal(record.refresh_token, "rotated-refresh");
    assert.equal(record.access_token, "rotated-access");
    assert.equal(record.shop_id, 777);
    assert.equal(ensured.record.refresh_token, "rotated-refresh");
  } finally {
    mock.restore();
  }
});

test("callback with all five granted scopes stores a verified record and writes are allowed", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-verified");
  let createCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === TOKEN_URL) {
      return {
        json: {
          access_token: "123456789.verified-access",
          refresh_token: "verified-refresh",
          expires_in: 3600,
          scope: FULL_SCOPE_STRING,
        },
      };
    }
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      createCalls++;
      return { status: 201, json: { listing_id: 7101 } };
    }
    if (url === API + "/users/me") {
      return { json: { user_id: 123456789, shop_id: 555 } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const callback = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=c&state=state-verified"),
      env
    );
    assert.equal(callback.status, 200);
    const record = storage.map.get("tokens:current");
    assert.equal(record.scope_status, "verified");
    assert.equal(record.scope, FULL_SCOPE_STRING);
    const draft = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "verified-key-01" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(draft.status, 201);
    assert.equal(createCalls, 1);
  } finally {
    mock.restore();
  }
});

test("callback with a missing granted scope stores an incomplete record: reads proceed, writes are blocked", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-incomplete");
  let writeCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === TOKEN_URL) {
      return {
        json: {
          access_token: "123456789.partial-access",
          refresh_token: "partial-refresh",
          expires_in: 3600,
          scope: "listings_r shops_r transactions_r",
        },
      };
    }
    if (url === API + "/users/me") {
      return { json: { user_id: 123456789, shop_id: 555 } };
    }
    if (url === API + "/shops/555" && init.method === "GET") {
      return { json: { shop_id: 555, shop_name: "FultonPrintables" } };
    }
    writeCalls++;
    return { json: {} };
  });
  try {
    const env = makeEnv(storage);
    const callback = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=c&state=state-incomplete"),
      env
    );
    assert.equal(callback.status, 200);
    assert.equal(storage.map.get("tokens:current").scope_status, "incomplete");
    const read = await worker.fetch(apiRequest("GET", "/api/shop"), env);
    assert.equal(read.status, 200, "reads proceed with reduced scopes");
    const write = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "incomplete-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(write.status, 403);
    const body = await write.json();
    assert.equal(body.error, "scopes_incomplete");
    assert.deepEqual(body.missing_scopes, ["listings_w", "shops_w"]);
    assert.equal(writeCalls, 0, "no Etsy write was attempted");
    // Owner confirmation cannot upgrade an incomplete grant; only a new
    // authorization with the missing scopes can.
    const confirm = await worker.fetch(
      new Request(HOST + "/oauth/confirm-scopes", {
        method: "POST",
        headers: { "x-setup-secret": SETUP_SECRET },
      }),
      env
    );
    assert.equal(confirm.status, 409);
    assert.equal((await confirm.json()).error, "scopes_incomplete");
    assert.equal(storage.map.get("tokens:current").scope_status, "incomplete");
  } finally {
    mock.restore();
  }
});

test("callback with no scope information stores an unverified record until the owner confirms", async () => {
  const storage = new MemoryStorage();
  await seedState(storage, "state-unverified");
  let createCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === TOKEN_URL) {
      return {
        json: {
          access_token: "123456789.mystery-access",
          refresh_token: "mystery-refresh",
          expires_in: 3600,
          // No scope field at all.
        },
      };
    }
    if (url === API + "/users/me") {
      return { json: { user_id: 123456789, shop_id: 555 } };
    }
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      createCalls++;
      return { status: 201, json: { listing_id: 7201 } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const callback = await worker.fetch(
      new Request(HOST + "/oauth/callback?code=c&state=state-unverified"),
      env
    );
    assert.equal(callback.status, 200);
    const record = storage.map.get("tokens:current");
    assert.equal(record.scope_status, "unverified");
    assert.equal(record.scope, null);
    const blocked = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "unverified-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, "scope_unverified");
    assert.equal(createCalls, 0);
    const wrongSecret = await worker.fetch(
      new Request(HOST + "/oauth/confirm-scopes", {
        method: "POST",
        headers: { "x-setup-secret": "not-the-secret" },
      }),
      env
    );
    assert.equal(wrongSecret.status, 403);
    assert.equal(storage.map.get("tokens:current").scope_status, "unverified");
    const confirmed = await worker.fetch(
      new Request(HOST + "/oauth/confirm-scopes", {
        method: "POST",
        headers: { "x-setup-secret": SETUP_SECRET },
      }),
      env
    );
    assert.equal(confirmed.status, 200);
    const confirmedBody = await confirmed.json();
    assert.equal(confirmedBody.scope_status, "owner_confirmed");
    assert.equal(typeof confirmedBody.scopes_confirmed_at, "number");
    assert.ok(!JSON.stringify(confirmedBody).includes(SETUP_SECRET));
    const after = storage.map.get("tokens:current");
    assert.equal(after.scope_status, "owner_confirmed");
    assert.equal(after.scopes_confirmed_at, confirmedBody.scopes_confirmed_at);
    const draft = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "unverified-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(draft.status, 201);
    assert.equal(createCalls, 1);
  } finally {
    mock.restore();
  }
});

test("a refresh response with reduced scope information downgrades a verified record", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage, { expires_at: Date.now() - 1000 });
  const mock = mockFetch(async (url) => {
    if (url === TOKEN_URL) {
      return {
        json: {
          access_token: "downgraded-access",
          refresh_token: "downgraded-refresh",
          expires_in: 3600,
          scope: "listings_r listings_w shops_r shops_w",
        },
      };
    }
    if (url === API + "/shops/555") return { json: { shop_id: 555 } };
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const read = await worker.fetch(apiRequest("GET", "/api/shop"), env);
    assert.equal(read.status, 200);
    const record = storage.map.get("tokens:current");
    assert.equal(record.scope_status, "incomplete");
    assert.equal(record.scope, "listings_r listings_w shops_r shops_w");
    const write = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "downgrade-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(write.status, 403);
    const body = await write.json();
    assert.equal(body.error, "scopes_incomplete");
    assert.deepEqual(body.missing_scopes, ["transactions_r"]);
  } finally {
    mock.restore();
  }
});

function publishMock(options) {
  const opts = options || {};
  const patchDelay = opts.patchDelay || 0;
  const patchStatuses = opts.patchStatuses || [200];
  const state = {
    patchCalls: 0,
    patchBodies: [],
  };
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555") return { json: { shop_id: 555 } };
    const getMatch = url.match(/\/listings\/(\d+)$/);
    if (getMatch && init.method === "GET") {
      return {
        json: {
          listing_id: Number(getMatch[1]),
          state: (opts.states || {})[getMatch[1]] || "draft",
        },
      };
    }
    const patchMatch = url.match(/\/shops\/555\/listings\/(\d+)$/);
    if (patchMatch && init.method === "PATCH") {
      state.patchCalls++;
      state.patchBodies.push({
        id: patchMatch[1],
        body: String(init.body || ""),
      });
      if (patchDelay) {
        await new Promise((resolve) => setTimeout(resolve, patchDelay));
      }
      const status =
        patchStatuses[Math.min(state.patchCalls - 1, patchStatuses.length - 1)];
      if (status !== 200) {
        return { status, json: { error: "etsy_activation_failed" } };
      }
      return {
        json: { listing_id: Number(patchMatch[1]), state: "active" },
      };
    }
    return undefined; // fail closed
  });
  mock.state = state;
  return mock;
}

test("two simultaneous publishes of the same listing issue exactly one activation call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = publishMock({ patchDelay: 25 });
  try {
    const env = makeEnv(storage);
    const publish = () =>
      worker.fetch(
        apiRequest("PATCH", "/api/listings/123", {
          body: { state: "active" },
        }),
        env
      );
    const [a, b] = await Promise.all([publish(), publish()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal((await loser.json()).error, "publish_in_progress");
    assert.equal(mock.state.patchCalls, 1, "one Etsy activation call");
    assert.equal(
      [...storage.map.keys()].filter((k) => k.startsWith("publish_lock:"))
        .length,
      0,
      "the lock is released after the publish completes"
    );
  } finally {
    mock.restore();
  }
});

test("two simultaneous publishes of different listings both proceed", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = publishMock({ patchDelay: 10 });
  try {
    const env = makeEnv(storage);
    const [a, b] = await Promise.all([
      worker.fetch(
        apiRequest("PATCH", "/api/listings/123", {
          body: { state: "active" },
        }),
        env
      ),
      worker.fetch(
        apiRequest("PATCH", "/api/listings/456", {
          body: { state: "active" },
        }),
        env
      ),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(mock.state.patchCalls, 2, "unrelated listings never block");
  } finally {
    mock.restore();
  }
});

test("a failed publish releases the lock and a retry succeeds", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = publishMock({ patchStatuses: [500, 200] });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      apiRequest("PATCH", "/api/listings/123", {
        body: { state: "active" },
      }),
      env
    );
    assert.equal(first.status, 500, "the Etsy failure passes through");
    assert.equal(
      [...storage.map.keys()].filter((k) => k.startsWith("publish_lock:"))
        .length,
      0,
      "no lock remains after the failed publish"
    );
    const retry = await worker.fetch(
      apiRequest("PATCH", "/api/listings/123", {
        body: { state: "active" },
      }),
      env
    );
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).state, "active");
    assert.equal(mock.state.patchCalls, 2);
  } finally {
    mock.restore();
  }
});

// ---------------------------------------------------------------------------
// Lease correction tests: execution ownership is separated from the
// in-progress lease. An expired lease moves an operation to uncertain
// and never authorizes a second external side effect; recovery runs
// through reconciliation and owner abandon only.
// ---------------------------------------------------------------------------

async function sha256HexOf(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DRAFT_FINGERPRINT = {
  title: VALID_DRAFT.title,
  price: VALID_DRAFT.price,
  quantity: VALID_DRAFT.quantity,
  taxonomy_id: VALID_DRAFT.taxonomy_id,
};

async function seedUncertainOperation(storage, key, overrides) {
  const hash = await sha256HexOf(JSON.stringify(VALID_DRAFT));
  const now = Date.now();
  const record = {
    version: 2,
    hash,
    fingerprint: Object.assign({}, DRAFT_FINGERPRINT),
    state: "uncertain",
    op_id: "crashed-op",
    attempts: 1,
    created_at: now - 5 * 60 * 1000,
    first_created_at: now - 5 * 60 * 1000,
    updated_at: now - 4 * 60 * 1000,
    stored_at: now - 4 * 60 * 1000,
    lease_expires_at: null,
    uncertain_at: now - 4 * 60 * 1000,
    history: [{ event: "marked_uncertain", at: now - 4 * 60 * 1000 }],
  };
  await storage.put("idem:" + key, Object.assign(record, overrides || {}));
  return record;
}

function matchingListing(overrides) {
  return Object.assign(
    {
      listing_id: 8801,
      title: "Printable Planner",
      state: "draft",
      creation_timestamp: Math.floor(Date.now() / 1000),
      quantity: 1,
      price: { amount: 999, divisor: 100, currency_code: "USD" },
    },
    overrides || {}
  );
}

test("begin on an expired in-progress record returns operation_uncertain and makes zero Etsy calls", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const hash = await sha256HexOf(JSON.stringify(VALID_DRAFT));
  const past = Date.now() - 121 * 1000;
  await seedIdemRecord(storage, "expired-lease-key", {
    hash,
    op_id: "crashed-op",
    created_at: past,
    first_created_at: past,
    updated_at: past,
    stored_at: past,
    lease_expires_at: Date.now() - 1000,
  });
  const mock = mockFetch(async () => undefined); // fail closed
  try {
    const res = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "expired-lease-key" },
        body: { ...VALID_DRAFT },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "operation_uncertain");
    assert.ok(body.reconcile_url.endsWith("/reconcile"));
    assert.equal(mock.calls.length, 0, "zero Etsy calls on the uncertain path");
    const record = storage.map.get("idem:expired-lease-key");
    assert.equal(record.state, "uncertain");
    assert.equal(record.op_id, "crashed-op");
  } finally {
    mock.restore();
  }
});

test("Durable Object: an uncertain record rejects complete and fail from owner and non-owner alike", async () => {
  const storage = new MemoryStorage();
  await seedUncertainOperation(storage, "uncertain-ops");
  const completeByOwner = await storePost(storage, {}, "/idem/complete", {
    key: "uncertain-ops",
    op_id: "crashed-op",
    status: 201,
    body: "{}",
  });
  assert.equal(completeByOwner.ok, false);
  const completeByOther = await storePost(storage, {}, "/idem/complete", {
    key: "uncertain-ops",
    op_id: "someone-else",
    status: 201,
    body: "{}",
  });
  assert.equal(completeByOther.ok, false);
  const failByOther = await storePost(storage, {}, "/idem/fail", {
    key: "uncertain-ops",
    op_id: "someone-else",
    status: 400,
  });
  assert.equal(failByOther.ok, false);
  assert.equal(failByOther.error, "not_operation_owner");
  const abortByOther = await storePost(storage, {}, "/idem/abort", {
    key: "uncertain-ops",
    op_id: "someone-else",
  });
  assert.equal(abortByOther.ok, false);
  const record = storage.map.get("idem:uncertain-ops");
  assert.equal(record.state, "uncertain");
  assert.equal(record.op_id, "crashed-op");
});

test("Durable Object: the owner marks its own operation uncertain and a begin then returns uncertain", async () => {
  const storage = new MemoryStorage();
  const begin = await storePost(storage, {}, "/idem/begin", {
    key: "mark-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(begin.action, "proceed");
  const wrong = await storePost(storage, {}, "/idem/uncertain", {
    key: "mark-key",
    op_id: "not-the-owner",
  });
  assert.equal(wrong.ok, false);
  const marked = await storePost(storage, {}, "/idem/uncertain", {
    key: "mark-key",
    op_id: begin.op_id,
  });
  assert.equal(marked.ok, true);
  const after = await storePost(storage, {}, "/idem/begin", {
    key: "mark-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(after.action, "uncertain");
});

test("a network failure mid-create marks the operation uncertain and the response is not a success", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      throw new Error("socket hang up");
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const res = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "network-key-01" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "etsy_outcome_unknown");
    assert.equal(body.state, "uncertain");
    const record = storage.map.get("idem:network-key-01");
    assert.equal(record.state, "uncertain");
    assert.equal(typeof record.uncertain_at, "number");
    const view = await worker.fetch(
      apiRequest("GET", "/api/operations/network-key-01"),
      env
    );
    assert.equal(view.status, 200);
    assert.equal((await view.json()).state, "uncertain");
    // A retry under the same key issues no second create.
    const retry = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "network-key-01" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).error, "operation_uncertain");
  } finally {
    mock.restore();
  }
});

test("a definite Etsy 400 stores a failed operation and the retry is a new attempt that succeeds", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let postCalls = 0;
  let successCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      postCalls++;
      if (postCalls === 1) {
        return { status: 400, json: { error: "bad_listing" } };
      }
      successCalls++;
      return { status: 201, json: { listing_id: 43, state: "draft" } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const first = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "fail-retry-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(first.status, 400);
    const failedView = await worker.fetch(
      apiRequest("GET", "/api/operations/fail-retry-key"),
      env
    );
    const failedBody = await failedView.json();
    assert.equal(failedBody.state, "failed");
    assert.equal(failedBody.failure_status, 400);
    assert.equal(failedBody.attempts, 1);
    const second = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "fail-retry-key" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(second.status, 201);
    assert.equal(postCalls, 2);
    assert.equal(successCalls, 1, "exactly one successful create total");
    const doneView = await worker.fetch(
      apiRequest("GET", "/api/operations/fail-retry-key"),
      env
    );
    const doneBody = await doneView.json();
    assert.equal(doneBody.state, "completed");
    assert.equal(doneBody.attempts, 2, "the retry counted as a new attempt");
    assert.equal(doneBody.result_listing_id, 43);
  } finally {
    mock.restore();
  }
});

test("reconcile with exactly one matching draft recovers the operation and a later request replays it", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedUncertainOperation(storage, "recon-key-1");
  let postCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (init.method === "POST") postCalls++;
    if (url.startsWith(API + "/shops/555/listings")) {
      const parsed = new URL(url);
      if (parsed.searchParams.get("state") === "draft") {
        return { json: { count: 1, results: [matchingListing()] } };
      }
      return { json: { count: 0, results: [] } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const res = await worker.fetch(
      apiRequest("POST", "/api/operations/recon-key-1/reconcile"),
      env
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "recovered");
    assert.equal(body.listing_id, 8801);
    const record = storage.map.get("idem:recon-key-1");
    assert.equal(record.state, "completed");
    assert.equal(record.recovered, true);
    assert.equal(record.result_listing_id, 8801);
    // A later create request with the same key replays the recovered
    // result and issues no new Etsy create.
    const replay = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "recon-key-1" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");
    const replayBody = await replay.json();
    assert.equal(replayBody.listing_id, 8801);
    assert.equal(replayBody.recovered, true);
    assert.equal(postCalls, 0, "reconcile and replay issue no creates");
  } finally {
    mock.restore();
  }
});

test("reconcile with zero matches leaves the record uncertain and issues no create", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedUncertainOperation(storage, "recon-key-2");
  const methods = [];
  const mock = mockFetch(async (url, init) => {
    methods.push(init.method);
    if (url.startsWith(API + "/shops/555/listings")) {
      return { json: { count: 0, results: [] } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const res = await worker.fetch(
      apiRequest("POST", "/api/operations/recon-key-2/reconcile"),
      env
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.status, "uncertain");
    assert.equal(body.matches, 0);
    assert.equal(storage.map.get("idem:recon-key-2").state, "uncertain");
    assert.ok(
      methods.every((m) => m === "GET"),
      "reconciliation only ever reads"
    );
  } finally {
    mock.restore();
  }
});

test("reconcile with two matches leaves the record uncertain and reports ambiguity", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedUncertainOperation(storage, "recon-key-3");
  const mock = mockFetch(async (url) => {
    if (url.startsWith(API + "/shops/555/listings")) {
      const parsed = new URL(url);
      if (parsed.searchParams.get("state") === "draft") {
        return {
          json: {
            count: 2,
            results: [
              matchingListing(),
              matchingListing({ listing_id: 8802 }),
            ],
          },
        };
      }
      return { json: { count: 0, results: [] } };
    }
    return undefined; // fail closed
  });
  try {
    const res = await worker.fetch(
      apiRequest("POST", "/api/operations/recon-key-3/reconcile"),
      makeEnv(storage)
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.status, "uncertain");
    assert.equal(body.matches, 2);
    assert.equal(body.ambiguous, true);
    assert.equal(storage.map.get("idem:recon-key-3").state, "uncertain");
  } finally {
    mock.restore();
  }
});

test("reconcile on a non-uncertain record is a no-op returning its status", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedIdemRecord(storage, "recon-key-4", {
    state: "completed",
    status: 201,
    body: "{\"listing_id\":42}",
    result_listing_id: 42,
    lease_expires_at: null,
  });
  const mock = mockFetch(async () => undefined); // fail closed
  try {
    const res = await worker.fetch(
      apiRequest("POST", "/api/operations/recon-key-4/reconcile"),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "completed");
    assert.equal(body.listing_id, 42);
    assert.equal(mock.calls.length, 0, "no Etsy call for a no-op reconcile");
    assert.equal(storage.map.get("idem:recon-key-4").state, "completed");
  } finally {
    mock.restore();
  }
});

test("abandon requires the setup secret and frees the key for exactly one new create", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedUncertainOperation(storage, "abandon-key-1");
  let postCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      postCalls++;
      return { status: 201, json: { listing_id: 9101, state: "draft" } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const noSecret = await worker.fetch(
      apiRequest("POST", "/api/operations/abandon-key-1/abandon"),
      env
    );
    assert.equal(noSecret.status, 403, "the gateway key alone is not enough");
    const wrongSecret = await worker.fetch(
      apiRequest("POST", "/api/operations/abandon-key-1/abandon", {
        headers: { "x-setup-secret": "not-the-secret" },
      }),
      env
    );
    assert.equal(wrongSecret.status, 403);
    assert.equal(storage.map.get("idem:abandon-key-1").state, "uncertain");
    const done = await worker.fetch(
      apiRequest("POST", "/api/operations/abandon-key-1/abandon", {
        headers: { "x-setup-secret": SETUP_SECRET },
      }),
      env
    );
    assert.equal(done.status, 200);
    assert.equal((await done.json()).status, "abandoned");
    const record = storage.map.get("idem:abandon-key-1");
    assert.equal(record.state, "abandoned");
    assert.equal(typeof record.abandoned_at, "number");
    const draft = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "abandon-key-1" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(draft.status, 201);
    assert.equal(postCalls, 1, "exactly one create after abandonment");
  } finally {
    mock.restore();
  }
});

test("abandon is only valid from uncertain", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await seedIdemRecord(storage, "abandon-key-2");
  const res = await worker.fetch(
    apiRequest("POST", "/api/operations/abandon-key-2/abandon", {
      headers: { "x-setup-secret": SETUP_SECRET },
    }),
    makeEnv(storage)
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "operation_not_uncertain");
  assert.equal(storage.map.get("idem:abandon-key-2").state, "in_progress");
});

test("GET operation status returns the state machine fields and no token material", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555/listings" && init.method === "POST") {
      return { status: 201, json: { listing_id: 42, state: "draft" } };
    }
    return undefined; // fail closed
  });
  try {
    const env = makeEnv(storage);
    const created = await worker.fetch(
      apiRequest("POST", "/api/listings/draft", {
        headers: { "idempotency-key": "status-key-01" },
        body: { ...VALID_DRAFT },
      }),
      env
    );
    assert.equal(created.status, 201);
    const res = await worker.fetch(
      apiRequest("GET", "/api/operations/status-key-01"),
      env
    );
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.state, "completed");
    assert.equal(body.status, "completed");
    assert.equal(body.attempts, 1);
    assert.equal(body.fingerprint_title, "Printable Planner");
    assert.equal(body.result_listing_id, 42);
    assert.equal(typeof body.created_at, "number");
    assert.equal(typeof body.updated_at, "number");
    assert.ok(!text.includes("op_id"), "ownership capability is not exposed");
    assert.ok(!text.includes("999999999.fresh-token"));
    assert.ok(!text.includes("refresh-1"));
    assert.ok(!text.includes(SETUP_SECRET));
    const missing = await worker.fetch(
      apiRequest("GET", "/api/operations/no-such-key"),
      env
    );
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "operation_not_found");
  } finally {
    mock.restore();
  }
});

test("Durable Object: idempotency records survive object reconstruction", async () => {
  const storage = new MemoryStorage();
  const begin = await storePost(storage, {}, "/idem/begin", {
    key: "persist-key",
    hash: "h",
    fingerprint: { title: "Printable Planner" },
  });
  assert.equal(begin.action, "proceed");
  const view = await storePost(
    storage,
    {},
    "/idem/get",
    { key: "persist-key" },
    { fresh: true }
  );
  assert.equal(view.found, true);
  assert.equal(view.state, "in_progress");
  assert.equal(view.fingerprint_title, "Printable Planner");
  const completed = await storePost(
    storage,
    {},
    "/idem/complete",
    {
      key: "persist-key",
      op_id: begin.op_id,
      status: 201,
      body: "{\"listing_id\":42}",
      result_listing_id: 42,
    },
    { fresh: true }
  );
  assert.equal(completed.ok, true);
});

test("publish retry after a crashed publisher: expired lock and an active listing returns already_active with zero activation calls", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  // A previous publisher acquired this lock, activated the listing,
  // and crashed before releasing; the lock has since expired.
  await storage.put("publish_lock:123", {
    token: "crashed-publisher",
    expires_at: Date.now() - 1000,
  });
  const mock = publishMock({ states: { "123": "active" } });
  try {
    const res = await worker.fetch(
      apiRequest("PATCH", "/api/listings/123", {
        body: { state: "active" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already_active, true);
    assert.equal(mock.state.patchCalls, 0, "zero activation calls");
  } finally {
    mock.restore();
  }
});

test("publish re-reads state after acquiring the lock: a listing activated in between returns already_active with zero activation calls", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  let getCalls = 0;
  let patchCalls = 0;
  const mock = mockFetch(async (url, init) => {
    if (url === API + "/shops/555") return { json: { shop_id: 555 } };
    if (url === API + "/listings/123" && init.method === "GET") {
      getCalls++;
      // The pre-lock read sees a draft; by the post-lock re-read the
      // listing was activated by the previous lock holder.
      return {
        json: {
          listing_id: 123,
          state: getCalls === 1 ? "draft" : "active",
        },
      };
    }
    if (init.method === "PATCH") {
      patchCalls++;
      return { json: { listing_id: 123, state: "active" } };
    }
    return undefined; // fail closed
  });
  try {
    const res = await worker.fetch(
      apiRequest("PATCH", "/api/listings/123", {
        body: { state: "active" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).already_active, true);
    assert.equal(getCalls, 2, "pre-read and post-lock re-read both happened");
    assert.equal(patchCalls, 0, "no activation call was issued");
  } finally {
    mock.restore();
  }
});

test("publish retry after a crashed publisher: expired lock and a still-draft listing proceeds with exactly one activation call", async () => {
  const storage = new MemoryStorage();
  await seedTokens(storage);
  await storage.put("publish_lock:123", {
    token: "crashed-publisher",
    expires_at: Date.now() - 1000,
  });
  const mock = publishMock({ states: { "123": "draft" } });
  try {
    const res = await worker.fetch(
      apiRequest("PATCH", "/api/listings/123", {
        body: { state: "active" },
      }),
      makeEnv(storage)
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).state, "active");
    assert.equal(mock.state.patchCalls, 1, "exactly one activation call");
    assert.equal(
      [...storage.map.keys()].filter((k) => k.startsWith("publish_lock:"))
        .length,
      0,
      "the fresh lock is released afterwards"
    );
  } finally {
    mock.restore();
  }
});

test("Durable Object: the publish lock is owner-only, expires, and is per listing", async () => {
  const storage = new MemoryStorage();
  const first = await storePost(storage, {}, "/publish/acquire", {
    listing_id: "42",
  });
  assert.equal(first.acquired, true);
  assert.ok(first.lock_token);
  const second = await storePost(storage, {}, "/publish/acquire", {
    listing_id: "42",
  });
  assert.equal(second.acquired, false);
  const otherListing = await storePost(storage, {}, "/publish/acquire", {
    listing_id: "43",
  });
  assert.equal(otherListing.acquired, true, "a different listing is free");
  const wrongRelease = await storePost(storage, {}, "/publish/release", {
    listing_id: "42",
    lock_token: "not-the-owner",
  });
  assert.equal(wrongRelease.ok, false);
  const stillHeld = await storePost(storage, {}, "/publish/acquire", {
    listing_id: "42",
  });
  assert.equal(stillHeld.acquired, false);
  const released = await storePost(storage, {}, "/publish/release", {
    listing_id: "42",
    lock_token: first.lock_token,
  });
  assert.equal(released.ok, true);
  // A lock whose owner crashed expires and can be re-acquired.
  await storage.put("publish_lock:44", {
    token: "crashed-owner",
    expires_at: Date.now() - 1,
  });
  const reacquired = await storePost(storage, {}, "/publish/acquire", {
    listing_id: "44",
  });
  assert.equal(reacquired.acquired, true);
});
