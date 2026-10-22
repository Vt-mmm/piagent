import { checkpointAuthority } from '../../piagent-core/runtime/checkpoints/checkpoint-authority.ts';
import { workspaceWriteAuthority } from '../../piagent-core/runtime/policy/workspace-write-authority.ts';
import { CheckpointController } from '../server/checkpoint-controller.ts';
import { CHECKPOINT_VERSION, sameCheckpointValue } from '../server/checkpoint-command.ts';
import type { CheckpointPreview } from '../contracts/generated/checkpoint-v1.ts';
import type { SessionRuntimeSupervisor } from './session-runtime-supervisor.ts';
import { sessionRefForPath, projectRefForCwd } from './session-catalog.ts';
import { CheckpointReceiptStore } from './checkpoint-store.ts';
import { transcriptMessageRef } from '../server/transcript-projection.ts';
import { webUiSessionRef } from '../../piagent-core/runtime/inspection/webui-snapshot.ts';
import type { CheckpointPort } from '../../piagent-core/runtime/checkpoints/checkpoint-authority.ts';

export type ManagedCheckpointRuntime = { current(): boolean; writable(): Promise<boolean>; port: CheckpointPort };

type Options = { root: string; key: Buffer; gatewayInstanceRef: string; managed: boolean;
  runtimes: Pick<SessionRuntimeSupervisor, 'listSessions' | 'acquire' | 'liveSessionManager' | 'ownership' | 'currentOperation'>;
  managedCheckpoint?(id: string): ManagedCheckpointRuntime;
  changed(sessionRef: string): void };

export class CheckpointSessions {
  #options: Options;
  #store: CheckpointReceiptStore;
  #controllers = new Map<string, CheckpointController>();
  constructor(options: Options) { this.#options = options; this.#store = new CheckpointReceiptStore(options.root, options.key); }
  async #live(sessionRef: string) {
    const { runtimes, key, gatewayInstanceRef } = this.#options;
    if (this.#options.managed && !this.#options.managedCheckpoint) throw Error('checkpoint-company-boundary-required');
    const matches = (await runtimes.listSessions()).filter(info => sessionRefForPath(key, info.path) === sessionRef);
    if (matches.length !== 1) throw Error('checkpoint-session-unavailable');
    const info = matches[0]!, lease = await runtimes.acquire(sessionRef), manager = runtimes.liveSessionManager(sessionRef);
    if (!manager || !lease.runtimeInstanceRef || manager.getSessionId() !== info.id) throw Error('checkpoint-session-unavailable');
    const managed = this.#options.managed ? this.#options.managedCheckpoint!(info.id) : null;
    const port = managed ? { ...managed.port, current: managed.current } : checkpointAuthority.resolve(info.cwd, info.id);
    const assertCurrent = () => {
      const ownership = runtimes.ownership(sessionRef);
      if (!port.current() || runtimes.liveSessionManager(sessionRef) !== manager || manager.getSessionId() !== info.id
        || ownership.state !== 'gateway-owned' || ownership.owner.continuity !== 'exact'
        || ownership.owner.gatewayInstanceRef !== gatewayInstanceRef || ownership.owner.runtimeInstanceRef !== lease.runtimeInstanceRef
        || ownership.owner.ownerEpoch !== lease.ownerEpoch) throw Error('checkpoint-runtime-replaced');
      if (!managed && manager.buildSessionContext().model?.provider === 'agent_watch_managed') throw Error('checkpoint-company-boundary-required');
    };
    assertCurrent();
    const identity = { projectRef: projectRefForCwd(key, info.cwd), sessionRef, runtimeInstanceId: lease.runtimeInstanceRef,
      taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    const writable = async () => {
      assertCurrent();
      const value = managed ? await managed.writable() : workspaceWriteAuthority.writable(info.cwd, info.id);
      assertCurrent(); return value;
    };
    return { info, port, assertCurrent, identity, writable, managed: !!managed };
  }
  async #facts(sessionRef: string) {
    const binding = await this.#live(sessionRef), listed = await binding.port.list();
    binding.assertCurrent();
    return { identity: binding.identity, revisions: { checkpointRevision: listed.revision },
      points: listed.points.map(point => ({ ...point, turnRef: transcriptMessageRef(webUiSessionRef(binding.info.id), point.turnRef) })),
      available: listed.available, agentRunning: Boolean(this.#options.runtimes.currentOperation(sessionRef)),
      writable: await binding.writable() };
  }
  #controller(sessionRef: string) {
    let controller = this.#controllers.get(sessionRef);
    if (!controller) {
      if (this.#controllers.size >= 1024) throw Error('checkpoint-session-capacity');
      controller = new CheckpointController({
        facts: () => this.#facts(sessionRef), history: () => this.#store.history(sessionRef),
        append: receipt => {
          this.#store.append(sessionRef, receipt);
          if (receipt.phase === 'settled' || receipt.phase === 'uncertain') this.#options.changed(sessionRef);
        },
        restore: async (target, expected, identity) => {
          const binding = await this.#live(sessionRef);
          if (!sameCheckpointValue(identity, binding.identity)) throw Error('checkpoint-runtime-replaced');
          if (!await binding.writable()) throw Error('checkpoint-read-only');
          const guard = () => {
            binding.assertCurrent();
            if (this.#options.runtimes.currentOperation(sessionRef)) throw Error('checkpoint-session-busy');
            if (!binding.managed && !workspaceWriteAuthority.writable(binding.info.cwd, binding.info.id)) throw Error('checkpoint-read-only');
          };
          guard();
          return await binding.port.restoreTo(target, expected, guard);
        },
      });
      this.#controllers.set(sessionRef, controller);
    }
    return controller;
  }
  state(sessionRef: string) { return this.#controller(sessionRef).state(); }
  execute(sessionRef: string, command: unknown) { return this.#controller(sessionRef).execute(command); }
  async preview(sessionRef: string, target: string): Promise<CheckpointPreview> {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target)) throw Error('invalid-checkpoint-target');
    const binding = await this.#live(sessionRef), preview = await binding.port.preview(target);
    binding.assertCurrent();
    return { schemaVersion: 1, version: CHECKPOINT_VERSION, messageType: 'preview', identity: binding.identity,
      revisions: { checkpointRevision: preview.revision }, targetId: target, result: preview.result as CheckpointPreview['result'],
      previewDigest: preview.digest, tree: preview.tree,
      steps: preview.steps.map(step => ({ ...step, turnRef: transcriptMessageRef(webUiSessionRef(binding.info.id), step.turnRef) })), files: preview.files,
      conflicts: preview.conflicts, stoppedAt: preview.stoppedAt };
  }
}
