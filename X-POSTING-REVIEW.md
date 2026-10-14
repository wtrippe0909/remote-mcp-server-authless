# Durable X Posting for the Fleet MCP Server — STAGED FOR REVIEW

**Status:** STAGED FOR REVIEW — not deployed, no secrets set, no commits to the GitHub repo.
**Staged by:** Muse, 2026-10-14, on GFED's explicit order ("Stage a durable X posting version for my review — no deploy yet").
**Base:** `wtrippe0909/remote-mcp-server-authless` @ `d0617a3` (verified live via GitHub before staging; local clone in this folder is the staging copy).
**Supersedes:** Grok's 2026-10-14 text-only draft (parked). Its three fatal defects are fixed here: correct env handling, authenticated endpoint, durable (non-expiring) OAuth 1.0a instead of a static 2-hour OAuth 2.0 token. Its merge-not-replace lesson is honored: existing tools, the ExecutiveOperator export, and the scheduled handler are untouched.

---

## 1. What GFED asked, in scope terms

- A **durable** way to post to X — not another one-shot paste of API values per post (the 2026-10-14 "The Room Leaks" post worked that way: values used once, transiently, script deleted).
- **Fleet-shared:** Muse, Grok, and his other AIs should all be able to use the same endpoint.
- **Review only:** stage it, deploy nothing.

## 2. Answer to "can any of my AIs use it?"

**Yes — by design.** This is a standard remote MCP server. Any AI client that can connect to a remote MCP URL with a custom `Authorization: Bearer` header can call it. Access is **per client**: the `MCP_CLIENT_TOKENS` secret holds one token per AI (`muse`, `grok`, `chatgpt`, …). GFED hands each AI its own token; revoking one AI never touches the others, and the X credentials themselves are never given to any AI — they live only as Worker secrets and every request is signed server-side.

Honest per-client status (each client's connector UI must be tested once, at deploy time — none of this is pre-verified):

| Client | Route | Status |
|---|---|---|
| Muse | Add the `/mcp` URL + its token via Muse's connector flow | Expected; test at deploy |
| Grok | grok.com/connectors → Custom (this is the flow Grok itself proposed) | Expected; test at deploy |
| ChatGPT | Custom MCP connector (developer mode) | Expected; test at deploy |
| Gemini | Settings → Connected apps → Custom apps | Expected; test at deploy |
| Claude | Remote MCP in Claude settings | Expected; test at deploy |

If a client's UI cannot send a custom bearer header, that client cannot use this endpoint until it can — that is a client limitation, not a server one. The fallback for such a client stays the proven one-shot route.

## 3. What changed vs the repo baseline (the whole diff)

| File | Change |
|---|---|
| `src/x-posting.ts` | **New.** OAuth 1.0a signing (WebCrypto HMAC-SHA1), X API client (`/2/users/me`, `/2/tweets`, chunked v2 media upload), per-client MCP auth, publish gate, and the three tools. |
| `src/index.ts` | **Merge only.** Imports + one registration line in `init()`; `/mcp` now requires a valid per-client token (401 otherwise, fails closed when tokens aren't configured); new public `/health`; server renamed "Fleet MCP Server", version 1.1.0. Existing tools (`add`, `calculate`, `greet`), the `ExecutiveOperator` export, and the `scheduled()` handler are byte-identical. |
| `wrangler.jsonc` | Adds one var: `"X_POSTING_ENABLED": "false"` plus a comment listing the deploy-time secrets. Nothing else touched (bindings, migrations, cron all as before). |
| `test/x-posting.test.ts` | **New.** Signature test against the RFC 5849 spec vector (+ cross-implementation check), percent-encoding, upload-segment slicing, missing-secret failure, per-client auth (incl. fail-closed). 6/6 passing. |

## 4. The three tools

| Tool | What it does | Gate |
|---|---|---|
| `x_whoami` | One read-only `GET /2/users/me`; proves the Worker's credentials resolve to the right account before any posting session. | Valid client token |
| `draft_x_post` | Returns the exact text + length check. **No X API call, nothing posts.** This is the review artifact an AI shows GFED. | Valid client token |
| `publish_x_post` | Optionally uploads ONE media item (chunked v2 flow: initialize → append <5 MB segments → finalize → processing poll), then `POST /2/tweets`. Returns the post ID and URL. | Client token **+** `X_POSTING_ENABLED=true` **+** GFED's current approval code (see §5) |

## 5. The approval gate (how review-first survives a shared tool)

Publishing governance (DRAFT → REVIEW → APPROVE → PUBLISH) is enforced on the server, not by asking AIs nicely:

1. **Master switch:** `X_POSTING_ENABLED` ships as `"false"`. Until GFED flips it, `publish_x_post` refuses every call. Drafts and `x_whoami` still work.
2. **Per-post code:** every publish call must carry `gfed_approval`, which must equal the `GFED_APPROVAL_CODE` secret. GFED issues the code when he approves a specific post — the flow for any AI is: `draft_x_post` → show GFED the exact text → GFED gives the code → AI publishes with it.
3. **Rotation (GFED's choice at deploy):** the code can be one standing code he keeps private to his AIs' approval chats, or he can rotate it in the Cloudflare dashboard after each use for true one-time codes. Rotation costs him ~30 seconds per post; the staged code supports both with no changes.

Known limit, stated plainly: an approval code an AI has seen once can be replayed by that AI until GFED rotates it. Combined with the master switch and per-client tokens (revocation), the residual risk is bounded — but if GFED wants hard one-time use, that needs a small state store (Durable Object counter) and is a v1.1 item, not hidden in this build.

## 6. Secrets — what GFED sets once, at deploy time only

Via `wrangler secret put` (or the Cloudflare dashboard), never in files or chat:

`X_CONSUMER_KEY` · `X_CONSUMER_SECRET` · `X_ACCESS_TOKEN` · `X_ACCESS_TOKEN_SECRET` · `GFED_APPROVAL_CODE` · `MCP_CLIENT_TOKENS` (JSON: one token per AI client)

Notes:
- These are the same four OAuth 1.0a values from his X developer project (app permissions already "Read and write" for @wtrippe0909). OAuth 1.0a user tokens do **not** expire on a timer — they stay valid until revoked/regenerated. That is why this route is durable and Grok's OAuth 2.0 static-token version was not.
- Because the values GFED pasted into the Room Leaks chat still sit in that chat's transcript, the recommended deploy-day hygiene is: **generate a fresh Access Token pair in the X console first**, then set the secrets from the fresh values. The pasted pair can then be treated as burned.
- Cost stays on his X project as before: Pay Per Use, cents per post (the Room Leaks post's verify+upload+post+read-back landed in the cents range, itemized in his X console).

## 7. Validation done in staging (no deploy)

- `npm run type-check` (tsc --noEmit) on the full repo with the merge in place: **passes**. The repo's existing suite still passes 22/22 (nothing existing was broken by the merge).
- New test suite (`test/x-posting.test.ts`, 5/5 passing): the OAuth 1.0a signature is verified against the **RFC 5849 spec's own worked example** (known keys, nonce, timestamp → the spec signature comes out), plus an X-shaped POST whose signature was cross-checked against a second, independent signing implementation. Together they exercise percent-encoding, parameter sorting, query+form inclusion, and HMAC-SHA1 end to end. Auth tests cover client identification and fail-closed behavior.
- One diligence note from testing: X's docs show a famous example header signature that does **not** reproduce from the docs' own published inputs — on either of two independent implementations. The staged code follows the spec vector, not the docs example; if a live `x_whoami` at deploy time ever returned 401, this discrepancy is the first place to look, and the fix would be small.
- Post-audit fix (2026-10-14, after Grok's PR #14 audit came back clean): Muse's own re-check caught a real media bug both the builder and Grok's audit missed — upload segments were taken as `subarray` views but sent via their underlying `.buffer`, which is the *whole file*, so any media over one 4 MB segment would have been corrupted/rejected. Fixed by copying segments (`sliceSegment`), with a regression test pinning exact segment lengths. New suite is now 6/6. Single-segment media (≤4 MB — e.g. the Room Leaks delivery clips) was never affected.
- Post-deploy addition (2026-10-14, PR #15): Grok's custom-connector dialog accepts ONLY a server URL (no header/token field — GFED's screenshot is the evidence) and rejects the endpoint because its unauthenticated probe gets the by-design 401. On GFED's explicit order, `authenticateMcpRequest` also accepts the same per-client token as a `?key=` query parameter when no Authorization header is present (header still wins when both are sent). Tradeoff, accepted by GFED with the design in front of him: URL tokens can land in request logs; mitigations are per-client revocability and the standing approval code still gating publish. Suite grows to 7 auth/signature tests.
- **Not validated, flagged honestly:** no live X call was made (no secrets exist in staging by design). The media **STATUS poll path** follows the published v2 chunked-upload flow but is unverified against the live API — it is deploy-day test step 1, before any real post. Per-client connector UIs (§2) are likewise deploy-day tests.

## 8. Deploy-day checklist (only on GFED's future explicit order — this is NOT that order)

1. Regenerate the Access Token pair in the X console (transcript hygiene, §6).
2. Apply this staged diff to the repo (branch + PR per the fleet rule; GFED merges — no direct `main` commits).
3. Set the six secrets (§6); confirm `X_POSTING_ENABLED` is still `"false"`.
4. `npm run deploy`; hit `/health` — expect `x_posting_enabled: false`, `mcp_auth_configured: true`.
5. Connect ONE client (Muse) with its token; run `x_whoami` — expect William Trippe @wtrippe0909.
6. Media test: upload a short throwaway clip via a draft publish with posting still disabled (expect refusal), then flip the switch, publish ONE test post with a fresh approval code, read it back on x.com, rotate the code.
7. Connect Grok with *its own* token; repeat `x_whoami`. Then the remaining clients, one token each.
8. Decide the approval-code rotation habit (§5.3) and write it into the runbook.

## 9. Decisions GFED still owns

1. **Deploy or keep parked?** Staging was his explicit override for Class B preparation only. Deployment (Class C) and any X posting program remain under the Oct 13 lock until he lifts it — the Oct 20 measurement and Nov 1 run end still stand as the natural review points.
2. **Approval code style:** standing code vs rotate-per-post (§5.3).
3. **Which clients get tokens** at deploy (§2) — recommend Muse + Grok first, others on demand.
4. **Repo path:** this staged clone, or should Muse prepare the branch/PR package so deploy day is one merge away? (Preparing a branch is a GitHub write — per-action approval, asked separately.)
