import XCTest
import CryptoKit
#if SWIFT_PACKAGE
@testable import RewardModels
#else
@testable import SuicaPay
#endif

final class LoyaltyTests: XCTestCase {
    private func scan(limit: String? = nil) -> ScanPayload {
        ScanPayload(version: 3, terminalId: "terminal", invoiceId: "invoice", challenge: "nonce", cardId: "0123456789ABCDEF", chainId: "11155111", token: "token", amount: "20000000000000000000", expiresAt: "2026-09-27T04:00:00.123Z", routerAddress: "0x" + String(repeating: "1", count: 40), useReward: true, maxPoints: limit)
    }
    func testV3SignsGrossAndExactPointLimitAndEncodesRequiredNull() throws {
        let automatic = scan()
        let expected = ["suica-payments-v3", "terminal", "invoice", "nonce", "0123456789ABCDEF", "11155111", "token", "20000000000000000000", "2026-09-27T04:00:00.123Z", "0x" + String(repeating: "1", count: 40), "1", "auto"].joined(separator: "\n")
        XCTAssertEqual(try automatic.canonicalBytes(), Data(expected.utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(automatic)) as? [String: Any])
        XCTAssertTrue(json["maxPoints"] is NSNull)
        let key = P256.Signing.PrivateKey(), capped = scan(limit: "5")
        let signature = try key.signature(for: capped.canonicalBytes())
        XCTAssertTrue(key.publicKey.isValidSignature(signature, for: try capped.canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(signature, for: try scan(limit: "6").canonicalBytes()))
        XCTAssertFalse(key.publicKey.isValidSignature(signature, for: try automatic.canonicalBytes()))
        XCTAssertTrue(String(decoding: try scan(limit: "0").canonicalBytes(), as: UTF8.self).hasSuffix("\n0"))
        var oldVersion = capped; oldVersion.version = 2
        XCTAssertThrowsError(try oldVersion.canonicalBytes())
    }
    func testPointsLimitsDistinguishAutomaticZeroAndFractionalInput() throws {
        XCTAssertNil(try WholePoints.limit(nil))
        XCTAssertEqual(try WholePoints.limit("0"), "0")
        XCTAssertEqual(try WholePoints.limit("0005"), "5")
        XCTAssertThrowsError(try WholePoints.limit("0.5"))
        XCTAssertThrowsError(try WholePoints.limit("-1"))
        let maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        XCTAssertEqual(try WholePoints.normalized(maximum), maximum)
        XCTAssertThrowsError(try WholePoints.normalized("115792089237316195423570985008687907853269984665640564039457584007913129639936"))
        let json = #"{"enabled":true,"perPaymentLimit":"2000","totalLimit":"10000","spent":"0","expiresAt":"2033-05-18T03:33:20Z","merchantIds":[],"merchantScope":"all","maxPointsPerPayment":"5"}"#
        let policy = try JSONDecoder().decode(Policy.self, from: Data(json.utf8))
        var form = SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 2)
        XCTAssertEqual(form.maxPointsPerPayment, "5")
        XCTAssertTrue(form.matches(policy, decimals: 2))
        form.maxPointsPerPayment = nil
        XCTAssertFalse(form.matches(policy, decimals: 2))
    }
    func testUnknownInvoiceRetryPreservesRouterLimitAndRequestIdentity() throws {
        let old = InvoiceDraft(amount: "20", description: "sale", requestID: "durable", useReward: true, router: "loyalty", maxPoints: "5")
        let recovered = try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: old, entered: old, hasPersistedActiveInvoice: false, newRequestID: { XCTFail("Must recover original identity"); return "bad" })
        XCTAssertEqual(recovered.draft, old)
        var edited = old; edited.maxPoints = nil
        XCTAssertThrowsError(try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: old, entered: edited, hasPersistedActiveInvoice: false))
        edited = old; edited.router = "collectibles"
        XCTAssertThrowsError(try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: old, entered: edited, hasPersistedActiveInvoice: false))
        let legacy = try JSONDecoder().decode(InvoiceDraft.self, from: Data(#"{"amount":"20","requestID":"legacy"}"#.utf8))
        XCTAssertNil(legacy.router)
        XCTAssertNil(legacy.maxPoints)
        let snapshot = PendingSpendingPermission(perPayment: "20", total: "100", expiresAt: "expiry", merchantIDs: [], jobID: "approval", requestID: "permission", router: "loyalty", routerAddress: "0xold", merchantScope: .all, maxPointsPerPayment: "5")
        let decoded = try JSONDecoder().decode(PendingSpendingPermission.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(decoded.maxPointsPerPayment, "5")
        XCTAssertFalse(decoded.matchesRouter(kind: "loyalty", address: "0xnew"))
    }
    func testConfirmedLedgerKeepsFractionAndWalletIdentitySeparate() throws {
        let json = #"{"id":"chain:router:wallet:merchant","cardId":"card-a","walletAddress":"0xABC","merchantId":"shop","merchantName":"Shop","merchantEnabled":true,"availablePoints":"12","reservedPoints":"2","spendablePoints":"10","fractionNumerator":"85","fractionDenominator":"100","fractionalUnits":"850000000000000000","debtUnits":"0","expiresAt":null,"program":null}"#
        let balance = try JSONDecoder().decode(LoyaltyBalance.self, from: Data(json.utf8))
        XCTAssertEqual(balance.fractionalProgress!, 0.85, accuracy: 0.000001)
        XCTAssertEqual(balance.spendablePoints, "10")
        XCTAssertTrue(balance.belongsTo(cardID: "card-a", walletAddress: "0xabc"))
        XCTAssertFalse(balance.belongsTo(cardID: "card-b", walletAddress: "0xabc"))
        XCTAssertFalse(balance.belongsTo(cardID: "card-a", walletAddress: "0xdef"))
        let unavailable = #"{"status":"unavailable","routerAddress":null,"token":{"address":"token","symbol":"MJPY","decimals":18},"pointValue":"1000000000000000000","balances":null,"history":null}"#
        XCTAssertFalse(try JSONDecoder().decode(LoyaltyResponse.self, from: Data(unavailable.utf8)).readable)
    }
    func testHistoryRetainsSubPointEarningsAndDebtRecovery() throws {
        let json = #"{"id":"receipt:log","cardId":"card","walletAddress":"wallet","merchantId":"shop","merchantName":"Shop","kind":"earned","points":"0","pointsUnits":"850000000000000000","debtRepaidUnits":"100000000000000000","tokenAmount":"19000000000000000000","invoiceId":"invoice","createdAt":"2026-09-27T04:00:00Z","txHash":"receipt","explorerUrl":null}"#
        let event = try JSONDecoder().decode(LoyaltyEvent.self, from: Data(json.utf8))
        XCTAssertEqual(TokenAmount.display(event.pointsUnits, decimals: 18), "0.85")
        XCTAssertEqual(TokenAmount.display(event.debtRepaidUnits!, decimals: 18), "0.1")
        XCTAssertEqual(event.title, "Earning progress")
        XCTAssertEqual(event.tokenAmount, "19000000000000000000")
    }
    func testRefundRecoveryRetainsIdentityAndNeedsMatchingFinalReceipt() throws {
        var request = PendingRefundRequest(requestID: "original-refund")
        let restored = try JSONDecoder().decode(PendingRefundRequest.self, from: JSONEncoder().encode(request))
        XCTAssertEqual(restored.requestBody(), ["requestId": "original-refund"])
        let receipt = PaymentRefund(id: "refund-operation", invoiceId: "paid-invoice", status: "confirmed", amount: "100", txHash: "canonical-return", explorerUrl: nil, errorCode: nil)
        XCTAssertFalse(request.canRetire(receipt), "A latest operation must not auto-bind a lost POST")
        request.operationID = "refund-operation"
        XCTAssertTrue(request.canRetire(receipt))
        let pending = PaymentRefund(id: "refund-operation", invoiceId: "paid-invoice", status: "reconciling", amount: "100", txHash: "possible-return", explorerUrl: nil, errorCode: nil)
        XCTAssertTrue(pending.isPending)
        XCTAssertFalse(request.canRetire(pending))
        request.operationID = "different-operation"
        XCTAssertFalse(request.canRetire(receipt))
    }
    func testOutstandingValueIncludesFractionalLiabilityAcrossWallets() throws {
        let json = #"{"outstandingPoints":"0","outstandingUnits":"1700000000000000000","earnedPoints":"1","earnedUnits":"1700000000000000000","redeemedPoints":"0","expiredPoints":"0","expiredUnits":"0","refundedPoints":"0","refundedUnits":"0","reversedPoints":"0","reversedUnits":"0","customerWallets":2}"#
        let summary = try JSONDecoder().decode(LoyaltyProgramResponse.Summary.self, from: Data(json.utf8))
        XCTAssertEqual(summary.outstandingPoints, "0")
        XCTAssertEqual(TokenAmount.display(summary.outstandingUnits, decimals: 18), "1.7")
        XCTAssertEqual(summary.customerWallets, 2)
    }
    func testOnlyDefinitiveFailedRefundCanStartAnotherEligibleRequest() throws {
        let json = #"{"id":"invoice","merchantId":"shop","recipient":"merchant-wallet","amount":"100","token":"token","chainId":"1","expiresAt":"expiry","status":"confirmed","refundEligible":true}"#
        var invoice = try JSONDecoder().decode(Invoice.self, from: Data(json.utf8))
        XCTAssertTrue(invoice.canRequestNewRefund)
        for status in ["queued", "submitting", "pending", "reconciling", "confirmed"] {
            invoice.refund = PaymentRefund(id: "old", invoiceId: "invoice", status: status, amount: "100", txHash: nil, explorerUrl: nil, errorCode: nil)
            XCTAssertFalse(invoice.canRequestNewRefund, status)
        }
        invoice.refund = PaymentRefund(id: "old", invoiceId: "invoice", status: "failed", amount: "100", txHash: nil, explorerUrl: nil, errorCode: "reverted")
        XCTAssertTrue(invoice.canRequestNewRefund)
        invoice.refundEligible = false
        XCTAssertFalse(invoice.canRequestNewRefund)
    }
    func testDisplayBrandingPreservesUnderlyingTokenAndExactAmounts() throws {
        let old = try JSONDecoder().decode(AppConfig.Token.self, from: Data(#"{"address":"0xexisting","symbol":"MJPY","decimals":18}"#.utf8))
        XCTAssertNil(old.name)
        XCTAssertNil(old.onchainSymbol)
        let branded = try JSONDecoder().decode(AppConfig.Token.self, from: Data(#"{"address":"0xexisting","symbol":"icUSD","name":"IC Stablecoin","onchainSymbol":"MJPY","decimals":18}"#.utf8))
        XCTAssertEqual(branded.address, old.address)
        XCTAssertEqual(branded.decimals, old.decimals)
        XCTAssertEqual(branded.symbol, "icUSD")
        XCTAssertEqual(branded.onchainSymbol, "MJPY")
        let wallet = try JSONDecoder().decode(Wallet.self, from: Data(#"{"address":"wallet","balance":"1700000000000000000","balanceStatus":"available","symbol":"icUSD","name":"IC Stablecoin","onchainSymbol":"MJPY","decimals":18,"chainId":"11155111"}"#.utf8))
        XCTAssertEqual(wallet.balance, "1700000000000000000")
        XCTAssertEqual(wallet.displayBalance, "1.7")
        XCTAssertEqual(wallet.onchainSymbol, "MJPY")
        let transfer = try JSONDecoder().decode(FundingTransfer.self, from: Data(#"{"id":"tx:0","from":"sender","amount":"1000000000000000000000","symbol":"icUSD","name":"IC Stablecoin","onchainSymbol":"MJPY","decimals":18,"createdAt":"2026-09-27T00:00:00Z","txHash":"tx","explorerUrl":null,"status":"confirmed"}"#.utf8))
        XCTAssertEqual(transfer.id, "tx:0")
        XCTAssertEqual(transfer.amount, "1000000000000000000000")
        XCTAssertEqual(transfer.onchainSymbol, "MJPY")
    }
    func testProgramCapUsesWholePointsAndNeverVoucherCreditUnits() throws {
        let draft = LoyaltyProgramDraft()
        let body = try draft.requestBody(decimals: 18, requestID: "same-program-request")
        XCTAssertEqual(body["maxPointsPerPurchase"] as? String, "50")
        XCTAssertEqual(body["minPurchase"] as? String, "1000000000000000000")
        XCTAssertEqual(body["earnBps"] as? Int, 500)
        XCTAssertEqual(body["enabled"] as? Bool, false)
        XCTAssertNil(body["maxCredit"])
        XCTAssertEqual(body["requestId"] as? String, "same-program-request")
    }
}
