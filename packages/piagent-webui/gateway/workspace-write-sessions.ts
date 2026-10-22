import { workspaceWriteAuthority } from '../../piagent-core/runtime/policy/workspace-write-authority.ts';
import { WORKSPACE_WRITE_ENTRY } from '../../piagent-core/runtime/session/workspace-member-edits.mjs';
import { WorkspaceWriteController, type WorkspaceWriteAdapterResult } from '../server/workspace-write-controller.ts';
import type { WorkspaceWritePayload } from '../contracts/generated/workspace-write-v1.ts';
import type { SessionRuntimeSupervisor } from './session-runtime-supervisor.ts';
import { projectRefForCwd, sessionRefForPath } from './session-catalog.ts';
import { WorkspaceWriteStore } from './workspace-write-store.ts';

export type ManagedWorkspaceWriter = (id: string, request: { kind: 'write-state' } | { kind: 'write'; payload: WorkspaceWritePayload }) => Promise<unknown>;
type Options = { root: string; key: Buffer; gatewayInstanceRef: string;
  runtimes: Pick<SessionRuntimeSupervisor, 'listSessions' | 'acquire' | 'liveSessionManager' | 'currentOperation'>;
  managed: boolean; managedWrite?: ManagedWorkspaceWriter; changed(sessionRef: string): void };

// One controller per catalog session owns serialization and durable receipts.
// Runtime eviction does not discard pending writes or idempotency evidence.
export class WorkspaceWriteSessions {
  readonly #options: Options;
  readonly #store: WorkspaceWriteStore;
  readonly #controllers = new Map<string, WorkspaceWriteController>();
  constructor(options: Options) { this.#options = options; this.#store = new WorkspaceWriteStore(options.root, options.key); }
  #controller(sessionRef: string): WorkspaceWriteController {
    const existing = this.#controllers.get(sessionRef); if (existing) return existing;
    const { runtimes, key, managed, managedWrite } = this.#options;
    const live = async () => {
      const info = (await runtimes.listSessions()).find(info => sessionRefForPath(key, info.path) === sessionRef);
      if (!info) throw new Error('workspace-session-unavailable');
      await runtimes.acquire(sessionRef);
      const manager = runtimes.liveSessionManager(sessionRef);
      if (!manager || manager.getSessionId() !== info.id) throw new Error('workspace-session-unavailable');
      if (!managed && manager.buildSessionContext().model?.provider === 'agent_watch_managed') throw new Error('workspace-company-boundary-required');
      return { info, manager };
    };
    const mirror = (manager: any) => {
      const seen = new Set(manager.getEntries().filter((entry: any) => entry.type === 'custom' && entry.customType === WORKSPACE_WRITE_ENTRY)
        .map((entry: any) => entry.data?.idempotencyKeyDigest));
      for (const receipt of this.#store.history(sessionRef)) if (receipt.phase === 'settled' && receipt.resultCode === 'saved' && !seen.has(receipt.idempotencyKeyDigest))
        manager.appendCustomEntry(WORKSPACE_WRITE_ENTRY, receipt);
    };
    const controller = new WorkspaceWriteController({
      facts: async () => {
        const { info, manager } = await live(); mirror(manager);
        const writable = managed ? (await managedWrite?.(info.id, { kind: 'write-state' }) as { writable?: unknown } | undefined)?.writable === true
          : workspaceWriteAuthority.writable(info.cwd, info.id);
        return { identity: { projectRef: projectRefForCwd(key, info.cwd), sessionRef, runtimeInstanceId: this.#options.gatewayInstanceRef,
          taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null }, writable, agentRunning: Boolean(runtimes.currentOperation(sessionRef)) };
      },
      history: () => this.#store.history(sessionRef),
      append: receipt => {
        this.#store.append(sessionRef, receipt);
        if (receipt.phase === 'settled' && receipt.resultCode === 'saved') {
          const manager = runtimes.liveSessionManager(sessionRef);
          if (manager) mirror(manager);
          this.#options.changed(sessionRef);
        }
      },
      write: async payload => {
        const { info } = await live();
        if (managed) {
          if (!managedWrite) throw new Error('workspace-company-boundary-required');
          return await managedWrite(info.id, { kind: 'write', payload }) as WorkspaceWriteAdapterResult;
        }
        return { state: 'saved', ...workspaceWriteAuthority.write(info.cwd, info.id, payload) };
      }
    });
    this.#controllers.set(sessionRef, controller); return controller;
  }
  state(sessionRef: string) { return this.#controller(sessionRef).state(); }
  execute(sessionRef: string, command: unknown) { return this.#controller(sessionRef).execute(command); }
}
