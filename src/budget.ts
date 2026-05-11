// Cumulative-spend tracker. Owned by VybeClient.
//
// Reservation-based to avoid a race in concurrent paidRequest calls. The
// previous two-phase API (check() then charge()) had a window between the
// two: caller A could check() and pass, await, and before A's charge()
// caller B could also check() against the still-unupdated `spent`. Both
// would proceed and both would charge, exceeding the cap.
//
// reserve() commits the spend up front; commit() adjusts to the actual
// billed amount once the call settles; refund() rolls back when the call
// fails without billing.

import { BudgetExceededError } from "./errors.js";

export interface BudgetState {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
}

function assertValidAmount(amountUsd: number, where: string): void {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new TypeError(
      `BudgetTracker.${where}: amount must be a finite non-negative number, got ${amountUsd}`,
    );
  }
}

export class BudgetTracker {
  private spent = 0;
  constructor(
    private readonly cap: number,
    private readonly mode: "reject" | "warn" = "reject",
  ) {
    if (!Number.isFinite(cap) || cap < 0) {
      throw new TypeError(`BudgetTracker: cap must be a finite non-negative number, got ${cap}`);
    }
  }

  /**
   * Reserve `amountUsd` against the cap, atomically incrementing `spent`.
   * Throws BudgetExceededError if the reservation would push spend over
   * the cap in "reject" mode. In "warn" mode, logs and reserves anyway.
   * Returns the reserved amount so callers can pair it with commit/refund.
   */
  reserve(amountUsd: number): number {
    assertValidAmount(amountUsd, "reserve");
    if (this.spent + amountUsd > this.cap) {
      if (this.mode === "warn") {
        // eslint-disable-next-line no-console
        console.warn(
          `[vybe] budget warning: $${amountUsd.toFixed(3)} would push spend to $${(this.spent + amountUsd).toFixed(3)}, over cap of $${this.cap.toFixed(3)}`,
        );
        this.spent += amountUsd;
        return amountUsd;
      }
      throw new BudgetExceededError(amountUsd, this.cap, this.spent);
    }
    this.spent += amountUsd;
    return amountUsd;
  }

  /**
   * Adjust a previous reservation to the actual amount billed. Useful when
   * the call's predicted price diverges from the API's actual receipt.
   *
   * If `actualUsd > reservedUsd` and the adjustment pushes spend over the
   * cap, the on-chain charge has already happened — we can't undo it.
   * Log a warning so the caller knows the cap was breached; subsequent
   * reserve() calls will then reject normally on the inflated spend.
   */
  commit(reservedUsd: number, actualUsd: number): void {
    assertValidAmount(reservedUsd, "commit");
    assertValidAmount(actualUsd, "commit");
    const wasUnderCap = this.spent <= this.cap;
    this.spent += (actualUsd - reservedUsd);
    if (actualUsd > reservedUsd && wasUnderCap && this.spent > this.cap) {
      // eslint-disable-next-line no-console
      console.warn(
        `[vybe] receipt amount $${actualUsd.toFixed(3)} exceeded reserved $${reservedUsd.toFixed(3)}; spend now $${this.spent.toFixed(3)} > cap $${this.cap.toFixed(3)} (cap breached, future calls will reject)`,
      );
    }
  }

  /**
   * Roll back a reservation when the call failed without billing. Clamps
   * `spent` at 0 — a buggy double-refund (or refund without a matching
   * reserve) would otherwise drive spend negative, masking the bug
   * silently because state() already clamps `remainingUsd` at 0.
   */
  refund(reservedUsd: number): void {
    assertValidAmount(reservedUsd, "refund");
    this.spent = Math.max(0, this.spent - reservedUsd);
  }

  state(): BudgetState {
    return {
      spentUsd: this.spent,
      capUsd: this.cap,
      remainingUsd: Math.max(0, this.cap - this.spent),
    };
  }
}

export { BudgetExceededError };
