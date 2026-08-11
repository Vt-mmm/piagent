// Compatibility boundary: the authority implementation lives in the capability
// layer so both core Task Contract code and runtime consumers can depend on it
// without reversing the core -> runtime architecture boundary.
export * from "../../capabilities/authority-manifest.ts";
