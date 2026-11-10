# etsy-gateway

A single-file Cloudflare Worker that connects Muse to Lawrence's Etsy shop
FultonPrintables without any Etsy credential ever reaching Muse.

## Why this exists

Etsy needs two distinct secrets on every API call: the `x-api-key` header
carrying `keystring:shared_secret`, plus an OAuth bearer token. Muse's secure
connection flow deposits exactly one secret per connection, so Etsy cannot be
connected to Muse directly. This Worker solves that:

- It runs in Lawrence's own Cloudflare account.
- It holds the Etsy app credentials as Worker secrets and the OAuth state
  and tokens inside a Durable Object. Etsy tokens never leave Lawrence's
  Cloudflare account.
- It performs every Etsy API call itself.
- It exposes a small JSON API to Muse protected by one secret,
  the gateway API key, sent in the `x-gateway-key` header.

Public host once deployed: `etsy-gateway.lawrencemurry.workers.dev`
OAuth redirect URI registered with Etsy:
`https://etsy-gateway.lawrencemurry.workers.dev/oauth/callback`

Status: audited, remediated, and corrected after the owner's independent
code review (see `AUDIT-REPORT.md` and `CORRECTION-REPORT.md`), with a
further lease and uncertain-outcome correction on 2026-11-10 (the LEASE
CORRECTION section of `CORRECTION-REPORT.md`). NOT deployed. Deployment
is BLOCKED pending independent review of the corrected source and a
separate owner authorization. Whenever deployment is authorized later,
deploy to the test environment first.

## Files

- `index.js` - the whole Worker, dependency-free ES module, including the
  `EtsyTokenStore` Durable Object class.
- `wrangler.toml` - Worker config: Durable Object binding and migration,
  rate limit variable, and a separate `[env.test]` configuration.
- `test/gateway.test.js` - node test suite with mocked fetch and an
  in-memory Durable Object storage stub. Run it with `npm test`.
- `AUDIT-REPORT.md` - the production readiness audit, findings, endpoint
  verification against Etsy's official documentation, and the verdict.
- `CORRECTION-REPORT.md` - the independent code review correction pass:
  transactional Durable Object operations, granted-scope verification,
  setup-secret authorization initiation, the per-listing publish lock,
  test results, and the verdict.

## Architecture

All critical OAuth state lives in one Durable Object instance
(`EtsyTokenStore`, addressed by a fixed name), because Cloudflare KV is
eventually consistent and caused two real risks: a callback could miss a
just-written OAuth state, and two concurrent requests could race a rotating
refresh token. The Durable Object stores:

- OAuth state records: 256-bit random state, the PKCE verifier, and a
  600 second expiry. States are single-use and deleted on the first
  callback attempt, success or failure.
- The token record. Refresh runs inside the Durable Object and concurrent
  callers share one in-flight refresh, so exactly one token request is
  made and the rotated refresh token is stored once.
- Idempotency records for draft listing creation, kept as a durable
  operation state machine (see the operations section below). Completed
  and failed records are retained for 24 hours; in-progress and
  uncertain records are never dropped by age, because an uncertain
  outcome must stay resolvable.
- Per-listing publish locks, so two simultaneous publish attempts for the
  same listing cannot both activate it.
- The gateway rate-limit window, plus the failed setup-attempt window
  that protects authorization initiation.

Every read-modify-write in the Durable Object runs inside a serialized
transaction (`storage.transaction` in production; the test stub
implements snapshot-and-rollback), so a check and its write are decided
against one consistent state: OAuth states are consumed exactly once,
concurrent idempotency begins yield exactly one owner, rate limits admit
exactly their limit under concurrency, and token refresh merges against
the current record so shop metadata updates can never resurrect a spent
refresh token.

There is no KV binding anymore.

## Deploy steps (Lawrence, in his own Cloudflare account)

Nothing here is deployed yet. These steps are done by Lawrence, or by Muse
only when Lawrence has explicitly authorized a deploy in his account.
Deploy to the test environment first, verify there, then deploy production.

1. Set the four Worker secrets for the target environment. Use the
   Cloudflare dashboard (Workers and Pages, the gateway Worker, Settings,
   Variables and Secrets) or the CLI:

   ```text
   wrangler secret put ETSY_KEYSTRING
   wrangler secret put ETSY_SHARED_SECRET
   wrangler secret put GATEWAY_API_KEY
   wrangler secret put SETUP_SECRET
   ```

   Add `--env test` to each command for the test environment.

   - `ETSY_KEYSTRING` and `ETSY_SHARED_SECRET` come from the Etsy Developer
     Portal, Your Apps page, after the Seller App is registered. See
     `~/workspace/fultonprintables/ETSY-APP-REGISTRATION-PACKET.md`.
   - `GATEWAY_API_KEY` is a long random value Lawrence generates himself.
     It is the one secret Muse will later hold, entered only through
     Muse's secure capture flow after deploy. It never goes in chat,
     email, or any file.
   - `SETUP_SECRET` guards authorization initiation (step 4). It belongs
     to Lawrence only: Muse never receives it, the connector never
     references it, and it appears in no response. Generate it with a
     password manager or with `openssl rand -hex 32`, and keep it with
     the other owner-only credentials. Never put it in a URL.

2. Deploy. The Durable Object migration in `wrangler.toml` is applied by
   the deploy; no separate storage setup is needed:

   ```text
   wrangler deploy --env test
   wrangler deploy
   ```

3. Check the health endpoint:

   ```text
   GET https://etsy-gateway.lawrencemurry.workers.dev/health
   ```

   Expected: `{"ok":true,"service":"etsy-gateway"}`

4. Authorize Etsy. This step is owner-only; Muse cannot and does not
   perform it. Open this address in a browser signed in to the Etsy
   account that owns FultonPrintables:

   ```text
   https://etsy-gateway.lawrencemurry.workers.dev/oauth/authorize
   ```

   The page is a plain form. Enter the `SETUP_SECRET` value from step 1
   and submit. The Worker checks the secret in constant time, then
   redirects to Etsy with a PKCE challenge. Approve every requested
   scope on Etsy's consent screen. The Worker receives the code at
   `/oauth/callback`, exchanges it, and stores the tokens in the Durable
   Object. A wrong secret returns 403 and creates no authorization
   state; five failed attempts within ten minutes trigger a 429 until
   the window passes. The secret must never travel in a URL: requests
   that carry it in the query string are rejected.

   After consent, the callback page reports the granted-scope status:
   connected (all five scopes verified from Etsy's token response),
   connected with reduced permissions (Etsy granted fewer scopes; write
   operations stay disabled until a new authorization grants all five),
   or connected with scope confirmation needed (Etsy returned no scope
   information; see the scope section below).

5. Register the Muse connection. After deploy, Muse registers connection
   `custom.etsy-gateway` (api_key scheme, host
   `etsy-gateway.lawrencemurry.workers.dev`, header `x-gateway-key`) and
   Lawrence enters the gateway API key on the secure capture card.

6. Verify. The first live proof is `GET /api/shop` returning the
   FultonPrintables shop from Etsy. Nothing is reported working before
   that response exists.

## API surface

All `/api/*` routes require the `x-gateway-key` header, compared in
constant time. Without stored Etsy tokens they return
`409 {"error":"not_authorized","authorize_url":"/oauth/authorize"}`.
Expired tokens are refreshed automatically inside the Durable Object, and
the rotated tokens are stored.

| Route | Etsy call |
|---|---|
| `GET /health` | none, no auth |
| `GET /oauth/authorize` | serves the owner initiation form only, no state created |
| `POST /oauth/authorize` | setup secret required; on success redirects to Etsy's consent screen with PKCE |
| `POST /oauth/confirm-scopes` | owner-only scope confirmation (setup secret header), no Etsy call |
| `GET /oauth/callback` | exchanges the code, stores tokens, shows no token values |
| `GET /api/shop` | getMe, then `GET /shops/{shop_id}` |
| `PUT /api/shop` | `PUT /shops/{shop_id}` (shop text fields only, see below) |
| `GET /api/listings` | `GET /shops/{shop_id}/listings`, validated query only |
| `GET /api/listings/:id` | `GET /listings/:id` |
| `POST /api/listings/draft` | `POST /shops/{shop_id}/listings`, requires an `Idempotency-Key` header |
| `POST /api/listings/:id/image` | `POST /shops/{shop_id}/listings/:id/images`, multipart validated |
| `POST /api/listings/:id/file` | `POST /shops/{shop_id}/listings/:id/files`, multipart validated |
| `PATCH /api/listings/:id` | `PATCH /shops/{shop_id}/listings/:id` |
| `GET /api/receipts` | `GET /shops/{shop_id}/receipts`, validated query only |
| `GET /api/operations/:idempotency_key` | none (Durable Object read); operation status, no token material |
| `POST /api/operations/:idempotency_key/reconcile` | Etsy reads only (`GET` shop listings, draft then active); never a create |
| `POST /api/operations/:idempotency_key/abandon` | none; setup secret required in addition to the gateway key |

There is deliberately no DELETE route. The gateway does not request the
`listings_d` scope, so a listing is retired by deactivation:
`PATCH /api/listings/:id` with `{"state":"inactive"}`.

Etsy scopes requested at consent:
`listings_r listings_w shops_r shops_w transactions_r`.

## Granted scopes: verification and gating

Etsy's token response documents a `scope` field carrying the scopes
actually granted, which may be a subset of what was requested. The
gateway stores that granted set with a `scope_status`:

- `verified`: the granted set includes all five requested scopes.
  Everything works.
- `incomplete`: the granted set is present but missing scopes. Reads
  proceed. Write operations (draft create, uploads, publish, shop
  update) return `403 {"error":"scopes_incomplete","missing_scopes":[...]}`.
  The fix is a new authorization that grants all five scopes; owner
  confirmation cannot substitute for a missing grant.
- `unverified`: the token response carried no usable scope information,
  so the gateway cannot verify the grant from Etsy data and never
  reports the authorization as verified. Reads proceed. Writes return
  `403 {"error":"scope_unverified"}` until the owner confirms.

Owner confirmation is a deliberate, setup-secret-gated action. Lawrence
runs it himself after checking on Etsy's consent review that all five
scopes were approved:

```bash
curl -X POST https://etsy-gateway.lawrencemurry.workers.dev/oauth/confirm-scopes \
  -H "x-setup-secret: <the SETUP_SECRET value>"
```

The request carries no token and the response echoes none. It records
`scope_status: "owner_confirmed"` with a timestamp, after which writes
proceed. If a later token refresh response carries scope information,
the status is recomputed from it transactionally, so a reduced grant
downgrades the record again.

## Idempotency operations: ownership, states, and recovery

Draft creation is guarded by an `Idempotency-Key`. Behind each key sits
a durable operation record in the Durable Object. The record's `op_id`,
assigned when the operation begins, is its EXECUTION OWNER for the life
of the operation. The 120 second in-progress lease is only a liveness
signal: lease expiry never transfers ownership and never authorizes
another Etsy call. This separation exists because a create that reached
Etsy but whose response was lost must not be duplicated by a retry.

Operation states:

- `in_progress`: the owner is executing (or its lease is still live).
  A retry with the same key returns `409 {"error":"request_in_progress"}`.
- `completed`: a stored successful response. The same key and body
  replay it with zero Etsy calls; a different body returns 409.
- `failed`: a DEFINITE outcome, meaning Etsy returned a response (any
  status) or the request was rejected before any Etsy call. A retry
  with the same key and body starts a new attempt: a fresh owner, an
  incremented attempts counter, and the prior failure kept in history.
- `uncertain`: the outcome is not known. This happens when the lease
  expires while an operation is still marked in progress, or when the
  Etsy create call fails at the network level after the request may
  have been sent (the gateway answers 502 `etsy_outcome_unknown` in
  that case, never a success). A retry with the same key returns
  `409 {"error":"operation_uncertain"}` and makes ZERO Etsy calls.
- `abandoned`: the owner resolved an uncertain operation by declaring
  nothing was created. The key is then free for a genuinely new
  operation.

**Rule: never retry a create against an uncertain operation. Reconcile
first.**

Recovery routes:

- `GET /api/operations/:idempotency_key` (gateway key): the record's
  state, attempts, fingerprint title, created and updated times, and
  the result listing id when present. It returns no token, secret, or
  ownership material.
- `POST /api/operations/:idempotency_key/reconcile` (gateway key):
  valid only for an uncertain record; any other state is returned
  as-is with no side effects. The gateway reads the shop's listings
  from Etsy (draft state first, then active; first 100 per state) and
  matches them against the fingerprint stored when the operation
  began: title exactly equal, creation timestamp at or after the
  operation start (with a 300 second clock-skew allowance before it),
  and price and quantity consistent where the payload exposes them.
  Exactly one match marks the operation completed with a recovered
  flag and returns `{"status":"recovered","listing_id":...}`; zero
  matches returns `{"status":"uncertain","matches":0}` and changes
  nothing (absence in one read is not proof); more than one returns
  `ambiguous: true` and changes nothing. Reconcile never issues a
  create. Title and timestamp matching is evidence, not proof, which
  is why ambiguity stays uncertain.
- `POST /api/operations/:idempotency_key/abandon` (gateway key PLUS
  the owner-only `x-setup-secret` header, under the same guard as
  scope confirmation; the secret in a query string is rejected): only
  valid from uncertain. Marks the record abandoned with a timestamp.
  Declaring that nothing was created is an owner judgment, so the
  gateway key alone is never enough.

The publish flow follows the same analysis with a different result,
because activation is a state transition on an existing listing rather
than a creation: after acquiring the per-listing publish lock, the
gateway ALWAYS re-reads the listing state before issuing any
activation call. If a previous publisher activated the listing and
crashed before releasing its (now expired) lock, the retry returns
`already_active` with zero activation calls. If the listing is still a
draft, exactly one `PATCH state=active` is issued, which is idempotent
on Etsy's side for the same listing. Lock expiry therefore cannot
duplicate anything.

## What the shop update actually is

`PUT /api/shop` sets shop-level text through Etsy's `updateShop`: the shop
`title`, the `announcement` shown on the shop homepage, the `sale_message`,
and the `digital_sale_message` sent to buyers after a purchase. That is
shop text, not buyer communication. The gateway does NOT support:

- Buyer messaging or conversations with individual buyers
- Refunds, cancellations, or cases
- Etsy Ads or promoted listings
- Shop statistics or analytics
- Logo, banner, shop icon, or any other branding asset management
- Shop policy page editing
- Listing deletion (no `listings_d` scope, by design)
- Updating transaction or shipment data (no `transactions_w` scope)

## Security controls

- Gateway key on every `/api/*` route, constant-time comparison.
- Rate limiting inside the Durable Object: 60 authenticated requests per
  minute by default, configurable with the `RATE_LIMIT_PER_MINUTE`
  variable. Over-limit returns 429 with a `retry-after` header.
- Request size limits: JSON bodies 256 KB, multipart uploads 20 MB
  (a gateway policy choice; Etsy publishes no listing file size limit in
  the documents verified for the audit). Over-limit returns 413 before
  any Etsy call.
- Strict route and method allowlist: unknown paths 404, wrong method 405,
  listing ids must be numeric, read queries validated against documented
  parameter allowlists.
- Input validation before any Etsy call: draft creation requires Etsy's
  documented minimum fields with type checks, updates restricted to
  documented field allowlists, shop updates restricted to the four text
  fields.
- Muse-facing JSON is converted to the `application/x-www-form-urlencoded`
  bodies Etsy's specification contracts for create, update, and shop calls.
- No arbitrary URL forwarding: the Etsy base URL is a fixed constant and
  every upstream path is built from validated segments only.
- No credential or token logging anywhere, and no token or secret value
  in any response, including error responses and the OAuth success page.
- Idempotency for draft creation: the same key and body replay the stored
  successful response without a second Etsy call; the same key with a
  different body returns 409; failed Etsy responses are never stored as
  successes. Each operation record is owned by one operation id for its
  whole life: only that operation can complete it, fail it, or mark it
  uncertain, and lease expiry never transfers ownership. An expired
  lease moves the record to the uncertain state instead of allowing a
  takeover; recovery runs through reconciliation or owner abandon only
  (see the operations section above).
- Publishing is guarded three times. A PATCH that would activate an
  already active listing returns the listing with `already_active` and
  issues no activation call (a pure read, so no lock is taken).
  Otherwise a per-listing lock is acquired inside a Durable Object
  transaction before the activation call: a second simultaneous publish
  of the same listing returns `409 {"error":"publish_in_progress"}` and
  issues no Etsy call. After acquiring the lock, the listing state is
  re-read before any activation call, so a retry after a crashed
  publisher finds an already active listing and returns
  `already_active` with zero activation calls. The lock is released on
  success and on failure, by its owner token only, and expires after
  120 seconds if its owner crashes, so a failed publish never wedges
  the listing. Different listings never block each other.
- Authorization initiation requires the owner-only `SETUP_SECRET`
  (constant-time comparison, Durable Object rate limit of 5 failed
  attempts per 10 minutes per source, rejected in query strings). The
  secret is never available to the Muse connector and appears in no
  response.
- Granted-scope gating: writes fail closed with 403 while the granted
  scopes are incomplete or unverified (see the scope section above).
- Etsy errors keep their status at the gateway (400, 401, 403, 404, 429,
  500), and a 429 keeps Etsy's `retry-after` header. A failed Etsy
  request is never reported as a success.

## Known behavior worth knowing

- Etsy access tokens last about one hour; the gateway refreshes when a
  token is expired or inside 60 seconds of expiry.
- Refresh tokens rotate. The gateway always stores the newest refresh
  token Etsy returns; if a refresh response omits one, the previous
  refresh token is kept.
- Updating a listing file on Etsy does not push the new file version to
  past buyers. That is Etsy's platform behavior, not a gateway limit.
