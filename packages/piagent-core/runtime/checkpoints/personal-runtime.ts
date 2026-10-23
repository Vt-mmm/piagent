import fs from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { WorkspacePolicy } from '../../extensions/workspace-inspection.ts';
import { isCompanySession } from '../../extensions/company-session-guard.ts';
import { PersonalCheckpointGit } from './personal-git.ts';
import { CheckpointStore } from './checkpoint-store.mjs';
import { CheckpointRefs } from './checkpoint-refs.mjs';
import { PersistentCheckpointHistory } from './persistent-history.mjs';
import { pruneStaleCheckpointSessions } from './prune.mjs';
import { TurnCheckpointService, checkpointOwnershipError } from './turn-checkpoints.mjs';
import { checkpointAuthority } from './checkpoint-authority.ts';
import { workspaceMemberEditsSince } from '../session/workspace-member-edits.mjs';

type Run = { turnRef: string; checkpoint?: unknown };
type Binding = { ctx: ExtensionContext; service: TurnCheckpointService; run?: Run; active: boolean; guard?: () => void; unbind(): void };

// The extension owns these bindings; refreshed contexts supply live permissions.
export class PersonalCheckpointRuntime {
  #bindings = new Map<string, Binding>();
  #pruned = new Set<string>();
  #tail = Promise.resolve();
  #pending = 0;
  private policy: (ctx: ExtensionContext) => WorkspacePolicy;
  constructor(policy: (ctx: ExtensionContext) => WorkspacePolicy) { this.policy = policy; }
  #key(ctx: ExtensionContext) {
    if (ctx.model?.provider === 'agent_watch_managed' || isCompanySession(ctx)) throw Error('checkpoint-company-boundary-required');
    const session = ctx.sessionManager.getSessionId();
    if (!session) throw Error('checkpoint-session-unavailable');
    return `${fs.realpathSync(ctx.cwd)}\0${session}`;
  }
  #binding(ctx: ExtensionContext): Binding {
    const key = this.#key(ctx);
    let binding = this.#bindings.get(key);
    if (!binding) {
      if (this.#bindings.size >= 64) throw Error('checkpoint-session-capacity');
      const state = { ctx, active: true } as Binding;
      const git = new PersonalCheckpointGit(ctx.cwd, () => {
        if (!state.active) throw Error('checkpoint-authority-changed');
        state.guard?.();
        return this.policy(state.ctx);
      }, { store: true });
      const store = new CheckpointStore(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!this.#pruned.has(store.directory)) {
        this.#pruned.add(store.directory);
        try { if (git.available()) pruneStaleCheckpointSessions(store.directory, git.refsExecutor, store.key); } catch { /* best effort */ }
      }
      state.service = new TurnCheckpointService(git, {
        busy: () => { state.guard?.(); return !state.active || !state.ctx.isIdle(); },
        history: new PersistentCheckpointHistory(store, new CheckpointRefs(git.refsExecutor, store.key)),
        memberEdits: since => workspaceMemberEditsSince(state.ctx.sessionManager, since),
      });
      state.unbind = checkpointAuthority.bind(ctx.cwd, ctx.sessionManager.getSessionId(), {
        revoke: () => { state.active = false; state.service.revoke(); },
        port: {
          list: () => this.list(state.ctx),
          preview: target => this.preview(state.ctx, target),
          restoreTo: (target, expected, guard) => this.restoreTo(state.ctx, target, expected, guard),
        },
      });
      binding = state;
      this.#bindings.set(key, binding);
    }
    if (!binding.active) throw Error('checkpoint-authority-changed');
    binding.ctx = ctx;
    return binding;
  }
  bind(ctx: ExtensionContext) {
    if (ctx.model?.provider === 'agent_watch_managed' || isCompanySession(ctx)) return;
    this.#binding(ctx);
  }
  async #settledBinding(ctx: ExtensionContext) {
    const binding = this.#binding(ctx);
    if (ctx.isIdle() && binding.run) {
      await binding.service.finish(binding.run);
      binding.run = undefined;
    }
    return binding;
  }
  list(ctx: ExtensionContext) {
    return this.#serial(async () => (await this.#settledBinding(ctx)).service.list());
  }
  preview(ctx: ExtensionContext, target: string) {
    return this.#serial(async () => (await this.#settledBinding(ctx)).service.preview(target));
  }
  restoreTo(ctx: ExtensionContext, target: string, expected: { digest: string; revision: string; tree: string }, guard?: () => void) {
    return this.#serial(async () => {
      guard?.();
      const binding = await this.#settledBinding(ctx);
      binding.guard = guard;
      try { guard?.(); return await binding.service.restoreTo(target, expected); }
      finally { binding.guard = undefined; }
    });
  }
  #serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.#pending >= 128) return Promise.reject(Error('checkpoint-command-capacity'));
    this.#pending++;
    const operation = this.#tail.then(action, action);
    this.#tail = operation.then(() => {}, () => {});
    return operation.finally(() => { this.#pending--; });
  }
  beforeMutation(ctx: ExtensionContext) {
    return this.#serial(async () => {
      const binding = this.#binding(ctx);
      let turn: string | undefined;
      try {
        const user = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === 'message' && entry.message.role === 'user');
        turn = user?.id;
        if (!user?.id) throw Error('checkpoint-turn-unavailable');
        if (binding.run?.turnRef !== user.id) {
          // Steering can add a user turn before the enclosing agent settles.
          if (binding.run) await binding.service.finish(binding.run);
          binding.run = { turnRef: user.id };
        }
        await binding.service.take(binding.run);
      } catch (error) {
        // Only a turn that already has its checkpoint may change files unrecorded.
        if (!checkpointOwnershipError(error) && (!turn || binding.run?.turnRef !== turn || binding.run.checkpoint === undefined)) binding.service.markGap();
        throw error;
      }
      if (!binding.active) throw Error('checkpoint-authority-changed');
    });
  }
  finish(ctx: ExtensionContext) {
    return this.#serial(async () => {
      if (ctx.model?.provider === 'agent_watch_managed' || isCompanySession(ctx)) return;
      const binding = this.#bindings.get(this.#key(ctx));
      if (!binding) return;
      if (!binding.active) throw Error('checkpoint-authority-changed');
      binding.ctx = ctx;
      if (binding.run) await binding.service.finish(binding.run);
      binding.run = undefined;
    });
  }
  undo(ctx: ExtensionContext) {
    return this.#serial(async () => {
      const binding = this.#binding(ctx);
      // A failed settlement must be resolved before exposing the older stack.
      if (ctx.isIdle() && binding.run) {
        await binding.service.finish(binding.run);
        binding.run = undefined;
      }
      return await binding.service.undo();
    });
  }
  close(ctx: ExtensionContext) {
    return this.#serial(async () => {
      if (ctx.model?.provider === 'agent_watch_managed' || isCompanySession(ctx)) return;
      const key = this.#key(ctx), binding = this.#bindings.get(key);
      if (!binding) return;
      binding.ctx = ctx;
      try { if (binding.active && binding.run) await binding.service.finish(binding.run); }
      finally {
        try { await binding.service.close(); }
        finally { binding.unbind(); this.#bindings.delete(key); }
      }
    });
  }
}
