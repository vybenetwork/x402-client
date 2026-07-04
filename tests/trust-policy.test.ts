// Unit tests for the x402 payment trust policy. The policy is the
// security boundary that prevents the SDK from signing 402 challenges
// that don't match the discovered identity or that exceed the per-call
// USD cap.

import { describe, it, expect } from "vitest";
import { buildTrustPolicy } from "../src/http.js";
import { UntrustedPaymentError } from "../src/errors.js";
import type { ApiInfo } from "../src/types.js";

const INFO: ApiInfo = {
  network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  payTo: "CicjSgQ9rVUSihnS4hNFYCL8gy3fXDM243ofdZYMrdpr",
  defaultPriceUsd: 0.001,
  pricing: [],
};

function req(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: INFO.network,
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "1000", // 0.001 USDC in 6-decimal atomic
    payTo: INFO.payTo,
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

describe("buildTrustPolicy — accepts valid requirements", () => {
  it("passes a single requirement at the discovered payTo and network", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const reqs = [req()];
    expect(policy(2, reqs)).toEqual(reqs);
  });

  it("passes multiple requirements when all match", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const reqs = [req(), req({ amount: "5000" })];
    expect(policy(2, reqs)).toEqual(reqs);
  });

  it("passes the exact at-cap amount (≤, not <)", () => {
    const policy = buildTrustPolicy(INFO, 0.01);
    expect(() => policy(2, [req({ amount: "10000" })])).not.toThrow();
  });
});

describe("buildTrustPolicy — rejects payTo mismatch", () => {
  it("throws UntrustedPaymentError with reason=payTo_mismatch", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const evil = req({ payTo: "AttackerAddressXXXXXXXXXXXXXXXXXXXXXXXXXX" });
    try {
      policy(2, [evil]);
      throw new Error("policy should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UntrustedPaymentError);
      const err = e as UntrustedPaymentError;
      expect(err.reason).toBe("payTo_mismatch");
      expect(err.message).toContain("[VYBE_TRUST:payTo_mismatch]");
      expect(err.message).toContain("AttackerAddress");
      expect(err.message).toContain(INFO.payTo);
    }
  });

  it("rejects if any of multiple requirements has wrong payTo", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const reqs = [req(), req({ payTo: "BadAddrXXX" })];
    expect(() => policy(2, reqs)).toThrow(UntrustedPaymentError);
  });
});

describe("buildTrustPolicy — rejects network mismatch", () => {
  it("throws when network differs from discovery", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const wrongNet = req({ network: "ethereum:1" });
    try {
      policy(2, [wrongNet]);
      throw new Error("policy should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UntrustedPaymentError);
      expect((e as UntrustedPaymentError).reason).toBe("network_mismatch");
    }
  });
});

describe("buildTrustPolicy — rejects asset mismatch", () => {
  it("throws when the challenge asks for a non-USDC asset", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const wrongAsset = req({ asset: "So11111111111111111111111111111111111111112" });
    try {
      policy(2, [wrongAsset]);
      throw new Error("policy should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UntrustedPaymentError);
      const err = e as UntrustedPaymentError;
      expect(err.reason).toBe("asset_mismatch");
      expect(err.message).toContain("[VYBE_TRUST:asset_mismatch]");
      expect(err.message).toContain("So11111111111111111111111111111111111111112");
    }
  });
});

describe("buildTrustPolicy — rejects amount over per-call cap", () => {
  it("throws when amount in USD exceeds maxUsdPerCall", () => {
    // cap = $0.01 = 10000 atomic; demand 0.02 USDC = 20000 atomic
    const policy = buildTrustPolicy(INFO, 0.01);
    try {
      policy(2, [req({ amount: "20000" })]);
      throw new Error("policy should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UntrustedPaymentError);
      const err = e as UntrustedPaymentError;
      expect(err.reason).toBe("amount_exceeds_per_call_cap");
      expect(err.message).toMatch(/\$0\.0200/);
      expect(err.message).toMatch(/\$0\.0100/);
    }
  });

  it("rejects a huge amount that would overflow Number but is valid BigInt", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    const huge = req({ amount: "999999999999999999999" });
    expect(() => policy(2, [huge])).toThrow(UntrustedPaymentError);
  });

  it("rejects non-integer amount strings", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    // "1.5" is not a valid BigInt literal
    expect(() => policy(2, [req({ amount: "1.5" })])).toThrow(UntrustedPaymentError);
  });

  it("rejects garbage amount strings", () => {
    const policy = buildTrustPolicy(INFO, 0.1);
    expect(() => policy(2, [req({ amount: "drain-my-wallet" })])).toThrow(UntrustedPaymentError);
  });
});

describe("buildTrustPolicy — input validation", () => {
  it("throws if maxUsdPerCall is zero", () => {
    expect(() => buildTrustPolicy(INFO, 0)).toThrow(TypeError);
  });

  it("throws if maxUsdPerCall is negative", () => {
    expect(() => buildTrustPolicy(INFO, -1)).toThrow(TypeError);
  });

  it("throws if maxUsdPerCall is NaN", () => {
    expect(() => buildTrustPolicy(INFO, Number.NaN)).toThrow(TypeError);
  });

  it("throws if maxUsdPerCall is Infinity", () => {
    expect(() => buildTrustPolicy(INFO, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe("VybeClient — maxUsdPerCall option validation", () => {
  it("VybeClient constructor rejects bad maxUsdPerCall", async () => {
    const { VybeClient, loadKeypair } = await import("../src/index.js");
    const { generateTestKeypairBase64 } = await import("../src/internal/test-keypair.js");
    const wallet = await loadKeypair(generateTestKeypairBase64());
    expect(() => new VybeClient({ wallet, maxUsdPerCall: 0 })).toThrow(TypeError);
    expect(() => new VybeClient({ wallet, maxUsdPerCall: -0.001 })).toThrow(TypeError);
    expect(() => new VybeClient({ wallet, maxUsdPerCall: Number.NaN })).toThrow(TypeError);
  });

  it("VybeClient defaults maxUsdPerCall to 0.10", async () => {
    const { VybeClient, loadKeypair } = await import("../src/index.js");
    const { generateTestKeypairBase64 } = await import("../src/internal/test-keypair.js");
    const wallet = await loadKeypair(generateTestKeypairBase64());
    const client = new VybeClient({ wallet });
    expect(client.maxUsdPerCall).toBe(0.10);
  });
});
