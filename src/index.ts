import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { OperatorEnv } from "./operator";
import {
	authenticateMcpRequest,
	registerXPostingTools,
	type XPostingEnv,
} from "./x-posting";

export { ExecutiveOperator } from "./operator";

// Define our MCP agent with tools
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Fleet MCP Server",
		version: "1.1.0",
	});

	async init() {
		// Simple addition tool
		this.server.registerTool(
			"add",
			{ inputSchema: { a: z.number(), b: z.number() } },
			async ({ a, b }) => ({
				content: [{ type: "text", text: String(a + b) }],
			}),
		);

		// Calculator tool with multiple operations
		this.server.registerTool(
			"calculate",
			{
				inputSchema: {
					operation: z.enum(["add", "subtract", "multiply", "divide"]),
					a: z.number(),
					b: z.number(),
				},
			},
			async ({ operation, a, b }) => {
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "subtract":
						result = a - b;
						break;
					case "multiply":
						result = a * b;
						break;
					case "divide":
						if (b === 0)
							return {
								content: [
									{
										type: "text",
										text: "Error: Cannot divide by zero",
									},
								],
							};
						result = a / b;
						break;
				}
				return { content: [{ type: "text", text: String(result) }] };
			},
		);

		// Custom greeting tool
		this.server.registerTool(
			"greet",
			{
				inputSchema: {
					name: z.string().describe("The name of the person to greet"),
				},
			},
			async ({ name }) => ({
				content: [
					{
						type: "text",
						text: `Hello, ${name}! This is your custom MCP tool running on Cloudflare.`,
					},
				],
			}),
		);

		// X posting tools (staged 2026-10-14): x_whoami, draft_x_post,
		// publish_x_post. Env is read lazily at call time via this.env.
		registerXPostingTools(this.server, () => this.env as Env & XPostingEnv);
	}
}

export default {
	fetch(request: Request, env: Env & XPostingEnv, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				server: "Fleet MCP Server",
				x_posting_enabled: env.X_POSTING_ENABLED === "true",
				mcp_auth_configured: Boolean(env.MCP_CLIENT_TOKENS),
			});
		}

		if (url.pathname === "/mcp") {
			// Authenticated per AI client (fleet-shared, owner-controlled).
			// Fails closed when MCP_CLIENT_TOKENS is not configured.
			const client = authenticateMcpRequest(request, env);
			if (!client) {
				return new Response(
					"Unauthorized: a valid per-client bearer token is required for /mcp.",
					{ status: 401 },
				);
			}
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},

	// The Zenzap Executive Operator is switched off (owner's decision, 2026-10-11): no polling and no
	// research sync. To bring it back, restore the cron in wrangler.jsonc and, here:
	//   await env.OPERATOR.get(env.OPERATOR.idFromName("executive-operator")).ensurePolling();
	//   ctx.waitUntil(runResearch(env).catch((err) => console.error("research sync failed", err)));
	async scheduled(
		_controller: ScheduledController,
		_env: Env & OperatorEnv,
		_ctx: ExecutionContext,
	) {},
};
