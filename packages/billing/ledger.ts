export type UsageDimension = "website" | "storage_bytes" | "ai_tokens" | "form_submission" | "publish" | "bandwidth_bytes" | "team_member";

export interface UsageEntry {
  eventId: string;
  tenantId: string;
  dimension: UsageDimension;
  quantity: bigint;
  occurredAt: string;
  source: string;
}

export interface Entitlement {
  dimension: UsageDimension;
  included: bigint;
  hardLimit?: bigint;
  overageUnit?: bigint;
  overagePriceMinor?: bigint;
}

export interface UsageDecision {
  allowed: boolean;
  current: bigint;
  projected: bigint;
  included: bigint;
  hardLimit?: bigint;
  overageQuantity: bigint;
  overageAmountMinor: bigint;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function usageEntry(input: UsageEntry): UsageEntry {
  if (!UUID.test(input.eventId) || !UUID.test(input.tenantId) || !/^[a-z0-9._:-]{2,100}$/.test(input.source)) throw new Error("INVALID_USAGE_ENTRY");
  if (input.quantity <= 0n) throw new Error("INVALID_USAGE_QUANTITY");
  if (!Number.isFinite(new Date(input.occurredAt).getTime())) throw new Error("INVALID_USAGE_TIME");
  return { ...input, eventId: input.eventId.toLowerCase(), tenantId: input.tenantId.toLowerCase() };
}

export function decideUsage(current: bigint, requested: bigint, entitlement: Entitlement): UsageDecision {
  if (current < 0n || requested <= 0n || entitlement.included < 0n || entitlement.hardLimit !== undefined && entitlement.hardLimit < entitlement.included) {
    throw new Error("INVALID_USAGE_DECISION");
  }
  const projected = current + requested;
  const allowed = entitlement.hardLimit === undefined || projected <= entitlement.hardLimit;
  const overageQuantity = projected > entitlement.included ? projected - entitlement.included : 0n;
  let overageAmountMinor = 0n;
  if (overageQuantity > 0n && entitlement.overageUnit !== undefined && entitlement.overagePriceMinor !== undefined) {
    if (entitlement.overageUnit <= 0n || entitlement.overagePriceMinor < 0n) throw new Error("INVALID_OVERAGE_PRICE");
    const units = (overageQuantity + entitlement.overageUnit - 1n) / entitlement.overageUnit;
    overageAmountMinor = units * entitlement.overagePriceMinor;
  }
  const result: UsageDecision = { allowed, current, projected, included: entitlement.included, overageQuantity, overageAmountMinor };
  if (entitlement.hardLimit !== undefined) result.hardLimit = entitlement.hardLimit;
  return result;
}

export function aggregateUsage(entries: readonly UsageEntry[]): Readonly<Record<UsageDimension, bigint>> {
  const totals: Record<UsageDimension, bigint> = {
    website: 0n, storage_bytes: 0n, ai_tokens: 0n, form_submission: 0n,
    publish: 0n, bandwidth_bytes: 0n, team_member: 0n,
  };
  const seen = new Set<string>();
  for (const entryValue of entries) {
    const entry = usageEntry(entryValue);
    if (seen.has(entry.eventId)) continue;
    seen.add(entry.eventId);
    totals[entry.dimension] += entry.quantity;
  }
  return totals;
}

export interface PriceTier { upTo?: bigint; pricePerUnitMinor: bigint }

export function tieredAmountMinor(quantity: bigint, tiers: readonly PriceTier[]): bigint {
  if (quantity < 0n || tiers.length === 0) throw new Error("INVALID_TIERED_PRICE");
  let previous = 0n;
  let remaining = quantity;
  let total = 0n;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index]!;
    if (tier.pricePerUnitMinor < 0n || tier.upTo !== undefined && tier.upTo <= previous) throw new Error("INVALID_TIERED_PRICE");
    const available = tier.upTo === undefined ? remaining : tier.upTo - previous;
    const used = remaining < available ? remaining : available;
    total += used * tier.pricePerUnitMinor;
    remaining -= used;
    if (remaining === 0n) return total;
    if (tier.upTo === undefined) return total;
    previous = tier.upTo;
  }
  if (remaining > 0n) throw new Error("UNPRICED_USAGE");
  return total;
}

export function moneyString(amountMinor: bigint, currency: string, fractionDigits = 2): string {
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 4) throw new Error("INVALID_MONEY");
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  const divisor = 10n ** BigInt(fractionDigits);
  const major = absolute / divisor;
  const minor = (absolute % divisor).toString().padStart(fractionDigits, "0");
  return `${negative ? "-" : ""}${currency} ${major}${fractionDigits === 0 ? "" : `.${minor}`}`;
}
