// Shared memory notebook and API cost log, both in the RESEARCH D1 database.
//
// The notebook is one memory for every chat: the agent writes decisions, rulings, IDs and
// preferences there and sees the notes on every turn. Claude Code (the developer session) can add
// notes too, with author "claude-code". The owner can read it directly in the Cloudflare
// dashboard (D1 > executive-operator-research > memory_notes) or ask the agent for an export.

export interface MemoryNote {
	id: number;
	created_at: string;
	author: string;
	topic_id: string | null;
	note: string;
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS memory_notes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		author TEXT NOT NULL,
		topic_id TEXT,
		note TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE IF NOT EXISTS usage_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		topic_id TEXT,
		model TEXT,
		requests INTEGER,
		input_tokens INTEGER,
		output_tokens INTEGER,
		cache_read_tokens INTEGER,
		cache_write_tokens INTEGER,
		cost_usd REAL,
		used_zapier INTEGER
	)`,
];

let schemaReady = false;

export async function ensureMemorySchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
	schemaReady = true;
}

/** Most recent active notes, oldest first, for the agent's context. */
export async function recentNotes(db: D1Database, limit = 60): Promise<MemoryNote[]> {
	await ensureMemorySchema(db);
	const { results } = await db
		.prepare(
			"SELECT id, created_at, author, topic_id, note FROM memory_notes WHERE archived = 0 ORDER BY id DESC LIMIT ?",
		)
		.bind(limit)
		.all<MemoryNote>();
	return results.reverse();
}

export async function addNote(
	db: D1Database,
	note: string,
	author: string,
	topicId: string | null,
): Promise<number> {
	await ensureMemorySchema(db);
	const row = await db
		.prepare("INSERT INTO memory_notes (author, topic_id, note) VALUES (?, ?, ?) RETURNING id")
		.bind(author, topicId, note.slice(0, 2000))
		.first<{ id: number }>();
	return row?.id ?? 0;
}

export async function archiveNote(db: D1Database, id: number): Promise<boolean> {
	await ensureMemorySchema(db);
	const res = await db
		.prepare("UPDATE memory_notes SET archived = 1 WHERE id = ?")
		.bind(id)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

export function formatNotes(notes: MemoryNote[]): string {
	if (notes.length === 0) return "(no notes yet)";
	return notes.map((n) => `#${n.id} [${n.created_at} UTC, ${n.author}] ${n.note}`).join("\n");
}

// Claude Opus 5.5 list prices per million tokens. Cache writes are 1.25x input (5-minute cache).
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
	"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

export interface UsageTotals {
	requests: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
}

export function emptyUsage(): UsageTotals {
	return {
		requests: 0,
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	};
}

export function costUsd(model: string, u: UsageTotals): number | null {
	const p = PRICES[model];
	if (!p) return null;
	return (
		(u.input_tokens * p.input +
			u.output_tokens * p.output +
			u.cache_read_tokens * p.cacheRead +
			u.cache_write_tokens * p.input * 1.25) /
		1_000_000
	);
}

export async function logUsage(
	db: D1Database,
	topicId: string,
	model: string,
	u: UsageTotals,
	usedZapier: boolean,
): Promise<void> {
	await ensureMemorySchema(db);
	await db
		.prepare(
			`INSERT INTO usage_log (topic_id, model, requests, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, cost_usd, used_zapier)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			topicId,
			model,
			u.requests,
			u.input_tokens,
			u.output_tokens,
			u.cache_read_tokens,
			u.cache_write_tokens,
			costUsd(model, u),
			usedZapier ? 1 : 0,
		)
		.run();
}

/** Spend per UTC day for the last `days` days. */
export async function usageSummary(db: D1Database, days: number): Promise<unknown[]> {
	await ensureMemorySchema(db);
	const { results } = await db
		.prepare(
			`SELECT date(created_at) AS day, COUNT(*) AS replies, SUM(requests) AS api_requests,
				SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
				SUM(cache_read_tokens) AS cache_read_tokens, ROUND(SUM(cost_usd), 4) AS cost_usd,
				ROUND(AVG(cost_usd), 4) AS avg_cost_per_reply
			FROM usage_log WHERE created_at >= datetime('now', ?)
			GROUP BY day ORDER BY day DESC`,
		)
		.bind(`-${Math.max(1, Math.min(90, days))} days`)
		.all();
	return results;
}
