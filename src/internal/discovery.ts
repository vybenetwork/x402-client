// API discovery — fetch GET / and parse into ApiInfo. Cached in http.ts;
// this module only handles the parsing.

import type { ApiInfo, NetworkId } from "../types.js";
import { NetworkError } from "../errors.js";

interface RawDiscovery {
  network: unknown;
  payTo: unknown;
  defaultPrice: unknown;
  pricing: unknown;
}

// Strict USD parser — must be a "$<number>" string with no trailing junk.
// `parseFloat("$0.001junk")` would silently return 0.001; `Number(...)`
// after a regex match rejects.
const USD_RE = /^\$?(-?(?:\d+(?:\.\d+)?|\.\d+))$/;

function parseUsd(s: unknown, field: string): number {
  if (typeof s !== "string") {
    throw new NetworkError(`API discovery field "${field}" was not a string: ${JSON.stringify(s)}`);
  }
  const trimmed = s.trim();
  const m = USD_RE.exec(trimmed);
  if (!m) {
    throw new NetworkError(`API discovery field "${field}" did not parse as USD: ${JSON.stringify(s)}`);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) {
    throw new NetworkError(`API discovery field "${field}" produced non-finite number: ${JSON.stringify(s)}`);
  }
  return n;
}

export async function discoverApi(apiUrl: string): Promise<ApiInfo> {
  // Build the URL via WHATWG URL so apiUrl with or without a trailing slash
  // both resolve to the same `/` path. String interpolation produced "//"
  // when apiUrl ended in "/", which some servers route differently.
  const discoveryUrl = new URL("/", apiUrl).toString();
  let res: Response;
  try {
    res = await fetch(discoveryUrl, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    throw new NetworkError(`could not reach API at ${apiUrl}`, err);
  }
  if (!res.ok) {
    throw new NetworkError(`API discovery returned status ${res.status}`);
  }
  let body: RawDiscovery;
  try {
    body = await res.json() as RawDiscovery;
  } catch (err) {
    throw new NetworkError(`API discovery returned non-JSON response`, err);
  }

  if (typeof body.network !== "string" || !body.network.includes(":")) {
    throw new NetworkError(`API discovery returned invalid network id: ${JSON.stringify(body.network)}`);
  }
  if (typeof body.payTo !== "string" || body.payTo.length === 0) {
    throw new NetworkError(`API discovery returned invalid payTo: ${JSON.stringify(body.payTo)}`);
  }
  if (!Array.isArray(body.pricing)) {
    throw new NetworkError(`API discovery returned invalid pricing array: ${JSON.stringify(body.pricing)}`);
  }
  const pricing = body.pricing.map((p, i) => {
    if (!p || typeof p !== "object") {
      throw new NetworkError(`API discovery pricing entry ${i} is not an object`);
    }
    const entry = p as Record<string, unknown>;
    if (typeof entry.match !== "string" || entry.match.length === 0) {
      throw new NetworkError(`API discovery pricing entry ${i} has invalid match: ${JSON.stringify(entry.match)}`);
    }
    return {
      match: entry.match,
      priceUsd: parseUsd(entry.price, `pricing[${i}].price`),
    };
  });

  return {
    network: body.network as NetworkId,
    payTo: body.payTo,
    defaultPriceUsd: parseUsd(body.defaultPrice, "defaultPrice"),
    pricing,
  };
}

/**
 * Predict the USD price for a path against the discovered pricing table.
 * Mirrors the API's segment-based matchPrice — split on /, exact-segment
 * equality. Used for budget pre-check before signing.
 */
export function predictPriceUsd(path: string, info: ApiInfo): number {
  // Strip query/hash so flag-style params can't trigger a route match.
  const pathname = (() => {
    try { return new URL(path, "http://local").pathname; }
    catch { return path.split(/[?#]/, 1)[0] ?? path; }
  })();
  const segments = pathname.split("/").filter(Boolean);
  for (const { match, priceUsd } of info.pricing) {
    if (segments.includes(match)) return priceUsd;
  }
  return info.defaultPriceUsd;
}
