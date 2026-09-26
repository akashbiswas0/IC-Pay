import XCTest
import IDKit
@testable import SuicaPay

final class NativeWorldTests: XCTestCase {
    private func context(session: String? = nil, purpose: String = "enrollment") -> NativeWorldContext {
        NativeWorldContext(id: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", purpose: purpose,
            appId: "app_serialization_fixture", environment: "production", sessionId: session,
            rpContext: .init(rpID: "rp_fixture", nonce: "fixture-nonce", createdAt: 1, expiresAt: 4_000_000_000, signature: "fixture-not-signed"))
    }
    /// Serialization fixture only. Never sent to a verifier or accepted as identity.
    private func proof() -> [String: Any] {
        ["protocol_version": "4.0", "nonce": "fixture-nonce", "session_id": "session_" + String(repeating: "0", count: 128), "environment": "production",
         "responses": [["identifier": "selfie", "issuer_schema_id": 11, "session_nullifier": ["0x01", "0x02"], "expires_at_min": 0, "sybil_score": 17, "proof": ["0x01", "0x02", "0x03", "0x04", "0x05"]]],
         "integrity_bundle": ["version": 2, "signature_format": "apple_app_attest", "timestamp": 1, "signature": "0x01", "jwt": "serialization-fixture-only"]]
    }
    private func json(_ proof: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: proof), as: UTF8.self)
    }
    func testOfficialNativeFFIPreservesCompleteSelfieSessionFields() throws {
        let typed = try idkitResultFromJson(json: json(proof()))
        let encoded = try idkitResultToJson(result: typed)
        try NativeWorldSession.validateCompleteProof(encoded, context: context())
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any])
        let response = try XCTUnwrap((result["responses"] as? [[String: Any]])?.first)
        XCTAssertEqual(response["sybil_score"] as? Int, 17)
        XCTAssertEqual(response["proof"] as? [String], ["0x01", "0x02", "0x03", "0x04", "0x05"])
        XCTAssertEqual(response["session_nullifier"] as? [String], ["0x01", "0x02"])
        XCTAssertEqual((result["integrity_bundle"] as? [String: Any])?["version"] as? Int, 2)
    }
    func testIncompleteOrDifferentContextProofIsRejectedBeforeSubmission() throws {
        var missing = proof()
        var response = (missing["responses"] as! [[String: Any]])[0]
        response.removeValue(forKey: "sybil_score")
        missing["responses"] = [response]
        XCTAssertThrowsError(try NativeWorldSession.validateCompleteProof(json(missing), context: context()))
        var wrongNonce = proof(); wrongNonce["nonce"] = "different-operation"
        XCTAssertThrowsError(try NativeWorldSession.validateCompleteProof(json(wrongNonce), context: context()))
        let anotherSession = "session_" + String(repeating: "1", count: 128)
        XCTAssertThrowsError(try NativeWorldSession.validateCompleteProof(json(proof()), context: context(session: anotherSession, purpose: "login")))
    }
    func testReturningOperationsRequireExistingSessionAndFreshContext() throws {
        XCTAssertThrowsError(try context(purpose: "login").validate())
        XCTAssertThrowsError(try context(purpose: "replacement").validate())
        XCTAssertThrowsError(try context(purpose: "addition").validate())
        XCTAssertThrowsError(try context(purpose: "recovery").validate())
        XCTAssertThrowsError(try context(session: "session_" + String(repeating: "0", count: 128)).validate())
        XCTAssertThrowsError(try context().validate(now: Date(timeIntervalSince1970: 4_000_000_001)))
        XCTAssertNoThrow(try context(session: "session_" + String(repeating: "0", count: 128), purpose: "login").validate())
        XCTAssertNoThrow(try context(session: "session_" + String(repeating: "0", count: 128), purpose: "addition").validate())
        XCTAssertNoThrow(try context(session: "session_" + String(repeating: "0", count: 128), purpose: "recovery").validate())
    }
    func testOperationGuardRejectsCallbackAfterCancelAccountSwitchOrCompletion() {
        let operation = NativeWorldOperation(id: "request-one", accountGeneration: 4, attempt: 2)
        XCTAssertTrue(operation.matches(id: "request-one", accountGeneration: 4, attempt: 2))
        XCTAssertFalse(operation.matches(id: "request-one", accountGeneration: 4, attempt: 3))
        XCTAssertFalse(operation.matches(id: "request-one", accountGeneration: 5, attempt: 2))
        XCTAssertFalse(operation.matches(id: "request-two", accountGeneration: 4, attempt: 2))
        XCTAssertFalse(operation.matches(id: nil, accountGeneration: 4, attempt: 2))
    }
}
