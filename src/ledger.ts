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

// Characters that can continue an identifier (task IDs, Drive fileIds, revisions, versions).
const ID_CHAR = "A-Za-z0-9_-";

/**
 * True when `id` appears in `text` as a whole identifier, case-sensitively: "T1" matches
 * "approve T1." but not "T10", "t1", "XT1" or "T1.5". A trailing dot only ends the match when no
 * identifier character follows it, since task IDs may contain dots.
 */
export function containsExactId(text: string, id: string): boolean {
	if (!id) return false;
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`(?<![${ID_CHAR}])(?<![${ID_CHAR}]\\.)${escaped}(?![${ID_CHAR}])(?!\\.[${ID_CHAR}])`,
	).test(text);
}

// Owner approval words, and words that turn a message into a refusal or a "not yet".
const APPROVAL_WORDS = /\b(approve|approved|authori[sz]e|authori[sz]ed|go ahead|proceed)\b/i;
const REFUSAL_WORDS =
	/\b(not|no|never|reject(ed)?|den(y|ied)|declin(e|ed)|hold|wait|stop|cancel(l?ed)?)\b|n['’]t\b/i;

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

/**
 * Reads a Validator verdict. A line "VERDICT: PASS|FAIL|INCONCLUSIVE" is authoritative and must be
 * the only such line. Without one, the message must contain exactly one bare verdict word that
 * isn't negated ("not PASS", "non-PASS", "isn't a PASS", "never PASS").
 */
export function parseVerdict(
	text: string,
): { ok: true; verdict: Verdict } | { ok: false; reason: string } {
	const lines = [
		...text.matchAll(/^[ \t*_>-]*VERDICT[ \t*_]*:[ \t*_]*(PASS|FAIL|INCONCLUSIVE)\b/gim),
	];
	if (lines.length > 1)
		return { ok: false, reason: "The verdict message has more than one VERDICT line." };
	if (lines.length === 1) return { ok: true, verdict: lines[0][1].toUpperCase() as Verdict };

	const hits = [...text.matchAll(/\b(PASS|FAIL|INCONCLUSIVE)\b/g)];
	const kinds = [...new Set(hits.map((h) => h[1]))];
	if (hits.length !== 1) {
		return {
			ok: false,
			reason: `The verdict message must contain a "VERDICT: PASS|FAIL|INCONCLUSIVE" line or exactly one verdict word (found: ${kinds.join(", ") || "none"}).`,
		};
	}
	const before = text.slice(0, hits[0].index).split("\n").pop() ?? "";
	if (isNegated(before))
		return {
			ok: false,
			reason: `The verdict word ${hits[0][1]} is negated; ask for "VERDICT: ..."`,
		};
	return { ok: true, verdict: hits[0][1] as Verdict };
}

function isNegated(before: string): boolean {
	if (/\bnon[ -]?$/i.test(before)) return true;
	return before
		.split(/\s+/)
		.filter(Boolean)
		.slice(-3)
		.map((w) => w.replace(/[^A-Za-z'’]/g, ""))
		.some((w) => /^(not|no|never|without|cannot)$/i.test(w) || /n['’]t$/i.test(w));
}

/** Audit-log copy of a request: every string clipped, and always valid JSON under 4000 chars. */
function serializeRequest(request: unknown): string {
	const clip = (v: unknown, max: number): unknown => {
		if (typeof v === "string")
			return v.length > max ? `${v.slice(0, max)}…[+${v.length - max}]` : v;
		if (v && typeof v === "object")
			return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, 500)]));
		return v;
	};
	const full = JSON.stringify(clip(request, 1500));
	if (full.length <= 4000) return full;
	// Keep the fields the ledger queries later; drop the prose.
	const r = (request ?? {}) as Record<string, unknown>;
	const keep = [
		"task_id",
		"to_state",
		"approval_message_id",
		"verdict_message_id",
		"artifact_file_id",
		"artifact_revision_id",
		"execution_outcome",
	];
	return JSON.stringify({
		...Object.fromEntries(keep.filter((k) => k in r).map((k) => [k, clip(r[k], 200)])),
		truncated: true,
	});
}

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
		needsExternalAction = false,
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
		try {
			await this.db.batch([
				this.db
					.prepare(
						"INSERT INTO ledger_tasks (task_id, title, objective, topic_id, needs_external_action) VALUES (?, ?, ?, ?, ?)",
					)
					.bind(
						taskId,
						title.slice(0, 300),
						objective.slice(0, 4000),
						topicId,
						needsExternalAction ? 1 : 0,
					),
				this.eventStatement(taskId, null, "INTAKE", "OK", "created", {
					title,
					objective,
					needs_external_action: needsExternalAction,
				}),
			]);
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			return this.reject(
				{ task_id: taskId, to_state: "INTAKE" },
				null,
				"TASK_EXISTS",
				`Task ${taskId} is already in the ledger.`,
			);
		}
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
		// needs_external_action is a one-way latch: any accepted move can turn it on, none can clear it.
		const needsExternalAction =
			task.needs_external_action === 1 || req.needs_external_action === true;
		if (needsExternalAction && task.needs_external_action !== 1)
			updates.needs_external_action = 1;

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
			if (from === "BLOCKED") {
				return this.reject(
					req,
					task,
					"ALREADY_BLOCKED",
					"The task is already BLOCKED; resolve it and resume, or cancel it.",
				);
			}
			// A block pauses a state; it can't be used to skip ahead to another one.
			if (br.resume_state !== from) {
				return this.reject(
					req,
					task,
					"INVALID_RESUME_STATE",
					`resume_state must be the state you are blocking from (${from}).`,
				);
			}
			if (req.verdict_message_id) {
				// An INCONCLUSIVE review is recorded when it blocks the task.
				if (from !== "VALIDATION_PENDING" && from !== "POST_EXEC_VALIDATION") {
					return this.reject(
						req,
						task,
						"VERDICT_NOT_APPLICABLE",
						"verdict_message_id only applies when blocking from VALIDATION_PENDING or POST_EXEC_VALIDATION.",
					);
				}
				const verdict = await this.verifyVerdict(req.verdict_message_id, task);
				if (!verdict.ok)
					return this.reject(req, task, "VALIDATOR_VERDICT_REQUIRED", verdict.reason);
				if (verdict.verdict !== "INCONCLUSIVE") {
					return this.reject(
						req,
						task,
						"VERDICT_MISMATCH",
						`That verdict is ${verdict.verdict}; only INCONCLUSIVE goes to BLOCKED. Use the normal move.`,
					);
				}
				Object.assign(updates, {
					validation_verdict: "INCONCLUSIVE",
					verdict_message_id: req.verdict_message_id,
				});
			}
			updates.block_record = JSON.stringify({
				originating_state: from,
				...br,
				recorded_at: new Date().toISOString(),
			});
			return this.commit(req, task, updates);
		}
		if (to === "CANCELLED" || to === "CANCELLATION_PENDING") {
			// In flight: the state says so, or the outcome is still open (e.g. blocked mid-execution).
			const inFlight =
				from === "EXECUTION_ACTIVE" ||
				from === "RECONCILIATION_PENDING" ||
				task.execution_outcome === "IN_PROGRESS" ||
				task.execution_outcome === "UNKNOWN";
			if (from === "BLOCKED") updates.block_record = null;
			if (to === "CANCELLATION_PENDING" && from === "CANCELLATION_PENDING") {
				return this.reject(
					req,
					task,
					"ILLEGAL_TRANSITION",
					"Already CANCELLATION_PENDING; confirm the outcome and go to CANCELLED.",
				);
			}
			if (to === "CANCELLED" && inFlight && from !== "CANCELLATION_PENDING") {
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

		// --- Leaving BLOCKED: only back to the state that was paused. ---
		if (from === "BLOCKED") {
			let br: { resume_state?: string; originating_state?: string } | null = null;
			try {
				br = task.block_record ? JSON.parse(task.block_record) : null;
			} catch {
				br = null;
			}
			// Rows written before originating_state was enforced: read it from the audit log.
			const origin = br?.originating_state ?? (await this.blockedFrom(task.task_id));
			if (!br?.resume_state || !origin || to !== br.resume_state || to !== origin) {
				return this.reject(
					req,
					task,
					"ILLEGAL_TRANSITION",
					origin && br?.resume_state === origin
						? `BLOCKED can only resume to ${origin}.`
						: `This block can't resume safely (paused ${origin ?? "unknown state"}, resume_state ${br?.resume_state ?? "missing"}); cancel the task or recreate it.`,
				);
			}
			updates.block_record = null;
			return this.commit(req, task, updates);
		}

		if (SIMPLE[from]?.includes(to)) return this.commit(req, task, updates);

		switch (`${from}->${to}`) {
			case "INTAKE->SPEC_ALIGNMENT": {
				// Supervisor approval of the objective: an owner message naming this task and approving it.
				const check = await this.verifyOwnerMessage(req.approval_message_id, task.task_id);
				if (!check.ok)
					return this.reject(req, task, "SUPERVISOR_APPROVAL_REQUIRED", check.reason);
				if (await this.approvalUsed(req.approval_message_id!)) {
					return this.reject(
						req,
						task,
						"APPROVAL_ALREADY_CONSUMED",
						"That approval was already used; ask the owner to approve this task's objective.",
					);
				}
				updates.intake_approval_id = req.approval_message_id!;
				return this.commit(req, task, updates, req.approval_message_id);
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
								// A task that needs an external action can't close out before doing it.
								PASS: needsExternalAction
									? ["EXECUTION_PENDING"]
									: ["CLOSEOUT_READY", "EXECUTION_PENDING"],
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
				// Single-use token: the approval message can be consumed exactly once. It is consumed
				// in the same batch as the move (see commit), so a failed move doesn't use it up.
				if (await this.approvalUsed(req.approval_message_id!)) {
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
				return this.commit(req, task, updates, req.approval_message_id);
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
	): Promise<{ ok: true; verdict: Verdict } | { ok: false; reason: string }> {
		if (!messageId)
			return {
				ok: false,
				reason: "Cite the Validator's verdict message (verdict_message_id).",
			};
		// A verdict covers one review: the pre-execution PASS can't be reused for post-execution validation.
		// json_valid guards old rows whose request was cut mid-JSON.
		const used = await this.db
			.prepare(
				"SELECT 1 FROM ledger_events WHERE task_id = ? AND result = 'OK' AND CASE WHEN json_valid(request) THEN json_extract(request, '$.verdict_message_id') END = ?",
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
		if (task.artifact_file_id && !containsExactId(text, task.artifact_file_id)) {
			return {
				ok: false,
				reason: `The verdict must cite the artifact fileId ${task.artifact_file_id}.`,
			};
		}
		if (task.artifact_revision_id && !containsExactId(text, task.artifact_revision_id)) {
			return {
				ok: false,
				reason: `The verdict must cite the artifact revision ${task.artifact_revision_id}.`,
			};
		}
		return parseVerdict(text);
	}

	private async verifyOwnerMessage(
		messageId: string | undefined,
		taskId: string,
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
		if (!containsExactId(msg.text, taskId)) {
			return {
				ok: false,
				reason: `The owner's approval must name the task exactly (${taskId}, same case).`,
			};
		}
		// Check the words around the ID, not the ID itself (an ID like NO-1 isn't a refusal).
		const words = msg.text.split(taskId).join(" ");
		if (!APPROVAL_WORDS.test(words)) {
			return {
				ok: false,
				reason: `The owner's message doesn't approve anything (expected e.g. "approve ${taskId}").`,
			};
		}
		if (REFUSAL_WORDS.test(words)) {
			return {
				ok: false,
				reason: "The owner's message contains a refusal or a hold; ask for an unambiguous approval.",
			};
		}
		return { ok: true };
	}

	/** Whether an owner message was already used as an approval (each one counts once). */
	private async approvalUsed(approvalId: string): Promise<boolean> {
		return !!(await this.db
			.prepare("SELECT 1 FROM ledger_approvals WHERE approval_id = ?")
			.bind(approvalId)
			.first());
	}

	/** The state a task was in when it was last blocked, from the audit log. */
	private async blockedFrom(taskId: string): Promise<string | null> {
		const row = await this.db
			.prepare(
				"SELECT from_state FROM ledger_events WHERE task_id = ? AND result = 'OK' AND to_state = 'BLOCKED' ORDER BY id DESC LIMIT 1",
			)
			.bind(taskId)
			.first<{ from_state: string | null }>();
		return row?.from_state ?? null;
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

	/**
	 * Applies one transition atomically: the task update, the consumed approval (if any) and the OK
	 * event go in one batch. The update only matches if the task is unchanged since it was read, and
	 * the later inserts only run if the update changed a row (changes() = 1), so a stale request
	 * writes nothing and comes back STALE_STATE.
	 */
	private async commit(
		req: TransitionRequest,
		task: TaskRow,
		updates: Partial<TaskRow>,
		consumeApprovalId?: string,
	): Promise<Result> {
		const fields = { ...updates, workflow_state: req.to_state };
		const cols = Object.keys(fields);
		const statements = [
			this.db
				.prepare(
					`UPDATE ledger_tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now')
				WHERE task_id = ? AND workflow_state = ? AND updated_at = ?`,
				)
				.bind(
					...cols.map((c) => (fields as Record<string, unknown>)[c] ?? null),
					task.task_id,
					task.workflow_state,
					task.updated_at,
				),
		];
		if (consumeApprovalId) {
			statements.push(
				this.db
					.prepare(
						"INSERT INTO ledger_approvals (approval_id, task_id, status, consumed_at) SELECT ?, ?, 'CONSUMED', datetime('now') WHERE changes() = 1",
					)
					.bind(consumeApprovalId, task.task_id),
			);
		}
		statements.push(
			this.eventStatement(
				task.task_id,
				task.workflow_state,
				req.to_state,
				"OK",
				req.note ?? null,
				req,
				true,
			),
		);

		let results: D1Result[];
		try {
			results = await this.db.batch(statements);
		} catch (err) {
			// Another request consumed the same approval between our check and this batch.
			if (consumeApprovalId && isUniqueViolation(err)) {
				return this.reject(
					req,
					task,
					"APPROVAL_ALREADY_CONSUMED",
					"That approval was already used; the owner must approve this attempt again.",
				);
			}
			throw err;
		}
		if ((results[0]?.meta?.changes ?? 0) !== 1) {
			const now = await this.getTask(task.task_id);
			return this.reject(
				req,
				now ?? task,
				"STALE_STATE",
				`The task changed while this request was checked (was ${task.workflow_state}, now ${now?.workflow_state ?? "missing"}). Nothing was written${consumeApprovalId ? " and the approval wasn't used" : ""}; re-read the task and retry.`,
			);
		}
		return { ok: true, task: (await this.getTask(task.task_id))! };
	}

	private async reject(
		req: TransitionRequest,
		task: TaskRow | null,
		error: string,
		reason: string,
	): Promise<Result> {
		await this.eventStatement(
			req.task_id,
			task?.workflow_state ?? null,
			req.to_state,
			"REJECTED",
			`${error}: ${reason}`,
			req,
		).run();
		return {
			ok: false,
			error,
			current_state: task?.workflow_state,
			target_state: req.to_state,
			reason,
		};
	}

	/** An audit-log insert. With onlyIfChanged, it only writes if the previous statement changed a row. */
	private eventStatement(
		taskId: string,
		from: string | null,
		to: string | null,
		result: string,
		reason: string | null,
		request: unknown,
		onlyIfChanged = false,
	): D1PreparedStatement {
		const cols = "task_id, from_state, to_state, result, reason, request";
		return this.db
			.prepare(
				onlyIfChanged
					? `INSERT INTO ledger_events (${cols}) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
					: `INSERT INTO ledger_events (${cols}) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				taskId,
				from,
				to,
				result,
				reason?.slice(0, 2000) ?? null,
				serializeRequest(request),
			);
	}
}

function isUniqueViolation(err: unknown): boolean {
	return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(
		String((err as Error)?.message ?? err),
	);
}
