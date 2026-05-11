// Test-only helper for generating fresh ed25519 keypairs in test fixtures.
// Shared across test files so the DER-encoding assumption lives in one place.

import { generateKeyPairSync } from "node:crypto";

/**
 * Generate a fresh ed25519 keypair and return it as a base64-encoded
 * 64-byte secret (32-byte seed || 32-byte public key) — the format
 * `loadKeypair` expects. ed25519's PKCS8 / SPKI DER encodings put the
 * raw 32-byte values in the trailing 32 bytes of each output.
 */
export function generateTestKeypairBase64(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const seed = privateKey.subarray(privateKey.length - 32);
  const pub = publicKey.subarray(publicKey.length - 32);
  return Buffer.concat([seed, pub]).toString("base64");
}
