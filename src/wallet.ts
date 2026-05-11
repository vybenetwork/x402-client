// Wallet loading. Accepts the two formats users actually have on hand:
//   - base58: what most Solana wallets export ("Show / Export Private
//     Key" — Phantom, Solflare, Backpack, etc). The string includes
//     both the 32-byte secret and the 32-byte public, base58-encoded.
//   - base64: what `solana-keygen` JSON files convert to with a quick
//     `cat key.json | base64` pipe.
//
// The format is auto-detected from the string contents — base58
// excludes `0`, `O`, `I`, `l`, `+`, `/`, `=`, so any of those chars
// means base64. Strings that match both alphabets are tried as base58
// first (the more common user-facing source today); on a length
// mismatch we fall through to base64.

import { createKeyPairSignerFromBytes, getBase58Encoder, type KeyPairSigner } from "@solana/kit";
import type { Wallet } from "./types.js";

const KEYPAIR_BYTES = 64;

const BASE64_CHARSET = /^[A-Za-z0-9+/]*={0,2}$/;
// Base58 (Bitcoin alphabet, used by Solana): all of base64 minus the
// confusable characters 0/O/I/l plus the symbol-free chars +/= absent.
const BASE58_CHARSET = /^[1-9A-HJ-NP-Za-km-z]+$/;
// If a string contains ANY of these, it can't be base58 — must be base64.
const BASE64_DISTINGUISHING = /[0OIl+/=]/;

function decodeBase64(s: string): Uint8Array {
  // Pre-validate: Buffer.from("...", "base64") silently returns garbage on
  // invalid input instead of throwing, so a syntactic check is the only
  // way to fail fast on bad input. atob in browsers does throw on invalid
  // chars, but we still pre-validate for a consistent error message.
  if (!BASE64_CHARSET.test(s)) {
    throw new TypeError("loadKeypair: input is not valid base64");
  }
  if (s.length % 4 !== 0) {
    throw new TypeError("loadKeypair: base64 input has invalid length");
  }

  let bytes: Uint8Array;
  if (typeof Buffer !== "undefined") {
    bytes = Uint8Array.from(Buffer.from(s, "base64"));
  } else if (typeof atob === "function") {
    const binary = atob(s);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    throw new Error("loadKeypair: no base64 decoder available in this runtime");
  }
  return bytes;
}

function decodeBase58(s: string): Uint8Array {
  if (!BASE58_CHARSET.test(s)) {
    throw new TypeError("loadKeypair: input is not valid base58");
  }
  // @solana/kit ships a base58 codec; reusing it avoids a separate
  // bs58 dependency and matches whatever Solana itself uses.
  return getBase58Encoder().encode(s) as Uint8Array;
}

/**
 * Decode the input as a 64-byte Solana keypair. Auto-detects base58 vs
 * base64. Module-private — callers go through `loadKeypair` for the
 * full Wallet construction path; if a future caller needs the raw
 * detection logic we can expose this then.
 */
function decodeKeypairBytes(s: string): Uint8Array {
  // Distinguishing chars give us a fast-path: if the string contains
  // anything that base58 forbids, it can only be base64.
  if (BASE64_DISTINGUISHING.test(s)) {
    return decodeBase64(s);
  }
  // Could be either alphabet (alphanumerics minus the confusables are
  // a subset of base64 too). Try base58 first — it's the more common
  // user-facing format (Phantom export). If decoding succeeds AND
  // produces 64 bytes, use it. Otherwise fall through to base64.
  if (BASE58_CHARSET.test(s)) {
    try {
      const b58 = decodeBase58(s);
      if (b58.length === KEYPAIR_BYTES) return b58;
    } catch {
      // Fall through to base64.
    }
  }
  return decodeBase64(s);
}

// Internal signer registry. Wallet objects expose only their public address;
// the underlying KeyPairSigner is held in this module-private WeakMap so
// callers can't mutate it. SDK code that needs to sign uses getSigner().
const signers = new WeakMap<Wallet, KeyPairSigner>();

export function getSigner(wallet: Wallet): KeyPairSigner {
  const s = signers.get(wallet);
  if (!s) {
    // TypeError because the structural Wallet type is satisfied at compile
    // time but the runtime contract (constructed by loadKeypair) wasn't.
    throw new TypeError("wallet was not constructed by loadKeypair (no signer registered)");
  }
  return s;
}

async function fromBytes(bytes: Uint8Array): Promise<Wallet> {
  if (bytes.length !== KEYPAIR_BYTES) {
    throw new TypeError(
      `loadKeypair: expected a ${KEYPAIR_BYTES}-byte keypair (32-byte private + 32-byte public), got ${bytes.length} bytes`,
    );
  }
  const signer: KeyPairSigner = await createKeyPairSignerFromBytes(bytes);
  const wallet: Wallet = Object.freeze({ address: signer.address as string });
  signers.set(wallet, signer);
  return wallet;
}

interface LoadKeypair {
  /**
   * Load a keypair from an encoded 64-byte secret. Auto-detects the
   * format:
   *
   * - **base58** — what most Solana wallets export (Phantom, Solflare,
   *   Backpack, etc — the "Show / Export Private Key" UI). Paste it
   *   directly: no conversion needed.
   * - **base64** — what `solana-keygen` JSON files become with a
   *   quick `cat key.json | base64` pipe.
   *
   * Detection is content-based: strings containing any of `0OIl+/=`
   * are treated as base64 (those chars are forbidden in base58); any
   * other string is tried as base58 first, then base64. Throws on
   * malformed input or a non-64-byte payload.
   *
   * **Use a dedicated wallet** for the API. The full keypair is held
   * in process memory and signs USDC transfers per call (or per
   * session); reusing a wallet that's also doing trading or other
   * activity creates fragile bookkeeping and accidental conflicts.
   */
  (encoded: string): Promise<Wallet>;

  /**
   * Node-only: load a keypair from a JSON file (the format `solana-keygen
   * new` produces — array of 64 bytes). Throws in browser builds.
   */
  fromFile(path: string): Promise<Wallet>;
}

export const loadKeypair = (async (encoded: string): Promise<Wallet> => {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new TypeError("loadKeypair: expected non-empty base58 or base64 string");
  }
  const bytes = decodeKeypairBytes(encoded);
  return fromBytes(bytes);
}) as LoadKeypair;

function isByteValue(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;
}

loadKeypair.fromFile = async (path: string): Promise<Wallet> => {
  // Lazy import — fs is not available in browser builds.
  let fs: typeof import("node:fs/promises");
  try {
    fs = await import("node:fs/promises");
  } catch {
    throw new Error("loadKeypair.fromFile is only available in Node");
  }
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    throw new TypeError(
      `loadKeypair.fromFile: failed to read ${path} (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch (err) {
    throw new TypeError(
      `loadKeypair.fromFile: file ${path} is not valid JSON (${err instanceof Error ? err.message : "unknown"})`,
    );
  }
  if (!Array.isArray(arr) || arr.length !== KEYPAIR_BYTES) {
    throw new TypeError(
      `loadKeypair.fromFile: expected a JSON array of ${KEYPAIR_BYTES} byte values (solana-keygen format)`,
    );
  }
  for (let i = 0; i < arr.length; i++) {
    if (!isByteValue(arr[i])) {
      throw new TypeError(
        `loadKeypair.fromFile: byte ${i} is not an integer in [0, 255] (got ${JSON.stringify(arr[i])})`,
      );
    }
  }
  return fromBytes(Uint8Array.from(arr as number[]));
};
