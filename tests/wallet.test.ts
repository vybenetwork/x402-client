import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { getBase58Decoder } from "@solana/kit";
import { loadKeypair } from "../src/index.js";

// Generate a fresh ed25519 keypair per test run rather than committing
// secret material into source. Solana's keypair format is the raw 32-byte
// seed concatenated with the raw 32-byte public key. Node's pkcs8/spki
// DER outputs put those raw bytes in the trailing 32 bytes of each.
function generateTestKeypairBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const seed = privateKey.subarray(privateKey.length - 32);
  const pub = publicKey.subarray(publicKey.length - 32);
  return Uint8Array.from(Buffer.concat([seed, pub]));
}

let testKeypairBytes: Uint8Array;
let testKeypairBase64: string;
let testKeypairBase58: string;
let tmpFile: string;

beforeAll(async () => {
  testKeypairBytes = generateTestKeypairBytes();
  testKeypairBase64 = Buffer.from(testKeypairBytes).toString("base64");
  testKeypairBase58 = getBase58Decoder().decode(testKeypairBytes);
  tmpFile = join(tmpdir(), `vybe-sdk-test-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(tmpFile, JSON.stringify(Array.from(testKeypairBytes)));
});

afterAll(async () => {
  try { await fs.unlink(tmpFile); } catch { /* ignore */ }
});

describe("loadKeypair (base64)", () => {
  it("returns a Wallet with a non-empty Solana address", async () => {
    const w = await loadKeypair(testKeypairBase64);
    expect(typeof w.address).toBe("string");
    expect(w.address.length).toBeGreaterThan(30); // base58 Solana address
  });

  it("throws on empty input", async () => {
    await expect(loadKeypair("")).rejects.toThrow(/non-empty base58 or base64/);
  });

  it("throws on non-string input", async () => {
    // @ts-expect-error testing runtime guard
    await expect(loadKeypair(42)).rejects.toThrow(/non-empty base58 or base64/);
  });

  it("throws on a string that is not valid base64", async () => {
    // "$" is not in the base64 charset
    await expect(loadKeypair("not$base64$here")).rejects.toThrow(/not valid base64/);
  });

  it("throws when base64 length isn't a multiple of 4", async () => {
    await expect(loadKeypair("abc")).rejects.toThrow(/invalid length/);
  });

  it("throws on the wrong byte length", async () => {
    const tooShort = Buffer.alloc(32).toString("base64");
    await expect(loadKeypair(tooShort)).rejects.toThrow(/expected a 64-byte keypair/);
  });

  it("returns a frozen object — wallet is opaque", async () => {
    const w = await loadKeypair(testKeypairBase64);
    expect(Object.isFrozen(w)).toBe(true);
  });
});

describe("loadKeypair (base58)", () => {
  it("loads a Phantom-style base58 export", async () => {
    const w = await loadKeypair(testKeypairBase58);
    expect(typeof w.address).toBe("string");
    expect(w.address.length).toBeGreaterThan(30);
  });

  it("matches the address loaded from the same key via base64", async () => {
    const fromB58 = await loadKeypair(testKeypairBase58);
    const fromB64 = await loadKeypair(testKeypairBase64);
    expect(fromB58.address).toBe(fromB64.address);
  });

  it("rejects a base58 string that decodes to the wrong byte length", async () => {
    // 32-byte buffer (random) → base58 ≈ 43–44 chars. No 0/O/I/l/+/=
    // means base58 is tried first; the 32-byte payload doesn't match
    // the 64-byte keypair size so it falls through to base64. The
    // base64 path then either trips the multiple-of-4 string-length
    // check OR (when length happens to be 4-aligned) decodes
    // successfully but produces a non-64-byte payload — caught by
    // fromBytes(). The regex covers all three failure modes.
    const seed32 = generateTestKeypairBytes().subarray(0, 32);
    const tooShortB58 = getBase58Decoder().decode(seed32);
    await expect(loadKeypair(tooShortB58)).rejects.toThrow(/64-byte keypair|invalid length|not valid/);
  });

  it("decoder picks base64 when distinguishing chars are present", async () => {
    // Strings containing any of 0/O/I/l/+/= can't be base58. The
    // detector must NOT try base58 first — that would fail and
    // potentially eat the underlying base64 error message.
    // Use a 10-byte input so the base64 output gets `==` padding.
    const b64WithPadding = Buffer.alloc(10).toString("base64");
    expect(b64WithPadding).toContain("=");
    await expect(loadKeypair(b64WithPadding)).rejects.toThrow(/64-byte keypair/);
  });
});

describe("loadKeypair.fromFile", () => {
  it("loads a solana-keygen-format JSON file", async () => {
    const w = await loadKeypair.fromFile(tmpFile);
    expect(typeof w.address).toBe("string");
    expect(w.address.length).toBeGreaterThan(30);
  });

  it("matches the address loaded from the same key via base64", async () => {
    const fromB64 = await loadKeypair(testKeypairBase64);
    const fromJson = await loadKeypair.fromFile(tmpFile);
    expect(fromJson.address).toBe(fromB64.address);
  });

  it("throws on non-existent file", async () => {
    await expect(loadKeypair.fromFile("/no/such/file.json")).rejects.toThrow();
  });

  it("throws when the file isn't JSON", async () => {
    const bad = join(tmpdir(), `vybe-sdk-bad-${Date.now()}.json`);
    await fs.writeFile(bad, "not json");
    try {
      await expect(loadKeypair.fromFile(bad)).rejects.toThrow(/not valid JSON/);
    } finally {
      await fs.unlink(bad);
    }
  });

  it("throws when JSON is the wrong shape", async () => {
    const bad = join(tmpdir(), `vybe-sdk-shape-${Date.now()}.json`);
    await fs.writeFile(bad, JSON.stringify([1, 2, 3]));
    try {
      await expect(loadKeypair.fromFile(bad)).rejects.toThrow(/array of 64 byte values/);
    } finally {
      await fs.unlink(bad);
    }
  });

  it("throws when JSON contains out-of-range byte values", async () => {
    const bad = join(tmpdir(), `vybe-sdk-vals-${Date.now()}.json`);
    const arr = new Array(64).fill(0);
    arr[5] = 256;
    await fs.writeFile(bad, JSON.stringify(arr));
    try {
      await expect(loadKeypair.fromFile(bad)).rejects.toThrow(/byte 5 is not an integer in \[0, 255\]/);
    } finally {
      await fs.unlink(bad);
    }
  });

  it("rejects float byte values", async () => {
    const bad = join(tmpdir(), `vybe-sdk-float-${Date.now()}.json`);
    const arr = new Array(64).fill(0);
    arr[10] = 0.5;
    await fs.writeFile(bad, JSON.stringify(arr));
    try {
      await expect(loadKeypair.fromFile(bad)).rejects.toThrow(/byte 10 is not an integer/);
    } finally {
      await fs.unlink(bad);
    }
  });
});
