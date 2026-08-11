export const EXECUTION_BACKEND_SCHEMA_VERSION = 1;

export function resolveExecutionBackend(input = {}) {
  const requested = String(input.backend ?? process.env.PIAGENT_EXECUTION_BACKEND ?? "host").trim().toLowerCase();
  if (requested === "host") {
    return {
      schemaVersion: EXECUTION_BACKEND_SCHEMA_VERSION,
      backend: "host",
      requested,
      valid: true,
      available: true,
      experimental: false,
      credentialsOwner: "pi-host",
      boundary: "Pi and the local OS execute commands; Piagent only evaluates policy before tool calls."
    };
  }
  if (["docker", "devcontainer", "sandbox"].includes(requested)) {
    const available = input.adapterAvailable === true;
    return {
      schemaVersion: EXECUTION_BACKEND_SCHEMA_VERSION,
      backend: requested,
      requested,
      valid: true,
      available,
      experimental: true,
      credentialsOwner: "pi-host",
      boundary: "Experimental execution backend may isolate process/filesystem resources, but OAuth/session credentials remain owned by Pi host.",
      requiresExplicitOperatorApproval: true,
      warning: available ? undefined : `${requested} execution adapter is not installed; mutation remains blocked.`
    };
  }
  return {
    schemaVersion: EXECUTION_BACKEND_SCHEMA_VERSION,
    backend: "host",
    requested,
    valid: false,
    available: true,
    experimental: false,
    credentialsOwner: "pi-host",
    boundary: "Unknown backend request ignored; host remains active.",
    warning: `Unsupported execution backend: ${requested}`
  };
}

export function executionBackendAllowsMutation(backend, operatorApproved = false) {
  if (backend?.valid === false) {
    return { allowed: false, reason: `Unsupported execution backend ${backend.requested}; fix the configuration before mutation.` };
  }
  if (backend?.available === false) {
    return { allowed: false, reason: `${backend.backend} execution adapter is not installed; mutation cannot be isolated as requested.` };
  }
  if (!backend?.experimental) return { allowed: true };
  if (operatorApproved) return { allowed: true };
  return {
    allowed: false,
    reason: `${backend.backend} execution backend is experimental and requires explicit operator approval before mutation.`
  };
}

export function executionBackendToolDecision(isMutation, input = {}) {
  if (!isMutation) return { allowed: true };
  return executionBackendAllowsMutation(resolveExecutionBackend(input), input.operatorApproved === true);
}
