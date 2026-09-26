import Foundation

/// Editable input, separate from both an allowance job and an enabled server policy.
/// Consent is intentionally not persisted: restoring input never authorizes a payment.
struct SpendingForm: Codable, Equatable {
    var perPayment = ""
    var total = ""
    var expires = Date().addingTimeInterval(86400)
    var merchantIDs: Set<String> = []
    var useRewards = false
    var merchantScope: MerchantScope = .all
    var maxPointsPerPayment: String? = nil

    /// Editing prepares new terms; it never changes the saved policy or an in-flight snapshot.
    func editingAllMerchants(pending: Bool) -> SpendingForm {
        guard !pending else { return self }
        var result = self
        result.merchantScope = .all
        result.merchantIDs = []
        return result
    }

    func matches(_ policy: Policy?, decimals: Int) -> Bool {
        guard let policy,
              let per = try? TokenAmount.units(perPayment, decimals: decimals),
              let cap = try? TokenAmount.units(total, decimals: decimals),
              let expiry = AppDates.date(policy.expiresAt),
              let normalizedLimit = try? (WholePoints.limit(maxPointsPerPayment) ?? "auto") else { return false }
        return per == policy.perPaymentLimit && cap == policy.totalLimit &&
            Int(expires.timeIntervalSince1970) == Int(expiry.timeIntervalSince1970) &&
            normalizedLimit == (policy.maxPointsPerPayment ?? "auto") && merchantScope == policy.effectiveMerchantScope && merchantIDs == Set(policy.merchantIds ?? []) && useRewards == (policy.useRewards == true)
    }

    func isEnabled(in policy: Policy?, decimals: Int, now: Date = .now) -> Bool {
        policy?.enabled == true && matches(policy, decimals: decimals) && (AppDates.date(policy?.expiresAt ?? "") ?? .distantPast) > now
    }

    static func restored(draft: SpendingForm?, pending: SpendingForm?, policy: Policy?, decimals: Int) -> SpendingForm {
        // An in-flight approval must keep the exact terms that created it.
        if let pending { return pending }
        if let draft { return draft }
        guard let policy else { return SpendingForm() }
        return SpendingForm(
            perPayment: TokenAmount.display(policy.perPaymentLimit, decimals: decimals),
            total: TokenAmount.display(policy.totalLimit, decimals: decimals),
            expires: AppDates.date(policy.expiresAt) ?? .now,
            merchantIDs: Set(policy.merchantIds ?? []), useRewards: policy.useRewards == true, merchantScope: policy.effectiveMerchantScope, maxPointsPerPayment: policy.maxPointsPerPayment
        )
    }
}


extension SpendingForm {
    enum CodingKeys: String, CodingKey { case perPayment, total, expires, merchantIDs, useRewards, merchantScope, maxPointsPerPayment }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        perPayment = try values.decode(String.self, forKey: .perPayment)
        total = try values.decode(String.self, forKey: .total)
        expires = try values.decode(Date.self, forKey: .expires)
        merchantIDs = try values.decode(Set<String>.self, forKey: .merchantIDs)
        useRewards = try values.decodeIfPresent(Bool.self, forKey: .useRewards) ?? false
        merchantScope = try values.decodeIfPresent(MerchantScope.self, forKey: .merchantScope) ?? .selected
        maxPointsPerPayment = try values.decodeIfPresent(String.self, forKey: .maxPointsPerPayment)
    }
}


enum MerchantScope: String, Codable { case selected, all }
struct PendingSpendingPermission: Codable {
    let perPayment: String
    let total: String
    let expiresAt: String
    let merchantIDs: [String]
    var jobID: String
    var requestID: String? = nil
    var useRewards: Bool? = nil
    var router: String? = nil
    var routerAddress: String? = nil
    var merchantScope: MerchantScope? = nil
    var maxPointsPerPayment: String? = nil
    var effectiveMerchantScope: MerchantScope { merchantScope ?? .selected }
    func matchesRouter(kind: String?, address: String?) -> Bool {
        guard let kind, let address else { return true }
        if let saved = routerAddress { return saved.caseInsensitiveCompare(address) == .orderedSame && (router == nil || router == kind) }
        if let router { return router == kind }
        // Snapshots written before router support belonged to the legacy system.
        return kind == "legacy"
    }
}
