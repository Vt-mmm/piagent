import type { BasePolicy, FinalGateConfig } from "./guard-types.ts";

export function finalGateConfig(policy: BasePolicy, fallback: BasePolicy): Required<FinalGateConfig> {
  const diagnostic = policy.finalGate?.acceptanceProofMode === "diagnostic";
  return {
    acceptanceProofMode: diagnostic ? "diagnostic" : "enforce",
    defaultMode: policy.finalGate?.defaultMode ?? fallback.finalGate?.defaultMode ?? "enforce",
    requireTaskContract: diagnostic || (policy.finalGate?.requireTaskContract ?? true),
    requireContextManifest: diagnostic || (policy.finalGate?.requireContextManifest ?? true),
    requireVerifyEvidence: diagnostic || (policy.finalGate?.requireVerifyEvidence ?? true),
    requireTrace: diagnostic || (policy.finalGate?.requireTrace ?? true),
    requirePassingVerify: diagnostic || (policy.finalGate?.requirePassingVerify ?? true)
  };
}
