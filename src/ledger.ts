// Executive Operator Doctrine v2.3: code-enforced task ledger (the "Runtime").
//
// The Executive Operator only *requests* transitions. This module is the sole writer of ledger
// state and rejects anything the doctrine forbids. Validator verdicts and owner approvals are
// never taken on the agent's word: the code reads the cited Zenzap message itself (from the
// message samples the Worker recorded, or from the Zenzap API) and checks who sent it and what
// it says. Every request, accepted or rejected, is written to ledger_events.

import { extractList, normalizeMessage, type ZenzapClient, type ZenzapMessage } from "./zenzap";

export const WORKFLOW_STATES = [
	"INTAKE",
	"SPEC_ALIGNMENT",
	"DISPATCH_READY",
	"BUILD_ACTIVE",
	"VALIDATION_PENDING",
	"REWORK_ACTIVE",
	"EXECUTION_PENDING",
	"EXECUTION_ACTIVE",
	"RECONCILIATION_PENDING",
	"POST_EXEC_VALIDATION",
	"CLOSEOUT_READY",
	"BLOCKED",
	"CANCELLATION_PENDING",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

const TERMINAL: WorkflowState[] = ["COMPLETED", "FAILED", "CANCELLED"];
const MAX_REWORKS = 2;
const MAX_EXEC_ATTEMPTS = 2;
const MAX_RECONCILE_POLLS = 3;

// Plain moves that need no evidence. Evidence-gated moves are handled in requestTransition.
const SIMPLE: Partial<Record<WorkflowState, WorkflowState[]>> = {
	SPEC_ALIGNMENT: ["DISPATCH_READY"],
	DISPATCH_READY: ["BUILD_ACTIVE"],
};

export interface LedgerRoles {
	ownerId?: string;
	validatorId: string;
	/** The owner's private topic, scanned when an approval message isn't in the recorded samples. */
	controlTopicId: string;
}

export interface TaskRow {
	task_id: string;
	title: string;
	objective: string;
	topic_id: string | null;
	workflow_state: WorkflowState;
	validation_verdict: string;
	authorization_status: string;
	execution_outcome: string;
	counter_build_rework: number;
	counter_exec_attempts: number;
	counter_reconcile_attempts: number;
	artifact_file_id: string | null;
	artifact_revision_id: string | null;
	verdict_message_id: string | null;
	intake_approval_id: string | null;
	pending_approval_id: string | null;
	needs_external_action: number;
	block_record: string | null;
	created_at: string;
	updated_at: string;
}

export interface TransitionRequest {
	task_id: string;
	to_state: WorkflowState;
	approval_message_id?: string;
	verdict_message_id?: string;
	artifact_file_id?: string;
	artifact_revision_id?: string;
	execution_outcome?: "SUCCEEDED" | "FAILED" | "UNKNOWN";
	needs_external_action?: boolean;
	block_record?: {
		cause: string;
		resolution_prerequisite: string;
		resume_state: WorkflowState;
	};
	note?: string;
}

type Result =
	| { ok: true; task: TaskRow }
	| { ok: false; error: string; current_state?: string; target_state?: string; reason: string };

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS ledger_tasks (
		task_id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		objective TEXT NOT NULL,
		topic_id TEXT,
		workflow_state TEXT NOT NULL DEFAULT 'INTAKE',
		validation_verdict TEXT NOT NULL DEFAULT 'UNREVIEWED',
		authorization_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
		execution_outcome TEXT NOT NULL DEFAULT 'NOT_STARTED',
		counter_build_rework INTEGER NOT NULL DEFAULT 0,
		counter_exec_attempts INTEGER NOT NULL DEFAULT 0,
		counter_reconcile_attempts INTEGER NOT NULL DEFAULT 0,
		artifact_file_id TEXT,
		artifact_revision_id TEXT,
		verdict_message_id TEXT,
		intake_approval_id TEXT,
		pending_approval_id TEXT,
		needs_external_action INTEGER NOT NULL DEFAULT 0,
		block_record TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)`,
	`CREATE TABLE IF NOT EXISTS ledger_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		task_id TEXT NOT NULL,
		from_state TEXT,
		to_state TEXT,
		result TEXT NOT NULL,
		reason TEXT,
		request TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS ledger_approvals (
		approval_id TEXT PRIMARY KEY,
		task_id TEXT NOT NULL,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		consumed_at TEXT
	)`,
];

let schemaReady = false;
export async function ensureLedgerSchema(db: D1Database): Promise<void> {
	if (schemaReady) return;
	await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
	schemaReady = true;
}

export class Ledger {
	constructor(
		private readonly db: D1Database,
		private readonly zenzap: ZenzapClient,
		private readonly roles: LedgerRoles,
	) {}

	async getTask(taskId: string): Promise<TaskRow | null> {
		await ensureLedgerSchema(this.db);
		return this.db
			.prepare("SELECT * FROM ledger_tasks WHERE task_id = ?")
			.bind(taskId)
			.first<TaskRow>();
	}

	async listTasks(includeTerminal: boolean): Promise<TaskRow[]> {
		await ensureLedgerSchema(this.db);
		const sql = includeTerminal
			? "SELECT * FROM ledger_tasks ORDER BY updated_at DESC LIMIT 100"
			: "SELECT * FROM ledger_tasks WHERE workflow_state NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY updated_at DESC LIMIT 100";
		const { results } = await this.db.prepare(sql).all<TaskRow>();
		return results;
	}

	async history(taskId: string): Promise<unknown[]> {
		await ensureLedgerSchema(this.db);
		const { results } = await this.db
			.prepare("SELECT * FROM ledger_events WHERE task_id = ? ORDER BY id")
			.bind(taskId)
			.all();
		return results;
	}

	async createTask(
		taskId: string,
		title: string,
		objective: string,
		topicId: string | null,
	): Promise<Result> {
		await ensureLedgerSchema(this.db);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
			return this.reject(
				{ task_id: taskId, to_state: "INTAKE" },
				null,
				"INVALID_TASK_ID",
				"Use letters, digits, dot, dash or underscore (e.g. T8-06).",
			);
		}
		if (await this.getTask(taskId)) {
			return this.reject(
				{ task_id: taskId, to_state: "INTAKE" },
				null,
				"TASK_EXISTS",
				`Task ${taskId} is already in the ledger.`,
			);
		}
		await this.db
			.prepare(
				"INSERT INTO ledger_tasks (task_id, title, objective, topic_id) VALUES (?, ?, ?, ?)",
			)
			.bind(taskId, title.slice(0, 300), objective.slice(0, 4000), topicId)
			.run();
		await this.event(taskId, null, "INTAKE", "OK", "created", { title, objective });
		return { ok: true, task: (await this.getTask(taskId))! };
	}

	async requestTransition(req: TransitionRequest): Promise<Result> {
		await ensureLedgerSchema(this.db);
		const task = await this.getTask(req.task_id);
		if (!task)
			return this.reject(
				req,
				null,
				"UNKNOWN_TASK",
				`No task ${req.task_id}; create it first.`,
			);
		const from = task.workflow_state;
		const to = req.to_state;
		if (!WORKFLOW_STATES.includes(to))
			return this.reject(req, task, "UNKNOWN_STATE", `${to} is not a workflow state.`);
		if (TERMINAL.includes(from))
			return this.reject(
				req,
				task,
				"TERMINAL_STATE",
				`${from} is terminal; nothing can follow it.`,
			);

		const updates: Partial<TaskRow> = {};

		// --- Blocking and cancellation are allowed from any non-terminal state, with rules. ---
		if (to === "BLOCKED") {
			const br = req.block_record;
			if (!br?.cause || !br.resolution_prerequisite || !br.resume_state) {
				return this.reject(
					req,
					task,
					"BLOCK_RECORD_REQUIRED",
					"BLOCKED needs block_record {cause, resolution_prerequisite, resume_state}.",
				);
			}
			if (TERMINAL.includes(br.resume_state) || br.resume_state === "BLOCKED") {
				return this.reject(
					req,
					task,
					"INVALID_RESUME_STATE",
					"resume_state must be a non-terminal, non-BLOCKED state.",
				);
			}
			updates.block_record = JSON.stringify({
				originating_state: from,
				...br,
				recorded_at: new Date().toISOString(),
			});
			return this.commit(req, task, updates);
		}
		if (to === "CANCELLED" || to === "CANCELLATION_PENDING") {
			const inFlight = from === "EXECUTION_ACTIVE" || from === "RECONCILIATION_PENDING";
			if (to === "CANCELLED" && inFlight) {
				return this.reject(
					req,
					task,
					"IN_FLIGHT_CUSTODY",
					"An external action may be in flight; go to CANCELLATION_PENDING and reconcile first.",
				);
			}
			if (to === "CANCELLED" && from === "CANCELLATION_PENDING") {
				const outcome = req.execution_outcome ?? task.execution_outcome;
				if (outcome === "IN_PROGRESS" || outcome === "UNKNOWN") {
					return this.reject(
						req,
						task,
						"UNRECONCILED",
						"Confirm the external action's final outcome (SUCCEEDED or FAILED) before cancelling.",
					);
				}
				updates.execution_outcome = outcome;
			}
			if (to === "CANCELLATION_PENDING" && !inFlight) {
				return this.reject(
					req,
					task,
					"NOT_IN_FLIGHT",
					"Nothing is in flight; go straight to CANCELLED.",
				);
			}
			return this.commit(req, task, updates);
		}

		// --- Leaving BLOCKED: only to the recorded resume state. ---
		if (from === "BLOCKED") {
			const br = task.block_record
				? (JSON.parse(task.block_record) as { resume_state?: string })
				: null;
			if (to !== br?.resume_state) {
				return this.reject(
					req,
					task,
					"ILLEGAL_TRANSITION",
					`BLOCKED can only resume to ${br?.resume_state ?? "its recorded resume_state"}.`,
				);
			}
			updates.block_record = null;
			return this.commit(req, task, updates);
		}

		if (SIMPLE[from]?.includes(to)) return this.commit(req, task, updates);

		switch (`${from}->${to}`) {
			case "INTAKE->SPEC_ALIGNMENT": {
				// Supervisor approval of the objective: any owner message in Zenzap.
				const check = await this.verifyOwnerMessage(req.approval_message_id, null);
				if (!check.ok)
					return this.reject(req, task, "SUPERVISOR_APPROVAL_REQUIRED", check.reason);
				updates.intake_approval_id = req.approval_message_id!;
				return this.commit(req, task, updates);
			}
			case "BUILD_ACTIVE->VALIDATION_PENDING":
			case "REWORK_ACTIVE->VALIDATION_PENDING": {
				if (!req.artifact_file_id || !req.artifact_revision_id) {
					return this.reject(
						req,
						task,
						"ARTIFACT_BINDING_REQUIRED",
						"Give the artifact's Drive fileId and headRevisionId (or version).",
					);
				}
				if (
					from === "REWORK_ACTIVE" &&
					req.artifact_revision_id === task.artifact_revision_id
				) {
					return this.reject(
						req,
						task,
						"SAME_REVISION",
						"A rework must be validated on a new revision.",
					);
				}
				Object.assign(updates, {
					artifact_file_id: req.artifact_file_id,
					artifact_revision_id: req.artifact_revision_id,
					validation_verdict: "UNREVIEWED",
					verdict_message_id: null,
				});
				if (from === "REWORK_ACTIVE")
					updates.counter_build_rework = task.counter_build_rework + 1;
				return this.commit(req, task, updates);
			}
			case "VALIDATION_PENDING->REWORK_ACTIVE":
			case "VALIDATION_PENDING->FAILED":
			case "VALIDATION_PENDING->CLOSEOUT_READY":
			case "VALIDATION_PENDING->EXECUTION_PENDING":
			case "POST_EXEC_VALIDATION->CLOSEOUT_READY":
			case "POST_EXEC_VALIDATION->FAILED": {
				const verdict = await this.verifyVerdict(req.verdict_message_id, task);
				if (!verdict.ok)
					return this.reject(req, task, "VALIDATOR_VERDICT_REQUIRED", verdict.reason);
				const v = verdict.verdict;
				const allowed: Record<string, WorkflowState[]> =
					from === "VALIDATION_PENDING"
						? {
								PASS: ["CLOSEOUT_READY", "EXECUTION_PENDING"],
								FAIL:
									task.counter_build_rework < MAX_REWORKS
										? ["REWORK_ACTIVE"]
										: ["FAILED"],
								INCONCLUSIVE: [],
							}
						: { PASS: ["CLOSEOUT_READY"], FAIL: ["FAILED"], INCONCLUSIVE: [] };
				if (!allowed[v].includes(to)) {
					const hint =
						v === "INCONCLUSIVE"
							? "An INCONCLUSIVE verdict goes to BLOCKED with a block_record."
							: `With ${v}, allowed: ${allowed[v].join(", ") || "BLOCKED"}.`;
					return this.reject(req, task, "VERDICT_MISMATCH", hint);
				}
				Object.assign(updates, {
					validation_verdict: v,
					verdict_message_id: req.verdict_message_id,
				});
				if (to === "EXECUTION_PENDING")
					Object.assign(updates, {
						needs_external_action: 1,
						authorization_status: "PENDING",
					});
				return this.commit(req, task, updates);
			}
			case "EXECUTION_PENDING->EXECUTION_ACTIVE": {
				if (task.counter_exec_attempts >= MAX_EXEC_ATTEMPTS) {
					return this.reject(
						req,
						task,
						"EXEC_ATTEMPTS_EXHAUSTED",
						`Max ${MAX_EXEC_ATTEMPTS} execution attempts; go to BLOCKED or FAILED.`,
					);
				}
				const check = await this.verifyOwnerMessage(req.approval_message_id, task.task_id);
				if (!check.ok)
					return this.reject(req, task, "AUTHORIZATION_REQUIRED", check.reason);
				// Single-use token: the approval message can be consumed exactly once.
				const consumed = await this.db
					.prepare(
						"INSERT OR IGNORE INTO ledger_approvals (approval_id, task_id, status, consumed_at) VALUES (?, ?, 'CONSUMED', datetime('now'))",
					)
					.bind(req.approval_message_id, task.task_id)
					.run();
				if ((consumed.meta.changes ?? 0) === 0) {
					return this.reject(
						req,
						task,
						"APPROVAL_ALREADY_CONSUMED",
						"That approval was already used; the owner must approve this attempt again.",
					);
				}
				Object.assign(updates, {
					authorization_status: "CONSUMED",
					execution_outcome: "IN_PROGRESS",
					counter_exec_attempts: task.counter_exec_attempts + 1,
					pending_approval_id: req.approval_message_id,
				});
				return this.commit(req, task, updates);
			}
			case "EXECUTION_ACTIVE->POST_EXEC_VALIDATION":
			case "RECONCILIATION_PENDING->POST_EXEC_VALIDATION": {
				if (req.execution_outcome !== "SUCCEEDED")
					return this.reject(
						req,
						task,
						"OUTCOME_REQUIRED",
						"Set execution_outcome SUCCEEDED (with its receipt in note).",
					);
				Object.assign(updates, {
					execution_outcome: "SUCCEEDED",
					validation_verdict: "UNREVIEWED",
					verdict_message_id: null,
				});
				return this.commit(req, task, updates);
			}
			case "EXECUTION_ACTIVE->EXECUTION_PENDING":
			case "RECONCILIATION_PENDING->EXECUTION_PENDING": {
				if (req.execution_outcome !== "FAILED")
					return this.reject(
						req,
						task,
						"OUTCOME_REQUIRED",
						"A retry needs execution_outcome FAILED.",
					);
				if (task.counter_exec_attempts >= MAX_EXEC_ATTEMPTS) {
					return this.reject(
						req,
						task,
						"EXEC_ATTEMPTS_EXHAUSTED",
						"No retries left; go to BLOCKED or FAILED.",
					);
				}
				Object.assign(updates, {
					execution_outcome: "FAILED",
					authorization_status: "PENDING",
				});
				return this.commit(req, task, updates);
			}
			case "EXECUTION_ACTIVE->FAILED":
			case "RECONCILIATION_PENDING->FAILED": {
				if (req.execution_outcome !== "FAILED")
					return this.reject(
						req,
						task,
						"OUTCOME_REQUIRED",
						"FAILED needs execution_outcome FAILED.",
					);
				updates.execution_outcome = "FAILED";
				return this.commit(req, task, updates);
			}
			case "EXECUTION_ACTIVE->RECONCILIATION_PENDING":
			case "RECONCILIATION_PENDING->RECONCILIATION_PENDING": {
				if (task.counter_reconcile_attempts >= MAX_RECONCILE_POLLS) {
					return this.reject(
						req,
						task,
						"RECONCILE_POLLS_EXHAUSTED",
						`Max ${MAX_RECONCILE_POLLS} polls; go to BLOCKED.`,
					);
				}
				Object.assign(updates, {
					execution_outcome: "UNKNOWN",
					counter_reconcile_attempts: task.counter_reconcile_attempts + 1,
				});
				return this.commit(req, task, updates);
			}
			case "CLOSEOUT_READY->COMPLETED": {
				if (task.validation_verdict !== "PASS" || !task.verdict_message_id) {
					return this.reject(
						req,
						task,
						"VALIDATOR_VERDICT_REQUIRED",
						"COMPLETED needs a verified Validator PASS on record.",
					);
				}
				if (task.needs_external_action && task.execution_outcome !== "SUCCEEDED") {
					return this.reject(
						req,
						task,
						"EXECUTION_NOT_CONFIRMED",
						"The external action never reached SUCCEEDED.",
					);
				}
				return this.commit(req, task, updates);
			}
		}
		return this.reject(
			req,
			task,
			"ILLEGAL_TRANSITION",
			`${from} -> ${to} is not allowed by the doctrine.`,
		);
	}

	// --- Evidence checks (independent of the agent's claims) ---

	private async verifyVerdict(
		messageId: string | undefined,
		task: TaskRow,
	): Promise<
		{ ok: true; verdict: "PASS" | "FAIL" | "INCONCLUSIVE" } | { ok: false; reason: string }
	> {
		if (!messageId)
			return {
				ok: false,
				reason: "Cite the Validator's verdict message (verdict_message_id).",
			};
		// A verdict covers one review: the pre-execution PASS can't be reused for post-execution validation.
		const used = await this.db
			.prepare(
				"SELECT 1 FROM ledger_events WHERE task_id = ? AND result = 'OK' AND json_extract(request, '$.verdict_message_id') = ?",
			)
			.bind(task.task_id, messageId)
			.first();
		if (used)
			return {
				ok: false,
				reason: "That verdict was already used; the Validator must review again.",
			};
		const msg = await this.fetchMessage(messageId, task.topic_id);
		if (!msg) return { ok: false, reason: `Couldn't find message ${messageId}.` };
		if (msg.senderId !== this.roles.validatorId)
			return { ok: false, reason: "That message isn't from the Validator (Custodian)." };
		const text = msg.text;
		if (task.artifact_file_id && !text.includes(task.artifact_file_id)) {
			return {
				ok: false,
				reason: `The verdict must cite the artifact fileId ${task.artifact_file_id}.`,
			};
		}
		if (task.artifact_revision_id && !text.includes(task.artifact_revision_id)) {
			return {
				ok: false,
				reason: `The verdict must cite the artifact revision ${task.artifact_revision_id}.`,
			};
		}
		const found = (["PASS", "FAIL", "INCONCLUSIVE"] as const).filter((v) =>
			new RegExp(`\\b${v}\\b`).test(text),
		);
		if (found.length !== 1) {
			return {
				ok: false,
				reason: `The verdict message must contain exactly one of PASS, FAIL or INCONCLUSIVE (found: ${found.join(", ") || "none"}).`,
			};
		}
		return { ok: true, verdict: found[0] };
	}

	private async verifyOwnerMessage(
		messageId: string | undefined,
		taskId: string | null,
	): Promise<{ ok: true } | { ok: false; reason: string }> {
		if (!messageId)
			return {
				ok: false,
				reason: "Cite the owner's approval message (approval_message_id).",
			};
		if (!this.roles.ownerId)
			return { ok: false, reason: "The owner's member ID isn't known yet." };
		const msg = await this.fetchMessage(messageId, this.roles.controlTopicId);
		if (!msg) return { ok: false, reason: `Couldn't find message ${messageId}.` };
		if (msg.senderId !== this.roles.ownerId)
			return { ok: false, reason: "That message isn't from the owner." };
		if (taskId) {
			if (!msg.text.toLowerCase().includes(taskId.toLowerCase())) {
				return {
					ok: false,
					reason: `The owner's approval must name the task (${taskId}).`,
				};
			}
			if (
				!/\b(approve|approved|authori[sz]e|authori[sz]ed|go ahead|proceed)\b/i.test(
					msg.text,
				)
			) {
				return {
					ok: false,
					reason: "The owner's message doesn't approve anything (expected e.g. 'approved').",
				};
			}
			if (/\b(not|don'?t|do not|never|no)\b/i.test(msg.text)) {
				return {
					ok: false,
					reason: "The owner's message contains a negation; ask for an unambiguous approval.",
				};
			}
		}
		return { ok: true };
	}

	/** Reads a message from the Worker's own recorded samples, falling back to the Zenzap API. */
	private async fetchMessage(
		messageId: string,
		topicId: string | null,
	): Promise<ZenzapMessage | null> {
		const row = await this.db
			.prepare("SELECT raw FROM message_samples WHERE message_id = ?")
			.bind(messageId)
			.first<{ raw: string }>()
			.catch(() => null);
		if (row) return normalizeMessage(JSON.parse(row.raw)) ?? null;
		try {
			const res = (await this.zenzap.request(
				"GET",
				`/v2/messages/${encodeURIComponent(messageId)}`,
			)) as Record<string, unknown>;
			const msg = normalizeMessage(res?.message ?? res);
			if (msg?.id === messageId) return msg;
		} catch {
			// fall through to the topic scan
		}
		if (topicId) {
			for (const raw of extractList(await this.zenzap.getTopicMessages(topicId, 100))) {
				const msg = normalizeMessage(raw);
				if (msg?.id === messageId) return msg;
			}
		}
		return null;
	}

	// --- Persistence ---

	private async commit(
		req: TransitionRequest,
		task: TaskRow,
		updates: Partial<TaskRow>,
	): Promise<Result> {
		const fields = { ...updates, workflow_state: req.to_state };
		const cols = Object.keys(fields);
		await this.db
			.prepare(
				`UPDATE ledger_tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now')
				WHERE task_id = ? AND workflow_state = ?`,
			)
			.bind(
				...cols.map((c) => (fields as Record<string, unknown>)[c] ?? null),
				task.task_id,
				task.workflow_state,
			)
			.run();
		await this.event(
			task.task_id,
			task.workflow_state,
			req.to_state,
			"OK",
			req.note ?? null,
			req,
		);
		return { ok: true, task: (await this.getTask(task.task_id))! };
	}

	private async reject(
		req: TransitionRequest,
		task: TaskRow | null,
		error: string,
		reason: string,
	): Promise<Result> {
		await this.event(
			req.task_id,
			task?.workflow_state ?? null,
			req.to_state,
			"REJECTED",
			`${error}: ${reason}`,
			req,
		);
		return {
			ok: false,
			error,
			current_state: task?.workflow_state,
			target_state: req.to_state,
			reason,
		};
	}

	private async event(
		taskId: string,
		from: string | null,
		to: string | null,
		result: string,
		reason: string | null,
		request: unknown,
	) {
		await this.db
			.prepare(
				"INSERT INTO ledger_events (task_id, from_state, to_state, result, reason, request) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.bind(taskId, from, to, result, reason, JSON.stringify(request).slice(0, 4000))
			.run();
	}
}
