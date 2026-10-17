import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

// Outbound HTTP to external providers (GitHub, Jira Cloud). Pure apart from the network calls it is handed, so tests can
// inject fake `fetch` and DNS implementations. Rules, enforced on every request and every redirect hop:
//   * https only, default port, no credentials in the URL;
//   * the host must pass the caller's allow-list (a fixed provider host, or a validated *.atlassian.net site);
//   * for caller-influenced hosts, every resolved address must be public (no loopback, private, link-local, ...);
//   * redirects are followed only to an explicitly allowed host, and Authorization is never sent to another host;
//   * responses are read with a byte cap and a timeout; bodies over the cap are aborted, not truncated.
// Errors carry a provider-neutral code and a safe message: never a token, header or response body.

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type LookupLike = (hostname: string) => Promise<{ address: string; family: number }[]>;

export type ProviderErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "conflict"
  | "invalid_request"
  | "too_large"
  | "timeout"
  | "network"
  | "bad_response";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type ProviderRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  allowHost: (hostname: string) => boolean;
  allowRedirectHost?: (hostname: string) => boolean;
  maxRedirects?: number;
  maxBytes: number;
  timeoutMs: number;
  checkDns?: boolean;
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
};

export type ProviderResponse = { status: number; headers: Headers; body: Buffer };

const defaultLookup: LookupLike = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && ip.split(".")[2] === "0"))) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

// True for addresses an outbound provider request must never reach.
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Private(address);
  if (kind !== 6) return true;
  const a = address.toLowerCase();
  if (a === "::" || a === "::1") return true;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
}

function checkUrl(raw: string, allow: (hostname: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("invalid_request", "Invalid provider URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port !== "" && url.port !== "443")) {
    throw new ProviderError("invalid_request", "Only https provider URLs on the default port are allowed.");
  }
  if (!allow(url.hostname)) throw new ProviderError("invalid_request", "This provider host is not allowed.");
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderError("too_large", "The provider response is larger than the allowed size.");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError("too_large", "The provider response is larger than the allowed size.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function providerRequest(request: ProviderRequest): Promise<ProviderResponse> {
  const fetchImpl = request.fetchImpl ?? (fetch as FetchLike);
  const lookupImpl = request.lookupImpl ?? defaultLookup;
  const signal = AbortSignal.timeout(request.timeoutMs);
  let url = checkUrl(request.url, request.allowHost);
  let headers = { ...(request.headers ?? {}) };
  let redirects = request.maxRedirects ?? 0;

  for (;;) {
    if (request.checkDns) {
      let addresses: { address: string }[];
      try {
        addresses = await lookupImpl(url.hostname);
      } catch {
        throw new ProviderError("network", "The provider host could not be resolved.");
      }
      if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
        throw new ProviderError("invalid_request", "The provider host resolves to a non-public address.");
      }
    }

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: request.method ?? "GET",
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ProviderError("timeout", "The provider did not respond in time.");
      }
      throw new ProviderError("network", "The provider could not be reached.");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirects <= 0 || !request.allowRedirectHost) {
        throw new ProviderError("bad_response", "The provider answered with an unexpected redirect.", response.status);
      }
      const next = checkUrl(new URL(location, url).toString(), request.allowRedirectHost);
      if (next.hostname !== url.hostname) {
        // Credentials never follow a redirect to another host.
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"));
      }
      url = next;
      redirects--;
      continue;
    }

    try {
      return { status: response.status, headers: response.headers, body: await readCapped(response, request.maxBytes) };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new ProviderError("timeout", "The provider did not respond in time.");
      }
      throw new ProviderError("network", "The provider connection was interrupted.");
    }
  }
}

export function parseJson<T>(response: ProviderResponse): T {
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new ProviderError("bad_response", "The provider returned an unreadable response.", response.status);
  }
}

// Seconds to wait, from Retry-After (seconds or HTTP date) or an epoch-seconds reset header.
export function retryAfterSeconds(headers: Headers, resetHeader?: string): number | undefined {
  const retry = headers.get("retry-after");
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
    const date = Date.parse(retry);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  if (resetHeader) {
    const reset = Number(headers.get(resetHeader));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  }
  return undefined;
}
