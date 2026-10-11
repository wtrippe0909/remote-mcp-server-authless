// A small in-memory stand-in for Cloudflare D1, backed by node:sqlite. It covers the subset the
// ledger uses: prepare/bind/first/all/run, and batch() as one transaction that rolls back on error.

import { DatabaseSync } from "node:sqlite";

type Param = string | number | null;

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		readonly sql: string,
		private readonly params: Param[] = [],
	) {}

	bind(...params: Param[]) {
		return new Statement(this.db, this.sql, params);
	}

	async first<T>(): Promise<T | null> {
		return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
	}

	async all<T>() {
		return {
			results: this.db.prepare(this.sql).all(...this.params) as T[],
			success: true,
			meta: {},
		};
	}

	async run() {
		return this.runSync();
	}

	runSync() {
		const r = this.db.prepare(this.sql).run(...this.params);
		return {
			results: [],
			success: true,
			meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
		};
	}
}

export class D1Shim {
	readonly sqlite = new DatabaseSync(":memory:");

	prepare(sql: string) {
		return new Statement(this.sqlite, sql);
	}

	async batch(statements: Statement[]) {
		this.sqlite.exec("BEGIN");
		try {
			const out = statements.map((s) => s.runSync());
			this.sqlite.exec("COMMIT");
			return out;
		} catch (err) {
			this.sqlite.exec("ROLLBACK");
			throw err;
		}
	}

	async exec(sql: string) {
		this.sqlite.exec(sql);
		return { count: 1, duration: 0 };
	}
}
