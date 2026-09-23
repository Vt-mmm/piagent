FROM piagent-da2-node-g0:20260831-1231@sha256:ae73771c2e50bcbfd18c19efe4c01cb800dbb66c408e2fc17d2de7e28cd18339
WORKDIR /executor
COPY Dockerfile package.json package-lock.json worker.mjs protocol.mjs values.mjs intrinsics.mjs module-graph.mjs guest.mjs budget.mjs capabilities.mjs callback-intrinsics.mjs jobs.mjs references.mjs reference-identity.mjs invocation.mjs structured-clone.mjs node-profile.mjs ./
USER 65534:65534
ENTRYPOINT ["timeout", "--signal=KILL", "8s", "node", "--max-old-space-size=96", "/executor/worker.mjs"]
