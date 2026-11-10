// etsy-gateway: a single-file Cloudflare Worker that holds Lawrence's Etsy
// Seller App credentials as Worker secrets and the OAuth state and tokens
// inside a Durable Object, performs Etsy Open API v3 calls itself, and
// exposes a single-secret API to Muse. Etsy tokens never leave Lawrence's
// Cloudflare account, and no token or secret value is ever logged or
// returned to a caller.
//
// Secrets required (set in the Cloudflare dashboard or with wrangler):
//   ETSY_KEYSTRING, ETSY_SHARED_SECRET, GATEWAY_API_KEY, SETUP_SECRET
// SETUP_SECRET is owner-only: it gates OAuth authorization initiation and
// the owner scope confirmation. It is never available to the Muse
// connector and never appears in any response.
// Binding required: TOKEN_STORE (Durable Object, class EtsyTokenStore)
//
// Production readiness audit: see AUDIT-REPORT.md in this directory.
// Independent review corrections: see CORRECTION-REPORT.md.

const ETSY_API_BASE = "https://api.etsy.com/v3/application";
const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
const ETSY_CONNECT_URL = "https://www.etsy.com/oauth/connect";
const REDIRECT_URI = "https://etsy-gateway.lawrencemurry.workers.dev/oauth/callback";
// Least-privilege scopes for the initial business operation. listings_d and
// transactions_w are deliberately NOT requested: listings are retired by
// deactivation, and the gateway never writes transaction data.
const SCOPES = "listings_r listings_w shops_r shops_w transactions_r";
const REQUIRED_SCOPES = SCOPES.split(" ");
const STORE_NAME = "etsy-gateway-global";
const TOKEN_KEY = "tokens:current";
const STATE_PREFIX = "oauth_state:";
const STATE_TTL_MS = 600 * 1000;
const MAX_OUTSTANDING_STATES = 100;
const REFRESH_SKEW_MS = 60 * 1000;
const JSON_MAX_BYTES = 256 * 1024;
// Gateway-chosen cap for multipart uploads. Etsy does not publish a listing
// file size limit in the documents verified for the audit, so this number is
// a gateway policy choice, not an Etsy limit.
const MULTIPART_MAX_BYTES = 20 * 1024 * 1024;
const IDEM_KEY_PREFIX = "idem:";
const IDEM_TTL_MS = 24 * 60 * 60 * 1000;
// The in-progress lease on an idempotency record. Lease expiry is NOT
// execution ownership: the op_id stored at begin owns the operation for
// its whole life, and an expired lease moves the record to "uncertain"
// rather than authorizing a second external side effect. See the lease
// correction section of CORRECTION-REPORT.md.
const IDEM_IN_PROGRESS_MS = 120 * 1000;
// Idempotency record schema version written by this build. Records
// written before it carry no version field and are normalized on read.
const IDEM_RECORD_VERSION = 2;
// Reconciliation clock skew: a listing created up to this long before
// the operation's recorded start still counts as a candidate match,
// to absorb clock differences between the gateway and Etsy.
const RECONCILE_SKEW_MS = 300 * 1000;
const RECONCILE_PAGE_LIMIT = 100;
const RATE_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT = 60;
// Failed setup-secret attempts (authorization initiation and scope
// confirmation) are limited per source through the Durable Object.
const SETUP_FAIL_LIMIT = 5;
const SETUP_FAIL_WINDOW_MS = 10 * 60 * 1000;
// Per-listing publish lock lifetime. A lock whose owner crashed expires
// after this window and a retry can then acquire it.
const PUBLISH_LOCK_PREFIX = "publish_lock:";
const PUBLISH_LOCK_MS = 120 * 1000;
// Gateway-chosen sanity caps for text fields (not Etsy limits).
const TITLE_MAX_CHARS = 1000;
const DESCRIPTION_MAX_CHARS = 20000;
const SHOP_TEXT_MAX_CHARS = 5000;

const WHO_MADE_VALUES = ["i_did", "someone_else", "collective"];
const WHEN_MADE_VALUES = [
  "made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007",
  "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s",
  "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700",
];
const LISTING_TYPE_VALUES = ["physical", "download", "both"];
const UPDATE_STATE_VALUES = ["active", "inactive"];
// Field allowlists taken from Etsy's official OpenAPI specification for
// createDraftListing and updateListing (see AUDIT-REPORT.md).
const CREATE_FIELDS = new Set([
  "quantity", "title", "description", "price", "who_made", "when_made",
  "taxonomy_id", "shipping_profile_id", "return_policy_id", "materials",
  "shop_section_id", "processing_min", "processing_max", "readiness_state_id",
  "tags", "styles", "item_weight", "item_length", "item_width", "item_height",
  "item_weight_unit", "item_dimensions_unit", "production_partner_ids",
  "image_ids", "is_supply", "is_customizable", "should_auto_renew",
  "is_taxable", "type",
]);
const CREATE_REQUIRED = [
  "quantity", "title", "description", "price", "who_made", "when_made",
  "taxonomy_id",
];
const UPDATE_FIELDS = new Set([
  "image_ids", "title", "description", "materials", "should_auto_renew",
  "shipping_profile_id", "return_policy_id", "shop_section_id", "item_weight",
  "item_length", "item_width", "item_height", "item_weight_unit",
  "item_dimensions_unit", "is_taxable", "taxonomy_id", "tags", "who_made",
  "when_made", "state", "is_supply", "production_partner_ids", "type",
]);
const SHOP_FIELDS = new Set([
  "title", "announcement", "sale_message", "digital_sale_message",
]);
const LISTING_STATES = ["active", "inactive", "sold_out", "draft", "removed", "expired"];
const SORT_ON_LISTINGS = ["created", "price", "updated", "score"];
const SORT_ON_RECEIPTS = ["created", "updated", "receipt_id"];
const SORT_ORDERS = ["asc", "ascending", "desc", "descending", "up", "down"];
const INCLUDES_VALUES = new Set([
  "Images", "Inventory", "Shipping", "Shop", "User", "Videos", "Translations",
]);
const IMAGE_FORM_FIELDS = new Set([
  "image", "listing_image_id", "rank", "overwrite", "is_watermarked", "alt_text",
]);
const FILE_FORM_FIELDS = new Set(["file", "listing_file_id", "name", "rank"]);

function jsonResponse(status, obj, extraHeaders) {
  const headers = { "content-type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(obj), { status, headers });
}

function htmlResponse(status, title, message) {
  const body =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>" + title +
    "</title></head><body><h1>" + title + "</h1><p>" + message +
    "</p></body></html>";
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// The owner initiation page for /oauth/authorize. Plain HTML with one form,
// no script, no inline event handlers, and no external resources. Built by
// string concatenation only, so the served bytes contain no template
// sequences at all.
function authorizePageResponse() {
  const body =
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<title>Connect FultonPrintables</title></head><body>" +
    "<h1>Connect FultonPrintables to Etsy</h1>" +
    "<p>Owner step: enter the gateway setup secret to begin Etsy " +
    "authorization. Muse does not know this secret and cannot perform " +
    "this step for you.</p>" +
    "<form method=\"POST\" action=\"/oauth/authorize\">" +
    "<label>Setup secret " +
    "<input type=\"password\" name=\"setup_secret\" autocomplete=\"off\" required>" +
    "</label> " +
    "<button type=\"submit\">Begin authorization</button>" +
    "</form></body></html>";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// 32 random bytes encoded as url-safe base64: 256 bits of entropy, 43 chars.
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// PKCE verifier and OAuth state both use the 32-byte form Etsy recommends:
// encode 32 bytes of random data into url-safe base64 (43 characters, inside
// the RFC 7636 range of 43 to 128).
export function generatePkceVerifier() {
  return randomToken();
}

export function generateState() {
  return randomToken();
}

// PKCE S256 challenge for a verifier, per RFC 7636.
export async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

export function parseUserId(accessToken) {
  if (typeof accessToken !== "string") return null;
  const dot = accessToken.indexOf(".");
  if (dot <= 0) return null;
  const prefix = accessToken.slice(0, dot);
  return prefix.length > 0 ? prefix : null;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time comparison: compare SHA-256 digests byte by byte so the
// result does not depend on where the first difference falls.
async function timingSafeEqual(a, b) {
  const ha = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(a || ""))
  );
  const hb = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b || ""))
  );
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

// Granted-scope assessment for a token response. Etsy's Authentication
// documentation specifies the token response field "scope" as "a
// space-delimited string of the scopes actually granted to the access
// token, which may be a subset of the requested scopes" (authorization
// code grant), and documents the same field on the refresh grant
// response. That field is the only documented source of granted scopes:
// the official OpenAPI specification defines no token introspection or
// scope-reading endpoint. When a response carries no usable scope string,
// the granted scopes cannot be established from Etsy data and the status
// stays (or becomes) "unverified"; a previous status is preserved because
// a refresh without scope information contradicts nothing.
function grantedScopeInfo(tokenResponse, previous) {
  const raw =
    tokenResponse && typeof tokenResponse.scope === "string"
      ? tokenResponse.scope.trim()
      : "";
  if (raw) {
    const granted = raw.split(/\s+/).filter(Boolean);
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    return {
      scope: granted.join(" "),
      scope_status: missing.length === 0 ? "verified" : "incomplete",
      scopes_confirmed_at: null,
    };
  }
  return {
    scope: previous ? previous.scope || null : null,
    scope_status: previous
      ? previous.scope_status || "unverified"
      : "unverified",
    scopes_confirmed_at: previous
      ? previous.scopes_confirmed_at || null
      : null,
  };
}

function tokenRecordFrom(tokenResponse, previous) {
  const now = Date.now();
  const expiresIn = Number(tokenResponse.expires_in || 3600);
  const scopeInfo = grantedScopeInfo(tokenResponse, previous);
  return {
    access_token: tokenResponse.access_token,
    refresh_token:
      tokenResponse.refresh_token || (previous ? previous.refresh_token : null),
    expires_at: now + expiresIn * 1000,
    user_id:
      parseUserId(tokenResponse.access_token) ||
      (previous ? previous.user_id : null),
    shop_id: previous ? previous.shop_id : null,
    scope: scopeInfo.scope,
    scope_status: scopeInfo.scope_status,
    scopes_confirmed_at: scopeInfo.scopes_confirmed_at,
  };
}

async function postTokenRequest(env, formFields, fetchFn) {
  const doFetch = fetchFn || fetch;
  const body = new URLSearchParams(formFields);
  let response;
  try {
    response = await doFetch(ETSY_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function storageRead(storage, key) {
  const value = await storage.get(key);
  return value === undefined || value === null ? null : value;
}

// ---------------------------------------------------------------------------
// Durable Object: EtsyTokenStore
//
// Owns all critical OAuth state so operations serialize in one place:
//   - oauth_state records (single-use, expiring) for the authorize flow
//   - the current token record, including serialized token refresh
//   - idempotency records for draft listing creation
//   - per-listing publish locks
//   - the gateway rate-limit windows (API traffic and setup attempts)
//
// Atomicity: executing inside one Durable Object does NOT by itself make
// an asynchronous read-modify-write sequence atomic. Every
// read-modify-write below therefore runs inside runTransaction, which
//   (a) chains calls through a per-instance promise queue, so two
//       transactions in this instance can never interleave, and
//   (b) delegates the callback to storage.transaction when the storage
//       provides it (production Durable Object storage, and the test
//       stub, which implements snapshot-and-rollback on throw).
// A transaction that throws therefore leaves storage unchanged, and a
// check-then-write pair (consume a state, begin an idempotent operation,
// take a publish lock, count a rate stamp) is decided against one
// consistent snapshot of the record it guards.
//
// The constructor accepts either a Durable Object state object (which has
// a .storage property) or a bare storage object with
// get/put/delete/list/transaction, so the logic runs in plain node tests
// with an in-memory stub.
// ---------------------------------------------------------------------------
export class EtsyTokenStore {
  constructor(stateOrStorage, env) {
    this.storage =
      stateOrStorage && stateOrStorage.storage
        ? stateOrStorage.storage
        : stateOrStorage;
    this.env = env || {};
    this.refreshPromise = null;
    this.txQueue = Promise.resolve();
  }

  async storageGet(key) {
    return storageRead(this.storage, key);
  }

  // Serialized transaction runner. The queue is kept alive across
  // failures: a rejected transaction rejects only its own caller.
  runTransaction(fn) {
    const run = this.txQueue.then(() => this.executeTransaction(fn));
    this.txQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async executeTransaction(fn) {
    const storage = this.storage;
    if (storage && typeof storage.transaction === "function") {
      return storage.transaction(async (txn) => fn(txn));
    }
    return fn(storage);
  }

  async handleStateCreate(payload) {
    return this.runTransaction(async (s) => {
      const now = Date.now();
      const listed = await s.list({ prefix: STATE_PREFIX });
      let live = 0;
      for (const [key, value] of listed) {
        if (!value || value.expires_at <= now) {
          await s.delete(key);
        } else {
          live += 1;
        }
      }
      if (live >= MAX_OUTSTANDING_STATES) {
        return { ok: false, error: "too_many_states" };
      }
      await s.put(STATE_PREFIX + payload.state, {
        verifier: payload.verifier,
        expires_at: payload.expires_at,
      });
      return { ok: true };
    });
  }

  // Single use is enforced inside the transaction: the record is read
  // and deleted in the same atomic step, so two simultaneous callbacks
  // with the same state cannot both receive the verifier.
  async handleStateConsume(payload) {
    const key = STATE_PREFIX + payload.state;
    return this.runTransaction(async (s) => {
      const record = await storageRead(s, key);
      if (record !== null) await s.delete(key);
      if (!record) return { ok: false, reason: "unknown" };
      if (!record.expires_at || record.expires_at <= Date.now()) {
        return { ok: false, reason: "expired" };
      }
      return { ok: true, verifier: record.verifier };
    });
  }

  async handleTokensGet() {
    return { record: await this.storageGet(TOKEN_KEY) };
  }

  // Initial authorization write only. This is a single unconditional put
  // of a complete new record, not a read-modify-write: there is no
  // previously fetched copy involved, so no stale field can be written
  // back. Every later token write goes through handleTokensEnsure or
  // handleTokensShopMeta, which merge against the current stored record
  // inside a transaction.
  async handleTokensPut(payload) {
    await this.storage.put(TOKEN_KEY, payload.record);
    return { ok: true };
  }

  // Returns one of:
  //   { status: "missing" }            no usable token record stored
  //   { status: "fresh", record }      access token still valid
  //   { status: "refreshed", record }  a refresh just completed
  //   { status: "failed" }             refresh was attempted and failed
  // Concurrent callers share a single in-flight refresh promise, so a
  // rotating refresh token can never be spent twice. The freshness check
  // and the promise assignment happen in one synchronous segment, so a
  // second caller cannot slip between them. The final write merges the
  // token response against the CURRENT stored record inside a
  // transaction and is abandoned if a different rotation already landed,
  // so a refresh can never overwrite newer tokens or shop metadata.
  async handleTokensEnsure() {
    const record = await this.storageGet(TOKEN_KEY);
    if (!record || !record.access_token || !record.refresh_token) {
      return { status: "missing" };
    }
    if (record.expires_at && record.expires_at - Date.now() > REFRESH_SKEW_MS) {
      return { status: "fresh", record };
    }
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const current = await this.runTransaction((s) =>
          storageRead(s, TOKEN_KEY)
        );
        if (!current || !current.refresh_token) return { status: "missing" };
        if (
          current.expires_at &&
          current.expires_at - Date.now() > REFRESH_SKEW_MS
        ) {
          return { status: "fresh", record: current };
        }
        const spentRefreshToken = current.refresh_token;
        const tokenResponse = await postTokenRequest(this.env, {
          grant_type: "refresh_token",
          client_id: this.env.ETSY_KEYSTRING,
          refresh_token: spentRefreshToken,
        });
        if (!tokenResponse || !tokenResponse.access_token) {
          return { status: "failed" };
        }
        const written = await this.runTransaction(async (s) => {
          const latest = (await storageRead(s, TOKEN_KEY)) || current;
          if (latest.refresh_token !== spentRefreshToken) {
            return latest;
          }
          const next = tokenRecordFrom(tokenResponse, latest);
          await s.put(TOKEN_KEY, next);
          return next;
        });
        return { status: "refreshed", record: written };
      } catch {
        return { status: "failed" };
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  // Dedicated shop metadata update. Merges only shop_id (and user_id when
  // the stored record has none) into the CURRENT stored record inside
  // one transaction, preserving the access token, refresh token, expiry,
  // and scope fields exactly as stored. Token refresh and this update
  // therefore cannot silently overwrite each other.
  async handleTokensShopMeta(payload) {
    return this.runTransaction(async (s) => {
      const current = await storageRead(s, TOKEN_KEY);
      if (!current) return { ok: false, error: "no_tokens" };
      const next = Object.assign({}, current);
      if (payload.shop_id) next.shop_id = payload.shop_id;
      if (payload.user_id && !current.user_id) next.user_id = payload.user_id;
      await s.put(TOKEN_KEY, next);
      return { ok: true, record: next };
    });
  }

  // Owner scope confirmation, reachable only through the setup-secret
  // gated Worker route. Resolves ONLY the "unverified" state (Etsy
  // returned no usable scope information). A record Etsy reported as
  // "incomplete" can never be confirmed over: the granted scopes are a
  // documented fact in that case, and the fix is a fresh consent.
  async handleScopesConfirm() {
    return this.runTransaction(async (s) => {
      const current = await storageRead(s, TOKEN_KEY);
      if (!current) return { ok: false, reason: "no_tokens" };
      if (current.scope_status === "verified") {
        return { ok: true, scope_status: "verified", already: true };
      }
      if (current.scope_status === "incomplete") {
        return {
          ok: false,
          reason: "incomplete",
          scope_status: "incomplete",
        };
      }
      const confirmedAt = Date.now();
      const next = Object.assign({}, current, {
        scope_status: "owner_confirmed",
        scopes_confirmed_at: confirmedAt,
      });
      await s.put(TOKEN_KEY, next);
      return {
        ok: true,
        scope_status: "owner_confirmed",
        scopes_confirmed_at: confirmedAt,
      };
    });
  }

  // ------------------------------------------------------------------
  // Idempotency operation state machine (lease correction).
  //
  // Execution ownership and lease are separate concepts. The op_id
  // written at begin is the execution owner for the life of the
  // operation. The lease (IDEM_IN_PROGRESS_MS) only bounds how long a
  // begin caller is told "in_progress"; its expiry NEVER transfers
  // ownership and NEVER by itself authorizes another external side
  // effect, because the original create may have reached Etsy while
  // its response was lost.
  //
  // States:
  //   in_progress  owner executing, lease live
  //   completed    a definite successful response is stored for replay
  //   failed       a definite outcome (Etsy returned non-2xx, or the
  //                gateway rejected before any Etsy call); a retry
  //                with the same key and hash starts a NEW attempt
  //   uncertain    the lease expired while in_progress, or the owner
  //                marked the outcome unknown; only the recovery path
  //                (reconcile, then owner abandon) can move it
  //   abandoned    owner-resolved from uncertain; terminal for the
  //                record, and the key may start a genuinely new
  //                operation
  //
  // Records written by this build carry version 2. Older records (no
  // version field) are normalized by normalizeIdemRecord: a completed
  // record still replays, and an in-progress record is judged by its
  // stored_at as both attempt start and lease start, so a stale legacy
  // record lands in uncertain like any other expired lease, never in a
  // takeover.
  // ------------------------------------------------------------------
  normalizeIdemRecord(existing) {
    if (!existing || existing.version === IDEM_RECORD_VERSION) {
      return existing;
    }
    const started = existing.stored_at || 0;
    return Object.assign({}, existing, {
      version: IDEM_RECORD_VERSION,
      fingerprint: existing.fingerprint || null,
      attempts: existing.attempts || 1,
      created_at: existing.created_at || started,
      first_created_at: existing.first_created_at || started,
      updated_at: existing.updated_at || started,
      lease_expires_at:
        existing.lease_expires_at || started + IDEM_IN_PROGRESS_MS,
      history: existing.history || [],
    });
  }

  appendIdemHistory(record, entry) {
    const history = Array.isArray(record.history) ? record.history.slice() : [];
    history.push(entry);
    return history.slice(-10);
  }

  freshIdemRecord(payload, opId, now) {
    return {
      version: IDEM_RECORD_VERSION,
      hash: payload.hash,
      fingerprint: payload.fingerprint || null,
      state: "in_progress",
      op_id: opId,
      attempts: 1,
      created_at: now,
      first_created_at: now,
      updated_at: now,
      stored_at: now,
      lease_expires_at: now + IDEM_IN_PROGRESS_MS,
      history: [{ event: "begin", attempt: 1, at: now }],
    };
  }

  // Begin an idempotent draft creation, decided and written in one
  // transaction. Possible actions: proceed (this caller owns a new
  // attempt), replay (stored completed response), conflict (same key,
  // different request), in_progress (live lease held by the owner),
  // uncertain (the operation's outcome is unknown; no new attempt may
  // start and no Etsy call may be made under this key).
  async handleIdemBegin(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    const opId = randomToken();
    return this.runTransaction(async (s) => {
      const now = Date.now();
      let existing = await storageRead(s, key);
      if (existing) existing = this.normalizeIdemRecord(existing);
      if (existing) {
        // Retention: completed, failed, and abandoned records fall out
        // after IDEM_TTL_MS and the key may start over. In-progress and
        // uncertain records are never dropped by age: expiry of time
        // alone must not silently free a key whose external effect is
        // unresolved.
        const droppable =
          existing.state === "completed" ||
          existing.state === "failed" ||
          existing.state === "abandoned";
        if (droppable && now - existing.stored_at >= IDEM_TTL_MS) {
          existing = null;
        }
      }
      if (existing && existing.state === "abandoned") {
        // The owner already resolved that nothing was created under
        // this key, so a new begin is treated exactly like no record.
        existing = null;
      }
      if (existing) {
        if (existing.state === "uncertain") {
          // An uncertain record answers uncertain to a same-hash begin
          // and conflict to a different hash. Only the recovery path
          // can move it; a begin never can, at any age.
          if (existing.hash !== payload.hash) return { action: "conflict" };
          return { action: "uncertain", state: "uncertain" };
        }
        if (existing.hash !== payload.hash) return { action: "conflict" };
        if (existing.state === "completed") {
          return {
            action: "replay",
            status: existing.status,
            body: existing.body,
          };
        }
        if (existing.state === "in_progress") {
          if (now < existing.lease_expires_at) {
            return { action: "in_progress" };
          }
          // Lease expired while the owner was executing. The Etsy-side
          // effect is unknown, so the record becomes uncertain with its
          // ownership, hash, fingerprint, and history preserved. This
          // is deliberately NOT a takeover.
          const transitioned = Object.assign({}, existing, {
            state: "uncertain",
            uncertain_at: now,
            updated_at: now,
            stored_at: now,
            lease_expires_at: null,
            history: this.appendIdemHistory(existing, {
              event: "lease_expired_uncertain",
              at: now,
            }),
          });
          await s.put(key, transitioned);
          return { action: "uncertain", state: "uncertain" };
        }
        if (existing.state === "failed") {
          // A definite failure means the prior attempt provably created
          // nothing, so a retry with the same key and hash is safe as a
          // NEW attempt under a NEW owner. History and the failure are
          // preserved; the attempt counter increments.
          const attempts = (existing.attempts || 1) + 1;
          const next = {
            version: IDEM_RECORD_VERSION,
            hash: existing.hash,
            fingerprint: payload.fingerprint || existing.fingerprint || null,
            state: "in_progress",
            op_id: opId,
            attempts,
            created_at: now,
            first_created_at: existing.first_created_at || existing.created_at,
            updated_at: now,
            stored_at: now,
            lease_expires_at: now + IDEM_IN_PROGRESS_MS,
            failure_status: existing.failure_status || null,
            failed_at: existing.failed_at || null,
            history: this.appendIdemHistory(existing, {
              event: "retry_begin",
              attempt: attempts,
              at: now,
            }),
          };
          await s.put(key, next);
          return { action: "proceed", op_id: opId, attempts };
        }
      }
      await s.put(key, this.freshIdemRecord(payload, opId, now));
      return { action: "proceed", op_id: opId, attempts: 1 };
    });
  }

  // Only the operation that owns the record may complete it, and only
  // from in_progress. A non-owner completion, and any completion of an
  // uncertain record (ownership survives lease expiry), is rejected and
  // the record is left unchanged.
  async handleIdemComplete(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: false, error: "no_such_operation" };
      if (
        existing.state !== "in_progress" ||
        existing.op_id !== payload.op_id
      ) {
        return { ok: false, error: "not_operation_owner" };
      }
      const now = Date.now();
      await s.put(
        key,
        Object.assign({}, existing, {
          state: "completed",
          status: payload.status,
          body: payload.body,
          result_listing_id:
            payload.result_listing_id !== undefined
              ? payload.result_listing_id
              : existing.result_listing_id || null,
          recovered: false,
          completed_at: now,
          updated_at: now,
          stored_at: now,
          lease_expires_at: null,
          history: this.appendIdemHistory(existing, {
            event: "completed",
            at: now,
          }),
        })
      );
      return { ok: true };
    });
  }

  // Record a DEFINITE failure: Etsy returned a non-2xx response, so the
  // attempt provably created nothing and a later retry is safe. Only
  // the owning operation may fail its record, and only from
  // in_progress. The record is kept (state "failed") rather than
  // deleted, so the attempt history survives and a retry begins as a
  // counted new attempt. Reached as /idem/fail; /idem/abort remains as
  // a legacy alias for the same operation.
  async handleIdemFail(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: true };
      if (
        existing.state !== "in_progress" ||
        existing.op_id !== payload.op_id
      ) {
        return { ok: false, error: "not_operation_owner" };
      }
      const now = Date.now();
      await s.put(
        key,
        Object.assign({}, existing, {
          state: "failed",
          failure_status:
            payload.status !== undefined ? payload.status : null,
          failed_at: now,
          updated_at: now,
          stored_at: now,
          lease_expires_at: null,
          history: this.appendIdemHistory(existing, {
            event: "failed",
            status: payload.status !== undefined ? payload.status : null,
            at: now,
          }),
        })
      );
      return { ok: true };
    });
  }

  // The owning operation marks its own outcome unknown: the Etsy call
  // failed in a way that leaves the Etsy-side effect undetermined (a
  // network error or timeout after the request may have been sent).
  // Owner-only and transactional, like complete and fail. Marking an
  // already uncertain record with the same owner is a no-op success.
  async handleIdemUncertain(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: false, error: "no_such_operation" };
      if (existing.op_id !== payload.op_id) {
        return { ok: false, error: "not_operation_owner" };
      }
      if (existing.state === "uncertain") return { ok: true };
      if (existing.state !== "in_progress") {
        return { ok: false, error: "not_operation_owner" };
      }
      const now = Date.now();
      await s.put(
        key,
        Object.assign({}, existing, {
          state: "uncertain",
          uncertain_at: now,
          updated_at: now,
          stored_at: now,
          lease_expires_at: null,
          history: this.appendIdemHistory(existing, {
            event: "marked_uncertain",
            at: now,
          }),
        })
      );
      return { ok: true };
    });
  }

  // Public view of an idempotency record for the operations status
  // route. Deliberately excludes the op_id (an ownership capability),
  // the stored response body, and any token or secret material.
  async handleIdemGet(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    const existing = await storageRead(this.storage, key);
    if (!existing) return { found: false };
    const record = this.normalizeIdemRecord(existing);
    return {
      found: true,
      state: record.state,
      attempts: record.attempts || 1,
      fingerprint: record.fingerprint || null,
      fingerprint_title:
        record.fingerprint && record.fingerprint.title
          ? record.fingerprint.title
          : null,
      created_at: record.created_at || null,
      updated_at: record.updated_at || record.stored_at || null,
      result_listing_id: record.result_listing_id || null,
      recovered: record.recovered === true,
      failure_status:
        record.failure_status !== undefined ? record.failure_status : null,
      uncertain_at: record.uncertain_at || null,
      abandoned_at: record.abandoned_at || null,
    };
  }

  // Reconciliation resolution: the Worker found exactly one listing
  // matching the stored fingerprint, so the record completes with a
  // synthesized stored response that references the found listing and
  // carries the recovered flag. The state is re-checked inside the
  // transaction, so a record resolved by another path in the meantime
  // is never overwritten.
  async handleIdemReconcileResolve(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: false, state: null };
      if (existing.state !== "uncertain") {
        return { ok: false, state: existing.state };
      }
      const now = Date.now();
      const body = JSON.stringify({
        listing_id: payload.listing_id,
        recovered: true,
        reconciled: true,
        title:
          existing.fingerprint && existing.fingerprint.title
            ? existing.fingerprint.title
            : null,
      });
      await s.put(
        key,
        Object.assign({}, existing, {
          state: "completed",
          status: 201,
          body,
          result_listing_id: payload.listing_id,
          recovered: true,
          completed_at: now,
          updated_at: now,
          stored_at: now,
          lease_expires_at: null,
          history: this.appendIdemHistory(existing, {
            event: "reconciled",
            listing_id: payload.listing_id,
            at: now,
          }),
        })
      );
      return { ok: true, state: "completed", listing_id: payload.listing_id };
    });
  }

  // Owner abandonment of an uncertain operation: a human judgment,
  // gated by the setup secret at the Worker, that nothing was created
  // under this key. Only valid from uncertain. The record becomes
  // terminal "abandoned" and the key may start a genuinely new
  // operation afterwards.
  async handleIdemAbandon(payload) {
    const key = IDEM_KEY_PREFIX + payload.key;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: false, state: null };
      if (existing.state !== "uncertain") {
        return { ok: false, state: existing.state };
      }
      const now = Date.now();
      await s.put(
        key,
        Object.assign({}, existing, {
          state: "abandoned",
          abandoned_at: now,
          updated_at: now,
          stored_at: now,
          lease_expires_at: null,
          history: this.appendIdemHistory(existing, {
            event: "abandoned",
            at: now,
          }),
        })
      );
      return { ok: true, state: "abandoned" };
    });
  }

  // Rate window check-and-count in one transaction, so concurrent
  // callers cannot collectively exceed the limit. With record set to
  // false the call is a peek: it reports whether the window is already
  // at the limit without adding a stamp (used before a setup-secret
  // verification, where only failures are recorded).
  async handleRateCheck(payload) {
    const key = "rate:" + payload.identity;
    const limit = payload.limit;
    const windowMs = payload.windowMs || RATE_WINDOW_MS;
    const shouldRecord = payload.record !== false;
    return this.runTransaction(async (s) => {
      const now = Date.now();
      const raw = (await storageRead(s, key)) || [];
      const stamps = raw.filter((t) => t > now - windowMs);
      if (stamps.length >= limit) {
        const retryAfter = Math.max(
          1,
          Math.ceil((stamps[0] + windowMs - now) / 1000)
        );
        if (stamps.length !== raw.length) await s.put(key, stamps);
        return { allowed: false, retry_after: retryAfter };
      }
      if (shouldRecord) {
        stamps.push(now);
        await s.put(key, stamps);
      } else if (stamps.length !== raw.length) {
        await s.put(key, stamps);
      }
      return { allowed: true, remaining: limit - stamps.length };
    });
  }

  // Single unconditional delete of one rate window. Not a
  // read-modify-write, so no transaction is needed.
  async handleRateClear(payload) {
    await this.storage.delete("rate:" + payload.identity);
    return { ok: true };
  }

  // Per-listing publish lock. Acquisition is decided and written inside
  // one transaction, so two simultaneous publish attempts for the same
  // listing cannot both hold the lock; locks for different listings are
  // independent records and never block each other.
  async handlePublishAcquire(payload) {
    const key = PUBLISH_LOCK_PREFIX + payload.listing_id;
    const lockToken = randomToken();
    const acquired = await this.runTransaction(async (s) => {
      const now = Date.now();
      const existing = await storageRead(s, key);
      if (existing && existing.expires_at > now) return false;
      await s.put(key, {
        token: lockToken,
        expires_at: now + PUBLISH_LOCK_MS,
      });
      return true;
    });
    return acquired
      ? { acquired: true, lock_token: lockToken }
      : { acquired: false };
  }

  // Only the lock owner may release. Releasing a lock that is already
  // gone (expired and swept, or never held) is a no-op success.
  async handlePublishRelease(payload) {
    const key = PUBLISH_LOCK_PREFIX + payload.listing_id;
    return this.runTransaction(async (s) => {
      const existing = await storageRead(s, key);
      if (!existing) return { ok: true };
      if (existing.token !== payload.lock_token) {
        return { ok: false, error: "not_lock_owner" };
      }
      await s.delete(key);
      return { ok: true };
    });
  }

  async fetch(request) {
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: "bad_store_request" });
    }
    const path = new URL(request.url).pathname;
    let result;
    switch (path) {
      case "/state/create":
        result = await this.handleStateCreate(payload);
        break;
      case "/state/consume":
        result = await this.handleStateConsume(payload);
        break;
      case "/tokens/get":
        result = await this.handleTokensGet();
        break;
      case "/tokens/put":
        result = await this.handleTokensPut(payload);
        break;
      case "/tokens/ensure":
        result = await this.handleTokensEnsure();
        break;
      case "/tokens/shop-meta":
        result = await this.handleTokensShopMeta(payload);
        break;
      case "/scopes/confirm":
        result = await this.handleScopesConfirm(payload);
        break;
      case "/idem/begin":
        result = await this.handleIdemBegin(payload);
        break;
      case "/idem/complete":
        result = await this.handleIdemComplete(payload);
        break;
      case "/idem/fail":
        result = await this.handleIdemFail(payload);
        break;
      case "/idem/abort":
        // Legacy alias for /idem/fail, kept so older callers and tests
        // keep their meaning: record a definite failure, owner-only.
        result = await this.handleIdemFail(payload);
        break;
      case "/idem/uncertain":
        result = await this.handleIdemUncertain(payload);
        break;
      case "/idem/get":
        result = await this.handleIdemGet(payload);
        break;
      case "/idem/reconcile-resolve":
        result = await this.handleIdemReconcileResolve(payload);
        break;
      case "/idem/abandon":
        result = await this.handleIdemAbandon(payload);
        break;
      case "/rate/check":
        result = await this.handleRateCheck(payload);
        break;
      case "/rate/clear":
        result = await this.handleRateClear(payload);
        break;
      case "/publish/acquire":
        result = await this.handlePublishAcquire(payload);
        break;
      case "/publish/release":
        result = await this.handlePublishRelease(payload);
        break;
      default:
        return jsonResponse(404, { error: "store_route_not_found" });
    }
    return jsonResponse(200, result);
  }
}

function storeStub(env) {
  const id = env.TOKEN_STORE.idFromName(STORE_NAME);
  return env.TOKEN_STORE.get(id);
}

async function storeCall(env, op, payload) {
  const stub = storeStub(env);
  const response = await stub.fetch("https://token-store/" + op, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Validation and form encoding
//
// Muse-facing request bodies are JSON. Etsy endpoints used here contract
// application/x-www-form-urlencoded bodies in Etsy's official OpenAPI
// specification, so validated JSON is converted with encodeForm before any
// upstream call. Nothing reaches Etsy unless it passes these checks.
// ---------------------------------------------------------------------------
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isIntArray(value) {
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}

function encodeForm(obj) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (typeof value === "boolean") {
      params.append(key, value ? "true" : "false");
    } else {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

// Each validator returns an error string, or null when the body is valid.
function validateCreateListing(body) {
  if (!isPlainObject(body)) return "body_must_be_a_json_object";
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) return "field_not_allowed:" + key;
  }
  for (const field of CREATE_REQUIRED) {
    if (body[field] === undefined || body[field] === null) {
      return "missing_field:" + field;
    }
  }
  if (!isPositiveInt(body.quantity)) return "invalid_field:quantity";
  if (
    typeof body.title !== "string" ||
    body.title.length === 0 ||
    body.title.length > TITLE_MAX_CHARS
  ) {
    return "invalid_field:title";
  }
  if (
    typeof body.description !== "string" ||
    body.description.length === 0 ||
    body.description.length > DESCRIPTION_MAX_CHARS
  ) {
    return "invalid_field:description";
  }
  if (!isPositiveNumber(body.price)) return "invalid_field:price";
  if (!WHO_MADE_VALUES.includes(body.who_made)) return "invalid_field:who_made";
  if (!WHEN_MADE_VALUES.includes(body.when_made)) {
    return "invalid_field:when_made";
  }
  if (!isPositiveInt(body.taxonomy_id)) return "invalid_field:taxonomy_id";
  if (body.type !== undefined && !LISTING_TYPE_VALUES.includes(body.type)) {
    return "invalid_field:type";
  }
  if (body.image_ids !== undefined && !isIntArray(body.image_ids)) {
    return "invalid_field:image_ids";
  }
  if (body.materials !== undefined && !isStringArray(body.materials)) {
    return "invalid_field:materials";
  }
  if (body.tags !== undefined && !isStringArray(body.tags)) {
    return "invalid_field:tags";
  }
  if (body.styles !== undefined && !isStringArray(body.styles)) {
    return "invalid_field:styles";
  }
  for (const field of ["shipping_profile_id", "readiness_state_id", "return_policy_id", "shop_section_id"]) {
    if (body[field] !== undefined && !isPositiveInt(body[field])) {
      return "invalid_field:" + field;
    }
  }
  // Etsy's listings tutorial: shipping_profile_id and readiness_state_id are
  // required for physical listings. Digital (download) listings do not need
  // them. A missing type is treated as physical, which is Etsy's default
  // listing kind in the create endpoint documentation.
  const type = body.type || "physical";
  if (type === "physical" || type === "both") {
    if (!isPositiveInt(body.shipping_profile_id)) {
      return "missing_field:shipping_profile_id";
    }
    if (!isPositiveInt(body.readiness_state_id)) {
      return "missing_field:readiness_state_id";
    }
  }
  return null;
}

function validateUpdateListing(body) {
  if (!isPlainObject(body)) return "body_must_be_a_json_object";
  const keys = Object.keys(body);
  if (keys.length === 0) return "empty_update";
  for (const key of keys) {
    if (!UPDATE_FIELDS.has(key)) return "field_not_allowed:" + key;
  }
  if (body.state !== undefined && !UPDATE_STATE_VALUES.includes(body.state)) {
    return "invalid_field:state";
  }
  if (body.type !== undefined && !LISTING_TYPE_VALUES.includes(body.type)) {
    return "invalid_field:type";
  }
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" ||
      body.title.length === 0 ||
      body.title.length > TITLE_MAX_CHARS)
  ) {
    return "invalid_field:title";
  }
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" ||
      body.description.length > DESCRIPTION_MAX_CHARS)
  ) {
    return "invalid_field:description";
  }
  if (body.taxonomy_id !== undefined && !isPositiveInt(body.taxonomy_id)) {
    return "invalid_field:taxonomy_id";
  }
  if (body.who_made !== undefined && !WHO_MADE_VALUES.includes(body.who_made)) {
    return "invalid_field:who_made";
  }
  if (body.when_made !== undefined && !WHEN_MADE_VALUES.includes(body.when_made)) {
    return "invalid_field:when_made";
  }
  if (body.image_ids !== undefined && !isIntArray(body.image_ids)) {
    return "invalid_field:image_ids";
  }
  return null;
}

function validateUpdateShop(body) {
  if (!isPlainObject(body)) return "body_must_be_a_json_object";
  const keys = Object.keys(body);
  if (keys.length === 0) return "empty_update";
  for (const key of keys) {
    if (!SHOP_FIELDS.has(key)) return "field_not_allowed:" + key;
    const value = body[key];
    if (typeof value !== "string" || value.length > SHOP_TEXT_MAX_CHARS) {
      return "invalid_field:" + key;
    }
  }
  return null;
}

const INT_QUERY_PARAMS = new Set([
  "limit", "offset", "min_created", "max_created", "min_last_modified",
  "max_last_modified",
]);
const BOOL_QUERY_PARAMS = new Set([
  "was_paid", "was_shipped", "was_delivered", "was_canceled", "legacy",
]);

// Validates list and receipt query parameters against the documented
// allowlists in Etsy's OpenAPI specification. Returns { error } or
// { search } with a query string built only from validated parameters.
function validateReadQuery(url, kind) {
  const allowed =
    kind === "listings"
      ? new Set(["state", "limit", "offset", "sort_on", "sort_order", "includes"])
      : new Set([
          "min_created", "max_created", "min_last_modified",
          "max_last_modified", "limit", "offset", "sort_on", "sort_order",
          "was_paid", "was_shipped", "was_delivered", "was_canceled", "legacy",
        ]);
  const out = new URLSearchParams();
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowed.has(name)) return { error: "query_param_not_allowed:" + name };
    const value = url.searchParams.get(name);
    if (INT_QUERY_PARAMS.has(name)) {
      if (!/^\d+$/.test(value)) return { error: "invalid_query_param:" + name };
      const n = Number(value);
      if (name === "limit" && (n < 1 || n > 100)) {
        return { error: "invalid_query_param:limit" };
      }
      out.set(name, String(n));
    } else if (BOOL_QUERY_PARAMS.has(name)) {
      if (value !== "true" && value !== "false") {
        return { error: "invalid_query_param:" + name };
      }
      out.set(name, value);
    } else if (name === "state") {
      if (!LISTING_STATES.includes(value)) {
        return { error: "invalid_query_param:state" };
      }
      out.set(name, value);
    } else if (name === "sort_on") {
      const values = kind === "listings" ? SORT_ON_LISTINGS : SORT_ON_RECEIPTS;
      if (!values.includes(value)) return { error: "invalid_query_param:sort_on" };
      out.set(name, value);
    } else if (name === "sort_order") {
      if (!SORT_ORDERS.includes(value)) {
        return { error: "invalid_query_param:sort_order" };
      }
      out.set(name, value);
    } else if (name === "includes") {
      const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (!INCLUDES_VALUES.has(part)) {
          return { error: "invalid_query_param:includes" };
        }
      }
      out.set(name, parts.join(","));
    }
  }
  const search = out.toString();
  return { search: search ? "?" + search : "" };
}

// Reads a JSON request body with a hard size cap. Returns { body } with the
// parsed object and the raw text, or { response } with a finished error.
async function readJsonRequest(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > JSON_MAX_BYTES) {
    return { response: jsonResponse(413, { error: "request_too_large" }) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > JSON_MAX_BYTES) {
    return { response: jsonResponse(413, { error: "request_too_large" }) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { response: jsonResponse(400, { error: "malformed_json" }) };
  }
  return { body: parsed, rawText: text };
}

// ---------------------------------------------------------------------------
// Setup-secret guard for the two owner-only OAuth actions: initiating an
// authorization flow and confirming granted scopes. The setup secret is a
// separate Worker secret the owner sets at deploy time. It is never
// available to the Muse connector, never accepted in a query string
// (URLs get logged), and never returned in any response. Failed attempts
// are rate limited per source through the Durable Object.
// ---------------------------------------------------------------------------
function setupIdentity(request) {
  return "oauth-setup:" + (request.headers.get("cf-connecting-ip") || "unknown");
}

// Returns { ok: true } or { response } with a finished error response.
async function checkSetupSecret(request, env, provided) {
  const identity = setupIdentity(request);
  const peek = await storeCall(env, "rate/check", {
    identity,
    limit: SETUP_FAIL_LIMIT,
    windowMs: SETUP_FAIL_WINDOW_MS,
    record: false,
  });
  if (!peek.allowed) {
    return {
      response: jsonResponse(
        429,
        { error: "too_many_failed_attempts" },
        { "retry-after": String(peek.retry_after || 60) }
      ),
    };
  }
  if (
    !env.SETUP_SECRET ||
    !provided ||
    !(await timingSafeEqual(String(provided), env.SETUP_SECRET))
  ) {
    await storeCall(env, "rate/check", {
      identity,
      limit: SETUP_FAIL_LIMIT,
      windowMs: SETUP_FAIL_WINDOW_MS,
    });
    return { response: jsonResponse(403, { error: "setup_secret_rejected" }) };
  }
  return { ok: true };
}

function queryCarriesSetupSecret(url) {
  return url.searchParams.has("setup_secret") || url.searchParams.has("setup");
}

// ---------------------------------------------------------------------------
// OAuth handlers
// ---------------------------------------------------------------------------
// GET /oauth/authorize serves only the owner initiation page. It creates
// no state and starts no flow by itself.
async function handleAuthorizePage(request, env) {
  const url = new URL(request.url);
  if (queryCarriesSetupSecret(url)) {
    return jsonResponse(400, { error: "setup_secret_in_query_not_allowed" });
  }
  return authorizePageResponse();
}

// POST /oauth/authorize initiates a flow, but only for the owner: the
// setup secret must arrive in the x-setup-secret header or as the form
// field of the initiation page. State and PKCE are created exactly as
// before, after the secret check passes.
async function handleAuthorizeSubmit(request, env) {
  const url = new URL(request.url);
  if (queryCarriesSetupSecret(url)) {
    return jsonResponse(400, { error: "setup_secret_in_query_not_allowed" });
  }
  let provided = request.headers.get("x-setup-secret");
  if (!provided) {
    const contentType = request.headers.get("content-type") || "";
    if (
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("multipart/form-data")
    ) {
      try {
        const form = await request.formData();
        provided = form.get("setup_secret");
      } catch {
        provided = null;
      }
    }
  }
  const guard = await checkSetupSecret(request, env, provided);
  if (guard.response) return guard.response;
  return initiateAuthorize(env);
}

async function initiateAuthorize(env) {
  if (!env.ETSY_KEYSTRING) {
    return jsonResponse(500, { error: "etsy_app_credentials_not_configured" });
  }
  const state = generateState();
  const verifier = generatePkceVerifier();
  const created = await storeCall(env, "state/create", {
    state,
    verifier,
    expires_at: Date.now() + STATE_TTL_MS,
  });
  if (!created.ok) {
    return jsonResponse(429, { error: "too_many_pending_authorizations" });
  }
  const challenge = await pkceChallenge(verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.ETSY_KEYSTRING,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return Response.redirect(ETSY_CONNECT_URL + "?" + params.toString(), 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) {
    return htmlResponse(400, "Authorization failed", "Etsy reported an error for this authorization attempt. Start again from the authorize address.");
  }
  if (!code || !state) {
    return htmlResponse(400, "Authorization failed", "The callback was missing its code or state. Start again from the authorize address.");
  }
  const consumed = await storeCall(env, "state/consume", { state });
  if (!consumed.ok) {
    return htmlResponse(400, "Authorization failed", "This authorization link has expired or was already used. Start again from the authorize address.");
  }
  const tokenResponse = await postTokenRequest(env, {
    grant_type: "authorization_code",
    client_id: env.ETSY_KEYSTRING,
    redirect_uri: REDIRECT_URI,
    code: code,
    code_verifier: consumed.verifier,
  });
  if (!tokenResponse || !tokenResponse.access_token) {
    return htmlResponse(502, "Authorization failed", "Etsy did not complete the token exchange. Start again from the authorize address.");
  }
  const record = tokenRecordFrom(tokenResponse, null);
  await storeCall(env, "tokens/put", { record });
  // The success page reports the scope status honestly and never claims
  // the authorization is fully verified when it is not.
  if (record.scope_status === "incomplete") {
    return htmlResponse(200, "Connected with reduced permissions", "Authorization is stored, but Etsy granted fewer scopes than the gateway requires, so write operations stay disabled. Start authorization again and approve every requested scope, then verify again.");
  }
  if (record.scope_status === "unverified") {
    return htmlResponse(200, "Connected, scope confirmation needed", "Authorization is stored, but Etsy returned no scope information with the token, so the granted permissions cannot be verified from Etsy data. Write operations stay disabled until the owner confirms the granted scopes with the setup secret. See the gateway README for the exact procedure.");
  }
  return htmlResponse(200, "FultonPrintables connected", "Authorization succeeded and the connection is stored. You can close this page and tell Muse to verify the shop.");
}

// POST /oauth/confirm-scopes: the owner's confirmation that the scopes
// shown on the Etsy consent screen were all granted, used only when
// Etsy's token response carried no scope information. Gated by the
// setup secret in the x-setup-secret header. The request carries no
// token material and the response echoes none.
async function handleConfirmScopes(request, env) {
  const url = new URL(request.url);
  if (queryCarriesSetupSecret(url)) {
    return jsonResponse(400, { error: "setup_secret_in_query_not_allowed" });
  }
  const guard = await checkSetupSecret(
    request,
    env,
    request.headers.get("x-setup-secret")
  );
  if (guard.response) return guard.response;
  const result = await storeCall(env, "scopes/confirm", {});
  if (result.ok && result.scope_status === "verified") {
    return jsonResponse(200, { ok: true, scope_status: "verified" });
  }
  if (result.ok) {
    return jsonResponse(200, {
      ok: true,
      scope_status: "owner_confirmed",
      scopes_confirmed_at: result.scopes_confirmed_at,
    });
  }
  if (result.reason === "incomplete") {
    return jsonResponse(409, {
      error: "scopes_incomplete",
      scope_status: "incomplete",
    });
  }
  return jsonResponse(409, {
    error: "not_authorized",
    authorize_url: "/oauth/authorize",
  });
}

// ---------------------------------------------------------------------------
// Etsy calls. The base URL is a fixed constant and every path is built only
// from validated segments, so no caller input can steer a request elsewhere.
// ---------------------------------------------------------------------------
function etsyHeaders(env, record) {
  return {
    "x-api-key": env.ETSY_KEYSTRING + ":" + env.ETSY_SHARED_SECRET,
    Authorization: "Bearer " + record.access_token,
  };
}

async function etsyFetch(env, record, method, path, options) {
  const opts = options || {};
  const headers = Object.assign({}, etsyHeaders(env, record), opts.headers || {});
  const init = { method, headers };
  if (opts.body !== undefined) init.body = opts.body;
  return fetch(ETSY_API_BASE + path, init);
}

// Passes an Etsy response through with its real status. A non-2xx Etsy
// response is never converted into a gateway success, and a 429 keeps the
// retry-after header when Etsy sends one.
async function passthrough(response) {
  const text = await response.text();
  const headers = {
    "content-type": response.headers.get("content-type") || "application/json",
  };
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) headers["retry-after"] = retryAfter;
  return new Response(text, { status: response.status, headers });
}

// Resolves the shop id through getMe when the token record does not carry
// one yet. Persistence goes through the Durable Object's shop-meta
// operation, which merges into the current stored record inside a
// transaction; a record fetched earlier in this request is never written
// back, so a concurrently rotated refresh token cannot be clobbered.
async function resolveShopId(env, record) {
  if (record.shop_id) return record.shop_id;
  const response = await etsyFetch(env, record, "GET", "/users/me");
  if (!response.ok) return null;
  let me;
  try {
    me = await response.json();
  } catch {
    return null;
  }
  const shopId = me.shop_id || null;
  if (shopId) {
    await storeCall(env, "tokens/shop-meta", {
      shop_id: shopId,
      user_id: me.user_id ? String(me.user_id) : null,
    });
  }
  return shopId;
}

function rateLimitFor(env) {
  const n = Number(env.RATE_LIMIT_PER_MINUTE);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RATE_LIMIT;
}

// Write gate for granted scopes. Reads may always proceed. A write
// requires the stored scope status to be "verified" (Etsy's token
// response documented all five scopes as granted) or "owner_confirmed"
// (Etsy returned no scope information and the owner confirmed the
// consent-screen scopes through the setup-secret procedure). Anything
// else fails closed: "incomplete" names the missing scopes, and every
// other status, including a legacy record with no status at all, is
// treated as unverified.
function scopeGateError(record) {
  if (
    record.scope_status === "verified" ||
    record.scope_status === "owner_confirmed"
  ) {
    return null;
  }
  if (record.scope_status === "incomplete") {
    const granted =
      typeof record.scope === "string"
        ? record.scope.split(/\s+/).filter(Boolean)
        : [];
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    return jsonResponse(403, {
      error: "scopes_incomplete",
      missing_scopes: missing,
    });
  }
  return jsonResponse(403, { error: "scope_unverified" });
}

// ---------------------------------------------------------------------------
// API routes: an explicit allowlist. A path that matches a known pattern with
// the wrong method returns 405; any other /api path returns 404. There is
// deliberately no DELETE route: listings_d is not among the granted scopes,
// so listings are retired by deactivation (PATCH with state=inactive).
// ---------------------------------------------------------------------------
const API_ROUTES = [
  { pattern: /^\/api\/shop$/, methods: ["GET", "PUT"] },
  { pattern: /^\/api\/listings$/, methods: ["GET"] },
  { pattern: /^\/api\/listings\/draft$/, methods: ["POST"] },
  { pattern: /^\/api\/listings\/\d+$/, methods: ["GET", "PATCH"] },
  { pattern: /^\/api\/listings\/\d+\/image$/, methods: ["POST"] },
  { pattern: /^\/api\/listings\/\d+\/file$/, methods: ["POST"] },
  { pattern: /^\/api\/receipts$/, methods: ["GET"] },
  // Idempotency operation inspection and recovery. The key segment is
  // the client-chosen Idempotency-Key, URL-encoded by the caller.
  { pattern: /^\/api\/operations\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/api\/operations\/[^/]+\/reconcile$/, methods: ["POST"] },
  { pattern: /^\/api\/operations\/[^/]+\/abandon$/, methods: ["POST"] },
];

const OPERATION_PATH = /^\/api\/operations\/([^/]+)(?:\/(reconcile|abandon))?$/;

function operationUrls(idemKey) {
  const base = "/api/operations/" + encodeURIComponent(idemKey);
  return { operation_url: base, reconcile_url: base + "/reconcile" };
}

// Reconciliation matcher: does an Etsy listing plausibly represent the
// creation a stored operation fingerprint describes? Evidence, not
// proof: the title must match exactly, the listing must have been
// created no earlier than the documented skew before the operation
// started, and price and quantity, where the listing payload exposes
// them, must be consistent with the fingerprint.
function listingMatchesFingerprint(listing, fingerprint, earliestMs) {
  if (!fingerprint || !listing || listing.title !== fingerprint.title) {
    return false;
  }
  const rawTs =
    listing.creation_timestamp !== undefined
      ? listing.creation_timestamp
      : listing.created_timestamp;
  if (typeof rawTs !== "number" || !Number.isFinite(rawTs)) return false;
  if (rawTs * 1000 < earliestMs) return false;
  const price = listing.price;
  if (
    price &&
    typeof price.amount === "number" &&
    typeof price.divisor === "number" &&
    price.divisor > 0 &&
    typeof fingerprint.price === "number"
  ) {
    const listingCents = Math.round((price.amount / price.divisor) * 100);
    const fingerprintCents = Math.round(fingerprint.price * 100);
    if (listingCents !== fingerprintCents) return false;
  }
  if (
    typeof listing.quantity === "number" &&
    typeof fingerprint.quantity === "number" &&
    listing.quantity !== fingerprint.quantity
  ) {
    return false;
  }
  return true;
}

// Reconciliation for an uncertain listing creation. This procedure
// NEVER issues a create. It reads the shop's listings (draft state
// first, then active) and compares them against the fingerprint stored
// when the operation began. Title and timestamp matching is evidence,
// not proof: exactly one match resolves the operation as recovered,
// zero matches proves nothing (one read can miss a listing, and
// absence is not evidence of non-creation), and more than one match is
// ambiguous. Both of those leave the record uncertain for the owner.
// Only the first RECONCILE_PAGE_LIMIT listings of each state are
// searched; that bound is a documented limitation.
async function reconcileOperation(env, record, shopBase, idemKey) {
  const view = await storeCall(env, "idem/get", { key: idemKey });
  if (!view.found) {
    return jsonResponse(404, { error: "operation_not_found" });
  }
  if (view.state !== "uncertain") {
    // Any other state is reported as-is, with no side effects at all.
    return jsonResponse(200, {
      status: view.state,
      state: view.state,
      listing_id: view.result_listing_id,
    });
  }
  const earliest = (view.created_at || 0) - RECONCILE_SKEW_MS;
  const search = async (state) => {
    const response = await etsyFetch(
      env,
      record,
      "GET",
      shopBase +
        "/listings?state=" +
        state +
        "&limit=" +
        RECONCILE_PAGE_LIMIT
    );
    if (!response.ok) return { response };
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const results = data && Array.isArray(data.results) ? data.results : [];
    return {
      matches: results.filter((listing) =>
        listingMatchesFingerprint(listing, view.fingerprint, earliest)
      ),
    };
  };
  let found = await search("draft");
  if (found.response) return passthrough(found.response);
  let matches = found.matches;
  if (matches.length === 0) {
    found = await search("active");
    if (found.response) return passthrough(found.response);
    matches = found.matches;
  }
  if (matches.length === 1) {
    const listingId = matches[0].listing_id;
    const resolved = await storeCall(env, "idem/reconcile-resolve", {
      key: idemKey,
      listing_id: listingId,
    });
    if (!resolved.ok) {
      // The record changed state under us (already resolved); report
      // its current state rather than claiming a recovery.
      return jsonResponse(200, {
        status: resolved.state || "uncertain",
        state: resolved.state || "uncertain",
      });
    }
    return jsonResponse(200, {
      status: "recovered",
      state: "completed",
      listing_id: listingId,
      recovered: true,
    });
  }
  if (matches.length === 0) {
    return jsonResponse(409, {
      status: "uncertain",
      state: "uncertain",
      matches: 0,
    });
  }
  return jsonResponse(409, {
    status: "uncertain",
    state: "uncertain",
    matches: matches.length,
    ambiguous: true,
  });
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // Route and method allowlist runs first, before any credential or token
  // work, so unknown surface is rejected as cheaply as possible.
  let routeKnown = false;
  let methodAllowed = false;
  for (const route of API_ROUTES) {
    if (route.pattern.test(path)) {
      routeKnown = true;
      if (route.methods.includes(method)) methodAllowed = true;
    }
  }
  if (!routeKnown) return jsonResponse(404, { error: "route_not_found" });
  if (!methodAllowed) {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  // Gateway authentication, constant-time comparison.
  const providedKey = request.headers.get("x-gateway-key") || "";
  if (!env.GATEWAY_API_KEY || !(await timingSafeEqual(providedKey, env.GATEWAY_API_KEY))) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  // Per-identity rate limit, enforced inside the Durable Object so the
  // window is shared across isolates.
  const rate = await storeCall(env, "rate/check", {
    identity: "gateway",
    limit: rateLimitFor(env),
    windowMs: RATE_WINDOW_MS,
  });
  if (!rate.allowed) {
    return jsonResponse(
      429,
      { error: "rate_limited" },
      { "retry-after": String(rate.retry_after || 60) }
    );
  }

  // Idempotency operation inspection and recovery. The status read and
  // the owner abandon are pure Durable Object operations: they need no
  // Etsy token, so they are served before token handling. Reconcile
  // needs Etsy reads and is handled after shop resolution below; it
  // issues no Etsy write, so it is exempt from the scope write gate.
  const opMatch = path.match(OPERATION_PATH);
  let idemKey = null;
  if (opMatch) {
    try {
      idemKey = decodeURIComponent(opMatch[1]);
    } catch {
      idemKey = opMatch[1];
    }
  }
  if (opMatch && method === "GET") {
    const view = await storeCall(env, "idem/get", { key: idemKey });
    if (!view.found) {
      return jsonResponse(404, { error: "operation_not_found" });
    }
    return jsonResponse(200, {
      state: view.state,
      status: view.state,
      attempts: view.attempts,
      fingerprint_title: view.fingerprint_title,
      created_at: view.created_at,
      updated_at: view.updated_at,
      result_listing_id: view.result_listing_id,
      recovered: view.recovered,
      failure_status: view.failure_status,
    });
  }
  if (opMatch && opMatch[2] === "abandon") {
    // Declaring that nothing was created under a key is an owner
    // judgment, so the gateway key alone is never enough: the setup
    // secret is required, under the same guard as scope confirmation.
    if (queryCarriesSetupSecret(url)) {
      return jsonResponse(400, {
        error: "setup_secret_in_query_not_allowed",
      });
    }
    const guard = await checkSetupSecret(
      request,
      env,
      request.headers.get("x-setup-secret")
    );
    if (guard.response) return guard.response;
    const result = await storeCall(env, "idem/abandon", { key: idemKey });
    if (result.ok) {
      return jsonResponse(200, { status: "abandoned", state: "abandoned" });
    }
    if (result.state === null || result.state === undefined) {
      return jsonResponse(404, { error: "operation_not_found" });
    }
    return jsonResponse(409, {
      error: "operation_not_uncertain",
      state: result.state,
    });
  }
  const isReconcile = Boolean(opMatch && opMatch[2] === "reconcile");

  // Token state, serialized through the Durable Object.
  const ensured = await storeCall(env, "tokens/ensure", {});
  if (!ensured.record) {
    return jsonResponse(409, {
      error: "not_authorized",
      authorize_url: "/oauth/authorize",
    });
  }
  const record = ensured.record;

  // Granted-scope gate: writes fail closed until the granted scopes are
  // verified or owner-confirmed. Reads proceed in every state.
  // Reconcile is exempt: it performs Etsy reads only and is the
  // recovery path for operations created under a previously valid
  // grant.
  if (method !== "GET" && !isReconcile) {
    const gate = scopeGateError(record);
    if (gate) return gate;
  }

  // Listing reads by id do not need the shop id.
  const listingById = path.match(/^\/api\/listings\/(\d+)$/);
  if (listingById && method === "GET") {
    return passthrough(await etsyFetch(env, record, "GET", "/listings/" + listingById[1]));
  }

  const shopId = await resolveShopId(env, record);
  if (!shopId) return jsonResponse(502, { error: "shop_id_unresolved" });
  const shopBase = "/shops/" + shopId;

  if (isReconcile) {
    return reconcileOperation(env, record, shopBase, idemKey);
  }

  if (path === "/api/shop" && method === "GET") {
    return passthrough(await etsyFetch(env, record, "GET", shopBase));
  }

  if (path === "/api/shop" && method === "PUT") {
    const read = await readJsonRequest(request);
    if (read.response) return read.response;
    const invalid = validateUpdateShop(read.body);
    if (invalid) return jsonResponse(400, { error: invalid });
    return passthrough(
      await etsyFetch(env, record, "PUT", shopBase, {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: encodeForm(read.body),
      })
    );
  }

  if (path === "/api/listings" && method === "GET") {
    const query = validateReadQuery(url, "listings");
    if (query.error) return jsonResponse(400, { error: query.error });
    return passthrough(
      await etsyFetch(env, record, "GET", shopBase + "/listings" + query.search)
    );
  }

  if (path === "/api/receipts" && method === "GET") {
    const query = validateReadQuery(url, "receipts");
    if (query.error) return jsonResponse(400, { error: query.error });
    return passthrough(
      await etsyFetch(env, record, "GET", shopBase + "/receipts" + query.search)
    );
  }

  if (path === "/api/listings/draft" && method === "POST") {
    const idemKey = (request.headers.get("idempotency-key") || "").trim();
    if (idemKey.length < 8 || idemKey.length > 128) {
      return jsonResponse(400, { error: "idempotency_key_required" });
    }
    const read = await readJsonRequest(request);
    if (read.response) return read.response;
    const invalid = validateCreateListing(read.body);
    if (invalid) return jsonResponse(400, { error: invalid });
    const hash = await sha256Hex(read.rawText);
    // The fingerprint is what reconciliation will later match Etsy
    // listings against if this operation's outcome becomes unknown.
    const fingerprint = {
      title: read.body.title,
      price: read.body.price,
      quantity: read.body.quantity,
      taxonomy_id: read.body.taxonomy_id,
    };
    const begin = await storeCall(env, "idem/begin", {
      key: idemKey,
      hash,
      fingerprint,
    });
    if (begin.action === "conflict") {
      return jsonResponse(409, { error: "idempotency_key_reused" });
    }
    if (begin.action === "in_progress") {
      return jsonResponse(409, { error: "request_in_progress" });
    }
    if (begin.action === "uncertain") {
      // The previous attempt under this key may or may not have
      // created a listing on Etsy. No new create may be issued under
      // this key until the operation is reconciled or the owner
      // abandons it. Zero Etsy calls are made on this path.
      return jsonResponse(
        409,
        Object.assign(
          { error: "operation_uncertain", state: "uncertain" },
          operationUrls(idemKey)
        )
      );
    }
    if (begin.action === "replay") {
      return new Response(begin.body, {
        status: begin.status,
        headers: {
          "content-type": "application/json",
          "x-idempotent-replay": "true",
        },
      });
    }
    // This request owns the idempotency record (begin.op_id) for the
    // life of the operation. Only this operation may complete it, fail
    // it, or mark it uncertain, regardless of lease timing.
    let response;
    try {
      response = await etsyFetch(env, record, "POST", shopBase + "/listings", {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: encodeForm(read.body),
      });
    } catch {
      // The request may have reached Etsy while its response was lost,
      // so the outcome is unknown, not failed. Mark the operation
      // uncertain under its owner before answering, and never report
      // this path as a success.
      await storeCall(env, "idem/uncertain", {
        key: idemKey,
        op_id: begin.op_id,
      });
      return jsonResponse(
        502,
        Object.assign(
          { error: "etsy_outcome_unknown", state: "uncertain" },
          operationUrls(idemKey)
        )
      );
    }
    const text = await response.text();
    if (response.ok) {
      // Only a successful Etsy response may become a stored replay.
      let resultListingId = null;
      try {
        const parsed = JSON.parse(text);
        if (parsed && Number.isInteger(parsed.listing_id)) {
          resultListingId = parsed.listing_id;
        }
      } catch {
        resultListingId = null;
      }
      await storeCall(env, "idem/complete", {
        key: idemKey,
        op_id: begin.op_id,
        status: response.status,
        body: text,
        result_listing_id: resultListingId,
      });
    } else {
      // A definite Etsy response (any status) is a definite outcome:
      // the record is failed, kept for history, and a retry with the
      // same key and body starts a counted new attempt.
      await storeCall(env, "idem/fail", {
        key: idemKey,
        op_id: begin.op_id,
        status: response.status,
      });
    }
    const headers = {
      "content-type": response.headers.get("content-type") || "application/json",
    };
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(text, { status: response.status, headers });
  }

  const uploadMatch = path.match(/^\/api\/listings\/(\d+)\/(image|file)$/);
  if (uploadMatch && method === "POST") {
    const isImage = uploadMatch[2] === "image";
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MULTIPART_MAX_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > MULTIPART_MAX_BYTES) {
      return jsonResponse(413, { error: "request_too_large" });
    }
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
      return jsonResponse(400, { error: "multipart_required" });
    }
    let form;
    try {
      const probe = new Request("https://gateway.local/upload", {
        method: "POST",
        headers: { "content-type": contentType },
        body: buffer.slice(0),
      });
      form = await probe.formData();
    } catch {
      return jsonResponse(400, { error: "malformed_multipart" });
    }
    const allowedFields = isImage ? IMAGE_FORM_FIELDS : FILE_FORM_FIELDS;
    for (const name of new Set(form.keys())) {
      if (!allowedFields.has(name)) {
        return jsonResponse(400, { error: "multipart_field_not_allowed:" + name });
      }
    }
    // Etsy requires exactly one of the binary part or the id of an item
    // already uploaded to the shop, never both and never neither.
    const binaryName = isImage ? "image" : "file";
    const idName = isImage ? "listing_image_id" : "listing_file_id";
    const binaryPart = form.get(binaryName);
    const hasBinary =
      binaryPart !== null && typeof binaryPart === "object";
    const hasId = form.get(idName) !== null;
    if (hasBinary === hasId) {
      return jsonResponse(400, {
        error: "multipart_requires_exactly_one_of:" + binaryName + "," + idName,
      });
    }
    const kind = isImage ? "images" : "files";
    return passthrough(
      await etsyFetch(
        env,
        record,
        "POST",
        shopBase + "/listings/" + uploadMatch[1] + "/" + kind,
        { headers: { "content-type": contentType }, body: buffer }
      )
    );
  }

  if (listingById && method === "PATCH") {
    const read = await readJsonRequest(request);
    if (read.response) return read.response;
    const invalid = validateUpdateListing(read.body);
    if (invalid) return jsonResponse(400, { error: invalid });
    if (read.body.state === "active") {
      // Publish path. The already-active check is a pure read and needs
      // no lock: an already active listing returns its current state and
      // no activation call is issued.
      const current = await etsyFetch(
        env,
        record,
        "GET",
        "/listings/" + listingById[1]
      );
      if (!current.ok) return passthrough(current);
      let listing = null;
      try {
        listing = await current.json();
      } catch {
        listing = null;
      }
      if (listing && listing.state === "active") {
        return jsonResponse(
          200,
          Object.assign({}, listing, { already_active: true })
        );
      }
      // Per-listing publish lock: acquired inside a Durable Object
      // transaction before the activation call, so two simultaneous
      // publishes of this listing cannot both activate it. A second
      // attempt gets 409 publish_in_progress and issues no Etsy call.
      // The lock is released in a finally block, by its owner token
      // only, on success and on failure alike, so a failed activation
      // never wedges the listing and a later retry can proceed.
      const lock = await storeCall(env, "publish/acquire", {
        listing_id: listingById[1],
      });
      if (!lock.acquired) {
        return jsonResponse(409, { error: "publish_in_progress" });
      }
      try {
        // Re-read the listing state AFTER acquiring the lock, before
        // any activation call. A previous publisher may have held this
        // lock, crashed, and still completed its activation before the
        // lock expired; in that case the listing is already active and
        // the correct answer is already_active with zero activation
        // calls, not a second PATCH. Activation is a state transition
        // on an existing listing and PATCH state=active is idempotent
        // on Etsy's side, so this re-read makes the whole publish flow
        // safe to retry in a way listing creation is not.
        const recheck = await etsyFetch(
          env,
          record,
          "GET",
          "/listings/" + listingById[1]
        );
        if (!recheck.ok) return passthrough(recheck);
        let current = null;
        try {
          current = await recheck.json();
        } catch {
          current = null;
        }
        if (current && current.state === "active") {
          return jsonResponse(
            200,
            Object.assign({}, current, { already_active: true })
          );
        }
        return passthrough(
          await etsyFetch(
            env,
            record,
            "PATCH",
            shopBase + "/listings/" + listingById[1],
            {
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: encodeForm(read.body),
            }
          )
        );
      } finally {
        await storeCall(env, "publish/release", {
          listing_id: listingById[1],
          lock_token: lock.lock_token,
        });
      }
    }
    return passthrough(
      await etsyFetch(
        env,
        record,
        "PATCH",
        shopBase + "/listings/" + listingById[1],
        {
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: encodeForm(read.body),
        }
      )
    );
  }

  return jsonResponse(404, { error: "route_not_found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    try {
      if (url.pathname === "/health") {
        if (method !== "GET") {
          return jsonResponse(405, { error: "method_not_allowed" });
        }
        return jsonResponse(200, { ok: true, service: "etsy-gateway" });
      }
      if (url.pathname === "/oauth/authorize") {
        if (method === "GET") return handleAuthorizePage(request, env);
        if (method === "POST") return handleAuthorizeSubmit(request, env);
        return jsonResponse(405, { error: "method_not_allowed" });
      }
      if (url.pathname === "/oauth/callback") {
        if (method !== "GET") {
          return jsonResponse(405, { error: "method_not_allowed" });
        }
        return handleCallback(request, env);
      }
      if (url.pathname === "/oauth/confirm-scopes") {
        if (method !== "POST") {
          return jsonResponse(405, { error: "method_not_allowed" });
        }
        return handleConfirmScopes(request, env);
      }
      if (url.pathname.startsWith("/api/")) {
        return handleApi(request, env, url);
      }
      return jsonResponse(404, { error: "route_not_found" });
    } catch {
      return jsonResponse(500, { error: "gateway_error" });
    }
  },
};
