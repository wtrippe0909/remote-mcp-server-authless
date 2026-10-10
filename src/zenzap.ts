// Minimal Zenzap API client using static-API-key auth.
// Every request carries a Bearer key plus an HMAC-SHA256 signature:
//   GET:              sign `${timestamp}.${pathWithQuery}`
//   POST/PATCH/...:   sign `${timestamp}.${rawBody}`

export type ZenzapMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ZenzapConfig {
	baseUrl: string;
	apiKey: string;
	apiSecret: string;
}

export class ZenzapError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		readonly method: string,
		readonly path: string,
	) {
		super(`Zenzap ${method} ${path} failed with ${status}: ${body.slice(0, 500)}`);
	}
}

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ZenzapClient {
	private readonly baseUrl: string;

	constructor(private readonly config: ZenzapConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
	}

	async request<T = unknown>(
		method: ZenzapMethod,
		path: string,
		options: {
			query?: Record<string, string | number | boolean | undefined>;
			body?: unknown;
		} = {},
	): Promise<T> {
		const search = new URLSearchParams();
		for (const [k, v] of Object.entries(options.query ?? {})) {
			if (v !== undefined) search.set(k, String(v));
		}
		const qs = search.toString();
		const uri = qs ? `${path}?${qs}` : path;

		const timestamp = Date.now().toString();
		const hasBody = method !== "GET";
		const rawBody = hasBody ? JSON.stringify(options.body ?? {}) : "";
		const signature = await hmacSha256Hex(
			this.config.apiSecret,
			`${timestamp}.${hasBody ? rawBody : uri}`,
		);

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.config.apiKey}`,
			"X-Signature": signature,
			"X-Timestamp": timestamp,
		};
		if (hasBody) headers["Content-Type"] = "application/json";

		const res = await fetch(this.baseUrl + uri, {
			method,
			headers,
			body: hasBody ? rawBody : undefined,
		});
		const text = await res.text();
		if (!res.ok) throw new ZenzapError(res.status, text, method, uri);
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			return text as T;
		}
	}

	getMe() {
		return this.request("GET", "/v2/members/me");
	}

	getTopicMessages(topicId: string, limit = 20) {
		return this.request("GET", `/v2/topics/${encodeURIComponent(topicId)}/messages`, {
			query: { limit },
		});
	}

	sendMessage(topicId: string, text: string) {
		return this.request("POST", "/v2/messages", { body: { topicId, text } });
	}
}

// The exact response shapes of the list endpoints aren't pinned down here, so
// these helpers accept the common envelope and field-name variants.

export interface ZenzapMessage {
	id: string;
	text: string;
	senderId?: string;
	createdAt?: number;
	raw: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function extractList(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isObj(payload)) return [];
	for (const key of ["messages", "data", "items", "results", "updates"]) {
		const v = payload[key];
		if (Array.isArray(v)) return v;
		if (isObj(v)) {
			const nested = extractList(v);
			if (nested.length) return nested;
		}
	}
	return [];
}

function pickString(o: Obj, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v) return v;
		if (typeof v === "number") return String(v);
	}
	return undefined;
}

export function extractId(payload: unknown): string | undefined {
	if (!isObj(payload)) return undefined;
	const direct = pickString(payload, "id", "messageId", "memberId", "userId");
	if (direct) return direct;
	for (const key of ["data", "message", "member", "user"]) {
		const nested = extractId(payload[key]);
		if (nested) return nested;
	}
	return undefined;
}

export function normalizeMessage(raw: unknown): ZenzapMessage | undefined {
	if (!isObj(raw)) return undefined;
	const id = pickString(raw, "id", "messageId", "_id");
	if (!id) return undefined;

	let text = pickString(raw, "text", "body", "content", "message") ?? "";
	if (!text && isObj(raw.content)) text = pickString(raw.content, "text", "body") ?? "";

	let senderId = pickString(raw, "senderId", "authorId", "memberId", "userId", "fromId");
	for (const key of ["sender", "author", "from", "member", "user"]) {
		if (senderId) break;
		const v = raw[key];
		if (isObj(v)) senderId = pickString(v, "id", "memberId", "userId");
		else if (typeof v === "string") senderId = v;
	}

	const created = raw.createdAt ?? raw.created_at ?? raw.timestamp ?? raw.sentAt;
	let createdAt: number | undefined;
	if (typeof created === "number") createdAt = created;
	else if (typeof created === "string") {
		const parsed = Date.parse(created);
		createdAt = Number.isNaN(parsed) ? Number(created) || undefined : parsed;
	}

	return { id, text, senderId, createdAt, raw };
}
