import { createHash } from "node:crypto";

export type MediaKind = "PNG" | "JPEG" | "GIF" | "WEBP" | "SVG" | "PDF" | "UNKNOWN";
export type MediaState = "UPLOADING" | "QUARANTINED" | "SCANNING" | "PROCESSING" | "READY" | "REJECTED" | "FAILED";

export interface MediaInspection {
  kind: MediaKind;
  contentType: string;
  size: number;
  sha256: string;
  width?: number;
  height?: number;
  sanitizedBody?: Uint8Array;
  warnings: readonly string[];
}

export interface MediaPolicy {
  maximumBytes: number;
  maximumPixels: number;
  allowSvg: boolean;
  allowPdf: boolean;
}

export const DEFAULT_MEDIA_POLICY: MediaPolicy = {
  maximumBytes: 25 * 1024 * 1024,
  maximumPixels: 80_000_000,
  allowSvg: true,
  allowPdf: true,
};

function checksum(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function pngDimensions(body: Uint8Array): { width: number; height: number } | null {
  if (body.length < 24 || !Buffer.from(body.slice(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

function gifDimensions(body: Uint8Array): { width: number; height: number } | null {
  const signature = Buffer.from(body.slice(0, 6)).toString("ascii");
  if ((signature !== "GIF87a" && signature !== "GIF89a") || body.length < 10) return null;
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
}

function jpegDimensions(body: Uint8Array): { width: number; height: number } | null {
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < body.length) {
    if (body[offset] !== 0xff) { offset += 1; continue; }
    const marker = body[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
    const length = (body[offset + 2]! << 8) + body[offset + 3]!;
    if (length < 2 || offset + 2 + length > body.length) return null;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      return { height: (body[offset + 5]! << 8) + body[offset + 6]!, width: (body[offset + 7]! << 8) + body[offset + 8]! };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(body: Uint8Array): { width: number; height: number } | null {
  if (body.length < 30 || Buffer.from(body.slice(0, 4)).toString("ascii") !== "RIFF" || Buffer.from(body.slice(8, 12)).toString("ascii") !== "WEBP") return null;
  const kind = Buffer.from(body.slice(12, 16)).toString("ascii");
  if (kind === "VP8X") {
    const width = 1 + body[24]! + (body[25]! << 8) + (body[26]! << 16);
    const height = 1 + body[27]! + (body[28]! << 8) + (body[29]! << 16);
    return { width, height };
  }
  return null;
}

function sanitizeSvg(body: Uint8Array): Uint8Array {
  let text = Buffer.from(body).toString("utf8");
  if (!/^\s*<svg\b/i.test(text) || !/<\/svg>\s*$/i.test(text)) throw new Error("INVALID_SVG");
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*("|')\s*(?:javascript:|data:text\/html)[\s\S]*?\1/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "");
  if (/\son[a-z]+\s*=|javascript:|<script\b|<foreignObject\b|<!ENTITY/i.test(text)) throw new Error("UNSAFE_SVG");
  return Buffer.from(text, "utf8");
}

function svgDimensions(body: Uint8Array): { width?: number; height?: number } {
  const text = Buffer.from(body).toString("utf8").slice(0, 64 * 1024);
  const width = /\bwidth=["']([0-9.]+)/i.exec(text)?.[1];
  const height = /\bheight=["']([0-9.]+)/i.exec(text)?.[1];
  const result: { width?: number; height?: number } = {};
  if (width && Number.isFinite(Number(width))) result.width = Math.round(Number(width));
  if (height && Number.isFinite(Number(height))) result.height = Math.round(Number(height));
  return result;
}

export function inspectMedia(body: Uint8Array, declaredContentType: string, policy: MediaPolicy = DEFAULT_MEDIA_POLICY): MediaInspection {
  if (!(body instanceof Uint8Array) || body.byteLength === 0) throw new Error("EMPTY_MEDIA");
  if (!Number.isSafeInteger(policy.maximumBytes) || policy.maximumBytes < 1 || body.byteLength > policy.maximumBytes) throw new Error("MEDIA_SIZE_LIMIT");
  let kind: MediaKind = "UNKNOWN";
  let contentType = "application/octet-stream";
  let dimensions: { width?: number; height?: number } = {};
  let sanitizedBody: Uint8Array | undefined;
  const warnings: string[] = [];

  const png = pngDimensions(body);
  const gif = gifDimensions(body);
  const jpeg = jpegDimensions(body);
  const webp = webpDimensions(body);
  if (png) { kind = "PNG"; contentType = "image/png"; dimensions = png; }
  else if (jpeg) { kind = "JPEG"; contentType = "image/jpeg"; dimensions = jpeg; }
  else if (gif) { kind = "GIF"; contentType = "image/gif"; dimensions = gif; warnings.push("Animated GIF processing is passthrough-only."); }
  else if (webp) { kind = "WEBP"; contentType = "image/webp"; dimensions = webp; }
  else if (Buffer.from(body.slice(0, 5)).toString("ascii") === "%PDF-") {
    if (!policy.allowPdf) throw new Error("PDF_NOT_ALLOWED");
    kind = "PDF"; contentType = "application/pdf";
  } else if (/^\s*<svg\b/i.test(Buffer.from(body.slice(0, Math.min(body.length, 1024))).toString("utf8"))) {
    if (!policy.allowSvg) throw new Error("SVG_NOT_ALLOWED");
    kind = "SVG"; contentType = "image/svg+xml";
    sanitizedBody = sanitizeSvg(body);
    dimensions = svgDimensions(sanitizedBody);
  } else {
    throw new Error("UNSUPPORTED_MEDIA_TYPE");
  }

  if (declaredContentType && declaredContentType.toLowerCase() !== contentType) warnings.push(`Declared content type ${declaredContentType} was replaced by detected type ${contentType}.`);
  if (dimensions.width !== undefined && dimensions.height !== undefined) {
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width * dimensions.height > policy.maximumPixels) throw new Error("MEDIA_DIMENSION_LIMIT");
  }
  const actualBody = sanitizedBody ?? body;
  const result: MediaInspection = {
    kind,
    contentType,
    size: actualBody.byteLength,
    sha256: checksum(actualBody),
    warnings,
  };
  if (dimensions.width !== undefined) result.width = dimensions.width;
  if (dimensions.height !== undefined) result.height = dimensions.height;
  if (sanitizedBody !== undefined) result.sanitizedBody = sanitizedBody;
  return result;
}

const TRANSITIONS: Readonly<Record<MediaState, readonly MediaState[]>> = {
  UPLOADING: ["QUARANTINED", "FAILED"],
  QUARANTINED: ["SCANNING", "REJECTED", "FAILED"],
  SCANNING: ["PROCESSING", "REJECTED", "FAILED"],
  PROCESSING: ["READY", "REJECTED", "FAILED"],
  READY: [], REJECTED: [], FAILED: ["QUARANTINED"],
};

export function advanceMediaState(current: MediaState, next: MediaState): MediaState {
  if (!TRANSITIONS[current].includes(next)) throw new Error("INVALID_MEDIA_STATE_TRANSITION");
  return next;
}

export function mediaDerivativeKey(tenantId: string, assetId: string, hash: string, variant: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(assetId) || !/^[0-9a-f]{64}$/.test(hash) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(variant)) {
    throw new Error("INVALID_MEDIA_KEY");
  }
  return `tenants/${tenantId.toLowerCase()}/media/${assetId.toLowerCase()}/${hash}/${variant}`;
}
