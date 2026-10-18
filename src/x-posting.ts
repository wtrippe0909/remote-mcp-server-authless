/**
 * X (Twitter) posting for the fleet MCP server — STAGED, NOT DEPLOYED.
 *
 * Design (see ../X-POSTING-REVIEW.md for the full review package):
 * - OAuth 1.0a user context, signed server-side with WebCrypto HMAC-SHA1.
 *   The four X values live ONLY as Cloudflare secrets on the Worker.
 *   OAuth 1.0a tokens do not expire on a timer (unlike OAuth 2.0 user
 *   tokens), so this is the durable route proven by the 2026-10-14
 *   "The Room Leaks" post.
 * - The /mcp endpoint is authenticated per AI client (see
 *   authenticateMcpRequest in this file and the fetch handler in
 *   index.ts). The previous authless behaviour is intentionally gone
 *   for this build: an unauthenticated posting endpoint would let
 *   anyone who learns the URL post as the owner.
 * - Publishing is gated by the per-client token auth on this endpoint
 *   plus the X_POSTING_ENABLED master switch, which must be "true".
 *   The former per-call GFED_APPROVAL_CODE requirement was retired by
 *   owner directive 2026-10-17 (the field is still accepted, ignored,
 *   so existing callers keep working). Drafts and identity checks
 *   need no gate.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface XPostingEnv {
	/** Cloudflare secret: X app Consumer Key (OAuth 1.0a). */
	X_CONSUMER_KEY?: string;
	/** Cloudflare secret: X app Consumer Secret (OAuth 1.0a). */
	X_CONSUMER_SECRET?: string;
	/** Cloudflare secret: Access Token for @wtrippe0909, Read and write. */
	X_ACCESS_TOKEN?: string;
	/** Cloudflare secret: Access Token Secret. */
	X_ACCESS_TOKEN_SECRET?: string;
	/** Retired 2026-10-17 (owner directive): per-post approval code. No longer checked. */
	GFED_APPROVAL_CODE?: string;
	/**
	 * Cloudflare secret: JSON object mapping client name -> bearer token,
	 * e.g. {"muse":"...","grok":"...","chatgpt":"..."}. One token per AI
	 * client, so a single client can be revoked without touching others.
	 */
	MCP_CLIENT_TOKENS?: string;
	/** Plain var (wrangler.jsonc): "true" enables publishing; anything else = draft-only. */
	X_POSTING_ENABLED?: string;
}

const X_API = "https://api.x.com";

/* ------------------------------------------------------------------ */
/* OAuth 1.0a signing (RFC 5849, HMAC-SHA1)                            */
/* ------------------------------------------------------------------ */

export function percentEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!*'()]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

function randomNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1Base64(key: string, baseString: string): Promise<string> {
	const enc = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		enc.encode(key),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(baseString));
	let binary = "";
	for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
	return btoa(binary);
}

export interface OAuthRequestParts {
	/** Query parameters actually sent (they are part of the signature). */
	query?: Record<string, string>;
	/**
	 * application/x-www-form-urlencoded body parameters (part of the
	 * signature). JSON and multipart bodies are NOT signed, per RFC 5849.
	 */
	form?: Record<string, string>;
}

/**
 * Build the OAuth 1.0a Authorization header for a request.
 * `fixed` exists so the test suite can replay published signature
 * vectors with a known nonce/timestamp.
 */
export async function buildOAuthHeader(
	env: XPostingEnv,
	method: string,
	urlString: string,
	parts: OAuthRequestParts = {},
	fixed?: { nonce: string; timestamp: string },
): Promise<string> {
	const { X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = env;
	if (!X_CONSUMER_KEY || !X_CONSUMER_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
		throw new Error(
			"X secrets are not configured on the Worker (X_CONSUMER_KEY / X_CONSUMER_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET).",
		);
	}

	const url = new URL(urlString);
	const oauthParams: Record<string, string> = {
		oauth_consumer_key: X_CONSUMER_KEY,
		oauth_nonce: fixed?.nonce ?? randomNonce(),
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: fixed?.timestamp ?? Math.floor(Date.now() / 1000).toString(),
		oauth_token: X_ACCESS_TOKEN,
		oauth_version: "1.0",
	};

	// Signature base string parameters: oauth_* + query + form body.
	const allParams: Record<string, string> = { ...oauthParams };
	for (const [k, v] of url.searchParams.entries()) allParams[k] = v;
	if (parts.query) for (const [k, v] of Object.entries(parts.query)) allParams[k] = v;
	if (parts.form) for (const [k, v] of Object.entries(parts.form)) allParams[k] = v;

	const paramString = Object.keys(allParams)
		.sort()
		.map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
		.join("&");
	const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
	const baseString = [
		method.toUpperCase(),
		percentEncode(baseUrl),
		percentEncode(paramString),
	].join("&");
	const signingKey = `${percentEncode(X_CONSUMER_SECRET)}&${percentEncode(X_ACCESS_TOKEN_SECRET)}`;
	const signature = await hmacSha1Base64(signingKey, baseString);

	const headerParams = {
		...oauthParams,
		oauth_signature: signature,
	};
	return (
		"OAuth " +
		Object.keys(headerParams)
			.sort()
			.map(
				(k) =>
					`${percentEncode(k)}="${percentEncode(headerParams[k as keyof typeof headerParams])}"`,
			)
			.join(", ")
	);
}

/* ------------------------------------------------------------------ */
/* X API client                                                        */
/* ------------------------------------------------------------------ */

interface XFetchInit {
	json?: unknown;
	formData?: FormData;
	query?: Record<string, string>;
	/** form-urlencoded params that were signed (only for /append status style calls) */
	form?: Record<string, string>;
}

async function xFetch(
	env: XPostingEnv,
	method: string,
	path: string,
	init: XFetchInit = {},
): Promise<{ status: number; data: any }> {
	const url = new URL(path, X_API);
	if (init.query) {
		for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
	}
	const authorization = await buildOAuthHeader(env, method, url.toString(), {
		query: init.query,
		form: init.form,
	});

	const headers: Record<string, string> = { Authorization: authorization };
	let body: BodyInit | undefined;
	if (init.json !== undefined) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(init.json);
	} else if (init.formData) {
		body = init.formData; // fetch sets the multipart boundary itself
	}

	const res = await fetch(url.toString(), { method, headers, body });
	const text = await res.text();
	let data: any = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { raw: text };
	}
	if (!res.ok) {
		throw new Error(`X API error (${res.status}) on ${method} ${path}: ${JSON.stringify(data)}`);
	}
	return { status: res.status, data };
}

export async function xWhoami(env: XPostingEnv): Promise<{ id: string; name: string; username: string }> {
	const { data } = await xFetch(env, "GET", "/2/users/me");
	return data.data;
}

export async function xPostTweet(
	env: XPostingEnv,
	text: string,
	mediaIds?: string[],
): Promise<{ id: string; url: string }> {
	const payload: Record<string, unknown> = { text };
	if (mediaIds && mediaIds.length > 0) payload.media = { media_ids: mediaIds };
	const { data } = await xFetch(env, "POST", "/2/tweets", { json: payload });
	const id = data?.data?.id as string;
	return { id, url: `https://x.com/i/status/${id}` };
}

function base64ToBytes(base64: string): Uint8Array {
	const clean = base64.includes(",") ? base64.split(",").pop()! : base64;
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

const APPEND_SEGMENT_BYTES = 4 * 1024 * 1024; // X append segments must be < 5 MB

/**
 * Copy out one upload segment. This MUST be a copy (slice), not a view
 * (subarray): a view's underlying .buffer is the whole file, so handing
 * the buffer to a Blob would re-send the entire file as every segment —
 * caught in review, 2026-10-14. Tests pin the exact-length behavior.
 */
export function sliceSegment(bytes: Uint8Array, offset: number, size: number): Uint8Array {
	return bytes.slice(offset, Math.min(offset + size, bytes.length));
}

/**
 * Chunked media upload via the v2 media endpoints:
 * initialize -> append (segments) -> finalize -> poll processing status.
 * NOTE (flagged in the review doc): the STATUS poll path is implemented
 * per the published v2 chunked-upload flow but is UNVERIFIED against the
 * live API — it is step 1 of the deploy-day test plan, before any post.
 */
export async function xUploadMedia(
	env: XPostingEnv,
	mediaBase64: string,
	mediaType: string,
	mediaCategory: "tweet_image" | "tweet_video" | "tweet_gif",
): Promise<string> {
	const bytes = base64ToBytes(mediaBase64);

	const init = await xFetch(env, "POST", "/2/media/upload/initialize", {
		json: {
			media_type: mediaType,
			media_category: mediaCategory,
			total_bytes: bytes.length,
			shared: false,
		},
	});
	// v2 responses surface the id as data.id or media_id_string depending on surface.
	const mediaId: string = init.data?.data?.id ?? init.data?.media_id_string ?? init.data?.media_id;
	if (!mediaId) throw new Error(`Media initialize returned no id: ${JSON.stringify(init.data)}`);

	for (let offset = 0, segmentIndex = 0; offset < bytes.length; offset += APPEND_SEGMENT_BYTES, segmentIndex++) {
		const chunk = sliceSegment(bytes, offset, APPEND_SEGMENT_BYTES);
		const form = new FormData();
		form.append("segment_index", String(segmentIndex));
		form.append("media", new Blob([chunk.buffer as ArrayBuffer], { type: mediaType }));
		await xFetch(env, "POST", `/2/media/upload/${mediaId}/append`, { formData: form });
	}

	const fin = await xFetch(env, "POST", `/2/media/upload/${mediaId}/finalize`, {});
	let processing = fin.data?.data?.processing_info ?? fin.data?.processing_info;

	const deadline = Date.now() + 180_000;
	while (processing && (processing.state === "pending" || processing.state === "in_progress")) {
		if (Date.now() > deadline) throw new Error("Media processing timed out after 180s.");
		const wait = Math.max(1, processing.check_after_secs ?? 5) * 1000;
		await new Promise((r) => setTimeout(r, wait));
		const status = await xFetch(env, "GET", "/2/media/upload", {
			query: { command: "STATUS", media_id: String(mediaId) },
		});
		processing = status.data?.data?.processing_info ?? status.data?.processing_info;
		if (processing?.state === "failed") {
			throw new Error(`Media processing failed: ${JSON.stringify(processing.error ?? processing)}`);
		}
	}
	return String(mediaId);
}

/* ------------------------------------------------------------------ */
/* /mcp endpoint authentication (per AI client)                        */
/* ------------------------------------------------------------------ */

function timingSafeEqual(a: string, b: string): boolean {
	const enc = new TextEncoder();
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
	return diff === 0;
}

/**
 * Identify the calling AI client from its bearer token.
 * Returns the client name (e.g. "muse", "grok") or null when the
 * request carries no valid token. Fails CLOSED: when MCP_CLIENT_TOKENS
 * is not configured at all, nobody is authenticated.
 */
export function authenticateMcpRequest(request: Request, env: XPostingEnv): string | null {
	if (!env.MCP_CLIENT_TOKENS) return null;
	let tokens: Record<string, string>;
	try {
		tokens = JSON.parse(env.MCP_CLIENT_TOKENS);
	} catch {
		return null;
	}
	const header = request.headers.get("Authorization") ?? "";
	let presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
	if (!presented) {
		// URL-only clients (e.g. Grok's custom-connector dialog has no header
		// field — URL is the only input) present the same per-client token as
		// ?key= instead. Weaker than a header (URLs can land in logs), so the
		// token stays per-client and individually revocable; added 2026-10-14
		// on the owner's order to admit Grok.
		try {
			presented = new URL(request.url).searchParams.get("key") ?? "";
		} catch {
			presented = "";
		}
	}
	if (!presented) return null;
	for (const [client, token] of Object.entries(tokens)) {
		if (typeof token === "string" && token.length > 0 && timingSafeEqual(presented, token)) {
			return client;
		}
	}
	return null;
}

function publishingGate(env: XPostingEnv): string | null {
	// Owner directive 2026-10-17: the per-call approval code is retired.
	// The gates are the per-client token auth on this endpoint (see
	// authenticateMcpRequest) and this master switch.
	if (env.X_POSTING_ENABLED !== "true") {
		return "Publishing is disabled on this Worker (X_POSTING_ENABLED is not \"true\"). Draft with draft_x_post instead.";
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* MCP tools                                                           */
/* ------------------------------------------------------------------ */

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

export function registerXPostingTools(server: McpServer, getEnv: () => XPostingEnv): void {
	server.registerTool(
		"x_whoami",
		{
			description:
				"Verify which X account the Worker's configured credentials resolve to. Read-only; makes one GET /2/users/me call. Run this before any publishing session.",
			inputSchema: {},
		},
		async () => {
			try {
				const me = await xWhoami(getEnv());
				return textResult(`X account verified: ${me.name} (@${me.username}), id ${me.id}`);
			} catch (err) {
				return textResult(`x_whoami failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	);

	server.registerTool(
		"draft_x_post",
		{
			description:
				"Preview an X post WITHOUT publishing or calling the X API. Returns the exact text and a length check. Use this to stage a post for the owner's review; publishing is publish_x_post, gated by client auth and the owner's master switch.",
			inputSchema: {
				text: z.string().min(1).max(280).describe("The exact text of the post"),
				media_type: z
					.string()
					.optional()
					.describe("Optional MIME type of media you intend to attach, e.g. video/mp4"),
			},
		},
		async ({ text, media_type }) => {
			const note =
				text.length > 280
					? "OVER the 280 limit."
					: `${text.length}/280 characters (simple count; X weights URLs as 23 chars and some scripts double, so treat 260+ as tight).`;
			return textResult(
				`DRAFT (not posted):\n${text}\n—\nLength: ${note}${media_type ? `\nPlanned media: ${media_type}` : ""}`,
			);
		},
	);

	server.registerTool(
		"publish_x_post",
		{
			description:
				"Publish a post to X as @wtrippe0909. GATED: the caller must be an authenticated fleet client (per-client token) and the Worker must have X_POSTING_ENABLED=true — the owner's master switch; when it is off, publishing is refused. Publishing authority itself is the owner's word on the specific post (use draft_x_post first for review). Optionally attach ONE media item (base64) which is uploaded via the chunked v2 flow first.",
			inputSchema: {
				text: z.string().min(1).max(280).describe("The exact, owner-approved text of the post"),
				gfed_approval: z
					.string()
					.optional()
					.describe("Legacy field, retired 2026-10-17 by owner directive — accepted for backward compatibility and ignored. Leave unset."),
				media_base64: z
					.string()
					.optional()
					.describe("Optional base64-encoded media file (single item, v1 scope)"),
				media_type: z
					.string()
					.optional()
					.describe("MIME type of the media, e.g. video/mp4 or image/jpeg (required with media_base64)"),
				media_category: z
					.enum(["tweet_image", "tweet_video", "tweet_gif"])
					.optional()
					.describe("X media category (required with media_base64)"),
			},
		},
		async ({ text, media_base64, media_type, media_category }) => {
			const env = getEnv();
			const gateError = publishingGate(env);
			if (gateError) return textResult(`Refused: ${gateError}`);
			try {
				let mediaIds: string[] | undefined;
				if (media_base64) {
					if (!media_type || !media_category) {
						return textResult("Refused: media_base64 requires media_type and media_category.");
					}
					const mediaId = await xUploadMedia(env, media_base64, media_type, media_category);
					mediaIds = [mediaId];
				}
				const posted = await xPostTweet(env, text, mediaIds);
				return textResult(`Posted successfully.\nID: ${posted.id}\nURL: ${posted.url}`);
			} catch (err) {
				return textResult(
					`publish_x_post failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	);
}
