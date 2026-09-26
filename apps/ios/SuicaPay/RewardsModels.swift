import Foundation

struct RewardVoucher: Decodable, Identifiable {
    let id: String
    let cardId: String?
    let walletAddress: String
    let merchantId: String
    let merchantName: String
    let discountBps: Int?
    let maxDiscount: String?
    let minPurchase: String?
    let expiresAt: String
    let status: String
    let earnedTxHash: String?
    let redeemedTxHash: String?
    let earnedAt: String?
    let redeemedAt: String?
    let earnedExplorerUrl: String?
    let redeemedExplorerUrl: String?
    var earnBps: Int? = nil
    var maxCredit: String? = nil
    var rewardType: String? = nil
    var tokenId: String? = nil
    var contractAddress: String? = nil
    var collectionKey: String? = nil
    var imageUrl: String? = nil
    var creditAmount: String? = nil
    var remainingCredit: String? = nil
    var purchaseAmount: String? = nil
    var nftOwned: Bool? = nil
    var symbol: String? = nil
    var decimals: Int? = nil
    var events: [CollectibleEvent]? = nil
    var isCredit: Bool { rewardType == "credit" }
    var collectionIdentity: String {
        collectionKey?.lowercased() ?? contractAddress.map { $0.lowercased() + ":" + (tokenId ?? id) } ?? id.lowercased()
    }
    var retainedCollectible: Bool { isCredit && nftOwned == true }
    var hasSpendableValue: Bool { ["available", "reserved"].contains(status) && (!isCredit || remainingCredit.flatMap { Decimal(string: $0) }.map { $0 > 0 } == true) }
    var artworkURL: URL? {
        guard let imageUrl, let url = URL(string: imageUrl), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    var percentage: String { discountBps.map(RewardFormatting.percentage) ?? "Unavailable" }
    var statusTitle: String {
        switch status {
        case "available": return isCredit && remainingCredit != creditAmount ? "Credit partly used" : "Available"
        case "reserved": return "In use by a pending payment"
        case "used": return retainedCollectible ? "Credit redeemed · NFT kept" : "Used"
        case "expired": return retainedCollectible ? "Credit expired · NFT kept" : "Expired"
        default: return "Status unavailable"
        }
    }
}
struct RewardsResponse: Decodable {
    let status: String
    let rewards: [RewardVoucher]?
    let routerAddress: String?
    var availableRewards: [RewardVoucher]? { status == "available" ? rewards : nil }
}
struct CollectiblesResponse: Decodable {
    let status: String
    let items: [RewardVoucher]?
    let routerAddress: String?
    var availableItems: [RewardVoucher]? { status == "available" ? items : nil }
}
struct CollectibleEvent: Decodable {
    let id: String
    let kind: String
    let createdAt: String
    let txHash: String
    let explorerUrl: String?
    let discountAmount: String?
    let remainingCredit: String?
}
struct RewardCampaign: Codable, Equatable {
    let enabled: Bool
    let minPurchase: String
    let discountBps: Int
    let maxDiscount: String
    let validitySeconds: Int
    let version: Int
}
struct RewardCampaignOperation: Decodable {
    let id: String
    let status: String
    let txHash: String?
    let errorCode: String?
    var isPending: Bool { !["confirmed", "failed"].contains(status) }
}
struct RewardCampaignResponse: Decodable {
    let status: String
    let campaign: RewardCampaign?
    let operation: RewardCampaignOperation?
}
/// A confirmed token's history remains distinct from merchant payments and funding.
struct RewardActivity: Identifiable {
    enum Kind: String { case earned, redeemed }
    let kind: Kind
    let reward: RewardVoucher
    let createdAt: String
    let txHash: String?
    let explorerURL: String?
    var eventID: String? = nil
    var discountAmount: String? = nil
    var remainingCredit: String? = nil
    var id: String { "reward:" + kind.rawValue + ":" + reward.collectionIdentity + (eventID.map { ":" + $0.lowercased() } ?? "") }
    static func events(_ reward: RewardVoucher) -> [RewardActivity] {
        if let logs = reward.events {
            return logs.compactMap { event in
                guard let kind = Kind(rawValue: event.kind), !event.txHash.isEmpty, AppDates.date(event.createdAt) != nil else { return nil }
                return RewardActivity(kind: kind, reward: reward, createdAt: event.createdAt, txHash: event.txHash, explorerURL: event.explorerUrl, eventID: event.id, discountAmount: event.discountAmount, remainingCredit: event.remainingCredit)
            }
        }
        // A remaining-credit snapshot cannot stand in for the actual partial-redemption receipts.
        guard !reward.isCredit else { return [] }
        var events: [RewardActivity] = []
        if let created = reward.earnedAt, let hash = reward.earnedTxHash {
            events.append(RewardActivity(kind: .earned, reward: reward, createdAt: created, txHash: hash, explorerURL: reward.earnedExplorerUrl))
        }
        if reward.status == "used", let used = reward.redeemedAt, let hash = reward.redeemedTxHash {
            events.append(RewardActivity(kind: .redeemed, reward: reward, createdAt: used, txHash: hash, explorerURL: reward.redeemedExplorerUrl))
        }
        return events
    }
}
enum RewardFormatting {
    static func duration(_ seconds: Int) -> String {
        guard seconds > 0 else { return "Unavailable" }
        var remaining = seconds
        return [(86_400, "day"), (3_600, "hour"), (60, "minute"), (1, "second")].compactMap { unit, name in
            let count = remaining / unit
            remaining %= unit
            return count == 0 ? nil : "\(count) \(name)" + (count == 1 ? "" : "s")
        }.joined(separator: ", ")
    }
    static func offer(_ campaign: RewardCampaign, decimals: Int, symbol: String) -> String {
        "Spend at least \(TokenAmount.display(campaign.minPurchase, decimals: decimals)) \(symbol) to earn \(percentage(campaign.discountBps)) off a later visit, up to \(TokenAmount.display(campaign.maxDiscount, decimals: decimals)) \(symbol). Valid for \(duration(campaign.validitySeconds))."
    }
    static func percentage(_ bps: Int) -> String {
        guard (1...9_999).contains(bps) else { return "Unavailable" }
        return TokenAmount.display(String(bps), decimals: 2) + "%"
    }
}
/// User-editable campaign settings are a draft, never presented as active onchain state.
struct RewardCampaignDraft: Codable, Equatable {
    var enabled = false
    var minimumPurchase = "100"
    var discountPercent = "50"
    var maximumDiscount = "50"
    var validityDays = "30"
    var requestID: String? = nil
    init() {}
    init(campaign: RewardCampaign, decimals: Int) {
        enabled = campaign.enabled
        minimumPurchase = TokenAmount.display(campaign.minPurchase, decimals: decimals)
        discountPercent = TokenAmount.display(String(campaign.discountBps), decimals: 2)
        maximumDiscount = TokenAmount.display(campaign.maxDiscount, decimals: decimals)
        validityDays = NSDecimalNumber(decimal: Decimal(campaign.validitySeconds) / Decimal(86_400)).stringValue
    }
    /// Uses the same normalized terms as submission, without changing the durable draft.
    func offerSummary(decimals: Int, symbol: String) -> String? {
        guard let body = try? requestBody(decimals: decimals, requestID: "summary"),
              let minimum = body["minPurchase"] as? String,
              let maximum = body["maxDiscount"] as? String,
              let bps = body["discountBps"] as? Int,
              let seconds = body["validitySeconds"] as? Int else { return nil }
        return RewardFormatting.offer(RewardCampaign(enabled: enabled, minPurchase: minimum, discountBps: bps, maxDiscount: maximum, validitySeconds: seconds, version: 0), decimals: decimals, symbol: symbol)
    }
    func matches(_ campaign: RewardCampaign, decimals: Int) -> Bool {
        guard let body = try? requestBody(decimals: decimals, requestID: "comparison") else { return false }
        return body["enabled"] as? Bool == campaign.enabled && body["minPurchase"] as? String == campaign.minPurchase &&
            body["discountBps"] as? Int == campaign.discountBps && body["maxDiscount"] as? String == campaign.maxDiscount &&
            body["validitySeconds"] as? Int == campaign.validitySeconds
    }
    func requestBody(decimals: Int, requestID: String) throws -> [String: Any] {
        guard let bps = Int(try TokenAmount.units(discountPercent, decimals: 2)), (1...9_999).contains(bps),
              validityDays.range(of: "^[0-9]+(\\.[0-9]+)?$", options: .regularExpression) != nil,
              let days = Decimal(string: validityDays, locale: Locale(identifier: "en_US_POSIX")), days > 0 else { throw AppError.message("Choose a discount from 0.01% to 99.99% and a valid duration in days.") }
        var rawSeconds = days * Decimal(86_400)
        var roundedSeconds = Decimal()
        NSDecimalRound(&roundedSeconds, &rawSeconds, 0, .plain)
        guard roundedSeconds >= 60, roundedSeconds <= 31_536_000 else { throw AppError.message("Reward validity must be between one minute and 365 days.") }
        return ["enabled": enabled, "minPurchase": try TokenAmount.units(minimumPurchase, decimals: decimals), "discountBps": bps,
                "maxDiscount": try TokenAmount.units(maximumDiscount, decimals: decimals), "validitySeconds": NSDecimalNumber(decimal: roundedSeconds).intValue, "requestId": requestID]
    }
}


struct CollectibleCampaign: Codable, Equatable {
    let enabled: Bool
    let minPurchase: String
    let earnBps: Int
    let maxCredit: String
    let validitySeconds: Int
    let version: Int
    func summary(decimals: Int, symbol: String) -> String {
        "Spend at least \(TokenAmount.display(minPurchase, decimals: decimals)) \(symbol) and earn \(TokenAmount.display(String(earnBps), decimals: 2) + "%") in credit, up to \(TokenAmount.display(maxCredit, decimals: decimals)) \(symbol), for a later visit. Credit is valid for \(RewardFormatting.duration(validitySeconds))."
    }
}
struct CollectibleCampaignResponse: Decodable {
    let status: String
    let campaign: CollectibleCampaign?
    let operation: RewardCampaignOperation?
}
struct CollectibleCampaignDraft: Codable, Equatable {
    var enabled = false
    var minimumPurchase = "1"
    var earnPercent = "5"
    var maximumCredit = "50"
    var validityDays = "30"
    var requestID: String? = nil
    init() {}
    init(campaign: CollectibleCampaign, decimals: Int) {
        enabled = campaign.enabled
        minimumPurchase = TokenAmount.display(campaign.minPurchase, decimals: decimals)
        earnPercent = TokenAmount.display(String(campaign.earnBps), decimals: 2)
        maximumCredit = TokenAmount.display(campaign.maxCredit, decimals: decimals)
        validityDays = NSDecimalNumber(decimal: Decimal(campaign.validitySeconds) / Decimal(86_400)).stringValue
    }
    func normalized(decimals: Int) throws -> CollectibleCampaign {
        guard let bps = Int(try TokenAmount.units(earnPercent, decimals: 2)), (1...10_000).contains(bps),
              validityDays.range(of: "^[0-9]+(\\.[0-9]+)?$", options: .regularExpression) != nil,
              let days = Decimal(string: validityDays, locale: Locale(identifier: "en_US_POSIX")) else {
            throw AppError.message("Choose an earning rate from 0.01% to 100% and a valid duration in days.")
        }
        var seconds = days * Decimal(86_400), rounded = Decimal()
        NSDecimalRound(&rounded, &seconds, 0, .plain)
        guard rounded >= 60, rounded <= 31_536_000 else { throw AppError.message("Credit validity must be between one minute and 365 days.") }
        return CollectibleCampaign(enabled: enabled, minPurchase: try TokenAmount.units(minimumPurchase, decimals: decimals), earnBps: bps, maxCredit: try TokenAmount.units(maximumCredit, decimals: decimals), validitySeconds: NSDecimalNumber(decimal: rounded).intValue, version: 0)
    }
    func requestBody(decimals: Int, requestID: String) throws -> [String: Any] {
        let campaign = try normalized(decimals: decimals)
        return ["enabled": campaign.enabled, "minPurchase": campaign.minPurchase, "earnBps": campaign.earnBps, "maxCredit": campaign.maxCredit, "validitySeconds": campaign.validitySeconds, "requestId": requestID]
    }
    func matches(_ campaign: CollectibleCampaign, decimals: Int) -> Bool {
        guard let normalized = try? normalized(decimals: decimals) else { return false }
        return normalized.enabled == campaign.enabled && normalized.minPurchase == campaign.minPurchase && normalized.earnBps == campaign.earnBps && normalized.maxCredit == campaign.maxCredit && normalized.validitySeconds == campaign.validitySeconds
    }
    func summary(decimals: Int, symbol: String) -> String? { (try? normalized(decimals: decimals))?.summary(decimals: decimals, symbol: symbol) }
}


/// Recovery is about the persisted request, never the server's unrelated latest operation.
enum CampaignRecovery {
    static func showsSubmit(hasPendingRequest: Bool, operation: RewardCampaignOperation?, hasReadError: Bool) -> Bool {
        // A saved UUID always has an idempotent recovery path, even when GET returns a latest operation.
        return hasPendingRequest || operation?.isPending != true || hasReadError
    }
    static func shouldRetire(hasPendingRequest: Bool, knownOperationID: String?, operation: RewardCampaignOperation?) -> Bool {
        guard hasPendingRequest, let knownOperationID, let operation else { return false }
        return knownOperationID == operation.id && !operation.isPending
    }
    static func replayPayload(_ payload: Data?, requestID: String) throws -> Data {
        guard let payload, let fields = try JSONSerialization.jsonObject(with: payload) as? [String: Any], fields["requestId"] as? String == requestID else {
            throw AppError.message("This campaign request needs support to recover its original terms.")
        }
        return payload
    }
}
