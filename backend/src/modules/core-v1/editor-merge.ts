import crypto from "node:crypto";

type JsonObject = Record<string, any>;
const CONTENT_FIELDS = ["content", "src", "alt", "href", "title", "caption"] as const;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function hasOwn(value: any, key: string) {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((out: JsonObject, key) => {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
      return out;
    }, {});
  }
  return value;
}

export function contentHash(value: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function mergeElementTree(
  currentElements: any[],
  incomingElements: any[],
  canEditDesign: boolean,
  isAdmin: boolean,
  allowedComponentIds: Set<string>
): any[] {
  const current = Array.isArray(currentElements) ? currentElements : [];
  const incoming = Array.isArray(incomingElements) ? incomingElements : [];
  const currentById = new Map(current.filter(Boolean).map((el: any) => [String(el.id), el]));
  const incomingById = new Map(incoming.filter(Boolean).map((el: any) => [String(el.id), el]));

  if (!canEditDesign) {
    return current.map((existing: any) => {
      const next: any = incomingById.get(String(existing.id));
      if (!next) return clone(existing);
      const merged = clone(existing);
      for (const field of CONTENT_FIELDS) {
        if (next[field] !== undefined) merged[field] = clone(next[field]);
      }
      if (Array.isArray(existing.children)) {
        merged.children = mergeElementTree(existing.children, next.children || [], false, isAdmin, allowedComponentIds);
      }
      return merged;
    });
  }

  const result: any[] = [];
  for (const next of incoming) {
    if (!next || next.id === undefined) continue;
    const previous: any = currentById.get(String(next.id));
    const protectedWithoutGrant = previous?.isProtected === true && !isAdmin && !allowedComponentIds.has(String(next.id));
    if (protectedWithoutGrant) {
      result.push(clone(previous));
      continue;
    }
    const merged = clone(next);
    if (previous?.children && Array.isArray(next.children)) {
      merged.children = mergeElementTree(previous.children, next.children, true, isAdmin, allowedComponentIds);
    }
    result.push(merged);
  }

  for (const previous of current) {
    if (!previous?.id || incomingById.has(String(previous.id))) continue;
    if (previous.isProtected === true && !isAdmin && !allowedComponentIds.has(String(previous.id))) {
      result.push(clone(previous));
    }
  }
  return result;
}

function mergePageLikeCollection(
  currentCollection: any[],
  incomingCollection: any[],
  canEditDesign: boolean,
  isAdmin: boolean,
  allowedComponentIds: Set<string>,
): any[] {
  const current = Array.isArray(currentCollection) ? currentCollection : [];
  const incoming = Array.isArray(incomingCollection) ? incomingCollection : [];
  if (canEditDesign) {
    const currentById = new Map(current.map((item: any) => [String(item.id), item]));
    return incoming.map((item: any) => {
      const previous: any = currentById.get(String(item.id));
      if (!previous) return clone(item);
      return { ...clone(item), elements: mergeElementTree(previous.elements || [], item.elements || [], true, isAdmin, allowedComponentIds) };
    });
  }
  const incomingById = new Map(incoming.map((item: any) => [String(item.id), item]));
  return current.map((item: any) => {
    const next: any = incomingById.get(String(item.id));
    return next ? { ...clone(item), elements: mergeElementTree(item.elements || [], next.elements || [], false, isAdmin, allowedComponentIds) } : clone(item);
  });
}

/**
 * Lossless partial-document merge. Fields omitted by a client are preserved.
 * Design editors may replace fields they explicitly send; content-only editors can only
 * change the allow-listed content properties inside existing elements.
 */
export function mergeEditorData(
  currentData: any,
  incomingData: any,
  canEditDesign: boolean,
  isAdmin: boolean,
  allowedComponentIds: Set<string>,
): JsonObject {
  const current = clone(currentData || {});
  const incoming = clone(incomingData || {});
  const merged: JsonObject = canEditDesign ? { ...current, ...incoming } : { ...current };

  if (hasOwn(incoming, "elements")) {
    merged.elements = mergeElementTree(current.elements || [], incoming.elements || [], canEditDesign, isAdmin, allowedComponentIds);
  } else if (hasOwn(current, "elements")) {
    merged.elements = clone(current.elements);
  }

  if (hasOwn(incoming, "pages")) {
    merged.pages = mergePageLikeCollection(current.pages || [], incoming.pages || [], canEditDesign, isAdmin, allowedComponentIds);
  } else if (hasOwn(current, "pages")) {
    merged.pages = clone(current.pages);
  }

  if (hasOwn(incoming, "popups")) {
    merged.popups = mergePageLikeCollection(current.popups || [], incoming.popups || [], canEditDesign, isAdmin, allowedComponentIds);
  } else if (hasOwn(current, "popups")) {
    merged.popups = clone(current.popups);
  }

  return merged;
}
