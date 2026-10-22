import fs from 'node:fs';
import type { TurnCheckpointService } from './turn-checkpoints.mjs';

export type CheckpointPort = Pick<TurnCheckpointService, 'list' | 'preview'> & {
  restoreTo(target: string, expected: { digest: string; revision: string; tree: string }, guard?: () => void): ReturnType<TurnCheckpointService['restoreTo']>;
};
type Binding = { port: CheckpointPort; revoke(): void };
const key = (cwd: string, sessionId: string) => `${fs.realpathSync(cwd)}\0${sessionId}`;

// Only the live extension may supply a personal checkpoint port. Gateway must
// never reconstruct mutation authority from persisted session messages.
export class CheckpointAuthority {
  #bindings = new Map<string, Binding>();
  bind(cwd: string, sessionId: string, binding: Binding) {
    const identity = key(cwd, sessionId), previous = this.#bindings.get(identity);
    if (!previous && this.#bindings.size >= 1024) throw Error('checkpoint-authority-capacity');
    previous?.revoke();
    this.#bindings.set(identity, binding);
    return () => {
      binding.revoke();
      if (this.#bindings.get(identity) === binding) this.#bindings.delete(identity);
    };
  }
  resolve(cwd: string, sessionId: string) {
    const identity = key(cwd, sessionId), binding = this.#bindings.get(identity);
    if (!binding) throw Error('checkpoint-runtime-unavailable');
    const current = () => this.#bindings.get(identity) === binding;
    const check = () => { if (!current()) throw Error('checkpoint-authority-changed'); };
    return {
      current,
      list: () => { check(); return binding.port.list(); },
      preview: (target: string) => { check(); return binding.port.preview(target); },
      restoreTo: (target: string, expected: { digest: string; revision: string; tree: string }, guard?: () => void) => {
        check(); return binding.port.restoreTo(target, expected, () => { check(); guard?.(); });
      },
    };
  }
}

// Pi's extension loader and the native Gateway can load distinct module copies.
const AUTHORITY_KEY = Symbol.for('piagent.checkpoint-authority.v1');
const root = globalThis as typeof globalThis & { [AUTHORITY_KEY]?: CheckpointAuthority };
export const checkpointAuthority = root[AUTHORITY_KEY] ??= new CheckpointAuthority();
