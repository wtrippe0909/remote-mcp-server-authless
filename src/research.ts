// Saves Zenzap's documentation and real API response shapes into the RESEARCH D1 database so
// the integration can be checked against them. Runs from the cron trigger, a few pages per run
// to stay within the per-invocation subrequest limit.

import { ZenzapClient, ZenzapError } from "./zenzap";

export interface ResearchEnv {
	RESEARCH?: D1Database;
	ZENZAP_BASE_URL: string;
	ZENZAP_CONTROL_TOPIC_ID: string;
	ZENZAP_API_KEY: string;
	ZENZAP_API_SECRET: string;
}

const DOCS_INDEX = "https://docs.zenzap.co/llms.txt";
const DOCS_ALWAYS = ["https://docs.zenzap.co/quickstart", "https://docs.zenzap.co/quickstart.md"];
const PAGES_PER_RUN = 20;
const REFRESH_MS = 24 * 60 * 60_000;
const API_SAMPLE_MS = 6 * 60 * 60_000;
const MAX_CONTENT_CHARS = 200_000;
const MESSAGE_SAMPLE_RETENTION = "-14 days";

export async function runResearch(env: ResearchEnv): Promise<void> {
	const db = env.RESEARCH;
	if (!db) return;
	await syncDocs(db);
	await sampleApi(db, env);
	await db
		.prepare("DELETE FROM message_samples WHERE captured_at < datetime('now', ?)")
		.bind(MESSAGE_SAMPLE_RETENTION)
		.run();
}

async function syncDocs(db: D1Database): Promise<void> {
	const index = await db
		.prepare("SELECT content, fetched_at FROM docs WHERE url = ?")
		.bind(DOCS_INDEX)
		.first<{ content: string; fetched_at: string }>();

	let indexText = index?.content ?? "";
	if (!index || isStale(index.fetched_at, REFRESH_MS)) {
		indexText = await saveDoc(db, DOCS_INDEX);
	}

	const urls = new Set(DOCS_ALWAYS);
	for (const match of indexText.matchAll(/https:\/\/docs\.zenzap\.co\/[^\s)"'<>\]]+/g)) {
		urls.add(match[0]);
	}
	urls.delete(DOCS_INDEX);

	const { results } = await db.prepare("SELECT url, fetched_at FROM docs").all<{
		url: string;
		fetched_at: string;
	}>();
	const fetchedAt = new Map(results.map((r) => [r.url, r.fetched_at]));
	const due = [...urls].filter((u) => {
		const at = fetchedAt.get(u);
		return !at || isStale(at, REFRESH_MS);
	});

	for (const url of due.slice(0, PAGES_PER_RUN)) {
		await saveDoc(db, url);
	}
}

async function saveDoc(db: D1Database, url: string): Promise<string> {
	let status = 0;
	let content = "";
	try {
		const res = await fetch(url, { headers: { Accept: "text/markdown, text/plain, */*" } });
		status = res.status;
		content = (await res.text()).slice(0, MAX_CONTENT_CHARS);
	} catch (err) {
		content = `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
	}
	await db
		.prepare(
			"INSERT OR REPLACE INTO docs (url, status, content, fetched_at) VALUES (?, ?, ?, datetime('now'))",
		)
		.bind(url, status, content)
		.run();
	return content;
}

async function sampleApi(db: D1Database, env: ResearchEnv): Promise<void> {
	const last = await db
		.prepare("SELECT MAX(fetched_at) AS at FROM api_samples")
		.first<{ at: string | null }>();
	if (last?.at && !isStale(last.at, API_SAMPLE_MS)) return;

	const zenzap = new ZenzapClient({
		baseUrl: env.ZENZAP_BASE_URL,
		apiKey: (env.ZENZAP_API_KEY ?? "").trim(),
		apiSecret: (env.ZENZAP_API_SECRET ?? "").trim(),
	});
	const control = encodeURIComponent(env.ZENZAP_CONTROL_TOPIC_ID);
	// Read-only endpoints whose response shapes the integration depends on.
	const endpoints: Array<[string, Record<string, string | number>]> = [
		["/v2/members/me", {}],
		["/v2/topics", { limit: 20 }],
		[`/v2/topics/${control}`, {}],
		[`/v2/topics/${control}/messages`, { limit: 5 }],
		["/v2/members", { limit: 5 }],
		["/v2/tasks", { limit: 5 }],
		["/v2/organization/labels", {}],
	];

	for (const [path, query] of endpoints) {
		let status = 200;
		let body: string;
		try {
			body = JSON.stringify(await zenzap.request("GET", path, { query }));
		} catch (err) {
			status = err instanceof ZenzapError ? err.status : 0;
			body = err instanceof ZenzapError ? err.body : String(err);
		}
		await db
			.prepare(
				"INSERT OR REPLACE INTO api_samples (endpoint, status, body, fetched_at) VALUES (?, ?, ?, datetime('now'))",
			)
			.bind(path, status, body.slice(0, MAX_CONTENT_CHARS))
			.run();
	}
}

/** Records raw message payloads (first sighting only) so their exact shape can be inspected. */
export async function recordMessageSamples(
	db: D1Database | undefined,
	topicId: string,
	messages: Array<{ id: string; raw: unknown }>,
): Promise<void> {
	if (!db || messages.length === 0) return;
	try {
		await db.batch(
			messages.map((m) =>
				db
					.prepare(
						"INSERT OR IGNORE INTO message_samples (message_id, topic_id, raw, captured_at) VALUES (?, ?, ?, datetime('now'))",
					)
					.bind(m.id, topicId, JSON.stringify(m.raw).slice(0, 20_000)),
			),
		);
	} catch (err) {
		console.error("recording message samples failed", err);
	}
}

function isStale(sqliteTime: string, maxAgeMs: number): boolean {
	const t = Date.parse(`${sqliteTime.replace(" ", "T")}Z`);
	return Number.isNaN(t) || Date.now() - t > maxAgeMs;
}
