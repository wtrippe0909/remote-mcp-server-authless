# Remote MCP Server on Cloudflare (Without Auth)

A remote MCP server with no authentication, deployed on Cloudflare Workers.

**Public endpoint:** `/mcp` exposes three demo tools only: `add`, `calculate`, and `greet`. It has no access to any external service or credentials.

## Get started

Deploy to Workers:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

Or create a local copy from the template:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

Once deployed, the server is at `https://<your-worker>.<your-account>.workers.dev/mcp`.

## Local development

```bash
npm install
npm run dev        # wrangler dev, serves on http://localhost:8787
npm run type-check
npm test
```

## Customizing

Add tools inside `init()` in `src/index.ts` using `this.server.registerTool(...)`.

## Connect a client

**Cloudflare AI Playground:** go to https://playground.ai.cloudflare.com/, enter your `/mcp` URL, and use the tools.

**Claude Desktop (via mcp-remote):** open Settings > Developer > Edit Config and add:

```json
{
	"mcpServers": {
		"remote-mcp-server": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp"
			]
		}
	}
}
```

Replace the URL with your deployed `/mcp` URL when not running locally. Restart Claude Desktop to load the tools.

## Executive Operator (Zenzap agent): switched off

`src/operator.ts` and related files contain a Claude-powered agent that was designed to watch a Zenzap control topic and act on it. It is **switched off** (owner decision, 2026-10-11):

- `wrangler.jsonc` has no cron triggers (`"crons": []`).
- `scheduled()` in `src/index.ts` does nothing.
- The Zenzap tools are not exposed through `/mcp`.

To re-enable it, restore the cron in `wrangler.jsonc` and the calls noted in the comment in `src/index.ts`. Its secrets are set with `wrangler secret put`: `ZENZAP_API_KEY`, `ZENZAP_API_SECRET`, `ANTHROPIC_API_KEY`, and optionally `OWNER_MEMBER_ID`. Those secrets must be set before it will run.

### Known assumptions (for when it's re-enabled)

The response shapes of Zenzap's list endpoints and the request bodies for tasks and polls were not confirmed when this was written. `normalizeMessage` and `extractList` in `src/zenzap.ts` accept common field-name variants and log the raw payload when they find no messages. Tasks and polls use the generic `zenzap_request` tool.
