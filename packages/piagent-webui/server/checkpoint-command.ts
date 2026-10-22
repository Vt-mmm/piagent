import { createHash } from 'node:crypto';
import { canonicalReviewValue } from '../../piagent-core/runtime/inspection/review-state-contract.ts';
import type { CheckpointCommand } from '../contracts/generated/checkpoint-v1.ts';

export const CHECKPOINT_VERSION = 'piagent-webui-checkpoint-v1' as const;
export const checkpointSha = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const sameCheckpointValue = (a: unknown, b: unknown) => canonicalReviewValue(a) === canonicalReviewValue(b);
const keys = (value: unknown, expected: string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && sameCheckpointValue(Object.keys(value).sort(), [...expected].sort());
const match = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
const hash = /^[a-f0-9]{64}$/, ref = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;
const timestamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const checkpointActionDigest = (command: Pick<CheckpointCommand, 'action' | 'identity' | 'expectedRevisions' | 'payload'>) =>
  checkpointSha(canonicalReviewValue({ action: command.action, identity: command.identity, expectedRevisions: command.expectedRevisions, payload: command.payload }));

export function parseCheckpointCommand(value: unknown): CheckpointCommand {
  const c = value as CheckpointCommand;
  if (!keys(value, ['schemaVersion', 'version', 'messageType', 'commandId', 'idempotencyKey', 'requestedAt', 'expiresAt', 'action', 'actionDigest', 'identity', 'expectedRevisions', 'payload'])
    || c.schemaVersion !== 1 || c.version !== CHECKPOINT_VERSION || c.messageType !== 'command' || c.action !== 'checkpoint.restore'
    || !match(c.commandId, ref) || !match(c.idempotencyKey, /^[A-Za-z0-9._~-]{32,128}$/) || !timestamp(c.requestedAt) || !timestamp(c.expiresAt)
    || !keys(c.identity, ['projectRef', 'runtimeInstanceId', 'sessionRef', 'taskId', 'taskRunId', 'agentOperationId', 'toolCallId'])
    || !['projectRef', 'runtimeInstanceId', 'sessionRef'].every(key => match(c.identity[key], ref))
    || !['taskId', 'taskRunId', 'agentOperationId', 'toolCallId'].every(key => c.identity[key] === null || match(c.identity[key], /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/))
    || !keys(c.expectedRevisions, ['checkpointRevision']) || !match(c.expectedRevisions.checkpointRevision, hash)
    || !keys(c.payload, ['targetId', 'previewDigest', 'expectedTree', 'confirmed']) || c.payload.confirmed !== true
    || !match(c.payload.targetId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    || !match(c.payload.previewDigest, hash) || !match(c.payload.expectedTree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    || c.actionDigest !== checkpointActionDigest(c)) throw Error('invalid-checkpoint-command');
  return structuredClone(c);
}
