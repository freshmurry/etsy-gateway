# Etsy Gateway Production Readiness Audit

Date: 2026-11-09. Auditor: Muse, at the owner's direction.
Scope: `~/workspace/etsy-gateway/` (index.js, wrangler.toml, README.md,
test/gateway.test.js), plus `~/workspace/custom-connectors/custom.etsy/`
and `~/workspace/fultonprintables/ETSY-APP-REGISTRATION-PACKET.md`.
Restrictions honored: nothing was deployed, no Etsy application was
registered, no authorization was requested, no listing was published, and
no live Etsy call was made. The only Etsy resources read were public
official documentation pages and the official OpenAPI specification.

## Verdict

**READY FOR OWNER DEPLOYMENT**

Conditions attached to this verdict, all mandatory:

1. Deploy to the test environment first (`wrangler deploy --env test`)
   and complete the live verification checklist in the Remaining
   Limitations section there before any production deploy.
2. This verdict is not based on mocked tests alone. It rests on three
   legs: every mandatory remediation in the owner's directive is
   implemented, every Etsy endpoint the gateway calls was verified
   against Etsy's current official documentation (table below, with one
   explicitly flagged exception), and the expanded mocked suite passes
   50 of 50. Zero Critical or High findings remain unfixed.
3. If any live verification step fails, the verdict for production falls
   back to BLOCKED: API IMPLEMENTATION FINDINGS until the failure is
   understood and fixed.

## Architecture assessment

The gateway pattern is sound and remains the right answer to the original
integration problem: Etsy requires two distinct secrets per request (the
`x-api-key` header carrying keystring:shared_secret, plus an OAuth bearer
token), and Muse's secure connection flow deposits exactly one secret.
Holding the Etsy credentials as Worker secrets, performing OAuth and all
Etsy calls inside Lawrence's Cloudflare account, and exposing one
gateway key to Muse preserves that separation.

The prototype's weak point was state management, not shape. All critical
OAuth state sat in Cloudflare KV, which is eventually consistent, and
token refresh was an unguarded read-modify-write. Both are fixed by
moving state into a single Durable Object (`EtsyTokenStore` in index.js),
which serializes state consumption, token storage, refresh, idempotency,
and rate limiting in one place. The Worker remains a single dependency
free file, and the Durable Object logic is testable in plain node with
an in-memory storage stub.

The audit also found that the prototype's write path would have failed
against the real API: it sent JSON bodies to endpoints whose official
specification contracts form-encoded bodies. That is corrected, and the
gateway now validates all input before converting it.

## Findings

Severity counts: Critical 2, High 4, Medium 5, Low 6. Total 17.
Unfixed: 2, both Low, each with a stated reason.

| ID | Severity | Finding (evidence in the pre-audit code) | Fix applied |
|---|---|---|---|
| F-01 | Critical | OAuth state stored in KV with a 600 second TTL (index.js lines 97 to 101). KV is eventually consistent, so a callback arriving at a different point of presence could fail to read a just-written state, or read a consumed state again. Intermittent, hard to reproduce, breaks the only authorization path. | State records moved into the Durable Object (index.js line 216, class `EtsyTokenStore`; consume at line 252). Single-use enforced by delete on first callback attempt. Covered by unknown, expired, and replayed state tests. |
| F-02 | Critical | Token refresh was an unguarded KV read-modify-write (lines 147 to 170). Two concurrent requests with an expired token could both refresh; the second write could overwrite the newly rotated refresh token with stale state, permanently breaking authorization until the owner re-consents. | Refresh runs inside the Durable Object (`handleTokensEnsure`, line 282) behind a shared in-flight promise. A test fires two concurrent requests against a delayed token endpoint and proves exactly one token call and the rotated refresh token stored. |
| F-03 | High | Write endpoints were called with `content-type: application/json` and a raw JSON body (shop update lines 239 to 245, draft create lines 251 to 256, listing update lines 268 to 275). Etsy's official OpenAPI specification contracts `application/x-www-form-urlencoded` for createDraftListing, updateListing, and updateShop. These writes would fail against the live API even though mocked tests passed, because the mock accepted any body. | Muse-facing JSON is validated, then converted with a form encoder before every upstream write. Tests assert the upstream content type and the encoded field values for draft create, publish, and shop update. |
| F-04 | High | Requested scopes exceeded least privilege (line 16): `listings_d` (delete listings) and `transactions_w` (write transaction data) were requested with no business requirement in the operating directive. | Scope string reduced to exactly `listings_r listings_w shops_r shops_w transactions_r` (line 21) everywhere: Worker, tests, README, connector doc, registration packet. The DELETE listing route was removed from the allowlist (a DELETE now returns 405); listings are retired by deactivation. |
| F-05 | High | No rate limiting anywhere. A leaked gateway key would have meant an unrestricted proxy into the owner's Etsy shop at whatever rate Etsy allows. | Rate limiting inside the Durable Object (`handleRateCheck`, line 355): 60 authenticated requests per minute by default, configurable with `RATE_LIMIT_PER_MINUTE`. Over-limit returns 429 with `retry-after`. Covered by test. Cloudflare edge rate limiting can be added at deploy time as a second layer; the in-gateway limit is the portable control. |
| F-06 | High | No idempotency on draft creation (lines 251 to 256): any retried POST, from a client timeout or a duplicated instruction, would create a second draft listing. Publishing had the same hole: a repeated activate request would issue a second publish call. | `POST /api/listings/draft` requires an `Idempotency-Key` header (line 911). The Durable Object stores key, request hash, and the completed successful response for 24 hours (`handleIdemBegin`, line 313). Same key and body replays the stored response with an `x-idempotent-replay` header and no second Etsy call; same key with a different body returns 409; an in-progress duplicate returns 409; failed Etsy responses abort the record and are never stored as successes. Publish is guarded: a state=active PATCH first reads the listing and, if already active, returns it with `already_active` and makes no publish call (line 1041). All covered by tests. |
| F-07 | Medium | Gateway key compared with `!==` (line 216), a short-circuit comparison that leaks timing information about the correct prefix. | Constant-time comparison over SHA-256 digests of both values (`timingSafeEqual`, line 155; used at line 838). |
| F-08 | Medium | No request size limits. Multipart bodies were buffered whole with `request.arrayBuffer()` (the upload block, lines 266 to 276) at whatever size a caller sent. | JSON bodies capped at 256 KB and multipart at 20 MB (`JSON_MAX_BYTES` line 28, `MULTIPART_MAX_BYTES` line 32), enforced from the declared content length and again from the actual bytes, returning 413 before any Etsy call. The 20 MB figure is a gateway policy choice: Etsy publishes no listing file size limit in the documents verified for this audit. Covered by tests. |
| F-09 | Medium | No input validation. Draft, update, and shop bodies were forwarded raw, and list/receipt query strings were passed through untouched (lines 246 and 263), so arbitrary parameters and fields reached Etsy and errors surfaced only live. | Validators for all three write shapes (`validateCreateListing` line 477, `validateUpdateListing`, `validateUpdateShop` line 587) enforce documented required fields, types, enums, and field allowlists from the OpenAPI specification, including the tutorial rule that physical listings require `shipping_profile_id` and `readiness_state_id`. Read queries are rebuilt from documented allowlists only (`validateReadQuery` line 612), with integer and enum checks. Rejections return 400 with zero Etsy calls, covered by tests. |
| F-10 | Medium | Multipart uploads were forwarded without checking that the form fields match Etsy's endpoint requirements. | Uploads are parsed and validated before forwarding: field names restricted to the documented sets, and exactly one of the binary part or the already-uploaded id is required, never both, never neither. Malformed multipart returns 400, oversized returns 413. Covered by tests for the files endpoint, the images endpoint, neither/both, unknown fields, malformed, and oversized bodies. |
| F-11 | Medium | Documentation blurred capabilities: the connector doc listed a delete operation and write transaction scope as available, and shop "messages" wording could be read as buyer messaging. | Corrected in README, CONNECTOR.md, the registration packet, and the helper docstring. The precise claim everywhere now: `updateShop` sets shop-level text (title, announcement, sale message, digital sale message). An explicit unsupported list appears in the connector doc and README: buyer messaging and conversations, refunds and cases, Etsy Ads, shop statistics, branding assets, policy page editing, listing deletion, and transaction writes. |
| F-12 | Low | OAuth state and PKCE verifier were generated with `randomUrlSafe` using `byte % charset.length` (lines 52 to 60), which has modulo bias, and the state was 32 characters. Well above brute-force range in practice, but below the standard Etsy itself recommends. | Both now use 32 bytes from `crypto.getRandomValues` encoded as url-safe base64: 256 bits, 43 characters, matching Etsy's documented verifier construction. RFC 7636 test vector passes. |
| F-13 | Low | The Etsy response passthrough rebuilt headers from scratch (lines 185 to 191), silently dropping Etsy's `retry-after` on 429 responses. | The passthrough now forwards `retry-after` when Etsy sends it. Covered by the 429 passthrough test. |
| F-14 | Low | The callback ignored Etsy's `error` parameter, so a denied consent fell into the generic missing-code path. | The callback checks for an error parameter first and returns a clear 400 page. Covered by test. |
| F-15 | Low | One environment only: `wrangler.toml` had a single production configuration, so the first live test would have run against production state. | `wrangler.toml` now declares the Durable Object binding with a `new_sqlite_classes` migration and a separate `[env.test]` configuration (name `etsy-gateway-test`, its own binding and variables), so testing uses isolated storage. |
| F-16 | Low | `htmlResponse` interpolates its title and message without escaping. UNFIXED, accepted: every call site passes compile-time literal strings; no caller input, Etsy response content, or credential material is ever interpolated. Revisit if a call site ever takes dynamic input. | Accepted as documented. |
| F-17 | Low | Granted scopes are not compared against requested scopes after consent. Etsy may grant a subset; the gateway would then surface Etsy's 403 responses at call time. UNFIXED, by design: the 403 passthrough behavior is correct and tested, and the first live verification includes a scope check on the stored token record (the granted scope string is saved with the tokens). | Accepted as a remaining limitation, with the live check named below. |

## Endpoint verification against Etsy's official documentation

Sources used, all official Etsy material read during this audit:

- Authentication essentials: https://developer.etsy.com/documentation/essentials/authentication/
- Listings tutorial: https://developers.etsy.com/documentation/tutorials/listings/
- Shop management tutorial: https://developers.etsy.com/documentation/tutorials/shopmanagement/
- Official OpenAPI specification (the same document the reference UI renders): https://www.etsy.com/openapi/generated/oas/3.0.0.json

| Interaction | Status | Evidence |
|---|---|---|
| Authorize URL `https://www.etsy.com/oauth/connect` with response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method=S256 | VERIFIED | Authentication essentials, Step 1 parameter table. Redirect URI matching is exact and case-sensitive, trailing slash fails: same page, Redirect URIs section. |
| Token endpoint `POST https://api.etsy.com/v3/public/oauth/token`, fields grant_type, client_id, redirect_uri, code, code_verifier, form-encoded | VERIFIED | Authentication essentials, Step 3 parameter table. Token response shape, 3600 second access token, 90 day refresh token, user id prefix on the access token: same page. |
| Refresh grant fields (grant_type=refresh_token, client_id, refresh_token) | VERIFIED | Authentication essentials refresh token grant documentation; rotation behavior handled defensively (a missing new refresh token keeps the previous one). |
| PKCE: verifier 43 to 128 chars from the unreserved set, S256 challenge, required on every flow | VERIFIED | Authentication essentials, PKCE section, which also recommends encoding 32 bytes of random data as url-safe base64: exactly what the gateway now does. Cryptographic correctness proven by the RFC 7636 test vector in the suite. |
| `x-api-key` header as keystring:shared_secret on every request, plus OAuth bearer for scoped endpoints | VERIFIED | Authentication essentials, API Key section; repeated in both tutorials. |
| getMe `GET /v3/application/users/me`, oauth shops_r | VERIFIED | OpenAPI specification, operation getMe. |
| getShop `GET /v3/application/shops/{shop_id}` | VERIFIED | OpenAPI specification, operation getShop (spec lists no oauth scope requirement for this operation; the gateway sends its token anyway, which is harmless). |
| updateShop `PUT /v3/application/shops/{shop_id}`, requires shops_r and shops_w together, fields title, announcement, sale_message, digital_sale_message | VERIFIED | OpenAPI specification, operation updateShop; shop management tutorial lists the same four attributes. The specification also lists a `policy_additional` field, which the gateway deliberately excludes per the owner's field restriction. |
| createDraftListing `POST /v3/application/shops/{shop_id}/listings`, listings_w, form-encoded, required fields quantity, title, description, price, who_made, when_made, taxonomy_id, success 201 | VERIFIED | OpenAPI specification, operation createDraftListing (required list read from the schema); listings tutorial minimum body list agrees, and adds image_ids for active listings and shipping_profile_id plus readiness_state_id for physical listings. |
| getListingsByShop `GET /v3/application/shops/{shop_id}/listings`, listings_r, state enum and limit, offset, sort_on, sort_order, includes parameters | VERIFIED | OpenAPI specification, operation getListingsByShop. |
| getListing `GET /v3/application/listings/{listing_id}` | VERIFIED | OpenAPI specification, operation getListing. |
| updateListing `PATCH /v3/application/shops/{shop_id}/listings/{listing_id}`, listings_w, form-encoded, state enum active and inactive only, type enum physical, download, both | VERIFIED | OpenAPI specification, operation updateListing; listings tutorial confirms publishing via state=active, setting type=download for digital listings, and a 409 when converting a multi-product physical listing to digital. The gateway field allowlist is the specification's field list. |
| deleteListing `DELETE /v3/application/listings/{listing_id}`, requires listings_d | VERIFIED as an endpoint, REMOVED from the gateway | OpenAPI specification, operation deleteListing. Removed under the least-privilege scope decision (F-04); deactivation is the supported retirement path. |
| uploadListingImage `POST .../listings/{listing_id}/images`, listings_w, multipart, `image` binary or `listing_image_id`, not both | VERIFIED | OpenAPI specification, operation uploadListingImage; listings tutorial agrees on both field names and the not-both rule. |
| uploadListingFile `POST .../listings/{listing_id}/files`, listings_w, multipart, `file` binary field | PARTIALLY VERIFIED, one field name UNVERIFIED | The binary `file` field is confirmed by both the specification and the listings tutorial. For associating an already-uploaded file, the tutorial prose says `file_id` while the OpenAPI schema names the field `listing_file_id`. The gateway follows the specification (`listing_file_id`). This affects only the associate-existing-file path, not uploads, and is listed as a remaining limitation, not a deployment blocker for the test environment. |
| getShopReceipts `GET /v3/application/shops/{shop_id}/receipts`, transactions_r, documented parameter set | VERIFIED | OpenAPI specification, operation getShopReceipts. |
| Listing file size limit on Etsy | UNVERIFIED | No size limit is published in the specification or tutorials reviewed. The gateway 20 MB cap is therefore labeled a gateway policy choice everywhere it appears. |
| Reference pages at developers.etsy.com/documentation/reference | Not relied on | They render client-side and return no operation text to a plain fetch, which is why this audit verified against the official OpenAPI specification document itself, the same source the reference UI renders. |

## Security design summary

- Authentication: gateway key required on every `/api/*` route, compared
  in constant time over SHA-256 digests. Route and method allowlist runs
  before credential checks; unknown paths 404, wrong methods 405.
- Authorization state: all Etsy credentials stay in Worker secrets; all
  OAuth state and tokens stay in the Durable Object; nothing sensitive
  is logged (there are no console calls in the file, enforced by a source
  scan test) and no token or secret value appears in any response,
  including error paths and the OAuth success page (asserted by tests).
- OAuth: 256-bit single-use expiring state, PKCE S256 with Etsy's
  recommended verifier construction, verifier looked up only from the
  Durable Object record, state deleted on first callback attempt.
- Refresh integrity: serialized inside the Durable Object with a shared
  in-flight promise; concurrent refresh attempts produce exactly one
  token endpoint call; rotation stores the newest refresh token.
- Abuse controls: Durable Object rate limiting (60 per minute default,
  configurable), request size caps (256 KB JSON, 20 MB multipart),
  a cap of 100 outstanding authorization states with expiry pruning,
  strict input validation, and a fixed Etsy base URL with paths built
  only from validated segments (no arbitrary URL forwarding).
- Write safety: idempotency keys required for draft creation with
  replay, conflict, and in-progress semantics in the Durable Object;
  publish guard for already active listings; failed Etsy responses are
  never stored as idempotent successes and never converted to gateway
  successes: upstream 400, 401, 403, 404, 429, and 500 all pass through
  with their status, and 429 keeps `retry-after`. Each status is covered
  by a test.
- Least privilege: five scopes only. No delete route, no transaction
  writes, and field allowlists that keep undocumented parameters from
  ever reaching Etsy.

## Test execution report

Runner: `node --test` via `npm test`, mocked fetch and an in-memory
Durable Object storage stub. No network, no real credentials.

Final run: **50 tests, 50 passed, 0 failed, duration 367 ms.**
(The pre-audit suite had 11 tests; its behaviors are preserved where the
remediation did not deliberately change them, for example the DELETE
route test now asserts 405.)

Coverage added in this audit: invalid state, expired state, replayed
callback, missing code, Etsy error parameter on callback, PKCE failure
at the token endpoint, RFC 7636 vector, token refresh success and
failure, concurrent refresh producing exactly one token call, refresh
rotation, Durable Object persistence across a simulated restart (a new
object instance over the same storage), missing and wrong gateway key,
unknown route 404, wrong method 405, non-numeric listing id, oversized
JSON 413, oversized multipart 413, malformed JSON 400, malformed
multipart 400, multipart neither/both/unknown-field 400, missing draft
fields 400 with zero Etsy calls, physical listing missing shipping
fields 400, disallowed updateListing field, invalid update state,
non-allowlisted updateShop field, query allowlist validation for
listings and receipts, rate limit 429, idempotency replay with one Etsy
call, idempotency conflict 409, failed creation not stored, publish of
an already active listing with no publish call, publish of a draft with
form-encoded state, form-encoding assertions for create and shop update,
Etsy 400, 401, 403, 404, 429 (with retry-after), and 500 passthrough,
insufficient-scope 403 passthrough, and token-leak assertions on error
and callback responses plus a source scan for logging calls, KV
remnants, and the exact scope string.

## Remaining limitations

1. Live behavior is unverified, by restriction. No live OAuth exchange,
   live token refresh, live multipart upload, or live shop lookup has
   ever succeeded, because deployment and app registration are not
   authorized. Mocked tests cannot prove Etsy's live responses match its
   documentation.
2. Live verification checklist for the test environment, in order:
   health check; authorize and consent with the five scopes; confirm the
   stored token record's granted scope string contains all five scopes
   (see F-17); `GET /api/shop` returns FultonPrintables; create one
   draft with an idempotency key; upload one image and one digital file
   to that draft; set type to download; publish; read it back active;
   deactivate it; read receipts. Any failure stops the rollout under the
   verdict conditions.
3. The already-uploaded file association field name conflict
   (`file_id` in tutorial prose versus `listing_file_id` in the
   specification) is unresolved in Etsy's own materials. Uploading new
   files, the primary path, is unaffected. Resolve it during the live
   checklist by testing one association on the test draft.
4. The gateway cannot do, and does not claim: buyer messaging, refunds
   or cases, Etsy Ads, shop statistics, branding assets, policy page
   editing, listing deletion, or transaction writes.
5. Rate limiting inside the Durable Object is per gateway identity and
   accurate for this single-key design; it is not a substitute for
   Cloudflare edge controls if the gateway host is ever exposed beyond
   Muse's use.
6. The authorize endpoint is intentionally reachable without the gateway
   key (the owner must open it in a browser). Outstanding states are
   capped and expire in 600 seconds, but a determined third party who
   learned the URL could still mint states up to the cap. Impact is
   bounded: a state alone grants nothing without the owner's Etsy
   consent and credentials.
7. F-16 and F-17 remain open as accepted Low findings, documented above.

## Files changed in this audit

- `index.js`: rewritten (Durable Object state, security controls,
  validation, form encoding, idempotency, reduced scopes, DELETE route
  removed).
- `wrangler.toml`: KV binding removed; Durable Object binding, sqlite
  migration, rate limit variable, and `[env.test]` added.
- `test/gateway.test.js`: expanded from 11 to 50 tests.
- `README.md`: rewritten for the new architecture and corrected claims.
- `~/workspace/custom-connectors/custom.etsy/CONNECTOR.md`: corrected
  claims, explicit unsupported list, delete operation removed.
- `~/workspace/custom-connectors/custom.etsy/bin/etsy_api.py`: docstring
  aligned with the corrected claims; still compiles (`py_compile` OK).
- `~/workspace/fultonprintables/ETSY-APP-REGISTRATION-PACKET.md`: scope
  list reduced with the two exclusions explained; KV step replaced with
  the Durable Object migration note; test count updated.
- `~/workspace/fultonprintables/OPERATIONS-LOG.md`: audit row added.
