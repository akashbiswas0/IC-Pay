import XCTest
@testable import SuicaPay

final class SpendingFormTests: XCTestCase {
    func testDraftRoundTripsThroughDeviceKeychainWithoutCrossingSessions() throws {
        let key = "spending-regression." + UUID().uuidString
        defer { try? Keychain.save(nil, key: key) }
        let draft = SpendingForm(perPayment: "7.25", total: "20", merchantIDs: ["TEST"])
        try Keychain.save(JSONEncoder().encode(draft), key: key)
        let reloaded = try JSONDecoder().decode(SpendingForm.self, from: XCTUnwrap(Keychain.read(key)))
        XCTAssertEqual(SpendingForm.restored(draft: reloaded, pending: nil, policy: nil, decimals: 18), draft)
        XCTAssertNil(try Keychain.read(key + ".another-session"))
    }
    func testPersistedDraftSurvivesNewScreenAndPartialEdits() throws {
        let draft = SpendingForm(perPayment: "7.25", total: "", expires: Date(timeIntervalSince1970: 2_000_000_000), merchantIDs: ["TEST"])
        let data = try JSONEncoder().encode(draft)
        let loaded = try JSONDecoder().decode(SpendingForm.self, from: data)
        XCTAssertEqual(SpendingForm.restored(draft: loaded, pending: nil, policy: nil, decimals: 18), draft)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(fields["consent"])
        XCTAssertNil(fields["enabled"])
    }
    func testPendingApprovalKeepsItsOriginalTerms() {
        let pending = SpendingForm(perPayment: "5", total: "10", merchantIDs: ["approved-merchant"])
        let edited = SpendingForm(perPayment: "500", total: "1000", merchantIDs: ["other-merchant"])
        XCTAssertEqual(SpendingForm.restored(draft: edited, pending: pending, policy: nil, decimals: 18), pending)
    }
    func testSavedPolicyRestoresMerchantIDsAndLimits() throws {
        let policy = try JSONDecoder().decode(Policy.self, from: Data(#"{"enabled":true,"perPaymentLimit":"7250000000000000000","totalLimit":"20000000000000000000","spent":"0","expiresAt":"2033-05-18T03:33:20Z","merchantIds":["TEST"]}"#.utf8))
        let form = SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 18)
        XCTAssertEqual(form.perPayment, "7.25")
        XCTAssertEqual(form.total, "20")
        XCTAssertEqual(form.merchantIDs, ["TEST"])
        XCTAssertEqual(form.expires, Date(timeIntervalSince1970: 2_000_000_000))
    }
    func testLegacyPolicyWithoutMerchantsDecodesWithoutInventingAccess() throws {
        let policy = try JSONDecoder().decode(Policy.self, from: Data(#"{"enabled":false,"perPaymentLimit":"1","totalLimit":"2","spent":"0","expiresAt":"2033-05-18T03:33:20Z"}"#.utf8))
        XCTAssertTrue(SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 0).merchantIDs.isEmpty)
    }
}
