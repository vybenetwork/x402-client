// Locks the public surface. These tests don't exercise behavior — they
// ensure the exported names + shapes don't accidentally change between
// releases.

import { describe, it, expect } from "vitest";
import * as sdk from "../src/index.js";

describe("public surface", () => {
  it("exports VybeClient and loadKeypair", () => {
    expect(typeof sdk.VybeClient).toBe("function");
    expect(typeof sdk.loadKeypair).toBe("function");
  });

  it("exports the typed errors", () => {
    expect(typeof sdk.VybeError).toBe("function");
    expect(typeof sdk.NetworkError).toBe("function");
    expect(typeof sdk.PaymentRequiredError).toBe("function");
    expect(typeof sdk.ApiError).toBe("function");
    expect(typeof sdk.ServiceUnavailableError).toBe("function");
    expect(typeof sdk.InsufficientCreditsError).toBe("function");
    expect(typeof sdk.BudgetExceededError).toBe("function");
  });

  it("error instances carry typed context", () => {
    const e = new sdk.PaymentRequiredError("test", 0.005, "TestPayer", "solana:test");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(sdk.VybeError);
    expect(e.amountUsd).toBe(0.005);
    expect(e.payTo).toBe("TestPayer");
  });
});
