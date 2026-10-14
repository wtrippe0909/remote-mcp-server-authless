import assert from "node:assert/strict";
import test from "node:test";
import {
	authenticateMcpRequest,
	buildOAuthHeader,
	percentEncode,
	type XPostingEnv,
} from "../src/x-posting";

// Public example credentials from X's own OAuth documentation — NOT the
// owner's keys. The expected signature below is the documented value for
// this exact request, nonce, and timestamp.
const DOC_ENV: XPostingEnv = {
	X_CONSUMER_KEY: "xvz1evFS4wEEPTGEFPHBog",
	X_CONSUMER_SECRET: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
	X_ACCESS_TOKEN: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
	X_ACCESS_TOKEN_SECRET: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
};

test("percentEncode follows RFC 3986", () => {
	assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
	assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
	assert.equal(percentEncode("~ok-._"), "~ok-._");
});

test("OAuth 1.0a signature matches the RFC 5849 spec vector", async () => {
	// The worked example from RFC 5849 itself (photos.example.net):
	// the signature for these exact inputs is a matter of spec record.
	const rfcEnv: XPostingEnv = {
		X_CONSUMER_KEY: "dpf43f3p2l4k3l03",
		X_CONSUMER_SECRET: "kd94hf93k423kf44",
		X_ACCESS_TOKEN: "nnch734d00sl2jdk",
		X_ACCESS_TOKEN_SECRET: "pfkkdhi9sl3r4s00",
	};
	const header = await buildOAuthHeader(
		rfcEnv,
		"GET",
		"http://photos.example.net/photos?file=vacation.jpg&size=original",
		{},
		{ nonce: "kllo9940pd9333jh", timestamp: "1191242096" },
	);
	assert.ok(
		header.includes('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"'),
		`RFC 5849 signature mismatch in header: ${header}`,
	);
});

test("OAuth 1.0a signature on an X-shaped POST matches an independent implementation", async () => {
	// Same inputs run through a second, independent HMAC-SHA1 signing
	// implementation (Python) produced exactly this signature. Note: X's
	// own docs header example (tnnArxj...) does NOT reproduce from the
	// docs' published inputs on either implementation — a known docs
	// inconsistency — so the cross-implementation value is asserted here.
	const header = await buildOAuthHeader(
		DOC_ENV,
		"POST",
		"https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
		{ form: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" } },
		{ nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: "1318622958" },
	);
	assert.ok(
		header.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'),
		`signature mismatch in header: ${header}`,
	);
});

test("missing X secrets fail loudly, not silently", async () => {
	await assert.rejects(
		() => buildOAuthHeader({}, "GET", "https://api.x.com/2/users/me"),
		/secrets are not configured/,
	);
});

test("per-client MCP auth identifies the caller and fails closed", () => {
	const env: XPostingEnv = {
		MCP_CLIENT_TOKENS: JSON.stringify({ muse: "token-muse", grok: "token-grok" }),
	};
	const as = (token?: string) =>
		new Request("https://example.workers.dev/mcp", {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
	assert.equal(authenticateMcpRequest(as("token-grok"), env), "grok");
	assert.equal(authenticateMcpRequest(as("token-muse"), env), "muse");
	assert.equal(authenticateMcpRequest(as("token-wrong"), env), null);
	assert.equal(authenticateMcpRequest(as(), env), null);
	// No tokens configured at all -> nobody is authenticated.
	assert.equal(authenticateMcpRequest(as("token-grok"), {}), null);
});
