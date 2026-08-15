/* Generated from schemas/piagent-webui/gateway-capabilities-v1.schema.json. Do not edit. */

export type PiagentGatewayCapabilityHandshakeV1 = {
  [k: string]: any;
} & {
  schemaVersion: 1;
  version: "piagent-gateway-capabilities-v1";
  generatedAt: string;
  gatewayInstanceRef: string;
  protocol: {
    minimum: 1;
    maximum: 1;
    selected: number | null;
    compatibility: "ready" | "incompatible" | "resync-required";
  };
  mode: "full" | "read-only" | "unavailable";
  capabilities: {
    catalog: Capability;
    events: Capability;
    terminalAdapter: Capability;
    sessionRuntime: Capability;
    sessionActions: {
      create: Capability;
      send: Capability;
      abort: Capability;
      setModel: Capability;
      setThinking: Capability;
      setPermission: Capability;
      rename: Capability;
      pin: Capability;
      archive: Capability;
      unarchive: Capability;
      fork: Capability;
      acquire: Capability;
      release: Capability;
    };
  };
  reasonCode: string | null;
};
export type Capability = {
  [k: string]: any;
} & {
  status: "available" | "unavailable";
  version: number | null;
  reasonCode: string | null;
};
