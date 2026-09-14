import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { AppError } from "../../utils/app-error.js";

export interface PinnedJsonResponse<T = any> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224;
}

function privateIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateIpv4(mapped[1]) : false;
}

async function pinnedTarget(url: URL) {
  if (url.protocol !== "https:") {
    throw new AppError("WordPress connections require HTTPS", 400, "WORDPRESS_HTTPS_REQUIRED");
  }
  if (url.username || url.password) {
    throw new AppError("Credentials must not be embedded in the site URL", 400, "WORDPRESS_URL_CREDENTIALS_FORBIDDEN");
  }
  const answers = await lookup(url.hostname, { all: true, verbatim: true });
  const publicAnswers = answers.filter((answer) => !privateIp(answer.address));
  if (publicAnswers.length === 0) {
    throw new AppError("WordPress host does not resolve to an allowed public address", 400, "WORDPRESS_PRIVATE_HOST_FORBIDDEN");
  }
  return publicAnswers[0].address;
}

export async function pinnedJsonRequest<T = any>(
  urlInput: string,
  headers: Record<string, string>,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<PinnedJsonResponse<T>> {
  const url = new URL(urlInput);
  const address = await pinnedTarget(url);
  const timeoutMs = Math.max(1000, Math.min(30_000, options.timeoutMs ?? 10_000));
  const maxBytes = Math.max(1024, Math.min(10 * 1024 * 1024, options.maxBytes ?? 2 * 1024 * 1024));

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: address,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: { ...headers, Host: url.host, Accept: "application/json", "User-Agent": "ForgeStudio-Connect/1.0" },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        reject(new AppError("WordPress redirects are not followed automatically", 502, "WORDPRESS_REDIRECT_REJECTED"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const body = text ? JSON.parse(text) : null;
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) responseHeaders[key] = value.join(",");
            else if (value !== undefined) responseHeaders[key] = String(value);
          }
          resolve({ status, headers: responseHeaders, body });
        } catch {
          reject(new AppError("WordPress returned invalid JSON", 502, "WORDPRESS_INVALID_RESPONSE"));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timeout")));
    request.on("error", (error) => {
      if (error instanceof AppError) reject(error);
      else reject(new AppError(`WordPress request failed: ${error.message}`, 502, "WORDPRESS_UNREACHABLE"));
    });
    request.end();
  });
}
