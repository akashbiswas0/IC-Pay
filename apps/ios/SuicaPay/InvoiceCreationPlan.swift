import Foundation

enum InvoicePersistenceMutation: Equatable {
    case clearActiveInvoice
    case saveDraft(InvoiceDraft)
    case clearDraft
}

/// Explicit creation and passive recovery have different identities and persistence rules.
struct InvoiceCreationPlan {
    let draft: InvoiceDraft
    let isNewRequest: Bool
    let mutations: [InvoicePersistenceMutation]

    static func make(knownInvoice: Invoice?, savedDraft: InvoiceDraft, entered: InvoiceDraft,
                     hasPersistedActiveInvoice: Bool, newRequestID: () -> String = { UUID().uuidString }) throws -> InvoiceCreationPlan {
        // Never rotate identity around a known unfinished invoice, even if its draft was lost.
        if let knownInvoice, !knownInvoice.isFinished {
            throw AppError.message("Finish or cancel the current payment before creating another.")
        }
        if knownInvoice?.isFinished == true {
            var fresh = entered
            fresh.requestID = newRequestID()
            // The old active pointer must disappear before a new unknown submission can exist.
            return InvoiceCreationPlan(draft: fresh, isNewRequest: true, mutations: [.clearActiveInvoice, .saveDraft(fresh)])
        }
        if savedDraft.requestID != nil {
            guard savedDraft.amount == entered.amount, savedDraft.description == entered.description,
                  savedDraft.useReward == entered.useReward, savedDraft.router == entered.router, savedDraft.maxPoints == entered.maxPoints else {
                throw AppError.message("Recover your payment request before editing it.")
            }
            return InvoiceCreationPlan(draft: savedDraft, isNewRequest: false, mutations: [])
        }
        guard !hasPersistedActiveInvoice else { throw AppError.message("Check the existing payment before creating another.") }
        var fresh = entered
        fresh.requestID = newRequestID()
        return InvoiceCreationPlan(draft: fresh, isNewRequest: true, mutations: [.saveDraft(fresh)])
    }

    /// Server-confirmed terminal results retire an old intent. They never generate a new request.
    static func retirement(knownInvoice: Invoice, savedDraft: InvoiceDraft) -> [InvoicePersistenceMutation] {
        guard knownInvoice.isFinished else { return [] }
        var editable = savedDraft
        editable.requestID = nil
        return [.clearActiveInvoice, .saveDraft(editable)]
    }
}

/// A duplicate recovery response cannot replace a newer intent or reopen a retired one.
struct InvoiceCompletionTicket {
    let revision: UInt
    let requestID: String
    func canApply(currentRevision: UInt, persistedRequestID: String?) -> Bool {
        revision == currentRevision && requestID == persistedRequestID
    }
}
