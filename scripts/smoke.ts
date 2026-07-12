// MANUAL SMOKE SCRIPT — never run by the automated test suite; hits real chain +
// real Trading API. Requires a deployed env + funded key. Run with:
//   pnpm smoke                 (quote + swap against the deployed REST API)
//   pnpm smoke -- --approve    (also offers the one-time USDC→router approval)
//
// This mirrors test/helpers/mintToken.ts (the real OAuth 2.1 + PKCE consent
// dance) but drives a DEPLOYED base URL over `fetch`, not the in-process worker.
// The one-time USDC approval mirrors docs/how-to/one-time-usdc-approval.md: the
// service NEVER auto-sends it, so this script only sends it behind BOTH the
// `--approve` flag AND an interactive confirmation prompt.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import {
  UNIVERSAL_ROUTER_ADDRESS,
  USDC_ADDRESS,
} from "../src/engine/constants";

/** ERC-20 fragment for the one-time approval the USDC→ETH direction requires. */
const ERC20_APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/** The consent form's allowed Origin — Claude's canonical redirect host. */
const SMOKE_ORIGIN = "https://claude.ai";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

/** The five env vars this script reads; the first two are always required. */
interface SmokeEnv {
  baseUrl: string;
  passphrase: string;
  uniswapApiKey?: string;
  ethRpcUrl?: string;
  swapPrivateKey?: string;
}

async function main(): Promise<void> {
  const wantsApprove = process.argv.slice(2).includes("--approve");
  const env = readEnv({ requireApprovalSecrets: wantsApprove });

  const base = env.baseUrl.replace(/\/+$/, "");
  const { accessToken } = await mintToken(base, env.passphrase);
  console.log("minted access token via real OAuth consent dance");

  const quote = await postJson(base, "/api/quote", accessToken, {
    direction: "ETH_TO_USDC",
    amountIn: "0.0001",
  });
  console.log("quote:", JSON.stringify(quote));

  const swap = await postJson(base, "/api/swap", accessToken, {
    direction: "ETH_TO_USDC",
    amountIn: "0.0001",
    expectedAmountOut: (quote as { quotedAmountOut?: string }).quotedAmountOut,
  });
  console.log("swap:", JSON.stringify(swap));

  const transactionId = (swap as { transactionId?: string }).transactionId;
  if (transactionId) {
    const row = await getJson(
      base,
      `/api/transactions/${transactionId}`,
      accessToken,
    );
    console.log("persisted row:", JSON.stringify(row));
  }

  await handleApproval(env, wantsApprove);
  console.log("smoke complete");
}

/** Read and validate the smoke env, failing fast with a clear message. */
function readEnv(opts: { requireApprovalSecrets: boolean }): SmokeEnv {
  const baseUrl = process.env.SWAP_MCP_BASE_URL;
  const passphrase = process.env.AUTH_PASSPHRASE;
  if (!baseUrl || !passphrase) {
    fail(
      "SWAP_MCP_BASE_URL and AUTH_PASSPHRASE are required (set them in your shell).",
    );
  }

  const swapPrivateKey = process.env.SWAP_PRIVATE_KEY;
  const ethRpcUrl = process.env.ETH_RPC_URL;
  if (opts.requireApprovalSecrets && (!swapPrivateKey || !ethRpcUrl)) {
    fail(
      "--approve requires SWAP_PRIVATE_KEY and ETH_RPC_URL to sign the approval tx.",
    );
  }

  return {
    baseUrl,
    passphrase,
    ...(process.env.UNISWAP_API_KEY !== undefined && {
      uniswapApiKey: process.env.UNISWAP_API_KEY,
    }),
    ...(ethRpcUrl !== undefined && { ethRpcUrl }),
    ...(swapPrivateKey !== undefined && { swapPrivateKey }),
  };
}

/**
 * Drive the deployed server's real OAuth 2.1 authorization-code + PKCE consent
 * flow over HTTP: open DCR → GET /authorize (scrape the CSRF token) → POST
 * /authorize (passphrase + allowed Origin, follow the 302) → exchange at /token.
 * Mirrors test/helpers/mintToken.ts against a real base URL.
 */
async function mintToken(
  base: string,
  passphrase: string,
): Promise<{ accessToken: string; clientId: string }> {
  const registerRes = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      client_name: "smoke-script-client",
    }),
  });
  if (registerRes.status !== 201 && registerRes.status !== 200) {
    fail(`DCR failed: ${registerRes.status} ${await registerRes.text()}`);
  }
  const clientId = ((await registerRes.json()) as { client_id: string })
    .client_id;

  const codeVerifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(codeVerifier),
      ),
    ),
  );
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  const authorizeQuery = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    resource: base,
    state,
    scope: "swap:read swap:write",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authorizeUrl = `${base}/authorize?${authorizeQuery.toString()}`;

  const consentRes = await fetch(authorizeUrl, {
    headers: { Origin: SMOKE_ORIGIN },
  });
  if (consentRes.status !== 200) {
    fail(
      `GET /authorize failed: ${consentRes.status} ${await consentRes.text()}`,
    );
  }
  const csrfToken = scrapeCsrfToken(await consentRes.text());

  const consentPostRes = await fetch(authorizeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Origin: SMOKE_ORIGIN,
    },
    body: new URLSearchParams({
      csrf_token: csrfToken,
      passphrase,
    }).toString(),
    redirect: "manual",
  });
  if (consentPostRes.status !== 302) {
    fail(
      `POST /authorize expected 302, got ${consentPostRes.status} ${await consentPostRes.text()}`,
    );
  }
  const location = consentPostRes.headers.get("Location");
  if (!location) {
    fail("POST /authorize 302 had no Location header");
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) {
    fail(`no authorization code in redirect: ${location}`);
  }

  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });
  if (tokenRes.status !== 200) {
    fail(`POST /token failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const accessToken = ((await tokenRes.json()) as { access_token: string })
    .access_token;
  if (!accessToken) {
    fail("token response had no access_token");
  }
  return { accessToken, clientId };
}

/**
 * Document, and only with `--approve` + an interactive confirmation actually
 * send, the one-time legacy ERC-20 approve granting the Universal Router an
 * allowance to move USDC (the USDC→ETH direction). The service never sends this.
 */
async function handleApproval(
  env: SmokeEnv,
  wantsApprove: boolean,
): Promise<void> {
  const maxAllowance = (1n << 256n) - 1n;
  console.log(
    `one-time USDC approval (USDC→ETH only): approve(${UNIVERSAL_ROUTER_ADDRESS}, MAX) on token ${USDC_ADDRESS}`,
  );

  if (!wantsApprove) {
    console.log(
      "not sending — pass --approve to be prompted before broadcasting this tx.",
    );
    return;
  }
  if (!env.swapPrivateKey || !env.ethRpcUrl) {
    fail("--approve requires SWAP_PRIVATE_KEY and ETH_RPC_URL.");
  }

  const account = privateKeyToAccount(env.swapPrivateKey as `0x${string}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `send approve() from ${account.address}? type "yes" to confirm: `,
  );
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") {
    console.log("approval cancelled by operator.");
    return;
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(env.ethRpcUrl),
  });
  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(env.ethRpcUrl),
  });
  const hash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [UNIVERSAL_ROUTER_ADDRESS, maxAllowance],
  });
  console.log(`approval submitted: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: hash as Hash,
  });
  console.log(`approval ${receipt.status} in block ${receipt.blockNumber}`);
}

/** Bearer-authenticated POST returning parsed JSON, or a fatal on non-2xx. */
async function postJson(
  base: string,
  path: string,
  token: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    fail(`POST ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Bearer-authenticated GET returning parsed JSON, or a fatal on non-2xx. */
async function getJson(
  base: string,
  path: string,
  token: string,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    fail(`GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Pull the single-use CSRF token out of the consent page's hidden input. */
function scrapeCsrfToken(html: string): string {
  const match = html.match(/name="csrf_token"\s+value="([^"]+)"/);
  if (!match) {
    fail("could not find csrf_token in consent HTML");
  }
  return match[1];
}

/** URL-safe base64 (no padding) of raw bytes, per RFC 7636 PKCE encoding. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return Buffer.from(binary, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Print a message and exit non-zero; never echoes secret material. */
function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

await main();
