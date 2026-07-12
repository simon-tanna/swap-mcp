import { z } from "zod";
import { AppError } from "./errors";

/** The only chain this worker serves (Ethereum mainnet); multi-chain is a non-goal. */
const CHAIN_ID = "1";

/** The sole host `TRADING_API_BASE_URL` may point at, so config cannot redirect swap traffic. */
const TRADING_API_HOST = "trade-api.gateway.uniswap.org";

/** Validated, fail-closed config; secrets are exposed only via lazy accessor methods. */
export interface ValidatedEnv {
  chainId: "1";
  canonicalMcpUri: string;
  tradingApiBaseUrl: string;
  allowedOrigins: string[];
  getSwapPrivateKey(): string;
  getAuthPassphrase(): string;
  getUniswapApiKey(): string;
  getEthRpcUrl(): string;
}

/** True when `value` is an https URL whose host is exactly the Uniswap Trading API host. */
function isAllowlistedTradingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === TRADING_API_HOST;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  SWAP_PRIVATE_KEY: z.string().min(1),
  AUTH_PASSPHRASE: z.string().min(1),
  UNISWAP_API_KEY: z.string().min(1),
  ETH_RPC_URL: z.string().min(1),
  CHAIN_ID: z.literal(CHAIN_ID),
  CANONICAL_MCP_URI: z.string().min(1),
  TRADING_API_BASE_URL: z.string().min(1).refine(isAllowlistedTradingUrl),
  ALLOWED_ORIGINS: z.string().min(1),
});

/** Parse and validate the raw bindings, throwing `AppError("internal", ...)` on any failure (fail-closed). */
export function validateEnv(env: CloudflareBindings): ValidatedEnv {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new AppError(
      "internal",
      "Invalid or missing environment configuration.",
    );
  }
  const data = parsed.data;

  const swapPrivateKey = data.SWAP_PRIVATE_KEY;
  const authPassphrase = data.AUTH_PASSPHRASE;
  const uniswapApiKey = data.UNISWAP_API_KEY;
  const ethRpcUrl = data.ETH_RPC_URL;

  return {
    chainId: data.CHAIN_ID,
    canonicalMcpUri: data.CANONICAL_MCP_URI,
    tradingApiBaseUrl: data.TRADING_API_BASE_URL,
    allowedOrigins: data.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    getSwapPrivateKey: () => swapPrivateKey,
    getAuthPassphrase: () => authPassphrase,
    getUniswapApiKey: () => uniswapApiKey,
    getEthRpcUrl: () => ethRpcUrl,
  };
}
