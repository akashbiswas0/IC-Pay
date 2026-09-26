import {
  CredentialRequest,
  IDKit,
  type IDKitSessionConfig,
} from "@worldcoin/idkit-core";

// idkit-core 4.3 session builders reject .preset(...), including selfieCheck().
// Use the released SDK's constraint API for both new and returning sessions.
export function createSelfieSession(
  config: IDKitSessionConfig,
  existingSessionId?: `session_${string}` | null,
) {
  const builder = existingSessionId
    ? IDKit.proveSession(existingSessionId, config)
    : IDKit.createSession(config);
  return builder.constraints(CredentialRequest("selfie"));
}
