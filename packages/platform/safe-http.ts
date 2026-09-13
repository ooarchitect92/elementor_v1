import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export class SafeHttpError extends Error {
  readonly code: string;
  readonly requestMayHaveBeenSent: boolean;

  constructor(code: string, requestMayHaveBeenSent = false) {
    super(code);
    this.name = "SafeHttpError";
    this.code = code;
    this.requestMayHaveBeenSent = requestMayHaveBeenSent;
  }
}

export interface SafeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface SafeHttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

function publicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function publicIpv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] || "";
  if (value.startsWith("::ffff:")) return publicIpv4(value.slice(7));
  // Restrict outbound delivery to globally routable IPv6 unicast (2000::/3).
  return /^[23][0-9a-f]{0,3}:/.test(value);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

function validateUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new SafeHttpError("OUTBOUND_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new SafeHttpError("OUTBOUND_URL_FORBIDDEN");
  }
  if (url.port && url.port !== "443") throw new SafeHttpError("OUTBOUND_PORT_FORBIDDEN");
  if (!url.hostname || url.hostname.length > 253 || url.hostname.endsWith(".local")) {
    throw new SafeHttpError("OUTBOUND_HOST_FORBIDDEN");
  }
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new SafeHttpError("OUTBOUND_ADDRESS_FORBIDDEN");
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  let records: Awaited<ReturnType<typeof lookup>>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SafeHttpError("OUTBOUND_DNS_FAILED");
  }
  const publicRecords = records.filter((record) => isPublicAddress(record.address));
  if (publicRecords.length === 0 || publicRecords.length !== records.length) {
    throw new SafeHttpError("OUTBOUND_ADDRESS_FORBIDDEN");
  }
  const selected = publicRecords[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new SafeHttpError("OUTBOUND_DNS_FAILED");
  return { address: selected.address, family: selected.family };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, code: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) throw new SafeHttpError(code);
  return selected;
}

function safeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || /[\r\n]/.test(value) || value.length > 8_192) {
      throw new SafeHttpError("OUTBOUND_HEADER_INVALID");
    }
    output[name] = value;
  }
  return output;
}

export async function safeHttpsRequest(input: string, options: SafeHttpRequestOptions = {}): Promise<SafeHttpResponse> {
  const url = validateUrl(input);
  const pinned = await resolvePublicAddress(url.hostname);
  const timeoutMs = boundedInteger(options.timeoutMs, 10_000, 250, 60_000, "OUTBOUND_TIMEOUT_INVALID");
  const maxBytes = boundedInteger(options.maxBytes, 512 * 1024, 1_024, 8 * 1024 * 1024, "OUTBOUND_LIMIT_INVALID");
  const body = options.body === undefined ? undefined : Buffer.from(options.body, "utf8");
  if (body && body.length > 2 * 1024 * 1024) throw new SafeHttpError("OUTBOUND_REQUEST_TOO_LARGE");
  const headers = safeHeaders(options.headers);
  if (body && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(body.length);
  }

  return new Promise<SafeHttpResponse>((resolve, reject) => {
    let requestMayHaveBeenSent = false;
    let settled = false;
    const fail = (error: unknown, code = "OUTBOUND_REQUEST_FAILED") => {
      if (settled) return;
      settled = true;
      if (error instanceof SafeHttpError) reject(error);
      else reject(new SafeHttpError(code, requestMayHaveBeenSent));
    };

    const request = httpsRequest({
      protocol: "https:",
      hostname: url.hostname,
      port: 443,
      method: options.method || (body ? "POST" : "GET"),
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: url.host },
      servername: url.hostname,
      rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (response) => {
      requestMayHaveBeenSent = true;
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.resume();
        fail(new SafeHttpError("OUTBOUND_REDIRECT_FORBIDDEN", true));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += value.length;
        if (size > maxBytes) {
          response.destroy(new SafeHttpError("OUTBOUND_RESPONSE_TOO_LARGE", true));
          return;
        }
        chunks.push(value);
      });
      response.on("error", (error) => fail(error));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) responseHeaders[name.toLowerCase()] = value.join(",");
          else if (value !== undefined) responseHeaders[name.toLowerCase()] = String(value);
        }
        resolve({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
      });
    });

    request.setTimeout(timeoutMs, () => request.destroy(new SafeHttpError("OUTBOUND_TIMEOUT", requestMayHaveBeenSent)));
    request.on("socket", (socket) => {
      socket.once("connect", () => { requestMayHaveBeenSent = Boolean(body); });
      socket.once("secureConnect", () => { requestMayHaveBeenSent = Boolean(body); });
    });
    request.on("error", (error) => fail(error));

    const abort = () => request.destroy(new SafeHttpError("OUTBOUND_ABORTED", requestMayHaveBeenSent));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    request.once("close", () => options.signal?.removeEventListener("abort", abort));
    if (body) {
      requestMayHaveBeenSent = true;
      request.write(body);
    }
    request.end();
  });
}
