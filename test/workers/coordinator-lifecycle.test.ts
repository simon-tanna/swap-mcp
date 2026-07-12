/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as schema from "../../src/db/schema";
import { swaps } from "../../src/db/schema";
import type { SwapCoordinator } from "../../src/coordinator/SwapCoordinator";
import { createTransactionsRepository } from "../../src/repository/transactions";
import {
  ethToUsdcInput,
  fakeSigner,
  makeDeps as makeDepsWithRepo,
  TX_HASH,
} from "./helpers/coordinatorFakes";
import type { ViemSigner } from "../../src/engine/viemSigner";
import type { SwapServiceDeps } from "../../src/services/swapService";

const db = drizzle(env.DB, { schema });
const repo = createTransactionsRepository(db);

/** Assemble injectable deps from fakes plus this file's REAL repository, so D1 is genuinely written. */
function makeDeps(signer: ViemSigner): SwapServiceDeps {
  return makeDepsWithRepo(signer, repo);
}

beforeEach(async () => {
  await db.delete(swaps);
});

describe("SwapCoordinator lifecycle", () => {
  test("executeSwap RPC drives pending→submitted→confirmed in D1", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("confirmed");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(fakeSigner());
        return instance.executeSwap(params);
      },
    );

    expect(result.status).toBe("confirmed");
    expect(result.result).toBe("ok");
    expect(result.txHash).toBe(TX_HASH);
    expect(result.transactionId).toBeDefined();

    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    expect(row!.status).toBe("confirmed");
    expect(row!.quotedAmountOut).toBe("999000000");
    expect(row!.actualAmountOut).toBe("999000000");
    expect(row!.gasUsed).toBe("21000");
    expect(row!.submittedAt).toBeGreaterThan(0);
    expect(row!.settledAt).toBeGreaterThan(0);
  });

  test("every transition is written eagerly before the call returns", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("eager");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    // The fake signer's waitForReceipt asserts, via a direct D1 read, that the
    // row is ALREADY `submitted` with the tx hash before the receipt resolves —
    // proving markSubmitted was written eagerly, before the receipt wait.
    let observedSubmitted = false;
    const signer = fakeSigner({
      async waitForReceipt(hash) {
        const rows = await db.query.swaps.findMany({
          where: eq(swaps.txHash, hash),
        });
        const submitted = rows.find((r) => r.status === "submitted");
        observedSubmitted =
          submitted !== undefined && submitted.txHash === hash;
        return { kind: "success", gasUsed: 21000n };
      },
    });

    const result = await runInDurableObject(
      stub,
      async (instance: SwapCoordinator) => {
        instance.deps = makeDeps(signer);
        return instance.executeSwap(params);
      },
    );

    expect(observedSubmitted).toBe(true);
    expect(result.status).toBe("confirmed");
  });

  test("deps default to env-built clients but are injectable for tests", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("lazy-default");
    const stub = env.SWAP_COORDINATOR.get(id);

    await runInDurableObject(stub, async (instance: SwapCoordinator) => {
      // Without injection, accessing deps lazily constructs real clients from env
      // via the secret accessors — never storing raw key material as a field.
      const deps = instance.deps;
      expect(deps.tradingApi).toBeDefined();
      expect(deps.signer).toBeDefined();
      expect(deps.repo).toBeDefined();

      // No key material is retained by OUR design: the lazily-built deps and any
      // coordinator-added instance state serialize without the raw key/rpc-url
      // (accessor closures hide them; the signer exposes only its address). The
      // platform's `this.env` is excluded — it is the runtime-provided binding
      // object, not something the coordinator stores.
      const snapshot = JSON.stringify({ deps, signer: deps.signer });
      expect(snapshot).not.toContain(env.SWAP_PRIVATE_KEY);
      expect(snapshot).not.toContain(env.ETH_RPC_URL);
      expect((deps.signer as { address: string }).address).toBe(
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      );
    });
  });

  test("a thrown error embedding secrets leaks into neither D1 columns nor coordinator logs", async () => {
    const id = env.SWAP_COORDINATOR.idFromName("leak-channels");
    const stub = env.SWAP_COORDINATOR.get(id);
    const params = ethToUsdcInput();

    // Reach the real secret values so the fake can embed them in a thrown error,
    // then assert neither D1 nor the coordinator's logs echo them back.
    const rpcUrl = env.ETH_RPC_URL;
    const privateKey = env.SWAP_PRIVATE_KEY;
    const secretMessage = `sendTransaction failed for ${rpcUrl} key=${privateKey}`;

    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    const signer = fakeSigner({
      async sendTransaction() {
        throw new Error(secretMessage);
      },
    });

    let result;
    try {
      result = await runInDurableObject(
        stub,
        async (instance: SwapCoordinator) => {
          instance.deps = makeDeps(signer);
          return instance.executeSwap(params);
        },
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    // The sendTransaction throw is pre-broadcast, so the row closes `failed`
    // carrying only an allowlisted errorCode — never the raw secret-bearing text.
    expect(result.status).toBe("failed");
    const row = await db.query.swaps.findFirst({
      where: eq(swaps.id, result.transactionId),
    });
    expect(row).toBeDefined();
    for (const col of Object.values(row!)) {
      const s = String(col);
      expect(s).not.toContain(rpcUrl);
      expect(s).not.toContain(privateKey);
    }

    // Every captured coordinator log call's serialized output is secret-free.
    const captured = [...logSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of captured) {
      const serialized = call.map((a) => String(a)).join(" ");
      expect(serialized).not.toContain(rpcUrl);
      expect(serialized).not.toContain(privateKey);
    }
  });
});
