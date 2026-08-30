ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /executor
COPY package.json package-lock.json worker.mjs protocol.mjs values.mjs intrinsics.mjs module-graph.mjs guest.mjs ./
COPY node_modules ./node_modules
USER 65534:65534
ENTRYPOINT ["timeout", "--signal=KILL", "8s", "node", "--max-old-space-size=96", "/executor/worker.mjs"]
