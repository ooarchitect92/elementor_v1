import { canonicalJson, object, uuid, revision, ContractError } from '../events/index.ts';
/** A lossless boundary for the existing editor JSON, not a new renderer format. */
export interface SaveCommand {
  websiteId: string;
  expectedRevision: number;
  idempotencyKey: string;
  editorData: Record<string, unknown>;
}
export function parseSaveCommand(input: unknown): SaveCommand {
  const value = object(input);
  const editorData = object(value.editorData);
  // Do not select only elements/popups: all editor fields must round-trip.
  canonicalJson(editorData, 1048576);
  if (typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.idempotencyKey)) throw new ContractError('Invalid idempotency key');
  return {websiteId: uuid(value.websiteId), expectedRevision: revision(value.expectedRevision), idempotencyKey: value.idempotencyKey, editorData};
}
export function assertRevision(actual: number, expected: number): void {
  revision(actual); revision(expected);
  if (actual !== expected) throw new Error('REVISION_CONFLICT');
}
