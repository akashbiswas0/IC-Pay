import XCTest
import CryptoKit
@testable import SuicaPay

final class ProtocolTests: XCTestCase {
    func testExactAmountConversionBeyondDoublePrecision() throws {
        XCTAssertEqual(try TokenAmount.units("12345678901234567890.123456", decimals: 6), "12345678901234567890123456")
        XCTAssertEqual(TokenAmount.display("12345678901234567890123456", decimals: 6), "12345678901234567890.123456")
        XCTAssertEqual(try TokenAmount.units("0.000001", decimals: 6), "1")
        XCTAssertEqual(TokenAmount.display("1", decimals: 6), "0.000001")
    }
    func testInvalidAmountsAreRejected() {
        for amount in ["0", "-1", "1e18", "1,000", "0.0000001", "nan", "1\n2"] {
            XCTAssertThrowsError(try TokenAmount.units(amount, decimals: 6), amount)
        }
    }
    func testCanonicalPayloadAndDERSignature() throws {
        let payload = ScanPayload(terminalId: "terminal", invoiceId: "invoice", challenge: "nonce", cardId: "0123456789ABCDEF", chainId: "11155111", token: "0xabc", amount: "500", expiresAt: "2026-09-26T00:00:00.000Z")
        let canonical = try payload.canonicalBytes()
        XCTAssertEqual(String(decoding: canonical, as: UTF8.self), "suica-payments-v1\nterminal\ninvoice\nnonce\n0123456789ABCDEF\n11155111\n0xabc\n500\n2026-09-26T00:00:00.000Z")
        let key = P256.Signing.PrivateKey()
        let der = try key.signature(for: canonical).derRepresentation
        let signature = try P256.Signing.ECDSASignature(derRepresentation: der)
        let publicKey = try P256.Signing.PublicKey(derRepresentation: key.publicKey.derRepresentation)
        XCTAssertTrue(publicKey.isValidSignature(signature, for: canonical))
        XCTAssertFalse(publicKey.isValidSignature(signature, for: canonical + Data("tampered".utf8)))
    }
    func testCanonicalNewlineInjectionIsRejected() {
        let payload = ScanPayload(terminalId: "terminal\ninjected", invoiceId: "invoice", challenge: "nonce", cardId: "0123456789ABCDEF", chainId: "1", token: "0xabc", amount: "1", expiresAt: "expiry")
        XCTAssertThrowsError(try payload.canonicalBytes())
    }
    func testServerRequiresHTTPSWithoutEmbeddedCredentials() throws {
        XCTAssertEqual(try APIClient.validatedURL("https://payments.example.com").host, "payments.example.com")
        for url in ["http://payments.example.com", "https://user:secret@payments.example.com", "https://payments.example.com?token=secret", "https://payments.example.com#secret"] {
            XCTAssertThrowsError(try APIClient.validatedURL(url))
        }
    }
}

final class SessionSafetyTests: XCTestCase {
    @MainActor func testStaleSessionCannotIssueNetworkRequest() async throws {
        let client = SessionAPIClient(client: APIClient(baseURL: try APIClient.validatedURL("https://unused.invalid"), token: nil), isCurrent: { false })
        do {
            let _: EmptyResponse = try await client.call("v1/dashboard")
            XCTFail("Stale session must fail before any network request")
        } catch is CancellationError {
            // A cancelled generation never reaches the network or updates account state.
        } catch { XCTFail("Expected cancellation, received \(error)") }
    }
}

final class ProductConfigurationTests: XCTestCase {
    func testBundledConfigurationRequiresRealHTTPSOrigins() throws {
        let config = try BuildConfiguration.parse(api: "https://api.example.com", web: "https://app.example.com")
        XCTAssertEqual(config.apiURL.host, "api.example.com")
        XCTAssertEqual(config.webURL.host, "app.example.com")
        for values: (String?, String?) in [(nil, nil), ("$(SUICA_API_BASE_URL)", "https://app.example.com"), ("http://api.example.com", "https://app.example.com"), ("https://api.example.com", "https://user:secret@app.example.com")] {
            XCTAssertThrowsError(try BuildConfiguration.parse(api: values.0, web: values.1))
        }
    }
    func testServiceDatesPreserveFractionalAndWholeSecondExpiry() {
        XCTAssertNotNil(AppDates.date("2026-09-26T10:00:00.123Z"))
        XCTAssertNotNil(AppDates.date("2026-09-26T10:00:00Z"))
        XCTAssertNil(AppDates.date("tomorrow"))
    }
}

final class WorldHandoffMigrationTests: XCTestCase {
    private let requestID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    private let capability = String(repeating: "x", count: 43)
    private let oldServer = "https://previous.example.com"
    private let newServer = "https://current.example.com"

    func testLegacyHandoffRecoversCapabilityWithoutRestoringBrowserNavigation() throws {
        let legacyURL = URL(string: "https://untrusted.example/verify#handoffToken=\(capability)&requestId=\(requestID)")!
        let old = PendingWorldHandoff(id: requestID, handoffToken: nil, url: legacyURL, server: oldServer, sessionHash: "session-hash", exchangeSecret: "local-exchange-secret")
        let migrated = try old.rebased(from: oldServer, session: "session-hash", to: newServer)
        XCTAssertEqual(try migrated.capability(), capability)
        XCTAssertNil(migrated.url)
        XCTAssertEqual(migrated.exchangeSecret, "local-exchange-secret")
        XCTAssertEqual(migrated.resolvedAccountAccess, .login)
        XCTAssertEqual(migrated.server, newServer)
    }
    func testMigrationRejectsDifferentSessionOrNonAllowlistedServer() throws {
        let pending = PendingWorldHandoff(id: requestID, handoffToken: capability, url: nil, server: oldServer, sessionHash: "original-session", exchangeSecret: nil)
        XCTAssertThrowsError(try pending.rebased(from: "https://other.example", session: "original-session", to: newServer))
        XCTAssertThrowsError(try pending.rebased(from: oldServer, session: "different-session", to: newServer))
    }
    func testLegacyFragmentRejectsMismatchedAndDuplicateRequestIDs() {
        for fragment in ["handoffToken=\(capability)&requestId=wrong", "handoffToken=\(capability)&requestId=\(requestID)&requestId=\(requestID)", "handoffToken=\(capability)&requestId=\(requestID)&redirect=https://untrusted.example"] {
            let pending = PendingWorldHandoff(id: requestID, handoffToken: nil, url: URL(string: oldServer + "/verify#" + fragment), server: oldServer, sessionHash: "session", exchangeSecret: nil)
            XCTAssertThrowsError(try pending.capability())
        }
    }
    func testExistingLegacyRecordDecodesWithoutNewCapabilityField() throws {
        let record: [String: String] = ["id": requestID, "url": oldServer + "/verify#handoffToken=" + capability + "&requestId=" + requestID, "server": oldServer, "sessionHash": "session"]
        let decoded = try JSONDecoder().decode(PendingWorldHandoff.self, from: JSONSerialization.data(withJSONObject: record))
        XCTAssertEqual(try decoded.capability(), capability)
        XCTAssertNil(decoded.exchangeSecret)
        XCTAssertNil(decoded.cardLink)
    }
    func testAddingOrReplacingCardsKeepsItsIntentAcrossRelaunchAndOriginMigration() throws {
        for intent in [CardLinkIntent.addition, .replacement("11111111-2222-4333-8444-555555555555")] {
            let pending = PendingWorldHandoff(id: requestID, handoffToken: capability, url: nil, server: oldServer, sessionHash: "session", exchangeSecret: nil, nativeStarted: true, cardLink: intent)
            let restored = try JSONDecoder().decode(PendingWorldHandoff.self, from: JSONEncoder().encode(pending))
            XCTAssertEqual(restored.cardLink, intent)
            let migrated = try restored.rebased(from: oldServer, session: "session", to: newServer)
            XCTAssertEqual(migrated.cardLink, intent, "An added card must never restart as a replacement")
        }
    }
    func testAccountRecoverySurvivesRelaunchWithoutBecomingCardEnrollment() throws {
        let pending = PendingWorldHandoff(id: requestID, handoffToken: capability, url: nil, server: oldServer, sessionHash: "session", exchangeSecret: "local-recovery-secret", nativeStarted: true, accountAccess: .recovery)
        let restored = try JSONDecoder().decode(PendingWorldHandoff.self, from: JSONEncoder().encode(pending))
        let migrated = try restored.rebased(from: oldServer, session: "session", to: newServer)
        XCTAssertEqual(migrated.resolvedAccountAccess, .recovery)
        XCTAssertNil(migrated.cardLink)
        XCTAssertEqual(migrated.exchangeSecret, pending.exchangeSecret)
    }
    func testPreviousDeploymentRequiresExplicitSafeBundledURL() throws {
        XCTAssertNil(try BuildConfiguration.parse(api: newServer, web: newServer).previousAPIURL)
        XCTAssertEqual(try BuildConfiguration.parse(api: newServer, web: newServer, previousAPI: oldServer).previousAPIURL?.absoluteString, oldServer)
        XCTAssertThrowsError(try BuildConfiguration.parse(api: newServer, web: newServer, previousAPI: "http://previous.example.com"))
    }
}


final class VerificationCancellationTests: XCTestCase {
    func testOnlyServerConfirmedCancellationOrCompletedProofAreAccepted() throws {
        let decoder = JSONDecoder()
        XCTAssertEqual(try decoder.decode(VerificationCancellation.self, from: Data(#"{"status":"cancelled"}"#.utf8)).status, .cancelled)
        XCTAssertEqual(try decoder.decode(VerificationCancellation.self, from: Data(#"{"status":"verified"}"#.utf8)).status, .verified)
        XCTAssertThrowsError(try decoder.decode(VerificationCancellation.self, from: Data(#"{"status":"pending"}"#.utf8)))
        XCTAssertThrowsError(try decoder.decode(VerificationCancellation.self, from: Data(#"{"status":"failed"}"#.utf8)))
    }
}


final class AccountAccessTests: XCTestCase {
    func testAuthenticatedMerchantDoesNotRequireCustomerWorldEnrollment() {
        XCTAssertTrue(Account(id: "merchant-account", role: "merchant", verified: false).canAccessApp)
        XCTAssertTrue(Account(id: "admin-account", role: "admin", verified: false).canAccessApp)
        XCTAssertFalse(Account(id: "new-customer", role: "customer", verified: false).canAccessApp)
        XCTAssertTrue(Account(id: "verified-customer", role: "customer", verified: true).canAccessApp)
        XCTAssertFalse(Account(id: "unknown", role: "unknown", verified: true).canAccessApp)
    }
}

final class PaymentHapticTests: XCTestCase {
    private func state(_ status: String, id: String = "invoice-a") -> PaymentFeedbackState {
        PaymentFeedbackState(invoiceID: id, status: status)
    }
    func testOnlyConfirmedPaymentProducesSuccess() {
        for status in ["awaiting_tap", "authorised", "submitting", "pending", "reconciling"] {
            XCTAssertNil(PaymentFeedbackState.outcome(from: state("awaiting_tap"), to: state(status)))
        }
        XCTAssertEqual(PaymentFeedbackState.outcome(from: state("pending"), to: state("confirmed")), .success)
        XCTAssertEqual(PaymentFeedbackState.outcome(from: state("pending"), to: state("failed")), .error)
        XCTAssertEqual(PaymentFeedbackState.outcome(from: state("awaiting_tap"), to: state("expired")), .warning)
    }
    func testRestorationPollingAndCancellationStayQuiet() {
        for status in ["confirmed", "failed", "expired"] {
            XCTAssertNil(PaymentFeedbackState.outcome(from: nil, to: state(status)))
            XCTAssertNil(PaymentFeedbackState.outcome(from: state(status), to: state(status)))
            XCTAssertNil(PaymentFeedbackState.outcome(from: state("pending"), to: state(status, id: "invoice-b")))
        }
        XCTAssertNil(PaymentFeedbackState.outcome(from: state("awaiting_tap"), to: state("cancelled")))
        XCTAssertNil(PaymentFeedbackState.outcome(from: state("confirmed"), to: nil))
    }
}
