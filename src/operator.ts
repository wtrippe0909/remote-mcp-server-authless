import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { buildOperatorTools } from "./operator-tools";
import {
	extractId,
	extractList,
	normalizeMessage,
	ZenzapClient,
	type ZenzapMessage,
} from "./zenzap";

export interface OperatorEnv {
	OPERATOR: DurableObjectNamespace<ExecutiveOperator>;
	ZENZAP_BASE_URL: string;
	ZENZAP_CONTROL_TOPIC_ID: string;
	ZENZAP_API_KEY: string;
	ZENZAP_API_SECRET: string;
	ANTHROPIC_API_KEY: string;
	/** Optional: only respond to messages from this member ID. */
	OWNER_MEMBER_ID?: string;
	/** Seconds between polls of the control topic (default 15). */
	POLL_INTERVAL_SECONDS?: string;
	/** low | medium | high | xhigh | max (default medium). */
	AGENT_EFFORT?: string;
}

const MODEL = "claude-opus-5-5";
const MAX_SEEN_IDS = 500;
const MAX_HISTORY_TURNS = 20;
const MAX_REPLY_CHARS = 4000;

const SYSTEM_PROMPT = `You are the Executive Operator, an AI chief-of-staff that works for the owner of a Zenzap workspace.
The owner talks to you in a private Zenzap "control topic". Your final reply text is posted back there automatically.

What you do:
- Run the owner's workspace through the Zenzap tools: read topics and messages, look up members, create topics,
  send messages to other topics, and create and update tasks and polls.
- Turn loose requests into concrete actions. When something is ambiguous (which person, which topic, what due date),
  look it up first; if it is still ambiguous, ask one short question instead of guessing.
- Before anything destructive or hard to undo (deleting messages, tasks or members, or messaging people other than
  the owner when they didn't explicitly ask for it), state what you plan to do and wait for the owner's go-ahead.

How you reply:
- Be brief and direct, like a capable executive assistant. Plain text that reads well in a chat app.
- After taking actions, say what you did and include any IDs or links that matter. If a tool call failed,
  say so plainly; never claim an action succeeded unless the tool result shows it did.
- You can't access email, calendar, or documents yet; say so if asked.`;

interface HistoryTurn {
	role: "user" | "assistant";
	text: string;
}

export class ExecutiveOperator extends DurableObject<OperatorEnv> {
	private running = false;

	private get zenzap() {
		return new ZenzapClient({
			baseUrl: this.env.ZENZAP_BASE_URL,
			apiKey: (this.env.ZENZAP_API_KEY ?? "").trim(),
			apiSecret: (this.env.ZENZAP_API_SECRET ?? "").trim(),
		});
	}

	private get pollMs() {
		const s = Number(this.env.POLL_INTERVAL_SECONDS ?? "15");
		return Math.max(5, Number.isFinite(s) ? s : 15) * 1000;
	}

	/** Called by the cron watchdog: make sure the polling alarm is scheduled. */
	async ensurePolling(): Promise<void> {
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm < Date.now() - 60_000) {
			await this.ctx.storage.setAlarm(Date.now() + 1000);
		}
	}

	async alarm(): Promise<void> {
		try {
			await this.poll();
		} catch (err) {
			console.error("poll failed", err);
		} finally {
			await this.ctx.storage.setAlarm(Date.now() + this.pollMs);
		}
	}

	async poll(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const zenzap = this.zenzap;
			const topicId = this.env.ZENZAP_CONTROL_TOPIC_ID;

			let botId = await this.ctx.storage.get<string>("botMemberId");
			if (!botId) {
				botId = extractId(await zenzap.getMe());
				if (botId) await this.ctx.storage.put("botMemberId", botId);
			}

			const payload = await zenzap.getTopicMessages(topicId, 30);
			const messages = extractList(payload)
				.map(normalizeMessage)
				.filter((m): m is ZenzapMessage => !!m);
			if (messages.length === 0) {
				if (extractList(payload).length > 0 || (payload && typeof payload === "object")) {
					console.log(
						"No parseable messages; raw payload:",
						JSON.stringify(payload).slice(0, 2000),
					);
				}
				return;
			}

			const seen = new Set((await this.ctx.storage.get<string[]>("seenIds")) ?? []);
			const initialized = await this.ctx.storage.get<boolean>("initialized");
			if (!initialized) {
				// First run: don't answer old history, just remember it.
				for (const m of messages) seen.add(m.id);
				await this.saveSeen(seen);
				await this.ctx.storage.put("initialized", true);
				console.log(`Initialized with ${messages.length} existing messages`);
				return;
			}

			const sentIds = new Set((await this.ctx.storage.get<string[]>("sentIds")) ?? []);
			const fresh = messages
				.filter((m) => !seen.has(m.id) && !sentIds.has(m.id))
				.filter((m) => !botId || m.senderId !== botId)
				.filter((m) => !this.env.OWNER_MEMBER_ID || m.senderId === this.env.OWNER_MEMBER_ID)
				.filter((m) => m.text.trim().length > 0)
				.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));

			// Mark everything we fetched as seen, including our own and filtered messages.
			for (const m of messages) seen.add(m.id);
			await this.saveSeen(seen);

			if (fresh.length === 0) return;
			if (!botId && fresh.every((m) => !m.senderId)) {
				console.warn(
					"Could not identify message senders; relying on sent-ID tracking to avoid echo loops",
				);
			}

			await this.handle(fresh.map((m) => m.text).join("\n\n"));
		} finally {
			this.running = false;
		}
	}

	private async handle(userText: string): Promise<void> {
		const zenzap = this.zenzap;
		const history = (await this.ctx.storage.get<HistoryTurn[]>("history")) ?? [];
		const sentMessageIds: string[] = [];

		let reply: string;
		let failed = false;
		try {
			reply = await this.runAgent(history, userText, sentMessageIds);
		} catch (err) {
			console.error("agent failed", err);
			failed = true;
			reply = this.describeAgentError(err);
		}

		for (const chunk of chunkText(reply, MAX_REPLY_CHARS)) {
			const res = await zenzap.sendMessage(this.env.ZENZAP_CONTROL_TOPIC_ID, chunk);
			const id = extractId(res);
			if (id) sentMessageIds.push(id);
		}

		const sent = (await this.ctx.storage.get<string[]>("sentIds")) ?? [];
		await this.ctx.storage.put("sentIds", [...sent, ...sentMessageIds].slice(-MAX_SEEN_IDS));

		if (failed) return;
		const updated: HistoryTurn[] = [
			...history,
			{ role: "user", text: userText },
			{ role: "assistant", text: reply },
		];
		await this.ctx.storage.put("history", updated.slice(-MAX_HISTORY_TURNS * 2));
	}

	private async runAgent(
		history: HistoryTurn[],
		userText: string,
		sentMessageIds: string[],
	): Promise<string> {
		const apiKey = this.anthropicKey;
		if (!apiKey) throw new MissingKeyError();
		const client = new Anthropic({ apiKey });
		const effort = (this.env.AGENT_EFFORT ?? "medium") as
			| "low"
			| "medium"
			| "high"
			| "xhigh"
			| "max";

		const messages: Anthropic.Beta.BetaMessageParam[] = [
			...history.map((t) => ({ role: t.role, content: t.text })),
			{
				role: "user",
				content: `[${new Date().toISOString()}]\n${userText}`,
			},
		];

		const final = await client.beta.messages.toolRunner({
			model: MODEL,
			max_tokens: 16000,
			max_iterations: 15,
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			output_config: { effort },
			cache_control: { type: "ephemeral" },
			system: SYSTEM_PROMPT,
			tools: buildOperatorTools(this.zenzap, sentMessageIds),
			messages,
		});

		if (final.stop_reason === "refusal") {
			return "I can't help with that request.";
		}
		const text = final.content
			.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (final.stop_reason === "max_tokens") {
			return `${text}\n\n(Reply cut off: it hit the length limit.)`.trim();
		}
		return text || "Done.";
	}

	private get anthropicKey() {
		// Strip whitespace and stray quotes that sneak in when pasting into the dashboard.
		return (this.env.ANTHROPIC_API_KEY ?? "").trim().replace(/^["']|["']$/g, "");
	}

	private describeAgentError(err: unknown): string {
		if (err instanceof MissingKeyError) {
			return "Setup problem: ANTHROPIC_API_KEY isn't set. Add it in Cloudflare under the Worker's Settings → Variables and Secrets.";
		}
		if (err instanceof Anthropic.AuthenticationError) {
			// Only a non-secret fingerprint of the key: its first characters and length.
			const key = this.anthropicKey;
			return [
				"Setup problem: Anthropic rejected the API key (error 401).",
				`The key Cloudflare has starts with "${key.slice(0, 10)}…" and is ${key.length} characters long.`,
				'A valid key starts with "sk-ant-api03-" and is about 108 characters long.',
				"Create a new key at console.anthropic.com → API Keys and paste it into ANTHROPIC_API_KEY.",
			].join(" ");
		}
		if (err instanceof Anthropic.APIError) {
			return `Sorry, the AI service returned error ${err.status}: ${err.message.slice(0, 300)}`;
		}
		return "Sorry, something went wrong while handling that request.";
	}

	private async saveSeen(seen: Set<string>) {
		await this.ctx.storage.put("seenIds", [...seen].slice(-MAX_SEEN_IDS));
	}
}

class MissingKeyError extends Error {}

function chunkText(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > size) {
		let cut = rest.lastIndexOf("\n", size);
		if (cut < size / 2) cut = size;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	if (rest) chunks.push(rest);
	return chunks;
}
