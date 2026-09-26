import XCTest
import CryptoKit
#if SWIFT_PACKAGE
@testable import RewardModels
#else
@testable import SuicaPay
#endif

final class RewardProtocolTests: XCTestCase {
    func testOfferSummaryPreservesFractionalDiscountAndExactDuration() {
        let campaign = RewardCampaign(enabled: true, minPurchase: "20000000", discountBps: 1255, maxDiscount: "10000001", validitySeconds: 90061, version: 4)
        let draft = RewardCampaignDraft(campaign: campaign, decimals: 6)
        let expected = "Spend at least 20 MJPY to earn 12.55% off a later visit, up to 10.000001 MJPY. Valid for 1 day, 1 hour, 1 minute, 1 second."
        XCTAssertEqual(RewardFormatting.offer(campaign, decimals: 6, symbol: "MJPY"), expected)
        XCTAssertEqual(draft.offerSummary(decimals: 6, symbol: "MJPY"), expected)
        XCTAssertTrue(draft.matches(campaign, decimals: 6))
        XCTAssertNil(draft.requestID)
        XCTAssertEqual(RewardFormatting.duration(60), "1 minute")
        XCTAssertEqual(RewardFormatting.duration(43_200), "12 hours")
    }
    func testIncompleteOfferSummaryDoesNotInventValidTermsOrMutateIdentity() {
        var draft = RewardCampaignDraft()
        draft.requestID = "persisted-update"
        draft.discountPercent = "100"
        XCTAssertNil(draft.offerSummary(decimals: 18, symbol: "MJPY"))
        XCTAssertEqual(draft.requestID, "persisted-update")
        draft.discountPercent = "50"
        draft.validityDays = ""
        XCTAssertNil(draft.offerSummary(decimals: 18, symbol: "MJPY"))
    }
    func testTestFundingEligibilityFailsClosedForExistingOrUnavailableClaims() throws {
        let claimed = #"{"status":"available","amount":"1000000000000000000000","symbol":"MJPY","canClaim":true,"claim":{"id":"claim","status":"failed","cardId":"card-A","walletAddress":"0xABC","amount":"1000000000000000000000","txHash":null,"explorerUrl":null,"errorCode":"transaction_reverted"}}"#
        let response = try JSONDecoder().decode(TestFundingResponse.self, from: Data(claimed.utf8))
        XCTAssertFalse(response.permitsNewClaim, "Even inconsistent canClaim must not remint an existing claim")
        for status in ["pending_setup", "unavailable", "unknown"] {
            let body = "{\"status\":\"\(status)\",\"amount\":\"1000\",\"symbol\":\"MJPY\",\"canClaim\":true,\"claim\":null}"
            XCTAssertFalse(try JSONDecoder().decode(TestFundingResponse.self, from: Data(body.utf8)).permitsNewClaim)
        }
    }
    func testTestFundingConfirmationIsBoundToBothCardAndWallet() throws {
        let json = #"{"id":"claim","status":"confirmed","cardId":"card-A","walletAddress":"0xABC","amount":"1000","txHash":"transaction","explorerUrl":null,"errorCode":null}"#
        let claim = try JSONDecoder().decode(TestFundingClaim.self, from: Data(json.utf8))
        XCTAssertTrue(claim.belongsTo(cardID: "card-A", address: "0xabc"))
        XCTAssertFalse(claim.belongsTo(cardID: "card-B", address: "0xabc"))
        XCTAssertFalse(claim.belongsTo(cardID: "card-A", address: "0xdef"))
        XCTAssertFalse(claim.belongsTo(cardID: nil, address: nil))
        XCTAssertTrue(claim.belongsTo(cardID: nil, address: "0xabc"))
        XCTAssertFalse(claim.isPending)
        for status in ["queued", "submitting", "pending", "reconciling"] {
            let pending = try JSONDecoder().decode(TestFundingClaim.self, from: Data(json.replacingOccurrences(of: "confirmed", with: status).utf8))
            XCTAssertTrue(pending.isPending)
        }
    }
    func testLegacyScopeDraftAndPendingRemainSelectedUntilExplicitNewEdit() throws {
        let legacy = #"{"perPayment":"20","total":"100","expires":2000000000,"merchantIDs":["merchant-old"],"useRewards":true}"#
        let draft = try JSONDecoder().decode(SpendingForm.self, from: Data(legacy.utf8))
        XCTAssertEqual(draft.merchantScope, .selected)
        let pendingJSON = #"{"perPayment":"2000","total":"10000","expiresAt":"2033-05-18T03:33:20Z","merchantIDs":["merchant-old"],"jobID":"job","requestID":"identity"}"#
        let pending = try JSONDecoder().decode(PendingSpendingPermission.self, from: Data(pendingJSON.utf8))
        XCTAssertEqual(pending.effectiveMerchantScope, .selected)
        XCTAssertEqual(pending.merchantIDs, ["merchant-old"])
        XCTAssertEqual(pending.requestID, "identity")
        XCTAssertEqual(draft.editingAllMerchants(pending: true), draft)
        let edit = draft.editingAllMerchants(pending: false)
        XCTAssertEqual(edit.merchantScope, .all)
        XCTAssertTrue(edit.merchantIDs.isEmpty)
        XCTAssertEqual(edit.perPayment, draft.perPayment)
        XCTAssertEqual(edit.total, draft.total)
        XCTAssertEqual(edit.expires, draft.expires)
        XCTAssertEqual(edit.useRewards, draft.useRewards)
        XCTAssertEqual(SpendingForm.restored(draft: edit, pending: draft, policy: nil, decimals: 2), draft)
        let reloaded = try JSONDecoder().decode(PendingSpendingPermission.self, from: JSONEncoder().encode(pending))
        XCTAssertEqual(reloaded.effectiveMerchantScope, .selected)
    }
    func testAllMerchantPolicyRestoresAndMatchesWithoutMerchantIDs() throws {
        let json = #"{"enabled":true,"perPaymentLimit":"2000","totalLimit":"10000","spent":"300","expiresAt":"2033-05-18T03:33:20Z","merchantIds":[],"merchantScope":"all","useRewards":true}"#
        let policy = try JSONDecoder().decode(Policy.self, from: Data(json.utf8))
        let form = SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 2)
        XCTAssertEqual(form.merchantScope, .all)
        XCTAssertEqual(form.perPayment, "20")
        XCTAssertEqual(form.total, "100")
        XCTAssertTrue(form.merchantIDs.isEmpty)
        XCTAssertTrue(form.matches(policy, decimals: 2))
        XCTAssertTrue(form.isEnabled(in: policy, decimals: 2, now: Date(timeIntervalSince1970: 1_000_000_000)))
        var changed = form; changed.merchantScope = .selected
        XCTAssertFalse(changed.matches(policy, decimals: 2))
        changed = form; changed.total = "101"
        XCTAssertFalse(changed.matches(policy, decimals: 2))
        let legacy = try JSONDecoder().decode(Policy.self, from: Data(json.replacingOccurrences(of: ",\"merchantScope\":\"all\"", with: "").utf8))
        XCTAssertEqual(legacy.effectiveMerchantScope, .selected)
        XCTAssertFalse(form.matches(legacy, decimals: 2))
        XCTAssertEqual(SpendingForm().merchantScope, .all)
    }
    private func creditCollectible(contract: String = "0x1111111111111111111111111111111111111111", remaining: String = "300", status: String = "available", events: Bool = true) throws -> RewardVoucher {
        var object: [String: Any] = ["id": "1", "tokenId": "1", "contractAddress": contract, "collectionKey": contract + ":1", "rewardType": "credit", "cardId": "card", "walletAddress": "wallet", "merchantId": "merchant", "merchantName": "Shop", "discountBps": NSNull(), "maxDiscount": NSNull(), "minPurchase": NSNull(), "expiresAt": "2033-05-18T03:33:20Z", "status": status, "creditAmount": "500", "remainingCredit": remaining, "purchaseAmount": "10000", "nftOwned": true, "symbol": "MJPY", "decimals": 2, "imageUrl": "https://art.example/print.jpg"]
        if events { object["events"] = [
            ["id": "issue:0", "kind": "earned", "createdAt": "2026-09-26T04:00:00Z", "txHash": "issue"],
            ["id": "partial:2", "kind": "redeemed", "createdAt": "2026-09-26T05:00:00Z", "txHash": "partial", "discountAmount": "200", "remainingCredit": "300"],
            ["id": "final:3", "kind": "redeemed", "createdAt": "2026-09-26T06:00:00Z", "txHash": "final", "discountAmount": "300", "remainingCredit": "0"]
        ] }
        return try JSONDecoder().decode(RewardVoucher.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testCreditOwnershipSurvivesPartialRedemptionExhaustionAndExpiry() throws {
        let partial = try creditCollectible()
        XCTAssertTrue(partial.isCredit)
        XCTAssertTrue(partial.hasSpendableValue)
        XCTAssertTrue(partial.retainedCollectible)
        XCTAssertEqual(partial.statusTitle, "Credit partly used")
        XCTAssertNil(partial.discountBps)
        XCTAssertNil(partial.minPurchase)
        let used = try creditCollectible(remaining: "0", status: "used")
        XCTAssertFalse(used.hasSpendableValue)
        XCTAssertTrue(used.retainedCollectible)
        XCTAssertEqual(used.statusTitle, "Credit redeemed · NFT kept")
        let expired = try creditCollectible(status: "expired")
        XCTAssertFalse(expired.hasSpendableValue)
        XCTAssertTrue(expired.retainedCollectible)
        XCTAssertNotNil(expired.artworkURL)
        XCTAssertFalse(try voucher(status: "used", redeemedHash: "burn").retainedCollectible)
    }
    func testCollectionIdentityAndReceiptEventsPreserveEveryPartialRedemption() throws {
        let first = try creditCollectible(), second = try creditCollectible(contract: "0x2222222222222222222222222222222222222222")
        XCTAssertEqual(first.id, second.id)
        XCTAssertNotEqual(first.collectionIdentity, second.collectionIdentity)
        let events = RewardActivity.events(first)
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events.filter { $0.kind == .redeemed }.map(\.discountAmount), ["200", "300"])
        XCTAssertEqual(events.last?.remainingCredit, "0")
        let timeline = WalletActivity.timeline(payments: [], funding: [], rewards: [first, second, first])
        XCTAssertEqual(timeline.count, 6)
        XCTAssertEqual(Set(timeline.map(\.id)).count, 6)
        XCTAssertTrue(RewardActivity.events(try creditCollectible(events: false)).isEmpty, "A credit snapshot must never manufacture receipt events")
    }
    func testFullyCreditFundedReceiptKeepsZeroNetAmount() throws {
        let json = #"{"id":"invoice","merchantId":"merchant","recipient":"address","amount":"0","token":"token","chainId":"11155111","expiresAt":"2033-05-18T03:33:20Z","status":"confirmed","grossAmount":"300","discountAmount":"300","rewardId":"1","scanVersion":2}"#
        let receipt = try JSONDecoder().decode(Invoice.self, from: Data(json.utf8))
        XCTAssertEqual(TokenAmount.display(receipt.amount, decimals: 2), "0")
        XCTAssertEqual(receipt.grossAmount, receipt.discountAmount)
        XCTAssertTrue(receipt.isFinished)
        XCTAssertEqual(receipt.amount, "0", "A free net payment must not become its gross amount")
    }
    func testCreditCampaignFieldsNeverBecomePercentageDiscountTerms() throws {
        var draft = CollectibleCampaignDraft()
        XCTAssertFalse(draft.enabled)
        let body = try draft.requestBody(decimals: 2, requestID: "durable-credit-id")
        XCTAssertEqual(body["earnBps"] as? Int, 500)
        XCTAssertEqual(body["minPurchase"] as? String, "100")
        XCTAssertEqual(body["maxCredit"] as? String, "5000")
        XCTAssertNil(body["discountBps"])
        XCTAssertNil(body["maxDiscount"])
        XCTAssertEqual(body["requestId"] as? String, "durable-credit-id")
        draft.earnPercent = "100"
        XCTAssertEqual(try draft.normalized(decimals: 2).earnBps, 10_000)
        draft.earnPercent = "100.01"
        XCTAssertThrowsError(try draft.normalized(decimals: 2))
    }
    func testPendingApprovalNeverChangesItsRouterDuringRestore() throws {
        let json = #"{"perPayment":"2000","total":"10000","expiresAt":"2033-05-18T03:33:20Z","merchantIDs":[],"merchantScope":"all","jobID":"old-job","requestID":"old-request","router":"rewards","routerAddress":"0xOLD"}"#
        let pending = try JSONDecoder().decode(PendingSpendingPermission.self, from: Data(json.utf8))
        XCTAssertFalse(pending.matchesRouter(kind: "collectibles", address: "0xNEW"))
        XCTAssertTrue(pending.matchesRouter(kind: "rewards", address: "0xold"))
        let restored = try JSONDecoder().decode(PendingSpendingPermission.self, from: JSONEncoder().encode(pending))
        XCTAssertEqual(restored.router, "rewards")
        XCTAssertEqual(restored.routerAddress, "0xOLD")
        XCTAssertEqual(restored.requestID, "old-request")
        let older = PendingSpendingPermission(perPayment: "1", total: "2", expiresAt: "expiry", merchantIDs: ["shop"], jobID: "legacy")
        XCTAssertFalse(older.matchesRouter(kind: "collectibles", address: "0xNEW"))
        XCTAssertTrue(older.matchesRouter(kind: "legacy", address: "0xLEGACY"))
    }
    func testTimedOutCampaignAlwaysOffersExactRequestRecovery() throws {
        let original = Data(#"{ "requestId": "unchanged-uuid", "enabled": true, "earnBps": 500, "minPurchase":"100", "maxCredit":"5000", "validitySeconds":2592000 }"#.utf8)
        for status in ["queued", "pending", "confirmed", "failed"] {
            let latest = RewardCampaignOperation(id: "latest-may-be-unrelated", status: status, txHash: nil, errorCode: nil)
            XCTAssertTrue(CampaignRecovery.showsSubmit(hasPendingRequest: true, operation: latest, hasReadError: false), "Lost PUT response must not hide Recover update when GET returns \(status)")
            XCTAssertFalse(CampaignRecovery.shouldRetire(hasPendingRequest: true, knownOperationID: nil, operation: latest))
            XCTAssertEqual(try CampaignRecovery.replayPayload(original, requestID: "unchanged-uuid"), original)
        }
        XCTAssertThrowsError(try CampaignRecovery.replayPayload(original, requestID: "new-uuid"))
        XCTAssertThrowsError(try CampaignRecovery.replayPayload(nil, requestID: "unchanged-uuid"))
    }
    func testCampaignRecoveryClearsOnlyBoundTerminalOperation() {
        let confirmed = RewardCampaignOperation(id: "own-operation", status: "confirmed", txHash: "receipt", errorCode: nil)
        let pending = RewardCampaignOperation(id: "own-operation", status: "pending", txHash: nil, errorCode: nil)
        XCTAssertTrue(CampaignRecovery.showsSubmit(hasPendingRequest: true, operation: pending, hasReadError: false))
        XCTAssertFalse(CampaignRecovery.shouldRetire(hasPendingRequest: true, knownOperationID: "own-operation", operation: pending))
        XCTAssertFalse(CampaignRecovery.shouldRetire(hasPendingRequest: true, knownOperationID: "other-operation", operation: confirmed))
        XCTAssertTrue(CampaignRecovery.shouldRetire(hasPendingRequest: true, knownOperationID: "own-operation", operation: confirmed))
        XCTAssertFalse(CampaignRecovery.showsSubmit(hasPendingRequest: false, operation: pending, hasReadError: false), "An unrelated pending update cannot enable a new campaign submission")
        XCTAssertTrue(CampaignRecovery.showsSubmit(hasPendingRequest: false, operation: confirmed, hasReadError: false))
    }
    private let router = "0x" + String(repeating: "1", count: 40)
    private func payload(useReward: Bool = true, amount: String = "100000000000000000000", router: String? = nil) -> ScanPayload {
        ScanPayload(version: 2, terminalId: "terminal", invoiceId: "invoice", challenge: "challenge", cardId: "0123456789ABCDEF", chainId: "11155111", token: "0x" + String(repeating: "2", count: 40), amount: amount, expiresAt: "2026-09-26T04:19:36.123Z", routerAddress: router ?? self.router, useReward: useReward)
    }
    func testV2CanonicalBytesBindGrossAmountRouterAndOptInExactly() throws {
        let report = payload()
        let expected = ["suica-payments-v2", "terminal", "invoice", "challenge", "0123456789ABCDEF", "11155111", "0x" + String(repeating: "2", count: 40), "100000000000000000000", "2026-09-26T04:19:36.123Z", router, "1"].joined(separator: "\n")
        XCTAssertEqual(String(decoding: try report.canonicalBytes(), as: UTF8.self), expected)
        let key = P256.Signing.PrivateKey()
        let signature = try key.signature(for: report.canonicalBytes())
        XCTAssertTrue(key.publicKey.isValidSignature(signature, for: try report.canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(signature, for: try payload(useReward: false).canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(signature, for: try payload(amount: "50000000000000000000").canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(signature, for: try payload(router: "0x" + String(repeating: "3", count: 40)).canonicalBytes()))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any])
        XCTAssertEqual(json["version"] as? Int, 2)
        XCTAssertEqual(json["useReward"] as? Bool, true)
    }
    func testV1RemainsUnchangedAndRejectsUnboundRewardFields() throws {
        var legacy = ScanPayload(terminalId: "terminal", invoiceId: "invoice", challenge: "challenge", cardId: "0123456789ABCDEF", chainId: "1", token: "token", amount: "500", expiresAt: "expiry")
        XCTAssertEqual(String(decoding: try legacy.canonicalBytes(), as: UTF8.self), "suica-payments-v1\nterminal\ninvoice\nchallenge\n0123456789ABCDEF\n1\ntoken\n500\nexpiry")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as? [String: Any])
        XCTAssertNil(json["useReward"])
        XCTAssertNil(json["routerAddress"])
        legacy.useReward = true
        XCTAssertThrowsError(try legacy.canonicalBytes())
    }
    func testIncompleteV2AndUnknownProtocolFailClosed() {
        var incomplete = payload()
        incomplete.routerAddress = nil
        XCTAssertThrowsError(try incomplete.canonicalBytes())
        incomplete = payload(); incomplete.useReward = nil
        XCTAssertThrowsError(try incomplete.canonicalBytes())
        incomplete = payload(); incomplete.version = 4
        XCTAssertThrowsError(try incomplete.canonicalBytes())
    }
    func testLegacyDraftsNeverOptInToAutomaticRewards() throws {
        let policy = try JSONDecoder().decode(Policy.self, from: Data(#"{"enabled":true,"perPaymentLimit":"100","totalLimit":"500","spent":"0","expiresAt":"2033-05-18T03:33:20Z","merchantIds":["merchant"]}"#.utf8))
        XCTAssertNotEqual(policy.useRewards, true)
        let oldForm = try JSONDecoder().decode(SpendingForm.self, from: Data(#"{"perPayment":"100","total":"500","expires":1000000000,"merchantIDs":["merchant"]}"#.utf8))
        XCTAssertFalse(oldForm.useRewards)
        let oldInvoice = try JSONDecoder().decode(InvoiceDraft.self, from: Data(#"{"amount":"100","description":"","requestID":"old-request"}"#.utf8))
        XCTAssertFalse(oldInvoice.useReward)
        var form = SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 0)
        XCTAssertTrue(form.matches(policy, decimals: 0))
        form.useRewards = true
        XCTAssertFalse(form.matches(policy, decimals: 0))
    }
    private func voucher(status: String, redeemedHash: Any = NSNull()) throws -> RewardVoucher {
        let object: [String: Any] = ["id": "1", "cardId": "card-one", "walletAddress": router, "merchantId": "merchant-one", "merchantName": "Merchant", "discountBps": 5000, "maxDiscount": "50000000000000000000", "minPurchase": "100000000000000000000", "expiresAt": "2026-10-26T04:00:00Z", "status": status, "earnedAt": "2026-09-26T04:00:00Z", "earnedTxHash": "earned-transaction", "redeemedAt": "2026-09-26T05:00:00Z", "redeemedTxHash": redeemedHash]
        return try JSONDecoder().decode(RewardVoucher.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func testRedemptionHistoryRequiresUsedStateAndConfirmedTransaction() throws {
        let reserved = try voucher(status: "reserved", redeemedHash: "not-consumed")
        XCTAssertEqual(RewardActivity.events(reserved).map(\.kind), [.earned])
        let usedWithoutReceipt = try voucher(status: "used")
        XCTAssertEqual(RewardActivity.events(usedWithoutReceipt).map(\.kind), [.earned])
        let used = try voucher(status: "used", redeemedHash: "redeemed-transaction")
        XCTAssertEqual(RewardActivity.events(used).map(\.kind), [.earned, .redeemed])
        let history = WalletActivity.timeline(payments: [], funding: [], rewards: [used, used])
        XCTAssertEqual(history.map(\.id), ["reward:redeemed:1", "reward:earned:1"])
    }
    func testRewardReadFailureDoesNotBecomeEmptyWallet() throws {
        let unavailable = try JSONDecoder().decode(RewardsResponse.self, from: Data(#"{"status":"unavailable","rewards":null,"routerAddress":null}"#.utf8))
        XCTAssertNil(unavailable.availableRewards)
        let empty = try JSONDecoder().decode(RewardsResponse.self, from: Data(#"{"status":"available","rewards":[],"routerAddress":null}"#.utf8))
        XCTAssertEqual(empty.availableRewards?.count, 0)
    }
    func testPartialFundingReadRetainsCoverageWarningAndRecentResults() throws {
        let result = try JSONDecoder().decode(FundingHistory.self, from: Data(#"{"status":"available","transfers":[],"historyComplete":false,"historyStatus":"partial"}"#.utf8))
        XCTAssertEqual(result.availability, .available)
        XCTAssertEqual(result.historyComplete, false)
        XCTAssertEqual(result.historyStatus, "partial")
        XCTAssertEqual(result.availableTransfers?.count, 0)
        let unavailable = try JSONDecoder().decode(FundingHistory.self, from: Data(#"{"status":"unavailable","transfers":null,"historyComplete":false,"historyStatus":"unavailable"}"#.utf8))
        XCTAssertNil(unavailable.availableTransfers)
        XCTAssertEqual(unavailable.historyComplete, false)
    }
    func testCampaignTermsPreserveAmountsAndRejectFreePaymentDiscount() throws {
        var form = RewardCampaignDraft()
        form.enabled = true
        let body = try form.requestBody(decimals: 18, requestID: "request")
        XCTAssertEqual(body["minPurchase"] as? String, "100000000000000000000")
        XCTAssertEqual(body["discountBps"] as? Int, 5000)
        XCTAssertEqual(body["maxDiscount"] as? String, "50000000000000000000")
        XCTAssertEqual(body["validitySeconds"] as? Int, 2_592_000)
        form.discountPercent = "100"
        XCTAssertThrowsError(try form.requestBody(decimals: 18, requestID: "request"))
        form.discountPercent = "99.99"; form.validityDays = "0.5"
        XCTAssertEqual(try form.requestBody(decimals: 18, requestID: "request")["validitySeconds"] as? Int, 43_200)
        form.validityDays = "30junk"
        XCTAssertThrowsError(try form.requestBody(decimals: 18, requestID: "request"))
        let short = RewardCampaign(enabled: true, minPurchase: "1", discountBps: 5000, maxDiscount: "1", validitySeconds: 60, version: 1)
        let restored = RewardCampaignDraft(campaign: short, decimals: 0)
        XCTAssertEqual(try restored.requestBody(decimals: 0, requestID: "request")["validitySeconds"] as? Int, 60)
    }
}
