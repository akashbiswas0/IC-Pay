import Foundation

enum AccountAccessPurpose: String, Codable { case login, recovery }

struct CardLinkIntent: Codable, Equatable {
    enum Purpose: String, Codable { case enrollment, addition, replacement }
    let purpose: Purpose
    var replacesCardId: String? = nil
    static let enrollment = CardLinkIntent(purpose: .enrollment)
    static let addition = CardLinkIntent(purpose: .addition)
    static func replacement(_ id: String? = nil) -> CardLinkIntent {
        CardLinkIntent(purpose: .replacement, replacesCardId: id)
    }
}

/// Secure backend operation metadata. Legacy URLs are parsed only to recover a scoped capability; the app never navigates to them.
struct PendingWorldHandoff: Codable {
    let id: String
    let handoffToken: String?
    let url: URL?
    let server: String
    let sessionHash: String
    let exchangeSecret: String?
    var nativeStarted: Bool? = nil
    var cardLink: CardLinkIntent? = nil
    var accountAccess: AccountAccessPurpose? = nil
    var resolvedAccountAccess: AccountAccessPurpose? { exchangeSecret == nil ? nil : accountAccess ?? .login }

    func capability() throws -> String {
        guard UUID(uuidString: id) != nil else { throw invalid() }
        if let handoffToken { return try validatedToken(handoffToken) }
        guard let url, url.scheme == "https", url.user == nil, url.password == nil,
              url.path.hasSuffix("/verify"), url.query == nil,
              let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
              let items = URLComponents(string: "?" + fragment)?.queryItems,
              items.count == 2,
              items.filter({ $0.name == "requestId" }).count == 1,
              items.filter({ $0.name == "handoffToken" }).count == 1,
              items.first(where: { $0.name == "requestId" })?.value == id,
              let token = items.first(where: { $0.name == "handoffToken" })?.value else { throw invalid() }
        return try validatedToken(token)
    }

    func rebased(from trustedServer: String, session expectedSessionHash: String, to currentServer: String) throws -> PendingWorldHandoff {
        guard server == trustedServer, sessionHash == expectedSessionHash else { throw invalid() }
        return PendingWorldHandoff(id: id, handoffToken: try capability(), url: nil, server: currentServer, sessionHash: sessionHash, exchangeSecret: exchangeSecret, nativeStarted: nativeStarted, cardLink: cardLink, accountAccess: accountAccess)
    }

    private func validatedToken(_ token: String) throws -> String {
        guard token.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil else { throw invalid() }
        return token
    }
    private func invalid() -> AppError { .message("Your verification needs a fresh start. Scan your card to try again.") }
}


struct VerificationCancellation: Decodable {
    enum Status: String, Decodable { case cancelled, verified }
    let status: Status
}
