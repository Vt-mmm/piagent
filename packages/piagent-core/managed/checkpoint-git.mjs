// This adapter contains no host Git/filesystem access. The pinned workspace
// worker applies path policy and byte-preserving Git operations in the sandbox.
export class BoundaryCheckpointGit {
  constructor(managed) { this.managed = managed; }
  request(operation, payload = {}, guard) {
    guard?.();
    return this.managed.boundary.invoke('workspace', { kind: 'checkpoint', operation, ...payload },
      undefined, undefined, undefined, { guard });
  }
  available() { return this.request('available'); }
  tree() { return this.request('tree'); }
  changed(from, to) { return this.request('changed', { from, to }); }
  restore(before, restore, remove, expectedTree, guard) {
    return this.request('restore', { before, restore, remove, expectedTree }, guard);
  }
}
