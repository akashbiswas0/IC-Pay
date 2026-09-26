import Foundation

struct AppConfig: Decodable {
    struct Token: Decodable {
        let address: String; let symbol: String; let decimals: Int
        var name: String? = nil
        var onchainSymbol: String? = nil
    }
    struct Capabilities: Decodable { let payments: Bool; let world: Bool; let multipleCards: Bool?; let accountRecovery: Bool?; var rewards: Bool? = nil; var testFunding: Bool? = nil; var collectibles: Bool? = nil; var loyalty: Bool? = nil }
    let chainId: String
    let token: Token
    let explorerUrl: String?
    let capabilities: Capabilities
    struct PaymentRouter: Decodable { let address: String; let kind: String }
    var paymentRouter: PaymentRouter? = nil
}
struct Account: Decodable {
    let id: String
    let role: String
    let verified: Bool
    var canAccessApp: Bool { (role == "customer" && verified) || ["merchant", "admin"].contains(role) }
}
enum BalanceAvailability: Equatable { case available, pendingSetup, unavailable }
struct Wallet: Decodable, Equatable {
    let address: String
    let balance: String?
    let balanceStatus: String?
    let symbol: String
    let decimals: Int
    let chainId: String
    var name: String? = nil
    var onchainSymbol: String? = nil
    var availability: BalanceAvailability {
        if balanceStatus == "pending_setup" { return .pendingSetup }
        if balanceStatus == "available" || balanceStatus == nil { return balance == nil ? .unavailable : .available }
        return .unavailable
    }
    var displayBalance: String? {
        guard availability == .available, let balance,
              balance.range(of: "^[0-9]+$", options: .regularExpression) != nil,
              (0...36).contains(decimals) else { return nil }
        return TokenAmount.display(balance, decimals: decimals)
    }
}
struct WalletCreationResult: Decodable {
    let address: String?
    let status: String
    var readyAddress: String? { status == "ready" ? address : nil }
}
struct FundingHistory: Decodable {
    let status: String?
    let transfers: [FundingTransfer]?
    var historyComplete: Bool? = nil
    var historyStatus: String? = nil
    var availability: BalanceAvailability {
        if status == "pending_setup" { return .pendingSetup }
        return (status == "available" || status == nil) && transfers != nil ? .available : .unavailable
    }
    var availableTransfers: [FundingTransfer]? { availability == .available ? transfers : nil }
}
struct Card: Decodable { let linked: Bool; let last4: String? }
struct LinkedCard: Decodable, Identifiable, Equatable {
    let id: String
    let nickname: String
    let last4: String
    let status: String
    let linkedAt: String
    var wallet: Wallet? = nil
    var policy: Policy? = nil
    var walletStatus: String? = nil
    var allowanceSufficient: Bool? = nil
    var isFrozen: Bool { status == "frozen" }
}
struct Policy: Decodable, Equatable {
    var enabled: Bool
    let perPaymentLimit: String; let totalLimit: String; let spent: String; let expiresAt: String; let merchantIds: [String]?
    var useRewards: Bool? = nil
    var routerAddress: String? = nil
    var requiresApproval: Bool? = nil
    var maxPointsPerPayment: String? = nil
    var merchantScope: MerchantScope? = nil
    var effectiveMerchantScope: MerchantScope { merchantScope ?? .selected }
}
struct Payment: Decodable, Identifiable {
    let id: String; let merchantName: String; let amount: String; let symbol: String; let decimals: Int
    let status: String; let createdAt: String; let txHash: String?; let explorerUrl: String?; let errorCode: String?
    var cardId: String? = nil
    var grossAmount: String? = nil
    var discountAmount: String? = nil
    var rewardId: String? = nil
}
struct Merchant: Decodable, Identifiable { let id: String; let name: String }
struct MerchantSetup: Decodable {
    let name: String
    let status: String
    let message: String
    var ready: Bool { status == "ready" }
}
struct MerchantInvite: Codable {
    let code: String
    let expiresAt: String
    let merchantName: String
}
struct MerchantSignupDraft: Codable {
    let name: String
    let signupSecret: String
}
struct MerchantSummary: Decodable { let id: String; let name: String; let recipient: String; let confirmedCount: Int; let receivedTotal: String }
struct Dashboard: Decodable {
    let account: Account; let wallet: Wallet?; var card: Card; var policy: Policy?
    var cards: [LinkedCard]?
    let payments: [Payment]; let merchant: MerchantSummary?
    var unassignedWalletAvailable: Bool? = nil
}
struct Invoice: Decodable, Identifiable {
    let id: String; let merchantId: String; let recipient: String; let amount: String
    let token: String; let chainId: String; let expiresAt: String; var status: String
    let txHash: String?; let explorerUrl: String?; let errorCode: String?
    var grossAmount: String? = nil
    var discountAmount: String? = nil
    var useReward: Bool? = nil
    var rewardId: String? = nil
    var routerAddress: String? = nil
    var scanVersion: Int? = nil
    var routerKind: String? = nil
    var maxPoints: String? = nil
    var refundEligible: Bool? = nil
    var refund: PaymentRefund? = nil
    var isFinished: Bool { ["confirmed", "failed", "expired", "cancelled"].contains(status.lowercased()) }
    var canRequestNewRefund: Bool { status == "confirmed" && refundEligible == true && (refund == nil || refund?.status == "failed") }
}
struct Challenge: Decodable { let challenge: String; let expiresAt: String }
struct Terminal: Decodable { let id: String; let merchantId: String }
struct TerminalStatus: Decodable { let id: String; let merchantId: String; let publicKey: String; let active: Bool }
struct InvoiceDraft: Codable, Equatable {
    var amount = ""
    var description = ""
    var requestID: String? = nil
    var useReward = false
    var router: String? = nil
    var maxPoints: String? = nil
}
extension InvoiceDraft {
    enum CodingKeys: String, CodingKey { case amount, description, requestID, useReward, router, maxPoints }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        amount = try values.decodeIfPresent(String.self, forKey: .amount) ?? ""
        description = try values.decodeIfPresent(String.self, forKey: .description) ?? ""
        requestID = try values.decodeIfPresent(String.self, forKey: .requestID)
        useReward = try values.decodeIfPresent(Bool.self, forKey: .useReward) ?? false
        router = try values.decodeIfPresent(String.self, forKey: .router)
        maxPoints = try values.decodeIfPresent(String.self, forKey: .maxPoints)
    }
}
struct ScanPayload: Encodable {
    var version = 1
    let terminalId: String; let invoiceId: String; let challenge: String; let cardId: String
    let chainId: String; let token: String; let amount: String; let expiresAt: String
    var routerAddress: String? = nil
    var useReward: Bool? = nil
    var maxPoints: String? = nil
    enum CodingKeys: String, CodingKey { case version, terminalId, invoiceId, challenge, cardId, chainId, token, amount, expiresAt, routerAddress, useReward, maxPoints }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version)
        try values.encode(terminalId, forKey: .terminalId); try values.encode(invoiceId, forKey: .invoiceId)
        try values.encode(challenge, forKey: .challenge); try values.encode(cardId, forKey: .cardId)
        try values.encode(chainId, forKey: .chainId); try values.encode(token, forKey: .token)
        try values.encode(amount, forKey: .amount); try values.encode(expiresAt, forKey: .expiresAt)
        try values.encodeIfPresent(routerAddress, forKey: .routerAddress); try values.encodeIfPresent(useReward, forKey: .useReward)
        if version == 3 { try values.encode(maxPoints, forKey: .maxPoints) }
    }
    func canonicalBytes() throws -> Data {
        let fields: [String]
        switch version {
        case 1:
            guard routerAddress == nil, useReward == nil, maxPoints == nil else { throw AppError.message("Invalid legacy payment terms.") }
            fields = ["suica-payments-v1", terminalId, invoiceId, challenge, cardId, chainId, token, amount, expiresAt]
        case 2, 3:
            guard version != 2 || maxPoints == nil else { throw AppError.message("Points limits need an updated checkout.") }
            if let maxPoints { guard (try WholePoints.normalized(maxPoints)) == maxPoints else { throw AppError.message("Invalid points limit.") } }
            guard let routerAddress, let useReward,
                  routerAddress.range(of: "^0x[0-9a-f]{40}$", options: .regularExpression) != nil else { throw AppError.message("Incomplete reward payment terms.") }
            fields = [version == 3 ? "suica-payments-v3" : "suica-payments-v2", terminalId, invoiceId, challenge, cardId, chainId, token, amount, expiresAt, routerAddress, useReward ? "1" : "0"] + (version == 3 ? [maxPoints ?? "auto"] : [])
        default: throw AppError.message("This payment needs an app update before it can be collected.")
        }
        guard !fields.contains(where: { $0.contains("\n") || $0.contains("\r") }) else { throw AppError.message("Invalid checkout challenge.") }
        return Data(fields.joined(separator: "\n").utf8)
    }
}
struct ScanReport: Encodable { let payload: ScanPayload; let signature: String }
struct EmptyResponse: Decodable {}
enum AppError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
enum TokenAmount {
    static func display(_ units: String, decimals: Int) -> String {
        guard (0...36).contains(decimals), !units.isEmpty, units.allSatisfy(\.isNumber) else { return "Unavailable" }
        let padded = String(repeating: "0", count: max(0, decimals + 1 - units.count)) + units
        guard decimals > 0 else { return padded }
        let split = padded.index(padded.endIndex, offsetBy: -decimals)
        let fraction = String(padded[split...]).replacingOccurrences(of: "0+$", with: "", options: .regularExpression)
        return String(padded[..<split]) + (fraction.isEmpty ? "" : "." + fraction)
    }
    static func units(_ text: String, decimals: Int) throws -> String {
        let value = text.trimmingCharacters(in: .whitespaces)
        guard (0...36).contains(decimals), value.range(of: "^[0-9]+(\\.[0-9]+)?$", options: .regularExpression) != nil else { throw AppError.message("Enter a positive amount using digits and a decimal point.") }
        let parts = value.split(separator: ".")
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        guard fraction.count <= decimals else { throw AppError.message("This token supports up to \(decimals) decimal places.") }
        let raw = String(parts[0]) + fraction + String(repeating: "0", count: decimals - fraction.count)
        let normalized = raw.drop(while: { $0 == "0" })
        guard !normalized.isEmpty, normalized.count <= 78 else { throw AppError.message("Enter an amount greater than zero and within the token limit.") }
        return String(normalized)
    }
}

struct FundingTransfer: Decodable, Identifiable {
    let id: String; let from: String; let amount: String; let symbol: String; let decimals: Int
    let createdAt: String; let txHash: String; let explorerUrl: String?; let status: String
    var name: String? = nil
    var onchainSymbol: String? = nil
}


enum PaymentIssue {
    static func message(code: String?, status: String) -> String? {
        guard status.lowercased() != "confirmed" else { return nil }
        switch code {
        case "insufficient_gas":
            return "Add network-fee funds to the linked wallet, then create a new payment."
        case "insufficient_tokens":
            return "Not enough test tokens. Add funds, then create a new payment."
        case "insufficient_allowance":
            return "Wallet approval is too low. Update it and wait for confirmation before creating a new payment."
        case "reward_unavailable":
            return "No eligible reward is available for this card at this merchant. Create a new payment without reward use if the customer wants to pay the full amount."
        case "reward_permission_required":
            return "Automatic reward use is not enabled for this card. Review spending permission or create a new payment without a reward."
        case "invoice_expired":
            return "Payment expired. Ask the merchant for a new one."
        case "spending_disabled_before_signing":
            return "Tap payments were disabled. Review your spending permission."
        case "transaction_reverted":
            return "Payment failed. Ask support to check before trying again."
        case "submission_unknown":
            return "Checking payment. Don’t tap again or create another payment yet."
        case .some:
            return "Ask support to check this payment before trying again."
        case .none:
            if status.lowercased() == "reconciling" {
                return "Checking payment. Don’t tap again or create another payment yet."
            }
            if status.lowercased() == "failed" {
                return "Ask support to check this payment before trying again."
            }
            return nil
        }
    }
}

struct DeviceLink: Codable {
    let id: String
    let userCode: String
    let deviceSecret: String
    let expiresAt: String
}
enum AppDates {
    static func date(_ raw: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
}

/// Display projection of two real API sources; funding never becomes a merchant-payment record.
enum WalletActivity: Identifiable {
    case payment(Payment)
    case funding(FundingTransfer)
    case reward(RewardActivity)

    var id: String {
        switch self {
        case .payment(let payment): return "payment:" + payment.id.lowercased()
        case .funding(let transfer): return "funding:" + transfer.id.lowercased()
        case .reward(let event): return event.id
        }
    }
    var createdAt: Date? {
        switch self {
        case .payment(let payment): return AppDates.date(payment.createdAt)
        case .funding(let transfer): return AppDates.date(transfer.createdAt)
        case .reward(let event): return AppDates.date(event.createdAt)
        }
    }
    static func timeline(payments: [Payment], funding: [FundingTransfer], rewards: [RewardVoucher] = []) -> [WalletActivity] {
        var seen = Set<String>()
        let entries = payments.map(Self.payment) + funding.map(Self.funding) + rewards.flatMap(RewardActivity.events).map(Self.reward)
        return entries.filter { seen.insert($0.id).inserted }.sorted {
            let leftDate = $0.createdAt ?? .distantPast
            let rightDate = $1.createdAt ?? .distantPast
            return leftDate == rightDate ? $0.id < $1.id : leftDate > rightDate
        }
    }
}


struct TestFundingResponse: Decodable {
    let status: String
    let amount: String
    let symbol: String
    let canClaim: Bool
    let claim: TestFundingClaim?
    let reason: String?
    var permitsNewClaim: Bool { status == "available" && canClaim && claim == nil }
    var unavailableMessage: String {
        switch reason {
        case "wallet_not_ready": return "Your wallet is still being prepared. Check again shortly."
        case "daily_limit_reached": return "Today's test-token limit has been reached. Try again tomorrow."
        case "test_funding_disabled", "test_funding_unconfigured": return "Test-token funding is not available yet. Check again later."
        default: return "Test-token funding is temporarily unavailable. Check again shortly."
        }
    }
}
struct TestFundingClaim: Decodable, Identifiable {
    let id: String
    let status: String
    let cardId: String
    let walletAddress: String
    let amount: String
    let txHash: String?
    let explorerUrl: String?
    let errorCode: String?
    var isPending: Bool { ["queued", "submitting", "pending", "reconciling"].contains(status) }
    func belongsTo(cardID: String?, address: String?) -> Bool {
        guard let address, address.caseInsensitiveCompare(walletAddress) == .orderedSame else { return false }
        return cardID == nil || cardID?.caseInsensitiveCompare(cardId) == .orderedSame
    }
    var progressMessage: String {
        switch status {
        case "queued": return "Your request is saved. Waiting to send your test tokens."
        case "submitting", "pending": return "Your test-token transfer is awaiting confirmation."
        case "reconciling": return "We’re checking the transfer. You don’t need to request it again."
        case "failed": return "The transfer needs support. Your saved request cannot be claimed again."
        default: return "Check status for the latest transfer information."
        }
    }
}
