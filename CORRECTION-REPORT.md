# Etsy Gateway Correction Report

Independent code review correction pass, 2026-11-09. This report covers
the six corrections in the owner's Correction Directive, the evidence for
each fix in the code, the scope-verification research, the exact owner
authorization procedure, every modified file, the full test results, the
remaining findings by severity, and the verdict.

Hard restrictions were honored throughout: nothing was deployed, no Etsy
app was registered, no credential was entered or requested, no OAuth flow
was initiated, and no live Etsy call was made. The only external material
read was Etsy's public official documentation and OpenAPI specification,
for Correction 3. All tests use mocked responses, and the test fetch
mock now fails closed: any URL a handler does not explicitly answer
throws, so an unmocked request fails the test instead of passing
silently.

## Defects corrected

### Correction 1 (Critical): non-atomic Durable Object operations

Defect: the OAuth state consume, idempotency begin/complete/abort, and
rate check were asynchronous read-modify-write sequences. Two operations
could interleave between the read and the write, so a state could be
consumed twice, two draft creations could both proceed under one
idempotency key, and a rate window could admit more than its limit.

Fix, all in `index.js`, class `EtsyTokenStore`:

- A serialized transaction runner, `runTransaction` (line 331) and
  `executeTransaction` (line 340): every operation chains through a
  per-instance promise queue that survives rejections, and the callback
  is delegated to `storage.transaction` when the storage provides it
  (production Durable Object storage does; the test stub implements
  snapshot-and-rollback on throw). A check and its write are therefore
  decided against one consistent snapshot, and a throwing transaction
  leaves storage unchanged.
- `handleStateCreate` (line 348): prune, live-count, cap check, and put
  in one transaction.
- `handleStateConsume` (line 374): read, delete, and validity decision
  in one transaction. A state is consumed exactly once.
- `handleIdemBegin` (line 517): replay, conflict, in-progress, takeover,
  and ownership assignment in one transaction. Takeover of an
  in-progress record is refused before its 120 second expiry and
  allowed after. The returned `proceed` result carries an `op_id`
  (256-bit random) that owns the record.
- `handleIdemComplete` (line 549) and `handleIdemAbort` (line 574): both
  verify the caller's `op_id` against the stored owner inside the
  transaction. A non-owner completion or abort returns
  `not_operation_owner` and leaves the record unchanged. The Worker
  passes the `op_id` from its own begin result on both paths.
- `handleRateCheck` (line 595): pruning and admission counting in one
  transaction, so with limit N, M simultaneous checks (M greater than N)
  admit exactly N. The handler also gained a peek mode (`record: false`)
  used by the setup-secret limiter so checking does not itself consume
  budget.

Audit of every other storage read-modify-write, as required:

- `handleTokensEnsure` (line 414): refresh merges against the current
  record inside a transaction; see Correction 2.
- `handleTokensShopMeta` (line 468): new transactional merge; see
  Correction 2.
- `handleScopesConfirm` (line 485): status read and write in one
  transaction.
- `handlePublishAcquire` (line 633) and `handlePublishRelease`
  (line 653): lock read-modify-write in one transaction; see
  Correction 5.
- `handleTokensGet` (line 387): read only, no write. Safe by
  construction.
- `handleTokensPut` (line 397): a single unconditional put of the
  complete record built by the OAuth callback. It is not a
  read-modify-write and involves no previously fetched copy, so it
  cannot write a stale field back. Justification is also recorded in
  the code comment at the function.
- `handleRateClear` (line 624): a single delete with no preceding read.
  Not a read-modify-write. Safe by construction.
- The idempotency expiry sweep lives inside `handleIdemBegin` (expired
  completed records are deleted in the same transaction that evaluates
  the new begin), so the sweep cannot race a begin.
- In the Worker, `resolveShopId` (line 1223) reads the token record but
  no longer writes it; persistence goes through the transactional
  `tokens/shop-meta` operation. No Worker code path writes a token
  record reconstructed from a fetched copy.

### Correction 2 (Critical): stale token record overwrites

Defect: `resolveShopId()` fetched the token record, set `shop_id` on the
copy, and wrote the whole record back. A token refresh rotating the
refresh token in between was silently reverted, which would have broken
authorization permanently on first use.

Fix:

- New Durable Object operation `handleTokensShopMeta` (line 468),
  reached as `tokens/shop-meta`: inside one transaction it reads the
  CURRENT stored record and merges only `shop_id` (always) and
  `user_id` (only when currently absent), preserving `access_token`,
  `refresh_token`, `expires_at`, `scope`, `scope_status`, and
  `scopes_confirmed_at` exactly as stored.
- `resolveShopId` (line 1223) now returns the shop id and persists it
  only through `tokens/shop-meta`. It never writes a token record.
- The refresh write inside `handleTokensEnsure` (line 414) likewise
  merges: it re-reads the current record inside a transaction, spends
  that record's refresh token, and on response re-reads inside a second
  transaction and builds the next record from the LATEST stored record.
  If the stored refresh token no longer equals the spent one (a
  different rotation already landed), the write is abandoned and the
  stored record wins. Shop metadata written concurrently survives.
- The only remaining whole-record write is the initial authorization
  write (`handleTokensPut`), which is not a read-modify-write (see the
  audit list above).

Proof: the mandated interleave test runs a refresh against delayed stub
storage (reads delayed 5 ms, writes 10 ms, token response gated) while a
shop metadata update lands mid-refresh. The final record carries the
ROTATED refresh token and the new shop_id 777. See the test list below.

### Correction 3 (High): granted scopes were never verified

Research result, from Etsy's official sources only:

- Etsy's official Authentication documentation
  (https://developers.etsy.com/documentation/essentials/authentication/),
  Step 3 token response fields, documents `scope` explicitly: "a
  space-delimited string of the scopes actually granted to the access
  token, which may be a subset of the requested scopes."
- The same page's refresh grant section documents the same `scope`
  field ("a space-delimited string of the scopes granted to the access
  token") and states that refresh tokens have the same scope as the
  initial grant and that scope cannot change via refresh.
- The official OpenAPI specification
  (https://www.etsy.com/openapi/generated/oas/3.0.0.json) contains no
  `/oauth/token` path at all and no token introspection or tokeninfo
  endpoint. Conclusion: the token response `scope` field is the ONLY
  documented source of granted scopes. Nothing else was invented; when
  a response omits usable scope information, the record is treated as
  unverified and the owner confirmation path below applies.

Implemented behavior (`grantedScopeInfo`, line 216; `tokenRecordFrom`,
line 241; `scopeGateError`, line 1256; gate applied in `handleApi`,
line 1293, to every non-GET request before any Etsy call):

- `verified`: the granted set includes all five required scopes. Reads
  and writes proceed.
- `incomplete`: a granted set is present but missing scopes. The record
  is stored, reads proceed, and writes return
  `403 {"error":"scopes_incomplete","missing_scopes":[...]}` naming the
  missing scopes. Owner confirmation cannot upgrade an incomplete
  grant (the confirm operation refuses with 409); only a new
  authorization granting all five scopes fixes it.
- `unverified`: the token response carried no usable scope information.
  The authorization is never reported as verified anywhere: the
  callback page says confirmation is needed, and writes return
  `403 {"error":"scope_unverified"}` until the owner confirms through
  `POST /oauth/confirm-scopes` (Correction 4's setup secret, header
  only). Confirmation sets `scope_status` to `owner_confirmed` with a
  `scopes_confirmed_at` timestamp, transactionally
  (`handleScopesConfirm`, line 485; route handler `handleConfirmScopes`,
  line 1152). The confirmation request carries no token and the
  response echoes none.
- A refresh response carrying scope information recomputes the status
  transactionally, so a reduced grant downgrades a verified or
  owner-confirmed record.
- Records with no `scope_status` (none exist, since nothing is
  deployed) would be treated as unverified: the gate fails closed.
- The requested scope string is unchanged: exactly
  `listings_r listings_w shops_r shops_w transactions_r`.

### Correction 4 (High): authorization initiation was unauthenticated

Defect: `GET /oauth/authorize` started an OAuth flow for anyone who
asked. Combined with state guessing or a stray crawler, that was an
open initiation endpoint on the owner's shop connection.

Fix:

- New Worker secret `SETUP_SECRET`, owner-set at deploy. It is never
  available to the Muse connector: the helper
  `~/workspace/custom-connectors/custom.etsy/bin/etsy_api.py` contains
  no reference to it (enforced by a source-scan test), the connector
  doc states Muse never receives it, and no gateway response contains
  it (asserted in tests for both failure and success paths).
- `GET /oauth/authorize` now serves a minimal initiation page
  (`authorizePageResponse`, line 122; handler `handleAuthorizePage`,
  line 1046): a plain HTML form posting to `/oauth/authorize`, built by
  string concatenation, with no script elements, no inline event
  handlers, and no external resources. Serving it creates no state.
- `POST /oauth/authorize` (`handleAuthorizeSubmit`, line 1058) requires
  the secret as the form field `setup_secret` or the `x-setup-secret`
  header, compared in constant time (`checkSetupSecret`, line 1005).
  Success runs the unchanged initiation (state plus PKCE, 302 to Etsy).
  Failure returns 403, creates NO state record, and is rate limited
  through the Durable Object: 5 failures per 10 minutes per source,
  then 429, and the limiter runs before verification so even a correct
  secret waits out the window.
- A setup secret in the query string is rejected with 400 on both GET
  and POST, even when the value is correct, because URLs are logged.
- If `SETUP_SECRET` is not configured, initiation fails closed with
  403.
- Callback behavior and state validation are unchanged.

### Correction 5 (High): simultaneous publishes could both activate

Defect: the already-active check narrowed but did not close the race:
two simultaneous publish PATCHes for the same draft could both pass the
check and both issue the activation call.

Fix:

- Per-listing lock in the Durable Object (`handlePublishAcquire`,
  line 633; `handlePublishRelease`, line 653): keyed `publish_lock:`
  plus the listing id, acquired inside a transaction before any
  activation call, returning a 256-bit lock token with a 120 second
  expiry. A live lock makes a second publish attempt return
  `409 {"error":"publish_in_progress"}` with NO Etsy call.
- Documented lock choice for the already-active case: it takes NO lock.
  The check is a pure read; an already active listing returns its
  current state with `already_active` and no activation call, exactly
  as before.
- Release happens in a `finally` block in `handleApi`, on success and
  on failure, and only for the matching owner token, so a failed
  activation never wedges the listing and a retry proceeds. A lock
  whose owner crashed expires after 120 seconds and can be
  re-acquired. Locks are per listing, so different listings never block
  each other.

### Correction 6: test additions

The suite now runs 76 tests: the 50 pre-existing tests plus 26 new or
replacement tests. Of the pre-existing 50, 49 pass with their assertions
unchanged. Two mandated harness-level changes are declared openly:

- The pre-existing test "authorize redirects to Etsy with the reduced
  scopes and a DO-stored state" was REPLACED, because Correction 4
  mandates that GET no longer initiates a flow. Its assertions (redirect
  target, parameters, exact scope string, PKCE challenge matching the
  stored verifier, state record shape) moved intact into the new test
  "POST /oauth/authorize with the setup secret in a header redirects to
  Etsy with a DO-stored state", joined by six further initiation tests.
- The seed helper now stamps seeded token records with
  `scope_status: "verified"` and `scopes_confirmed_at: null`, the
  record schema Correction 3 introduced. A seed represents a verified
  grant; no assertion in any pre-existing test changed.

The fetch mock fails closed (any unmocked URL throws), the in-memory
storage stub implements `transaction` with snapshot-and-rollback, and a
delay wrapper widens race windows so interleavings are exercised rather
than assumed away.

## Exact owner authorization procedure

Muse cannot perform any part of this procedure.

1. Set the four Worker secrets (Etsy keystring, Etsy shared secret,
   gateway API key, setup secret). Generate the setup secret with a
   password manager or `openssl rand -hex 32`. It is entered only into
   Cloudflare's secret field. It is never given to Muse in any form.
2. Open `https://etsy-gateway.lawrencemurry.workers.dev/oauth/authorize`
   in a browser signed in to the Etsy account that owns
   FultonPrintables.
3. Enter the setup secret into the form and submit. The gateway
   redirects to Etsy's consent screen.
4. Approve all five requested scopes on Etsy's consent screen.
5. Read the callback page: "FultonPrintables connected" (verified,
   nothing further needed), "Connected with reduced permissions"
   (repeat consent and approve every scope), or "Connected, scope
   confirmation needed" (step 6).
6. Only if confirmation is needed: after checking on Etsy's consent
   review that all five scopes were approved, run:
   `curl -X POST https://etsy-gateway.lawrencemurry.workers.dev/oauth/confirm-scopes -H "x-setup-secret: <the SETUP_SECRET value>"`.
   Never put the secret in a URL.

## Test results

Full suite (`npm test`, node --test): 76 tests, 76 passed, 0 failed,
duration between 0.6 and 2.7 seconds across runs (the concurrency tests
use real timers). The suite was run repeatedly, including three
consecutive runs, with identical pass results every time. `node --check index.js` passes.
`python3 -m py_compile` on the helper passes. Scans: no console calls in
index.js, no KV references anywhere, the exact five-scope string appears
exactly once (the SCOPES constant), no SETUP_SECRET reference in the
helper, no em or en dashes in any touched file.

The directive's ten mandated test areas, by test name, all passing:

1. Two simultaneous callbacks, same state: "two simultaneous callbacks
   with the same state: exactly one succeeds" (one 200, one 400, token
   endpoint called exactly once), plus "Durable Object: two
   simultaneous state consumes yield the verifier exactly once".
2. Two simultaneous draft requests, same idempotency key: "two
   simultaneous draft requests with the same idempotency key create
   exactly one listing" (one 201, one 409 request_in_progress, exactly
   one Etsy create call), plus "Durable Object: simultaneous
   idempotency begins yield exactly one owner", "Durable Object: a
   conflicting hash under concurrency returns conflict, never a second
   owner", "Durable Object: idempotency complete and abort are rejected
   for a non-owner", and "Durable Object: an in-progress record cannot
   be taken over before expiry and can after".
3. Simultaneous rate-limit checks at threshold: "simultaneous
   rate-limit checks at the threshold admit exactly the limit" (12
   parallel requests, limit 5: exactly 5 admitted, 7 times 429), plus
   "Durable Object: concurrent rate checks at the threshold admit
   exactly the limit" (10 checks, limit 3: exactly 3 admitted).
4. Refresh concurrent with shop metadata update: "token refresh
   concurrent with a shop metadata update keeps the rotated refresh
   token and the new shop id" (delayed storage interleave; final record
   carries the rotated refresh token AND shop_id 777).
5. Two simultaneous publishes, same listing: "two simultaneous
   publishes of the same listing issue exactly one activation call"
   (one 200, one 409 publish_in_progress, exactly one Etsy PATCH, lock
   released afterwards), plus "two simultaneous publishes of different
   listings both proceed" and "Durable Object: the publish lock is
   owner-only, expires, and is per listing".
6. Failed publish then successful retry: "a failed publish releases the
   lock and a retry succeeds" (500 passthrough, no lock left behind,
   retry returns 200 active).
7. Durable Object persistence across reconstruction: "Durable Object
   operations survive object reconstruction over the same storage" (a
   state written transactionally by one instance is consumed exactly
   once by a new instance over the same storage).
8. Refresh rotation under concurrent API requests: the pre-existing
   "concurrent requests with an expired token trigger exactly one
   refresh" passes unchanged against the new transactional code (one
   token call, rotated tokens stored).
9. Missing, incomplete, unverified scope information: "callback with
   all five granted scopes stores a verified record and writes are
   allowed"; "callback with a missing granted scope stores an
   incomplete record: reads proceed, writes are blocked" (403
   scopes_incomplete naming listings_w and shops_w, zero Etsy write
   calls, owner confirmation refused); "callback with no scope
   information stores an unverified record until the owner confirms"
   (403 scope_unverified, wrong-secret confirmation 403, correct
   confirmation 200 with timestamp, write then succeeds); "a refresh
   response with reduced scope information downgrades a verified
   record".
10. Unauthorized authorization initiation: "unauthorized authorization
    initiation: wrong setup secret returns 403 and creates no state",
    plus "GET /oauth/authorize serves the owner initiation form and
    creates no state", "a setup secret in the query string is rejected,
    even when correct", "repeated failed authorization attempts are
    rate limited", and "authorization initiation fails closed when no
    setup secret is configured".

Fault injection: "a transaction that throws mid-operation leaves
storage unchanged" (two puts and a delete inside the transaction, then
a throw; all three keys verified at their pre-transaction state).

## Modified files

- `~/workspace/etsy-gateway/index.js` - rewritten, 1,616 lines: the six
  corrections. Architecture, route surface, five scopes, and all
  pre-existing validated behaviors preserved.
- `~/workspace/etsy-gateway/test/gateway.test.js` - expanded to 76
  tests (2,198 lines): transactional stub with snapshot-and-rollback,
  fail-closed fetch mock, delayed-storage wrapper, setup-secret seed,
  scope-status seed field, replaced authorize test, 20 new correction
  tests, source-scan additions.
- `~/workspace/etsy-gateway/README.md` - status line (deployment blocked
  pending independent review), correction report reference, transactional
  architecture notes, four-secret deploy steps with setup-secret
  generation guidance, the exact owner authorization procedure, new
  routes in the API table, the granted-scope verification and gating
  section with the owner confirmation command, publish lock and
  idempotency-ownership controls.
- `~/workspace/etsy-gateway/CORRECTION-REPORT.md` - this report (new).
- `~/workspace/custom-connectors/custom.etsy/CONNECTOR.md` - owner-only
  initiation and confirm-scopes operation rows, the statement that the
  setup secret is never available to Muse or the connector, behavior
  bullets for scopes_incomplete, scope_unverified, and
  publish_in_progress, correction status on the gateway code line.
- `~/workspace/fultonprintables/ETSY-APP-REGISTRATION-PACKET.md` - Step 6
  now lists four Worker secrets with setup-secret generation guidance
  and the rule that it is never entered into Muse at all; Step 7
  consent flow now includes entering the setup secret on the gateway
  form and the three scope outcomes with what each requires; the
  "already built" section carries the corrected test count, the
  correction report, and the blocked status.
- `~/workspace/fultonprintables/OPERATIONS-LOG.md` - one row summarizing
  this correction pass and its verdict.

NOT modified: `~/workspace/etsy-gateway/wrangler.toml`. No change was
needed: `SETUP_SECRET` is a Worker secret set through the dashboard or
`wrangler secret put`, never a var in the toml, and the Durable Object
binding and migration already exist. The helper
`~/workspace/custom-connectors/custom.etsy/bin/etsy_api.py` was also NOT
modified: it needed no change, and it must never reference the setup
secret.

## Remaining limitations

- Nothing about live behavior is verified. Deployment, Etsy app
  registration, live OAuth, live token refresh timing, and every live
  Etsy response remain untested because they were prohibited in this
  pass. The first live proof remains `GET /api/shop` returning
  FultonPrintables after an owner-authorized test deployment.
- Concurrency correctness is proven against the test stub's
  transactional storage, which mirrors the documented Durable Object
  storage transaction contract, and against the single-instance
  serialization a Durable Object provides. Production transaction
  semantics are Cloudflare's documented behavior, not re-verified live.
- The scope gate trusts the documented `scope` field of Etsy's token
  responses. If Etsy omits it in practice, every authorization lands in
  the unverified state by design and writes stay blocked until owner
  confirmation; that is the mandated fail-closed behavior, and the live
  behavior of the field is part of what the test deployment must check.

## Remaining findings by severity

- Critical: 0.
- High: 0.
- Medium: 0.
- Low: 4.
  1. (Carried from the audit, F-16, accepted) `htmlResponse` interpolates
     its title and body without escaping. Every call site passes
     compile-time string literals only; no request data, Etsy data, or
     secret is ever interpolated, including on the new confirmation and
     initiation paths. Left unchanged deliberately.
  2. (Carried from the audit, unverifiable offline) Etsy's own materials
     conflict on the already-uploaded-file association field: the
     tutorial prose says `file_id`, the OpenAPI schema says
     `listing_file_id`. The gateway follows the schema. This can only be
     settled by a live upload, which this pass prohibited.
  3. (New, defense-in-depth only) `handleRateCheck` keeps a
     non-transactional fallback for storage without a `transaction`
     method, serialized by the per-instance queue alone. Production
     Durable Object storage and the test stub both provide
     `transaction`, so the fallback never runs in either environment.
  4. (Informational) Token records written before this correction would
     carry no `scope_status` and would be gated as unverified. No such
     records exist because the gateway has never been deployed.

## Verdict

READY FOR INDEPENDENT REVIEW

Deployment remains BLOCKED. This verdict does not authorize deployment;
it states only that the correction pass is complete, internally
verified, and ready for the independent reviewer and the owner.

---

# LEASE CORRECTION (2026-11-10)

Owner-identified defect in the correction pass above, corrected the
same night under the same hard restrictions: nothing was deployed, no
Etsy app was registered, no credential was entered or requested, no
OAuth flow was initiated, and no live Etsy call was made. All tests use
mocked responses with the fail-closed fetch mock.

## The defect

Correction 1 made idempotency begin transactional and gave each
in-progress record an owner `op_id`, but it kept one behavior from the
original design: when an in-progress record's 120 second lease expired,
a new begin could TAKE OVER the record, replacing the owner and
proceeding to issue a fresh Etsy create. That conflates lease expiry
with execution ownership. Lease expiry proves only that the original
operation stopped reporting; it does not prove the original create
failed. If the original create reached Etsy and only its response was
lost (a network failure, a crashed Worker, a timeout), a takeover retry
creates a DUPLICATE listing, and the idempotency key, the control whose
entire purpose is preventing exactly that, becomes the mechanism that
causes it.

## The fix: ownership separated from lease, as a state machine

Idempotency records are now schema version 2 (`IDEM_RECORD_VERSION`,
index.js line 48) and carry an explicit state machine. The `op_id`
stored at begin is the EXECUTION OWNER for the life of the operation.
Lease expiry never transfers ownership and never, by itself, authorizes
another external side effect. All transitions run inside Durable
Object transactions, as with every other operation in this gateway.

States:

- `in_progress`: the owner is executing; its lease is a liveness
  signal only. A same-key begin returns in_progress while the lease is
  live.
- `completed`: a stored successful response, replayed for the same key
  and body; a different body conflicts (409), unchanged.
- `failed`: a DEFINITE outcome. Etsy returned a response (any status),
  or the gateway rejected the request before any Etsy call. The record
  is kept, with the failure status and timestamp, instead of being
  deleted. A retry with the same key and same hash begins a NEW
  attempt: a fresh owner op_id, an incremented `attempts` counter,
  the original `first_created_at` and the prior failure preserved, and
  the attempt history appended. A different hash still conflicts.
- `uncertain`: the Etsy-side effect is not known. Entered two ways:
  (a) a begin finds an in-progress record whose lease has expired, and
  transitions it transactionally, preserving op_id, hash, fingerprint,
  and history, recording `uncertain_at`; (b) the owner explicitly marks
  its own operation uncertain through the new `idem/uncertain`
  operation when the create call fails at the network level.
- `abandoned`: the owner resolved an uncertain record through the
  abandon route. Terminal for that record; a later begin with the same
  key and hash starts a genuinely new operation.

Begin semantics (`handleIdemBegin`, line 604), all transactional:

- No record (or an abandoned record): create version 2 in_progress
  with a new op_id, the request hash, a request FINGERPRINT (for
  listing creation: title, price, quantity, taxonomy_id, plus the
  operation's created_at), attempts 1, and the lease expiry; return
  proceed.
- Completed, same hash: stored replay. Different hash: conflict.
- In progress, live lease: in_progress.
- In progress, EXPIRED lease: transition to uncertain and return
  uncertain. NEVER a takeover, never a new owner, zero Etsy calls. The
  Worker surfaces this as `409 {"error":"operation_uncertain", ...}`
  with the operation and reconcile URLs.
- Failed, same hash: new attempt as described above. Different hash:
  conflict.
- Uncertain: uncertain for any same-hash begin; a different hash still
  conflicts. Only the recovery path moves an uncertain record.

Completion and failure are owner-only AND state-guarded
(`handleIdemComplete`, line 707; `handleIdemFail`, line 751, which is
also still routed at the legacy `idem/abort` path so the correction
pass's abort semantics and tests keep their meaning: a definite
failure is recorded, never a success): completing or failing an
uncertain record is rejected for owner and non-owner alike, because
once an outcome is unknown, no caller may rewrite it as known. The
24 hour retention sweep now applies only to completed, failed, and
abandoned records; in-progress and uncertain records are never dropped
by age. Records written before this correction (schema version 1,
none exist in production) are normalized on read
(`normalizeIdemRecord`, line 557): a completed legacy record still
replays, and a legacy in-progress record is judged by its stored
timestamp, so a stale one lands in uncertain rather than in a takeover.

Owner marking uncertain (`handleIdemUncertain`, line 789): the Worker
calls it when the create's Etsy call throws (network error or timeout
after the request may have been sent). The mark is owner-only and
transactional. In the draft handler, the Etsy create now runs inside a
try/catch: on a throw, the Worker attempts the uncertain mark under
the begin op_id before answering `502 {"error":"etsy_outcome_unknown",
...}`. A definite Etsy HTTP response is never uncertain: 2xx completes
the record (now also capturing the created `listing_id` onto the
record), and any other status fails it through `idem/fail` with the
response status stored.

## Recovery and reconciliation

Three routes, all in the route allowlist:

- `GET /api/operations/:idempotency_key` (gateway key): returns the
  record's state, attempts, fingerprint title, created and updated
  times, result listing id, recovered flag, and failure status, via
  `handleIdemGet` (line 823). It exposes no op_id, no stored response
  body, and no token or secret material (asserted by test).
- `POST /api/operations/:idempotency_key/reconcile` (gateway key):
  only valid for an uncertain record; any other state is returned
  as-is with no side effects. Procedure (`reconcileOperation`,
  line 1707; matcher `listingMatchesFingerprint`, line 1665): read the
  shop's listings from Etsy, draft state first, then active if the
  draft read produced no decision, at most 100 per state
  (`RECONCILE_PAGE_LIMIT`). A listing matches when its title equals
  the fingerprint title EXACTLY, its creation timestamp is at or after
  the operation's created_at with a documented 300 second clock-skew
  allowance before it (`RECONCILE_SKEW_MS`), and, where the payload
  exposes them, price and quantity are consistent with the
  fingerprint. A listing without a usable creation timestamp never
  matches. Exactly one match: the record is marked completed
  transactionally (`handleIdemReconcileResolve`, line 854) with a
  synthesized stored response carrying the found listing_id and a
  `recovered: true` flag, and the route returns
  `{"status":"recovered","listing_id":...}`; a later same-key create
  request replays that recovered result with zero additional creates.
  Zero matches: the record stays uncertain and the route returns
  `{"status":"uncertain","matches":0}`; absence in one read is not
  proof of non-creation. More than one match: the record stays
  uncertain and the route returns `ambiguous: true`. Reconcile never
  issues a create, and because it performs Etsy reads only, it is
  exempt from the granted-scope write gate. If an Etsy read itself
  errors, its status passes through and the record stays uncertain.
- `POST /api/operations/:idempotency_key/abandon` (gateway key PLUS
  the owner-only setup secret in the `x-setup-secret` header, through
  the same guard as scope confirmation, including rejection of the
  secret in a query string): only valid from uncertain. Marks the
  record abandoned with a timestamp (`handleIdemAbandon`, line 900)
  and frees the key. Declaring that nothing was created is an owner
  judgment, so the gateway key alone is never enough; Muse cannot
  perform this step, exactly as it cannot initiate authorization.

Limits of reconciliation, stated plainly: title and timestamp matching
is evidence, not proof. Two genuinely different listings with the same
title created in the same window are indistinguishable, which is why
ambiguity stays uncertain rather than guessing. A shop with more than
100 drafts (or actives) can hide the created listing beyond the
searched page, which is why zero matches also stays uncertain. The
fingerprint's price and quantity checks narrow matches only where
Etsy exposes those fields on the listing payload. The operating rule
for Muse and the owner is: never retry a create against an uncertain
operation; reconcile first, and let the owner abandon only when he
judges that nothing was created.

## Publish lock analysis

The same lease-versus-ownership question was applied to the per-listing
publish lock. Conclusion: lock expiry does not create a creation-class
risk, for two reasons. First, activation is a state transition on an
EXISTING listing, not a creation: `PATCH state=active` on listing N is
idempotent on Etsy's side, so a repeated activation cannot duplicate
anything. Second, the flow re-reads state before acting. The
correction pass already re-read the listing before acquiring the lock
(the already-active fast path); this pass closes the remaining gap:
after acquiring the lock, the Worker now ALWAYS re-reads the listing
state before issuing any activation call. If a previous publisher held
the lock, activated the listing, and crashed before releasing (lock
since expired), the retry's post-lock re-read sees an active listing
and returns `already_active` with ZERO activation calls. If the
listing is still a draft, the retry proceeds with exactly one
activation call, which is safe for the idempotence reason above. Both
cases are covered by tests, including a mid-flow variant where the
listing becomes active between the pre-lock read and the post-lock
re-read. Note the deliberate asymmetry with creation: the publish
PATCH test's upstream call count rose from 2 to 3 (pre-read, post-lock
re-read, PATCH); that assertion update is declared below.

## Tests

Full suite (`npm test`, node --test): 93 tests, 93 passed, 0 failed.
`node --check index.js` passes. The helper is unchanged and
`python3 -m py_compile` passes. Scans: no console calls in index.js
(the single "console." string in the test file is the pre-existing
source-scan assertion literal), no KV references anywhere, the exact
five-scope string appears exactly once in index.js (the SCOPES
constant), no SETUP_SECRET reference in the helper, no em or en dashes
in any touched file.

Declared changes to pre-existing tests, openly:

- REPLACED, as mandated: "Durable Object: an in-progress record cannot
  be taken over before expiry and can after". Its after-expiry
  expectation (takeover with a new owner) is exactly the defect. It is
  replaced by two tests: "Durable Object: an in-progress record with a
  live lease cannot be taken over" and "Durable Object: an expired
  lease transitions to uncertain and is never taken over" (asserting
  the uncertain state, the preserved original op_id, hash and
  fingerprint, a still-uncertain second begin, and a conflict for a
  different hash). The correction pass's test list above cites the old
  name in area 2; that citation is historical and the replacement is
  recorded here.
- UPDATED assertion: "publishing a draft listing issues the PATCH with
  form-encoded state" now expects 3 upstream calls (pre-read, post-lock
  re-read, PATCH) instead of 2, because the mandated post-lock re-read
  adds one GET. No other pre-existing assertion changed; the
  correction's fail-instead-of-delete semantics preserve the intent of
  "an errored creation is not stored as a success and the key may be
  reused" and "Durable Object: idempotency complete and abort are
  rejected for a non-owner", both passing unmodified.

New tests (16), all passing:

1. "begin on an expired in-progress record returns
   operation_uncertain and makes zero Etsy calls"
2. "Durable Object: an uncertain record rejects complete and fail
   from owner and non-owner alike"
3. "Durable Object: the owner marks its own operation uncertain and a
   begin then returns uncertain"
4. "a network failure mid-create marks the operation uncertain and
   the response is not a success" (502 etsy_outcome_unknown, record
   uncertain, same-key retry 409 with no second create)
5. "a definite Etsy 400 stores a failed operation and the retry is a
   new attempt that succeeds" (attempts 1 then 2 via the status
   route, exactly one successful create)
6. "reconcile with exactly one matching draft recovers the operation
   and a later request replays it" (recovered flag, stored
   listing_id, replay with zero creates)
7. "reconcile with zero matches leaves the record uncertain and
   issues no create" (all upstream calls are GETs)
8. "reconcile with two matches leaves the record uncertain and
   reports ambiguity"
9. "reconcile on a non-uncertain record is a no-op returning its
   status" (zero Etsy calls)
10. "abandon requires the setup secret and frees the key for exactly
    one new create" (no secret 403, wrong secret 403, correct secret
    abandoned, subsequent same-key create succeeds once)
11. "abandon is only valid from uncertain"
12. "GET operation status returns the state machine fields and no
    token material" (no op_id, token, refresh token, or setup secret
    in the response; unknown key 404)
13. "Durable Object: idempotency records survive object
    reconstruction"
14. "publish retry after a crashed publisher: expired lock and an
    active listing returns already_active with zero activation calls"
15. "publish re-reads state after acquiring the lock: a listing
    activated in between returns already_active with zero activation
    calls"
16. "publish retry after a crashed publisher: expired lock and a
    still-draft listing proceeds with exactly one activation call"

## Modified files (this correction)

- `~/workspace/etsy-gateway/index.js`: 1,616 to 2,270 lines. Operation
  state machine (schema version 2 records, fingerprint, attempts,
  history), begin/complete/fail/uncertain/get/reconcile-resolve/
  abandon Durable Object operations (fail also routed at the legacy
  abort path), draft handler uncertain and network-failure paths with
  result listing id capture, operations routes with the setup-secret
  abandon guard and the reconcile scope-gate exemption, the reconcile
  procedure and matcher, and the post-lock publish re-read. Route
  surface otherwise preserved; the five scopes are unchanged.
- `~/workspace/etsy-gateway/test/gateway.test.js`: 2,198 to 2,907
  lines, 76 to 93 tests (one mandated replacement that splits into
  two, one declared assertion update, 16 new tests, plus the
  seedIdemRecord, seedUncertainOperation, matchingListing, and
  sha256HexOf helpers).
- `~/workspace/etsy-gateway/README.md`: status line, Durable Object
  record notes, three operations routes in the API table, a new
  "Idempotency operations: ownership, states, and recovery" section
  with the never-retry-uncertain rule, and updated idempotency and
  publish security bullets.
- `~/workspace/etsy-gateway/CORRECTION-REPORT.md`: this section.
- `~/workspace/custom-connectors/custom.etsy/CONNECTOR.md`: three
  operation rows (status, reconcile, owner abandon), the operation
  states and never-retry-uncertain behavior bullets, the post-lock
  re-read note, and the setup-secret bullet extended to abandon.
- `~/workspace/fultonprintables/OPERATIONS-LOG.md`: one row for this
  correction.

NOT modified: `~/workspace/etsy-gateway/wrangler.toml` (no new binding
or variable; the setup secret was already a secret, not a var), the
helper `~/workspace/custom-connectors/custom.etsy/bin/etsy_api.py` (it
gains no operation commands in this pass and must never reference the
setup secret; the recovery routes are documented in the README and the
connector doc), and `~/workspace/fultonprintables/ETSY-APP-REGISTRATION-PACKET.md`
(the owner procedure is unchanged: abandon uses the setup secret the
packet already documents, so no packet edit was needed).

## Remaining findings by severity (updated)

- Critical: 0.
- High: 0.
- Medium: 0.
- Low: 5. Items 1 to 4 are unchanged from the correction pass list
  above (htmlResponse literal escaping, accepted; the file_id versus
  listing_file_id documentation conflict, unverifiable offline; the
  non-transactional rate-check fallback that never runs in production;
  the informational pre-correction token-record note). Item 5 is new:
  5. (New, Low) Reconciliation searches only the first 100 listings of
     each state and matches on title, timestamp, and, where exposed,
     price and quantity. That is evidence, not proof: a match beyond
     the first page or two same-title listings in the same window
     leave the operation uncertain by design, resolvable only by the
     owner's abandon judgment. Accepted as the safe failure mode; the
     alternative (guessing) is what this correction exists to prevent.

## Updated verdict

READY FOR INDEPENDENT REVIEW

Deployment remains BLOCKED. This verdict is the ceiling for the build
side, unchanged by this correction: it does not authorize deployment,
registration, OAuth initiation, or any live Etsy call. The next
approval must come from an independent review of the revised source,
followed by the owner's explicit authorization.
