import Foundation

enum WholePoints {
    static func normalized(_ text: String) throws -> String {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard value.range(of: "^[0-9]+$", options: .regularExpression) != nil else { throw AppError.message("Enter a whole number of points, zero or more.") }
        let digits = value.drop(while: { $0 == "0" })
        let normalized = digits.isEmpty ? "0" : String(digits)
        let maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        guard normalized.count < maximum.count || (normalized.count == maximum.count && normalized <= maximum) else { throw AppError.message("The points limit is too large.") }
        return normalized
    }
    static func limit(_ text: String?) throws -> String? { try text.map(normalized) }
}
struct LoyaltyResponse: Decodable {
    let status: String
    let routerAddress: String?
    let token: AppConfig.Token
    let pointValue: String
    let balances: [LoyaltyBalance]?
    let history: [LoyaltyEvent]?
    var readable: Bool { status == "available" && balances != nil && history != nil }
}
struct LoyaltyBalance: Decodable, Identifiable {
    let id: String
    let cardId: String?
    let walletAddress: String
    let merchantId: String
    let merchantName: String
    let merchantEnabled: Bool
    let availablePoints: String
    let reservedPoints: String
    let spendablePoints: String
    let fractionNumerator: String
    let fractionDenominator: String
    let expiresAt: String?
    let program: LoyaltyProgram?
    let fractionalUnits: String?
    let debtUnits: String?
    var fractionalProgress: Double? {
        guard let numerator = Decimal(string: fractionNumerator), let denominator = Decimal(string: fractionDenominator),
              denominator > 0, numerator >= 0, numerator < denominator else { return nil }
        return NSDecimalNumber(decimal: numerator / denominator).doubleValue
    }
    func belongsTo(cardID: String?, walletAddress: String?) -> Bool {
        guard let walletAddress, self.walletAddress.caseInsensitiveCompare(walletAddress) == .orderedSame else { return false }
        return cardID == nil || self.cardId?.caseInsensitiveCompare(cardID!) == .orderedSame
    }
}
struct LoyaltyEvent: Decodable, Identifiable {
    let id: String
    let cardId: String?
    let walletAddress: String
    let merchantId: String
    let merchantName: String
    let kind: String
    let points: String
    let pointsUnits: String
    let debtRepaidUnits: String?
    let tokenAmount: String?
    let invoiceId: String?
    let createdAt: String
    let txHash: String
    let explorerUrl: String?
    var title: String {
        switch kind {
        case "earned": return points == "0" ? "Earning progress" : "Points earned"
        case "redeemed": return "Points used"
        case "expired": return "Points expired"
        case "refunded": return "Points returned"
        case "reversed": return "Earning reversed"
        default: return "Points update"
        }
    }
}
struct LoyaltyProgram: Codable, Equatable {
    let enabled: Bool
    let earnBps: Int
    let minPurchase: String
    let maxPointsPerPurchase: String
    let validitySeconds: Int
    let version: Int
    func summary(decimals: Int, symbol: String) -> String {
        "Earn \(TokenAmount.display(String(earnBps), decimals: 2))% on tokens paid, up to \(maxPointsPerPurchase) points per purchase. Minimum purchase \(TokenAmount.display(minPurchase, decimals: decimals)) \(symbol). Valid for \(RewardFormatting.duration(validitySeconds))."
    }
}
struct LoyaltyProgramResponse: Decodable {
    struct Summary: Decodable {
        let outstandingPoints: String
        let outstandingUnits: String
        let earnedPoints: String
        let redeemedPoints: String
        let refundedPoints: String
        let customerWallets: Int
        let earnedUnits: String
        let expiredUnits: String
        let refundedUnits: String
        let reversedUnits: String
        let expiredPoints: String
        let reversedPoints: String
    }
    let status: String
    let program: LoyaltyProgram?
    let operation: RewardCampaignOperation?
    let summary: Summary?
}
struct LoyaltyProgramDraft: Codable, Equatable {
    var enabled = false
    var earnPercent = "5"
    var minimumPurchase = "1"
    var maximumPoints = "50"
    var validityDays = "30"
    var requestID: String? = nil
    init() {}
    init(program: LoyaltyProgram, decimals: Int) {
        enabled = program.enabled
        earnPercent = TokenAmount.display(String(program.earnBps), decimals: 2)
        minimumPurchase = TokenAmount.display(program.minPurchase, decimals: decimals)
        maximumPoints = program.maxPointsPerPurchase
        validityDays = NSDecimalNumber(decimal: Decimal(program.validitySeconds) / Decimal(86_400)).stringValue
    }
    func normalized(decimals: Int) throws -> LoyaltyProgram {
        var terms = CollectibleCampaignDraft()
        terms.enabled = enabled; terms.earnPercent = earnPercent; terms.minimumPurchase = minimumPurchase; terms.validityDays = validityDays
        let validated = try terms.normalized(decimals: decimals)
        let maximum = try WholePoints.normalized(maximumPoints)
        guard maximum != "0" else { throw AppError.message("The points earned per purchase must be greater than zero.") }
        return LoyaltyProgram(enabled: enabled, earnBps: validated.earnBps, minPurchase: validated.minPurchase, maxPointsPerPurchase: maximum, validitySeconds: validated.validitySeconds, version: 0)
    }
    func requestBody(decimals: Int, requestID: String) throws -> [String: Any] {
        let program = try normalized(decimals: decimals)
        return ["enabled": program.enabled, "earnBps": program.earnBps, "minPurchase": program.minPurchase, "maxPointsPerPurchase": program.maxPointsPerPurchase, "validitySeconds": program.validitySeconds, "requestId": requestID]
    }
    func matches(_ program: LoyaltyProgram, decimals: Int) -> Bool {
        guard var normalized = try? normalized(decimals: decimals) else { return false }
        normalized = LoyaltyProgram(enabled: normalized.enabled, earnBps: normalized.earnBps, minPurchase: normalized.minPurchase, maxPointsPerPurchase: normalized.maxPointsPerPurchase, validitySeconds: normalized.validitySeconds, version: program.version)
        return normalized == program
    }
}


struct PaymentRefund: Decodable, Identifiable {
    let id: String
    let invoiceId: String
    let status: String
    let amount: String
    let txHash: String?
    let explorerUrl: String?
    let errorCode: String?
    var isPending: Bool { ["queued", "submitting", "pending", "reconciling"].contains(status) }
    var isTerminal: Bool { ["confirmed", "failed"].contains(status) }
}
struct PendingRefundRequest: Codable, Equatable {
    let requestID: String
    var operationID: String? = nil
    func requestBody() -> [String: String] { ["requestId": requestID] }
    func canRetire(_ refund: PaymentRefund) -> Bool { operationID == refund.id && refund.isTerminal }
}
