type SessionContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};

export class EditRecoveryDeliveryState {
  readonly #sessions = new WeakMap<SessionContext["sessionManager"], { identity: string; epoch: number; delivered: Set<string> }>();

  #sessionKey(ctx: SessionContext): string {
    return `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
  }

  #session(ctx: SessionContext): { identity: string; epoch: number; delivered: Set<string> } {
    const identity = this.#sessionKey(ctx), existing = this.#sessions.get(ctx.sessionManager);
    if (existing?.identity === identity) return existing;
    const created = { identity, epoch: 0, delivered: new Set<string>() };
    this.#sessions.set(ctx.sessionManager, created);
    return created;
  }

  reserve(ctx: SessionContext, taskRunId: string, recoveryKey: string): boolean {
    const session = this.#session(ctx);
    const key = `${session.epoch}\0${taskRunId}\0${recoveryKey}`;
    if (session.delivered.has(key)) return false;
    // Refuse further automatic recovery in this context epoch once the bounded
    // allowance is exhausted. Evicting an old key would permit duplicate
    // injection and make recovery tokens unbounded under repeated failures.
    if (session.delivered.size >= 16) return false;
    session.delivered.add(key);
    return true;
  }

  advanceEpoch(ctx: SessionContext): void {
    const session = this.#session(ctx);
    session.epoch += 1;
    session.delivered.clear();
  }

  clearSession(ctx: SessionContext): void {
    this.#sessions.delete(ctx.sessionManager);
  }
}
