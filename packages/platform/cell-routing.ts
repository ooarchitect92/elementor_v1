import { createHash, randomUUID } from "node:crypto";

export type CellStatus = "ACTIVE" | "DRAINING" | "UNAVAILABLE";
export type PlacementState = "STABLE" | "COPYING" | "CATCHING_UP" | "CUTOVER_PENDING" | "CUTOVER" | "ROLLBACK_PENDING";

export interface CellDescriptor {
  id: string;
  region: string;
  status: CellStatus;
  capacityUnits: number;
  allocatedUnits: number;
  generation: number;
}

export interface TenantPlacement {
  tenantId: string;
  cellId: string;
  epoch: number;
  fenceToken: string;
  state: PlacementState;
  targetCellId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CELL_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

function validTenant(value: string): string {
  if (!UUID.test(value)) throw new Error("INVALID_TENANT_ID");
  return value.toLowerCase();
}

function validateCell(cell: CellDescriptor): void {
  if (!CELL_ID.test(cell.id) || !/^[a-z0-9-]{2,32}$/.test(cell.region)) throw new Error("INVALID_CELL");
  if (!Number.isSafeInteger(cell.capacityUnits) || cell.capacityUnits < 1 || !Number.isSafeInteger(cell.allocatedUnits)
    || cell.allocatedUnits < 0 || cell.allocatedUnits > cell.capacityUnits || !Number.isSafeInteger(cell.generation) || cell.generation < 1) {
    throw new Error("INVALID_CELL_CAPACITY");
  }
}

function score(tenantId: string, cell: CellDescriptor): bigint {
  const digest = createHash("sha256").update(`${tenantId}:${cell.id}:${cell.generation}`).digest();
  const raw = digest.readBigUInt64BE(0);
  const available = BigInt(Math.max(1, cell.capacityUnits - cell.allocatedUnits));
  return raw * available / BigInt(cell.capacityUnits);
}

export function chooseCell(tenantIdValue: string, cells: readonly CellDescriptor[], requiredUnits = 1): CellDescriptor {
  const tenantId = validTenant(tenantIdValue);
  if (!Number.isSafeInteger(requiredUnits) || requiredUnits < 1) throw new Error("INVALID_REQUIRED_CAPACITY");
  const eligible = cells.filter((cell) => {
    validateCell(cell);
    return cell.status === "ACTIVE" && cell.capacityUnits - cell.allocatedUnits >= requiredUnits;
  });
  if (eligible.length === 0) throw new Error("NO_CELL_CAPACITY");
  return [...eligible].sort((a, b) => {
    const left = score(tenantId, a);
    const right = score(tenantId, b);
    return left === right ? a.id.localeCompare(b.id) : left > right ? -1 : 1;
  })[0]!;
}

export function initialPlacement(tenantId: string, cells: readonly CellDescriptor[], requiredUnits = 1): TenantPlacement {
  const normalized = validTenant(tenantId);
  const cell = chooseCell(normalized, cells, requiredUnits);
  return { tenantId: normalized, cellId: cell.id, epoch: 1, fenceToken: randomUUID(), state: "STABLE" };
}

export function assertWriteFence(placement: TenantPlacement, cellId: string, epoch: number, fenceToken: string): void {
  if (placement.cellId !== cellId || placement.epoch !== epoch || placement.fenceToken !== fenceToken || placement.state === "CUTOVER_PENDING") {
    throw new Error("STALE_CELL_WRITER");
  }
}

export function startMigration(placement: TenantPlacement, targetCell: CellDescriptor): TenantPlacement {
  validateCell(targetCell);
  if (placement.state !== "STABLE") throw new Error("MIGRATION_ALREADY_ACTIVE");
  if (targetCell.status !== "ACTIVE" || targetCell.id === placement.cellId) throw new Error("INVALID_MIGRATION_TARGET");
  return { ...placement, state: "COPYING", targetCellId: targetCell.id };
}

export function advanceMigration(placement: TenantPlacement, next: PlacementState): TenantPlacement {
  const allowed: Readonly<Record<PlacementState, readonly PlacementState[]>> = {
    STABLE: ["COPYING"],
    COPYING: ["CATCHING_UP", "ROLLBACK_PENDING"],
    CATCHING_UP: ["CUTOVER_PENDING", "ROLLBACK_PENDING"],
    CUTOVER_PENDING: ["CUTOVER", "ROLLBACK_PENDING"],
    CUTOVER: ["STABLE", "ROLLBACK_PENDING"],
    ROLLBACK_PENDING: ["STABLE"],
  };
  if (!allowed[placement.state].includes(next)) throw new Error("INVALID_MIGRATION_TRANSITION");
  if (!placement.targetCellId && next !== "STABLE") throw new Error("MIGRATION_TARGET_MISSING");
  if (next === "CUTOVER") {
    return {
      tenantId: placement.tenantId,
      cellId: placement.targetCellId!,
      epoch: placement.epoch + 1,
      fenceToken: randomUUID(),
      state: "CUTOVER",
      targetCellId: placement.cellId,
    };
  }
  if (next === "STABLE") {
    return {
      tenantId: placement.tenantId,
      cellId: placement.cellId,
      epoch: placement.epoch + 1,
      fenceToken: randomUUID(),
      state: "STABLE",
    };
  }
  return { ...placement, state: next };
}

export function cellUtilization(cell: CellDescriptor): number {
  validateCell(cell);
  return cell.allocatedUnits / cell.capacityUnits;
}

export function capacityDecision(cell: CellDescriptor, requiredUnits: number, maximumUtilization = 0.7): { allowed: boolean; projectedUtilization: number } {
  validateCell(cell);
  if (!Number.isSafeInteger(requiredUnits) || requiredUnits < 1 || maximumUtilization <= 0 || maximumUtilization > 1) {
    throw new Error("INVALID_CAPACITY_DECISION");
  }
  const projectedUtilization = (cell.allocatedUnits + requiredUnits) / cell.capacityUnits;
  return { allowed: cell.status === "ACTIVE" && projectedUtilization <= maximumUtilization, projectedUtilization };
}
