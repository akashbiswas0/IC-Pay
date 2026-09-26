import XCTest
#if SWIFT_PACKAGE
@testable import RewardModels
#else
@testable import SuicaPay
#endif

final class InvoiceCreationPlanTests: XCTestCase {
    private let oldID = "63C46081-3385-40B7-80AF-45B923A32E23"
    private let freshID = "99999999-1111-4222-8333-444444444444"
    private func invoice(_ status: String) -> Invoice {
        Invoice(id: "finished-invoice", merchantId: "merchant", recipient: "recipient", amount: "20000000000000000000", token: "token", chainId: "11155111", expiresAt: "2026-09-26T04:00:00Z", status: status, txHash: nil, explorerUrl: nil, errorCode: nil)
    }
    func testExplicitCreateAfterKnownFinishedInvoiceUsesFreshIdentityEvenForSameTerms() throws {
        for status in ["confirmed", "failed", "expired", "cancelled"] {
            let old = InvoiceDraft(amount: "20", description: "sale", requestID: oldID)
            let plan = try InvoiceCreationPlan.make(knownInvoice: invoice(status), savedDraft: old, entered: InvoiceDraft(amount: "20", description: "sale"), hasPersistedActiveInvoice: true, newRequestID: { self.freshID })
            XCTAssertTrue(plan.isNewRequest, status)
            XCTAssertEqual(plan.draft.requestID, freshID, status)
            XCTAssertEqual(plan.mutations.first, .clearActiveInvoice, "Retire old durable active ID before storing a new intent")
        }
    }
    func testFinishedInvoiceAllowsNewEnteredAmountDescriptionAndRewardChoice() throws {
        let plan = try InvoiceCreationPlan.make(knownInvoice: invoice("confirmed"), savedDraft: InvoiceDraft(amount: "20", description: "sale", requestID: oldID), entered: InvoiceDraft(amount: "100", description: "new sale", useReward: true), hasPersistedActiveInvoice: true, newRequestID: { self.freshID })
        XCTAssertEqual(plan.draft.amount, "100")
        XCTAssertEqual(plan.draft.description, "new sale")
        XCTAssertTrue(plan.draft.useReward)
        XCTAssertEqual(plan.draft.requestID, freshID)
    }
    func testAmbiguousRequestAlwaysRetainsOriginalIdentityAndTerms() throws {
        let original = InvoiceDraft(amount: "20", description: "sale", requestID: oldID, useReward: true)
        let plan = try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: original, entered: InvoiceDraft(amount: "20", description: "sale", useReward: true), hasPersistedActiveInvoice: false, newRequestID: { XCTFail("Must not create another identity after an unknown response"); return self.freshID })
        XCTAssertEqual(plan.draft, original)
        XCTAssertFalse(plan.isNewRequest)
        XCTAssertTrue(plan.mutations.isEmpty)
        XCTAssertThrowsError(try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: original, entered: InvoiceDraft(amount: "30", description: "sale", useReward: true), hasPersistedActiveInvoice: false))
    }
    func testKnownUnfinishedOrUnrestoredActiveInvoiceCannotStartFreshRequest() {
        for status in ["awaiting_tap", "authorised", "submitting", "pending", "reconciling"] {
            XCTAssertThrowsError(try InvoiceCreationPlan.make(knownInvoice: invoice(status), savedDraft: InvoiceDraft(), entered: InvoiceDraft(amount: "20"), hasPersistedActiveInvoice: true), status)
        }
        XCTAssertThrowsError(try InvoiceCreationPlan.make(knownInvoice: nil, savedDraft: InvoiceDraft(), entered: InvoiceDraft(amount: "20"), hasPersistedActiveInvoice: true))
    }
    func testFinishedToFreshPendingTimeoutKeepsSameIdentityOnNextCreate() throws {
        let old = InvoiceDraft(amount: "20", description: "sale", requestID: oldID)
        let fresh = try InvoiceCreationPlan.make(knownInvoice: invoice("confirmed"), savedDraft: old, entered: InvoiceDraft(amount: "20", description: "sale"), hasPersistedActiveInvoice: true, newRequestID: { self.freshID })
        var memoryInvoice: Invoice? = invoice("confirmed")
        var durableActiveID: String? = memoryInvoice?.id
        var durableDraft = old
        for mutation in fresh.mutations {
            switch mutation {
            case .clearActiveInvoice: durableActiveID = nil; memoryInvoice = nil
            case .saveDraft(let draft):
                XCTAssertNil(durableActiveID, "Old durable active pointer must be gone before storing the new UUID")
                XCTAssertNil(memoryInvoice, "Old completed in-memory invoice must not survive into an ambiguous new submission")
                durableDraft = draft
            case .clearDraft: XCTFail("Creation keeps entered terms")
            }
        }
        // The POST times out: no new invoice was returned, and the durable draft is the sole recovery identity.
        let retry = try InvoiceCreationPlan.make(knownInvoice: memoryInvoice, savedDraft: durableDraft, entered: InvoiceDraft(amount: "20", description: "sale"), hasPersistedActiveInvoice: durableActiveID != nil, newRequestID: { XCTFail("Timeout must not rotate again"); return "unexpected" })
        XCTAssertEqual(retry.draft.requestID, freshID)
        XCTAssertFalse(retry.isNewRequest)
        XCTAssertTrue(retry.mutations.isEmpty)
    }
    func testBackgroundFinishedRecoveryOnlyRetiresNeverCreates() {
        let old = InvoiceDraft(amount: "20", description: "sale", requestID: oldID, useReward: true)
        let actions = InvoiceCreationPlan.retirement(knownInvoice: invoice("confirmed"), savedDraft: old)
        XCTAssertEqual(actions.first, .clearActiveInvoice)
        guard case .saveDraft(let editable) = actions.last else { return XCTFail("Expected an editable retired draft") }
        XCTAssertNil(editable.requestID)
        XCTAssertEqual(editable.amount, old.amount)
        XCTAssertEqual(editable.description, old.description)
        XCTAssertEqual(editable.useReward, old.useReward)
        XCTAssertTrue(InvoiceCreationPlan.retirement(knownInvoice: invoice("pending"), savedDraft: old).isEmpty)
    }

    func testLateOldRecoveryCannotRetireOrOverwriteNewPendingIntent() {
        let firstRecovery = InvoiceCompletionTicket(revision: 10, requestID: oldID)
        let overlappingRecovery = InvoiceCompletionTicket(revision: 10, requestID: oldID)
        XCTAssertTrue(firstRecovery.canApply(currentRevision: 10, persistedRequestID: oldID))
        // The first completion retires the old request, then explicit Create persists a new one.
        XCTAssertFalse(overlappingRecovery.canApply(currentRevision: 12, persistedRequestID: freshID))
        XCTAssertFalse(overlappingRecovery.canApply(currentRevision: 11, persistedRequestID: nil))
        // Identity also protects against a storage change that has not advanced a caller's revision.
        XCTAssertFalse(overlappingRecovery.canApply(currentRevision: 10, persistedRequestID: freshID))
        let current = InvoiceCompletionTicket(revision: 12, requestID: freshID)
        XCTAssertTrue(current.canApply(currentRevision: 12, persistedRequestID: freshID))
    }

}
