import { describe, expect, test } from "vitest";
import {
  MAINNET_CHAIN_ID,
  NATIVE_ETH_SENTINEL,
  PERMIT2_ADDRESS,
  UNIVERSAL_ROUTER_ADDRESS,
  USDC_ADDRESS,
  WETH9_ADDRESS,
} from "../../src/engine/constants";

describe("constants", () => {
  test("each embedded mainnet address equals its known-good checksummed value", () => {
    expect(USDC_ADDRESS).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(WETH9_ADDRESS).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(UNIVERSAL_ROUTER_ADDRESS).toBe(
      "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
    );
    expect(PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
    expect(NATIVE_ETH_SENTINEL).toBe(
      "0x0000000000000000000000000000000000000000",
    );
    expect(MAINNET_CHAIN_ID).toBe("1");
  });
});
