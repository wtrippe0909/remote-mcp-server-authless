# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a remote MCP server that doesn't require authentication on Cloudflare Workers.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/tools/) to the MCP server, define each tool inside the `init()` method of `src/index.ts` using `this.server.tool(...)`.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/mcp`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp" // or remote-mcp-server-authless.your-account.workers.dev/mcp
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.

## Executive Operator (Zenzap agent)

This Worker also runs **Executive Operator**, a Claude-powered agent you chat with in Zenzap. It watches your Zenzap
*control topic*, answers each new message with Claude (`claude-opus-5-5`), and can act in your workspace: read
topics and messages, look up members, create topics, message other topics, and create and update tasks and polls.

How it works:

- A Durable Object (`ExecutiveOperator`) polls `GET /v2/topics/{controlTopicId}/messages` every
  `POLL_INTERVAL_SECONDS` (default 15) using a Durable Object alarm. A cron trigger runs every minute to restart the
  alarm if it ever stops.
- On the very first poll it only records existing messages and doesn't reply to old history.
- It ignores its own messages (matched by bot member ID and by the IDs of messages it sent). If `OWNER_MEMBER_ID` is
  set, it only answers that member.
- New messages go to Claude with the last 20 exchanges as context. Claude can call the Zenzap tools in
  `src/operator-tools.ts` (up to 15 rounds), and its final answer is posted back to the control topic.
- Every Zenzap request is signed with the static-API-key HMAC scheme (`src/zenzap.ts`).
- There is no public HTTP endpoint for the agent. The existing `/mcp` server is unauthenticated, so the Zenzap
  tools are deliberately **not** exposed through it.

### Deploy

```bash
npm install
npx wrangler secret put ZENZAP_API_KEY       # API Key from the Zenzap "Connect your AI agent" screen
npx wrangler secret put ZENZAP_API_SECRET    # API Secret from the same screen
npx wrangler secret put ANTHROPIC_API_KEY    # https://console.anthropic.com/settings/keys
# optional: only respond to you
npx wrangler secret put OWNER_MEMBER_ID
npm run deploy
```

`ZENZAP_BASE_URL`, `ZENZAP_CONTROL_TOPIC_ID`, `POLL_INTERVAL_SECONDS` and `AGENT_EFFORT` are plain vars in
`wrangler.jsonc`. The first reply can take up to a minute, until the cron starts the polling loop. Then send a
message in the control topic. Use `npx wrangler tail` to follow the logs.

### Known assumptions

The response shapes of Zenzap's list endpoints and the request bodies for tasks and polls weren't available when
this was written. Message parsing (`normalizeMessage` / `extractList` in `src/zenzap.ts`) accepts the common field
names (`messages`/`data`/`items`, `text`/`body`, `senderId`/`sender.id`, and so on). If it finds no messages, it
logs the raw payload so the parser can be adjusted. For tasks and polls, the agent uses the generic `zenzap_request`
tool and corrects itself from Zenzap's error messages.
