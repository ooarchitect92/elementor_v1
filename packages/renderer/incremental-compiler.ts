import { createHash } from "node:crypto";
import { canonicalJson } from "../events/index.ts";
import type { ObjectStore } from "../platform/object-store.ts";
import { objectKey, sha256 } from "../platform/object-store.ts";

export interface CompiledArtifact {
  path: string;
  key: string;
  hash: string;
  size: number;
  contentType: "application/json";
}

export interface ReleaseManifest {
  schemaVersion: 1;
  tenantId: string;
  websiteId: string;
  releaseId: string;
  sourceRevision: number;
  rendererVersion: string;
  generatedAt: string;
  artifacts: Readonly<Record<string, CompiledArtifact>>;
  removedPaths: readonly string[];
  manifestHash: string;
}

export interface CompiledRelease {
  manifest: ReleaseManifest;
  manifestKey: string;
  activePointerKey: string;
  changed: readonly { artifact: CompiledArtifact; body: Uint8Array }[];
  unchanged: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: string, code: string): string {
  if (!UUID.test(value)) throw new Error(code);
  return value.toLowerCase();
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function safeSlug(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = text.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9/_-]+/g, "-").replace(/\/{2,}/g, "/");
  const slug = normalized || fallback;
  if (slug.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("INVALID_PAGE_SLUG");
  return slug;
}

function pageDocuments(payload: Record<string, unknown>): Array<{ path: string; document: Record<string, unknown> }> {
  const editorData = record(payload.editorData, "PUBLISH_EDITOR_DATA_INVALID");
  const website = record(payload.website, "PUBLISH_WEBSITE_INVALID");
  const shared = {
    website: {
      id: website.id,
      name: website.name,
      slug: website.slug,
      status: website.status,
    },
    globalSettings: editorData.globalSettings ?? {},
    breakpoints: editorData.breakpoints ?? [],
    popups: editorData.popups ?? [],
    customCodeSnippets: payload.customCodeSnippets ?? [],
    themeLocationRules: payload.themeLocationRules ?? [],
  };
  const pages = editorData.pages;
  if (Array.isArray(pages) && pages.length > 0) {
    const seen = new Set<string>();
    return pages.map((raw, index) => {
      const page = record(raw, "PUBLISH_PAGE_INVALID");
      const slug = safeSlug(page.slug, index === 0 ? "index" : `page-${index + 1}`);
      const path = slug === "index" || slug === "home" ? "index.json" : `pages/${slug}.json`;
      if (seen.has(path)) throw new Error("PUBLISH_DUPLICATE_PAGE_SLUG");
      seen.add(path);
      return {
        path,
        document: {
          schemaVersion: 1,
          ...shared,
          page: {
            id: page.id,
            name: page.name,
            slug: page.slug,
            customCss: page.customCss ?? "",
            elements: page.elements ?? [],
          },
        },
      };
    });
  }
  return [{
    path: "index.json",
    document: {
      schemaVersion: 1,
      ...shared,
      page: { id: "home", name: "Home", slug: "/", customCss: "", elements: editorData.elements ?? [] },
    },
  }];
}

function artifactBody(document: Record<string, unknown>): Uint8Array {
  return Buffer.from(canonicalJson(document, 32 * 1024 * 1024), "utf8");
}

function manifestDigest(value: Omit<ReleaseManifest, "manifestHash">): string {
  return createHash("sha256").update(canonicalJson(value, 32 * 1024 * 1024)).digest("hex");
}

export interface CompileReleaseInput {
  tenantId: string;
  websiteId: string;
  releaseId: string;
  sourceRevision: number;
  rendererVersion: string;
  payload: unknown;
  previousManifest?: ReleaseManifest | null;
  generatedAt?: string;
}

export function compileIncrementalRelease(input: CompileReleaseInput): CompiledRelease {
  const tenantId = uuid(input.tenantId, "INVALID_TENANT_ID");
  const websiteId = uuid(input.websiteId, "INVALID_WEBSITE_ID");
  const releaseId = uuid(input.releaseId, "INVALID_RELEASE_ID");
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0) throw new Error("INVALID_SOURCE_REVISION");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.rendererVersion)) throw new Error("INVALID_RENDERER_VERSION");
  const payload = record(input.payload, "PUBLISH_PAYLOAD_INVALID");
  const documents = pageDocuments(payload);
  if (documents.length > 10_000) throw new Error("PUBLISH_PAGE_LIMIT_EXCEEDED");

  const previous = input.previousManifest?.artifacts ?? {};
  const artifacts: Record<string, CompiledArtifact> = {};
  const changed: Array<{ artifact: CompiledArtifact; body: Uint8Array }> = [];
  const unchanged: string[] = [];
  for (const item of documents) {
    const body = artifactBody(item.document);
    const hash = sha256(body);
    const artifact: CompiledArtifact = {
      path: item.path,
      key: objectKey(`blobs/sha256/${hash.slice(0, 2)}/${hash}.json`),
      hash,
      size: body.byteLength,
      contentType: "application/json",
    };
    artifacts[item.path] = artifact;
    if (previous[item.path]?.hash === hash) unchanged.push(item.path);
    else changed.push({ artifact, body });
  }
  const removedPaths = Object.keys(previous).filter((path) => !(path in artifacts)).sort();
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(new Date(generatedAt).getTime())) throw new Error("INVALID_GENERATED_AT");
  const withoutHash: Omit<ReleaseManifest, "manifestHash"> = {
    schemaVersion: 1,
    tenantId,
    websiteId,
    releaseId,
    sourceRevision: input.sourceRevision,
    rendererVersion: input.rendererVersion,
    generatedAt,
    artifacts,
    removedPaths,
  };
  const manifest: ReleaseManifest = { ...withoutHash, manifestHash: manifestDigest(withoutHash) };
  return {
    manifest,
    manifestKey: objectKey(`tenants/${tenantId}/sites/${websiteId}/releases/${releaseId}/manifest.json`),
    activePointerKey: objectKey(`tenants/${tenantId}/sites/${websiteId}/active.json`),
    changed,
    unchanged,
  };
}

export async function publishCompiledRelease(store: ObjectStore, release: CompiledRelease): Promise<ReleaseManifest> {
  for (const item of release.changed) {
    const existing = await store.head(item.artifact.key);
    if (existing) {
      if (existing.sha256 !== item.artifact.hash || existing.size !== item.artifact.size) throw new Error("ARTIFACT_HASH_COLLISION");
      continue;
    }
    await store.put({
      key: item.artifact.key,
      body: item.body,
      contentType: item.artifact.contentType,
      cacheControl: "public, max-age=31536000, immutable",
      expectedSha256: item.artifact.hash,
      ifNoneMatch: true,
      metadata: { artifact: "page", renderer: release.manifest.rendererVersion },
    });
  }

  const manifestBody = Buffer.from(canonicalJson(release.manifest, 32 * 1024 * 1024), "utf8");
  await store.put({
    key: release.manifestKey,
    body: manifestBody,
    contentType: "application/json",
    cacheControl: "public, max-age=31536000, immutable",
    expectedSha256: sha256(manifestBody),
    ifNoneMatch: true,
    metadata: { artifact: "release-manifest", manifest: release.manifest.manifestHash },
  }).catch(async (error) => {
    if (!(error instanceof Error) || error.message !== "OBJECT_ALREADY_EXISTS") throw error;
    const existing = await store.get(release.manifestKey);
    if (sha256(existing.body) !== sha256(manifestBody)) throw new Error("RELEASE_MANIFEST_CONFLICT");
  });

  const pointer = {
    schemaVersion: 1,
    tenantId: release.manifest.tenantId,
    websiteId: release.manifest.websiteId,
    releaseId: release.manifest.releaseId,
    sourceRevision: release.manifest.sourceRevision,
    manifestKey: release.manifestKey,
    manifestHash: release.manifest.manifestHash,
    activatedAt: new Date().toISOString(),
  };
  const pointerBody = Buffer.from(canonicalJson(pointer), "utf8");
  await store.put({
    key: release.activePointerKey,
    body: pointerBody,
    contentType: "application/json",
    cacheControl: "public, max-age=30, stale-while-revalidate=300, stale-if-error=86400",
    expectedSha256: sha256(pointerBody),
    metadata: { artifact: "active-pointer", release: release.manifest.releaseId },
  });

  const verified = await store.get(release.manifestKey);
  if (sha256(verified.body) !== sha256(manifestBody)) throw new Error("RELEASE_MANIFEST_VERIFY_FAILED");
  return release.manifest;
}
