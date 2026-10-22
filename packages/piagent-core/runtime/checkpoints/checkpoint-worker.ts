import { PersonalCheckpointGit } from './personal-git.ts';
import type { WorkspacePolicy } from '../../extensions/workspace-inspection.ts';

// Reuse the guarded raw-byte adapter inside the sandbox. No checkout filters,
// host fallback or project policy bypass is needed for company restoration.
export function managedCheckpointOperation(cwd: string, policy: () => WorkspacePolicy, value: unknown) {
  const input = value as Record<string, unknown>;
  if (!input || input.kind !== 'checkpoint') throw Error('checkpoint-request-invalid');
  const fields: Record<string, string[]> = { available: [], tree: [], changed: ['from', 'to'], restore: ['before', 'restore', 'remove', 'expectedTree'] };
  if (typeof input.operation !== 'string' || !Object.hasOwn(fields, input.operation)) throw Error('checkpoint-request-invalid');
  const expected = ['kind', 'operation', ...fields[input.operation]!];
  if (Object.keys(input).length !== expected.length || Object.keys(input).some(key => !expected.includes(key))) throw Error('checkpoint-request-invalid');
  const oid = (key: string) => {
    if (typeof input[key] !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input[key])) throw Error('checkpoint-object-invalid');
    return input[key] as string;
  };
  const paths = (key: string) => {
    const value = input[key];
    if (!Array.isArray(value) || value.length > 10000 || value.some(path => typeof path !== 'string' || !path || path.length > 4096)) throw Error('checkpoint-path-invalid');
    return value as string[];
  };
  const git = new PersonalCheckpointGit(cwd, policy);
  if (input.operation === 'available') return git.available();
  if (input.operation === 'tree') return git.tree();
  if (input.operation === 'changed') return git.changed(oid('from'), oid('to'));
  git.restore(oid('before'), paths('restore'), paths('remove'), oid('expectedTree'));
  return { restored: true };
}
