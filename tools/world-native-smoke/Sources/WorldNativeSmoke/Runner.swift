import Foundation
import IDKit

@main struct Runner {
    static func main() async {
        do { try await run() }
        catch Failure.message(let reason) { print("FAIL: \(reason)"); exit(1) }
        catch { print("FAIL: Native SDK/transport error (\(String(describing: type(of: error))))."); exit(1) }
    }
    static func run() async throws {
        guard CommandLine.arguments.count == 2 else { throw Failure.message("Supply a fresh locally generated RP context JSON file.") }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let context = try JSONDecoder().decode(NativeWorldContext.self, from: data)
        try context.validate()

        // This is only a serialization fixture. It is never sent to a verifier,
        // treated as valid identity, or installed into an application account.
        let sample: [String: Any] = [
            "protocol_version": "4.0", "nonce": context.rpContext.nonce,
            "session_id": "session_" + String(repeating: "0", count: 128),
            "environment": "production",
            "responses": [["identifier": "selfie", "issuer_schema_id": 11,
                           "session_nullifier": ["0x01", "0x02"],
                           "expires_at_min": 0, "sybil_score": 17,
                           "proof": ["0x01", "0x02", "0x03", "0x04", "0x05"]]],
            "integrity_bundle": ["version": 2, "signature_format": "apple_app_attest",
                                 "timestamp": 1, "signature": "0x01", "jwt": "serialization-fixture-only"]
        ]
        let encoded = String(decoding: try JSONSerialization.data(withJSONObject: sample), as: UTF8.self)
        let typed = try idkitResultFromJson(json: encoded)
        let roundTrip = try idkitResultToJson(result: typed)
        let result = try JSONSerialization.jsonObject(with: Data(roundTrip.utf8)) as! [String: Any]
        let responses = result["responses"] as! [[String: Any]]
        guard responses[0]["sybil_score"] as? Int == 17,
              (result["integrity_bundle"] as? [String: Any])?["version"] as? Int == 2,
              responses[0]["session_nullifier"] as? [String] == ["0x01", "0x02"],
              responses[0]["proof"] as? [String] == ["0x01", "0x02", "0x03", "0x04", "0x05"] else {
            throw Failure.message("Native SDK dropped a required proof field during FFI serialization.")
        }
        try NativeWorldSession.validateCompleteProof(roundTrip, context: context)

        // Actual signed RP context, actual official native SDK, real World bridge.
        let session = try await NativeWorldSession.start(context: context)
        guard session.connectorURL.scheme == "https", session.connectorURL.host == "world.org" else { throw Failure.message("Unexpected World connector.") }
        let callback = URLComponents(url: session.connectorURL, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "return_to" }?.value
        guard callback == "suicapay://verify-return" else { throw Failure.message("Native callback missing.") }
        let event = try await session.pollOnce()
        switch event {
        case .waiting:
            print("PASS: required Selfie fields survive native FFI serialization; real native session created; World connector + native callback valid; bridge polling reports waiting. No identity proof completed.")
        case .awaitingConfirmation:
            print("PASS: real native session created and bridge connected. No identity proof completed by this test.")
        default: throw Failure.message("Unexpected native bridge status during smoke test.")
        }
    }
    enum Failure: Error { case message(String) }
}
