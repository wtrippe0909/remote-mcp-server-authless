import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { type Ledger, WORKFLOW_STATES } from "./ledger";
import { addNote, archiveNote, usageSummary } from "./memory";
import { extractId, type ZenzapClient, ZenzapError } from "./zenzap";

// Tools the Executive Operator can use. Each returns JSON text (or an error
// string the model can read and correct from) rather than throwing.

async function run(fn: () => Promise<unknown>): Promise<string> {
	try {
		const result = await fn();
		return JSON.stringify(result ?? { ok: true }).slice(0, 20000);
	} catch (err) {
		if (err instanceof ZenzapError) {
			return `Error ${err.status} from Zenzap ${err.method} ${err.path}: ${err.body.slice(0, 2000)}`;
		}
		return `Error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

const ALLOWED_PREFIXES = [
	"/v2/topics",
	"/v2/messages",
	"/v2/tasks",
	"/v2/polls",
	"/v2/members",
	"/v2/updates",
	"/v2/org-units",
	"/v2/organization/labels",
];

export function buildOperatorTools(zenzap: ZenzapClient, sentMessageIds: string[]) {
	return [
		betaZodTool({
			name: "zenzap_send_message",
			description:
				"Send a text message to a Zenzap topic (chat). Do NOT use this to answer the owner in the control topic; your final reply is posted there automatically. Use it only to message other topics.",
			inputSchema: z.object({
				topicId: z.string().describe("Topic ID (UUID)"),
				text: z.string().describe("Message text"),
			}),
			run: ({ topicId, text }) =>
				run(async () => {
					const res = await zenzap.sendMessage(topicId, text);
					const id = extractId(res);
					if (id) sentMessageIds.push(id);
					return res;
				}),
		}),
		betaZodTool({
			name: "zenzap_list_topics",
			description: "List Zenzap topics (chats/channels) the bot can see.",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(100).optional(),
				offset: z.number().int().min(0).optional(),
			}),
			run: ({ limit, offset }) =>
				run(() =>
					zenzap.request("GET", "/v2/topics", { query: { limit: limit ?? 50, offset } }),
				),
		}),
		betaZodTool({
			name: "zenzap_get_topic",
			description: "Get details (name, members, etc.) of one Zenzap topic.",
			inputSchema: z.object({ topicId: z.string() }),
			run: ({ topicId }) =>
				run(() => zenzap.request("GET", `/v2/topics/${encodeURIComponent(topicId)}`)),
		}),
		betaZodTool({
			name: "zenzap_get_topic_messages",
			description: "Read recent messages from a Zenzap topic.",
			inputSchema: z.object({
				topicId: z.string(),
				limit: z.number().int().min(1).max(100).optional(),
			}),
			run: ({ topicId, limit }) => run(() => zenzap.getTopicMessages(topicId, limit ?? 20)),
		}),
		betaZodTool({
			name: "zenzap_list_members",
			description:
				"List members of the Zenzap organization (use to resolve names to member IDs).",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(100).optional(),
				offset: z.number().int().min(0).optional(),
			}),
			run: ({ limit, offset }) =>
				run(() =>
					zenzap.request("GET", "/v2/members", { query: { limit: limit ?? 50, offset } }),
				),
		}),
		betaZodTool({
			name: "zenzap_create_topic",
			description: "Create a new Zenzap topic (group chat) with the given members.",
			inputSchema: z.object({
				name: z.string(),
				members: z.array(z.string()).describe("Member IDs to add"),
			}),
			run: ({ name, members }) =>
				run(() => zenzap.request("POST", "/v2/topics", { body: { name, members } })),
		}),
		betaZodTool({
			name: "zenzap_request",
			description: [
				"Call any other Zenzap v2 endpoint. Use this for tasks, polls, reactions, labels, org units, and edits.",
				"Endpoints: GET/POST /v2/tasks, GET/PATCH/DELETE /v2/tasks/{taskId}; POST /v2/polls,",
				"POST/DELETE /v2/polls/{pollId}/votes/...; PATCH/DELETE /v2/messages/{messageId};",
				"POST /v2/messages/{messageId}/reactions; PATCH /v2/topics/{topicId};",
				"POST/DELETE /v2/topics/{topicId}/members; GET /v2/org-units; GET/POST /v2/organization/labels.",
				"Request body field names are not documented here: make a best guess (e.g. tasks: title, description,",
				"topicId, assignees, dueDate; polls: topicId, question, options) and adjust from the error message if",
				"Zenzap rejects it.",
			].join(" "),
			inputSchema: z.object({
				method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
				path: z.string().describe("Path starting with /v2/, without query string"),
				query: z
					.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
					.optional(),
				body: z.record(z.string(), z.unknown()).optional(),
			}),
			run: ({ method, path, query, body }) =>
				run(async () => {
					if (
						!ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ||
						path.includes("..")
					) {
						throw new Error(`Path not allowed: ${path}`);
					}
					return zenzap.request(method, path, { query, body });
				}),
		}),
	];
}

/** Shared-notebook and cost tools; only offered when the RESEARCH database is bound. */
export function buildMemoryTools(db: D1Database, topicId: string) {
	return [
		betaZodTool({
			name: "memory_remember",
			description: [
				"Save a note to your shared notebook, which you see in every chat (private and group) on every turn.",
				"Save anything you'll need later: the owner's decisions and rulings, preferences, who owns which tool,",
				"task/topic/file IDs you looked up, and open items. One fact per note, written so it stands on its own.",
			].join(" "),
			inputSchema: z.object({ note: z.string().min(1).max(2000) }),
			run: ({ note }) =>
				run(async () => ({
					saved: await addNote(db, note, "executive-operator", topicId),
				})),
		}),
		betaZodTool({
			name: "memory_forget",
			description:
				"Archive a notebook note that is wrong or no longer true, by its #id. Save a corrected note if needed.",
			inputSchema: z.object({ id: z.number().int().positive() }),
			run: ({ id }) => run(async () => ({ archived: await archiveNote(db, id) })),
		}),
		betaZodTool({
			name: "memory_export",
			description:
				"Return the full notebook, including archived notes, when the owner asks to see or export it.",
			inputSchema: z.object({}),
			run: () =>
				run(async () => {
					const { results } = await db
						.prepare(
							"SELECT id, created_at, author, note, archived FROM memory_notes ORDER BY id",
						)
						.all();
					return results;
				}),
		}),
		betaZodTool({
			name: "usage_report",
			description:
				"Report your real Anthropic API spend per day (tokens and USD at list prices) from your usage log.",
			inputSchema: z.object({ days: z.number().int().min(1).max(90).optional() }),
			run: ({ days }) => run(() => usageSummary(db, days ?? 7)),
		}),
	];
}

/**
 * Doctrine v2.3 task ledger. The agent can only request transitions; the Ledger checks every one
 * and returns either the updated task or a structured error ({error, current_state, target_state,
 * reason}).
 */
export function buildLedgerTools(ledger: Ledger, topicId: string) {
	const state = z.enum(WORKFLOW_STATES);
	return [
		betaZodTool({
			name: "ledger_create_task",
			description:
				"Open a governed task in the ledger at INTAKE. Use the same ID as its Zenzap task when there is one (e.g. T8-06).",
			inputSchema: z.object({
				task_id: z.string(),
				title: z.string(),
				objective: z.string().describe("What done looks like, in one or two sentences"),
				needs_external_action: z
					.boolean()
					.describe(
						"True if finishing the task means sending, writing, sharing or deleting something outside the chat (an email, a Drive file, a calendar invite). Once true it can't be turned off, and the task must go through owner-approved execution.",
					),
			}),
			run: ({ task_id, title, objective, needs_external_action }) =>
				run(() =>
					ledger.createTask(task_id, title, objective, topicId, needs_external_action),
				),
		}),
		betaZodTool({
			name: "ledger_transition",
			description: [
				"Request a workflow_state change for a ledger task. The ledger enforces the doctrine and reads the cited",
				"Zenzap messages itself; a rejection comes back as {ok:false, error, current_state, target_state, reason}.",
				"Evidence each move needs: INTAKE->SPEC_ALIGNMENT approval_message_id (an owner message naming the",
				"exact task ID, same case, and approving it, e.g. 'approve T8-06'); BUILD_ACTIVE or",
				"REWORK_ACTIVE->VALIDATION_PENDING artifact_file_id + artifact_revision_id (Drive headRevisionId or",
				"version); out of VALIDATION_PENDING or POST_EXEC_VALIDATION verdict_message_id (the Validator's",
				"message citing the exact fileId and revision, with a line 'VERDICT: PASS', 'VERDICT: FAIL' or",
				"'VERDICT: INCONCLUSIVE'); EXECUTION_PENDING->EXECUTION_ACTIVE approval_message_id (a fresh owner",
				"message naming the exact task ID and approving it; every approval is single use, including the",
				"intake one); leaving EXECUTION_ACTIVE or RECONCILIATION_PENDING execution_outcome; BLOCKED",
				"block_record {cause, resolution_prerequisite, resume_state}, where resume_state must equal the",
				"state you block from (blocking on an INCONCLUSIVE verdict: also pass its verdict_message_id).",
				"Owner messages with a refusal or hold (not, no, don't, wait, hold, stop, cancel...) never count.",
				"If a task needs an external action, a PASS can only go to EXECUTION_PENDING.",
			].join(" "),
			inputSchema: z.object({
				task_id: z.string(),
				to_state: state,
				approval_message_id: z.string().optional(),
				verdict_message_id: z.string().optional(),
				artifact_file_id: z.string().optional(),
				artifact_revision_id: z.string().optional(),
				execution_outcome: z.enum(["SUCCEEDED", "FAILED", "UNKNOWN"]).optional(),
				needs_external_action: z
					.boolean()
					.optional()
					.describe(
						"Set true if you learn the task needs an external action; it can't be turned off",
					),
				block_record: z
					.object({
						cause: z.string(),
						resolution_prerequisite: z.string(),
						resume_state: state,
					})
					.optional(),
				note: z
					.string()
					.optional()
					.describe("Receipt, reason or context for the audit log"),
			}),
			run: (req) => run(() => ledger.requestTransition(req)),
		}),
		betaZodTool({
			name: "ledger_get",
			description:
				"Get one ledger task with its four status dimensions, counters and artifact binding.",
			inputSchema: z.object({ task_id: z.string() }),
			run: ({ task_id }) =>
				run(
					async () =>
						(await ledger.getTask(task_id)) ?? { error: "UNKNOWN_TASK", task_id },
				),
		}),
		betaZodTool({
			name: "ledger_list",
			description:
				"List ledger tasks, newest activity first. Open tasks only unless include_closed is true.",
			inputSchema: z.object({ include_closed: z.boolean().optional() }),
			run: ({ include_closed }) => run(() => ledger.listTasks(include_closed ?? false)),
		}),
		betaZodTool({
			name: "ledger_history",
			description:
				"The audit log of one task: every requested transition, accepted or rejected, with reasons.",
			inputSchema: z.object({ task_id: z.string() }),
			run: ({ task_id }) => run(() => ledger.history(task_id)),
		}),
	];
}
