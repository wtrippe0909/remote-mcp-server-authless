// Ledger tests: one per Greptile finding on PR #11, plus the happy path and terminal states.
// Run with `npm test`. They use a node:sqlite stand-in for D1 (see d1-shim.ts) and a fake Zenzap
// client, so nothing leaves the machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { containsExactId, Ledger, parseVerdict, type TransitionRequest } from "../src/ledger";
import type { ZenzapClient } from "../src/zenzap";
import { D1Shim } from "./d1-shim";

const OWNER = "owner-1";
const VALIDATOR = "validator-1";

// One database for the whole file; every test uses its own task IDs.
const db = new D1Shim();
db.sqlite.exec("CREATE TABLE message_samples (message_id TEXT PRIMARY KEY, raw TEXT)");

// Messages the fake Zenzap API serves (not in message_samples), with an optional side effect that
// runs while the ledger is "waiting on the network".
const remote = new Map<string, { raw: unknown; before?: () => void }>();
const zenzap = {
	async request(_method: string, path: string) {
		const id = decodeURIComponent(path.split("/").pop() ?? "");
		const hit = remote.get(id);
		if (!hit) throw new Error("not found");
		hit.before?.();
		return hit.raw;
	},
	async getTopicMessages() {
		return [];
	},
} as unknown as ZenzapClient;

const ledger = new Ledger(db as unknown as D1Database, zenzap, {
	ownerId: OWNER,
	validatorId: VALIDATOR,
	controlTopicId: "control",
});

let seq = 0;
function msg(sender: string, text: string): string {
	const id = `m${++seq}`;
	db.sqlite
		.prepare("INSERT INTO message_samples (message_id, raw) VALUES (?, ?)")
		.run(id, JSON.stringify({ id, text, senderId: sender }));
	return id;
}
const owner = (text: string) => msg(OWNER, text);
const validator = (text: string) => msg(VALIDATOR, text);

async function create(id: string, needsExternalAction = false) {
	const r = await (ledger.createTask as (...a: unknown[]) => ReturnType<Ledger["createTask"]>)(
		id,
		`Task ${id}`,
		"Ship it",
		"topic",
		needsExternalAction,
	);
	assert.equal(r.ok, true, JSON.stringify(r));
}

async function move(req: TransitionRequest) {
	return ledger.requestTransition(req);
}

async function ok(req: TransitionRequest) {
	const r = await move(req);
	assert.equal(r.ok, true, `${req.task_id} -> ${req.to_state}: ${JSON.stringify(r)}`);
	return r.ok ? r.task : (undefined as never);
}

async function rejected(req: TransitionRequest, error?: string) {
	const r = await move(req);
	assert.equal(r.ok, false, `${req.task_id} -> ${req.to_state} should be rejected`);
	if (error && !r.ok) assert.equal(r.error, error, r.reason);
	return r;
}

/** INTAKE through VALIDATION_PENDING, bound to fileId/revision. */
async function toValidation(id: string, file = "F1", rev = "R1", needsExternalAction = false) {
	await create(id, needsExternalAction);
	await ok({
		task_id: id,
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner(`approve ${id}`),
	});
	await ok({ task_id: id, to_state: "DISPATCH_READY" });
	await ok({ task_id: id, to_state: "BUILD_ACTIVE" });
	await ok({
		task_id: id,
		to_state: "VALIDATION_PENDING",
		artifact_file_id: file,
		artifact_revision_id: rev,
	});
}

/** ...through EXECUTION_ACTIVE with an owner approval. */
async function toExecution(id: string) {
	await toValidation(id);
	await ok({
		task_id: id,
		to_state: "EXECUTION_PENDING",
		verdict_message_id: validator("for F1 revision R1\nVERDICT: PASS"),
	});
	await ok({
		task_id: id,
		to_state: "EXECUTION_ACTIVE",
		approval_message_id: owner(`approve ${id}, send it`),
	});
}

async function task(id: string) {
	const t = await ledger.getTask(id);
	assert.ok(t, `task ${id} exists`);
	return t;
}

async function events(id: string) {
	return (await ledger.history(id)) as Array<{
		from_state: string | null;
		to_state: string | null;
		result: string;
		request: string;
	}>;
}

// --- Baseline ---

test("happy path: INTAKE to COMPLETED, every accepted move logged OK", async () => {
	await toValidation("H1");
	await ok({
		task_id: "H1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("for F1 revision R1\nVERDICT: PASS"),
	});
	await ok({ task_id: "H1", to_state: "COMPLETED" });
	const log = await events("H1");
	assert.deepEqual(
		log.map((e) => `${e.result} ${e.to_state}`),
		[
			"OK INTAKE",
			"OK SPEC_ALIGNMENT",
			"OK DISPATCH_READY",
			"OK BUILD_ACTIVE",
			"OK VALIDATION_PENDING",
			"OK CLOSEOUT_READY",
			"OK COMPLETED",
		],
	);
});

test("happy path with an external action: execution, post-exec validation, closeout", async () => {
	await toExecution("H2");
	await ok({ task_id: "H2", to_state: "POST_EXEC_VALIDATION", execution_outcome: "SUCCEEDED" });
	await ok({
		task_id: "H2",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("for F1 revision R1, email sent\nVERDICT: PASS"),
	});
	await ok({ task_id: "H2", to_state: "COMPLETED" });
});

test("terminal states accept nothing", async () => {
	await create("X1");
	await ok({ task_id: "X1", to_state: "CANCELLED" });
	await rejected({ task_id: "X1", to_state: "SPEC_ALIGNMENT" }, "TERMINAL_STATE");
	await rejected(
		{
			task_id: "X1",
			to_state: "BLOCKED",
			block_record: { cause: "x", resolution_prerequisite: "y", resume_state: "INTAKE" },
		},
		"TERMINAL_STATE",
	);
});

// --- Finding 1: blocking skipped owner approval ---

test("1. a block can only resume to the state it paused", async () => {
	await create("B1");
	await rejected({
		task_id: "B1",
		to_state: "BLOCKED",
		block_record: {
			cause: "x",
			resolution_prerequisite: "y",
			resume_state: "EXECUTION_ACTIVE",
		},
	});
	assert.equal((await task("B1")).workflow_state, "INTAKE");

	await ok({
		task_id: "B1",
		to_state: "BLOCKED",
		block_record: { cause: "x", resolution_prerequisite: "y", resume_state: "INTAKE" },
	});
	await rejected(
		{
			task_id: "B1",
			to_state: "BLOCKED",
			block_record: { cause: "x", resolution_prerequisite: "y", resume_state: "BLOCKED" },
		},
		"ALREADY_BLOCKED",
	);
	await rejected({ task_id: "B1", to_state: "EXECUTION_ACTIVE" });
	await ok({ task_id: "B1", to_state: "INTAKE" });
});

test("1. an old block record without originating_state can't jump ahead", async () => {
	await create("B2");
	await ok({
		task_id: "B2",
		to_state: "BLOCKED",
		block_record: { cause: "x", resolution_prerequisite: "y", resume_state: "INTAKE" },
	});
	// Simulate a row written before this fix: no originating_state, and a resume_state ahead.
	db.sqlite.prepare("UPDATE ledger_tasks SET block_record = ? WHERE task_id = 'B2'").run(
		JSON.stringify({
			cause: "x",
			resolution_prerequisite: "y",
			resume_state: "EXECUTION_ACTIVE",
		}),
	);
	await rejected({ task_id: "B2", to_state: "EXECUTION_ACTIVE" });
	assert.equal((await task("B2")).workflow_state, "BLOCKED");
});

// --- Finding 2: cancellation hid unfinished work ---

test("2. a blocked task with an action in flight goes through CANCELLATION_PENDING", async () => {
	await toExecution("C1");
	await ok({
		task_id: "C1",
		to_state: "BLOCKED",
		block_record: {
			cause: "x",
			resolution_prerequisite: "y",
			resume_state: "EXECUTION_ACTIVE",
		},
	});
	await rejected({ task_id: "C1", to_state: "CANCELLED" });
	await ok({ task_id: "C1", to_state: "CANCELLATION_PENDING" });
	await rejected({ task_id: "C1", to_state: "CANCELLED" }, "UNRECONCILED");
	await rejected(
		{ task_id: "C1", to_state: "CANCELLED", execution_outcome: "UNKNOWN" },
		"UNRECONCILED",
	);
	const t = await ok({ task_id: "C1", to_state: "CANCELLED", execution_outcome: "FAILED" });
	assert.equal(t.execution_outcome, "FAILED");
});

// --- Finding 3: rejections counted as approval ---

test("3. intake approval must name the task and approve it", async () => {
	await create("R1");
	await rejected({
		task_id: "R1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("no, don't do this"),
	});
	await rejected({
		task_id: "R1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("what's the status on R1?"),
	});
	await rejected({
		task_id: "R1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("don’t approve R1 yet"),
	});
	await rejected({
		task_id: "R1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve R1 but hold off on the email"),
	});
	assert.equal((await task("R1")).workflow_state, "INTAKE");
	await ok({
		task_id: "R1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve R1"),
	});
});

// --- Finding 4: approval covered the wrong task ---

test("4. task IDs match whole and case-sensitively", async () => {
	await create("A1");
	await create("A10");
	await rejected({
		task_id: "A1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve A10"),
	});
	await rejected({
		task_id: "A1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve a1"),
	});
	await rejected({
		task_id: "A1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve A1.5"),
	});
	await ok({
		task_id: "A1",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve A1."),
	});
	await ok({
		task_id: "A10",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve A10"),
	});
});

test("4. an execution approval for another task doesn't start this one", async () => {
	await toValidation("E1");
	await create("E10");
	await ok({
		task_id: "E1",
		to_state: "EXECUTION_PENDING",
		verdict_message_id: validator("for F1 revision R1\nVERDICT: PASS"),
	});
	const forE10 = owner("approve E10");
	await rejected({ task_id: "E1", to_state: "EXECUTION_ACTIVE", approval_message_id: forE10 });
	const used = db.sqlite
		.prepare("SELECT 1 FROM ledger_approvals WHERE approval_id = ?")
		.get(forE10);
	assert.equal(used, undefined, "the other task's approval must not be consumed");
});

// --- Finding 5: rejected verdicts became passes ---

test("5. a negated verdict word is not a PASS", async () => {
	await toValidation("V1", "F1", "R1");
	await rejected({
		task_id: "V1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("Not PASS for F1 revision R1"),
	});
	await rejected({
		task_id: "V1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("This is non-PASS for F1 R1"),
	});
	await rejected({
		task_id: "V1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("F1 R1 isn't a PASS"),
	});
	// Bare verdict words never count, negated or not; only a VERDICT line does.
	await rejected({
		task_id: "V1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("PASS for F1 R1"),
	});
	await rejected({
		task_id: "V1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS not met"),
	});
	// A VERDICT line is authoritative even when the prose mentions other words.
	const t = await ok({
		task_id: "V1",
		to_state: "REWORK_ACTIVE",
		verdict_message_id: validator("VERDICT: FAIL\nF1 revision R1 does not PASS the spec."),
	});
	assert.equal(t.validation_verdict, "FAIL");
});

test("5. two VERDICT lines are ambiguous", async () => {
	await toValidation("V2");
	await rejected({
		task_id: "V2",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("VERDICT: PASS\nVERDICT: FAIL\nF1 R1"),
	});
});

// --- Finding 6: review covered the wrong version ---

test("6. revision and fileId match whole", async () => {
	await toValidation("W1", "F1", "1");
	await rejected({
		task_id: "W1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("for F1 revision 10\nVERDICT: PASS"),
	});
	await rejected({
		task_id: "W1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("for F12 revision 1\nVERDICT: PASS"),
	});
	await ok({
		task_id: "W1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("for F1 revision 1.\nVERDICT: PASS"),
	});
});

// --- Finding 7: inconclusive reviews weren't saved ---

test("7. blocking on an INCONCLUSIVE verdict records it", async () => {
	await toValidation("I1");
	await rejected({
		task_id: "I1",
		to_state: "BLOCKED",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
		block_record: {
			cause: "x",
			resolution_prerequisite: "y",
			resume_state: "VALIDATION_PENDING",
		},
	});
	const vm = validator("can't open F1 R1\nVERDICT: INCONCLUSIVE");
	const t = await ok({
		task_id: "I1",
		to_state: "BLOCKED",
		verdict_message_id: vm,
		block_record: {
			cause: "x",
			resolution_prerequisite: "y",
			resume_state: "VALIDATION_PENDING",
		},
	});
	assert.equal(t.validation_verdict, "INCONCLUSIVE");
	assert.equal(t.verdict_message_id, vm);
});

// --- Finding 8: required external actions could be skipped ---

test("8. a task that needs an external action can't close out straight from PASS", async () => {
	await toValidation("N1", "F1", "R1", true);
	assert.equal((await task("N1")).needs_external_action, 1);
	await rejected({
		task_id: "N1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
	});
	await ok({
		task_id: "N1",
		to_state: "EXECUTION_PENDING",
		verdict_message_id: validator("F1 R1 again\nVERDICT: PASS"),
	});
});

test("8. needs_external_action is a one-way latch", async () => {
	await create("N2");
	await ok({
		task_id: "N2",
		to_state: "SPEC_ALIGNMENT",
		approval_message_id: owner("approve N2"),
		needs_external_action: true,
	});
	await ok({ task_id: "N2", to_state: "DISPATCH_READY", needs_external_action: false });
	assert.equal((await task("N2")).needs_external_action, 1);
});

// --- Finding 9: long notes broke later reviews ---

test("9. a long note still stores valid JSON and later verdict checks work", async () => {
	await toValidation("L1");
	db.sqlite.exec("PRAGMA foreign_keys = OFF");
	await ok({
		task_id: "L1",
		to_state: "BLOCKED",
		note: "x".repeat(10_000),
		block_record: {
			cause: "c".repeat(5000),
			resolution_prerequisite: "y",
			resume_state: "VALIDATION_PENDING",
		},
	});
	await ok({ task_id: "L1", to_state: "VALIDATION_PENDING" });
	for (const e of await events("L1")) JSON.parse(e.request);
	await ok({
		task_id: "L1",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
	});
});

test("9. an old row with truncated JSON doesn't break the verdict-reuse check", async () => {
	await toValidation("L2");
	db.sqlite
		.prepare(
			"INSERT INTO ledger_events (task_id, from_state, to_state, result, reason, request) VALUES ('L2', 'X', 'Y', 'OK', null, ?)",
		)
		.run('{"task_id":"L2","note":"cut off');
	await ok({
		task_id: "L2",
		to_state: "CLOSEOUT_READY",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
	});
});

// --- Finding 10: partial writes ---

test("10. a task that changed mid-request writes nothing and keeps the approval", async () => {
	await toValidation("S1");
	await ok({
		task_id: "S1",
		to_state: "EXECUTION_PENDING",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
	});
	// The approval comes from the Zenzap API; while the ledger waits on it, the task moves on.
	remote.set("remote-approval", {
		raw: { id: "remote-approval", text: "approve S1", senderId: OWNER },
		before: () =>
			db.sqlite
				.prepare(
					"UPDATE ledger_tasks SET workflow_state = 'FAILED', updated_at = '2099-01-01 00:00:00' WHERE task_id = 'S1'",
				)
				.run(),
	});
	const r = await rejected(
		{ task_id: "S1", to_state: "EXECUTION_ACTIVE", approval_message_id: "remote-approval" },
		"STALE_STATE",
	);
	assert.equal(r.ok, false);
	const consumed = db.sqlite
		.prepare("SELECT 1 FROM ledger_approvals WHERE approval_id = 'remote-approval'")
		.get();
	assert.equal(consumed, undefined, "approval must not be consumed");
	const okExec = (await events("S1")).filter(
		(e) => e.result === "OK" && e.to_state === "EXECUTION_ACTIVE",
	);
	assert.equal(okExec.length, 0, "no OK event for a move that didn't happen");
});

test("10. a chained insert that didn't run is reported, not hidden", async () => {
	await create("Z1");
	// Simulate D1 not carrying changes() between batch statements: the audit insert is skipped.
	db.skipInBatch = (sql) =>
		sql.startsWith("INSERT INTO ledger_events") && sql.includes("changes()");
	try {
		const r = await rejected(
			{ task_id: "Z1", to_state: "SPEC_ALIGNMENT", approval_message_id: owner("approve Z1") },
			"WRITE_INCONSISTENT",
		);
		assert.match(r.ok ? "" : r.reason, /audit event wasn't written/);
	} finally {
		db.skipInBatch = undefined;
	}
	const log = await events("Z1");
	assert.deepEqual(
		log.map((e) => `${e.result} ${e.to_state}`),
		["OK INTAKE", "WRITE_INCONSISTENT SPEC_ALIGNMENT"],
	);
});

test("10. an approval is single-use, including one first used at intake", async () => {
	await create("U1");
	const approval = owner("approve U1");
	await ok({ task_id: "U1", to_state: "SPEC_ALIGNMENT", approval_message_id: approval });
	await ok({ task_id: "U1", to_state: "DISPATCH_READY" });
	await ok({ task_id: "U1", to_state: "BUILD_ACTIVE" });
	await ok({
		task_id: "U1",
		to_state: "VALIDATION_PENDING",
		artifact_file_id: "F1",
		artifact_revision_id: "R1",
	});
	await ok({
		task_id: "U1",
		to_state: "EXECUTION_PENDING",
		verdict_message_id: validator("F1 R1\nVERDICT: PASS"),
	});
	await rejected(
		{ task_id: "U1", to_state: "EXECUTION_ACTIVE", approval_message_id: approval },
		"APPROVAL_ALREADY_CONSUMED",
	);
	const fresh = owner("approve U1 send");
	await ok({ task_id: "U1", to_state: "EXECUTION_ACTIVE", approval_message_id: fresh });
	await ok({ task_id: "U1", to_state: "EXECUTION_PENDING", execution_outcome: "FAILED" });
	await rejected(
		{ task_id: "U1", to_state: "EXECUTION_ACTIVE", approval_message_id: fresh },
		"APPROVAL_ALREADY_CONSUMED",
	);
});

// --- Parsing helpers ---

test("containsExactId: whole identifier, case-sensitive, trailing dot allowed", () => {
	assert.equal(containsExactId("approve T1.", "T1"), true);
	assert.equal(containsExactId("approve T1, go", "T1"), true);
	assert.equal(containsExactId("(T8-06)", "T8-06"), true);
	assert.equal(containsExactId("approve T10", "T1"), false);
	assert.equal(containsExactId("approve t1", "T1"), false);
	assert.equal(containsExactId("approve XT1", "T1"), false);
	assert.equal(containsExactId("approve T1.5", "T1"), false);
	assert.equal(containsExactId("approve T8-061", "T8-06"), false);
	assert.equal(containsExactId("approve v2.T1", "T1"), false);
	assert.equal(containsExactId("approve T1.5", "T1.5"), true);
	assert.equal(containsExactId("approve T1x5", "T1.5"), false);
});

test("parseVerdict: exactly one VERDICT line holding only the verdict", () => {
	const v = (t: string) => {
		const r = parseVerdict(t);
		return r.ok ? r.verdict : "REJECTED";
	};
	assert.equal(v("VERDICT: PASS"), "PASS");
	assert.equal(v("F1 R1\nVERDICT: PASS."), "PASS");
	assert.equal(v("**VERDICT:** fail\nnotes"), "FAIL");
	assert.equal(v("Checked F1.\nVerdict: INCONCLUSIVE"), "INCONCLUSIVE");
	assert.equal(v("> VERDICT: **PASS**"), "PASS");
	assert.equal(v("PASS for F1 R1"), "REJECTED");
	assert.equal(v("VERDICT: PASS not met"), "REJECTED");
	assert.equal(v("VERDICT: PASS? no"), "REJECTED");
	assert.equal(v("VERDICT: not PASS"), "REJECTED");
	assert.equal(v("VERDICT: PASS\nVERDICT: PASS"), "REJECTED");
	assert.equal(v("No verdict yet; PASS pending"), "REJECTED");
	assert.equal(v("looks fine"), "REJECTED");
});
