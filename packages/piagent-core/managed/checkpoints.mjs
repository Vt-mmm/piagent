import { BoundaryCheckpointGit } from './checkpoint-git.mjs';
import { TurnCheckpointService } from '../runtime/checkpoints/turn-checkpoints.mjs';

// Keep the company API and sandbox execution while sharing checkpoint behavior.
export class TurnCheckpoints extends TurnCheckpointService {
  constructor(managed) {
    super(new BoundaryCheckpointGit(managed), { busy: () => managed.activePrompt });
    this.managed = managed;
  }
  take(run = this.managed.run) {
    if (run && !run.turnRef) {
      const branch = this.managed.session?.sessionManager?.getBranch?.() ?? [];
      const entry = [...branch].reverse().find(entry => entry.type === 'message' && entry.message?.role === 'user');
      if (entry?.id) run.turnRef = entry.id;
    }
    return super.take(run);
  }
  finish(run = this.managed.run) { return super.finish(run); }
}
export const checkpointsOf = managed => (managed.checkpoints ??= new TurnCheckpoints(managed));
