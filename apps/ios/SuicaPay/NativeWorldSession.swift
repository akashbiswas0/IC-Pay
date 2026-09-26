import Foundation
import IDKit

struct NativeWorldContext: Decodable, Sendable {
    struct RP: Decodable, Sendable {
        let rpID: String
        let nonce: String
        let createdAt: UInt64
        let expiresAt: UInt64
        let signature: String
        enum CodingKeys: String, CodingKey {
            case rpID = "rp_id", nonce, createdAt = "created_at", expiresAt = "expires_at", signature
        }
    }
    let id: String
    let purpose: String
    let appId: String
    let environment: String
    let sessionId: String?
    let rpContext: RP
    var replacesCardId: String? = nil

    func validate(now: Date = Date()) throws {
        guard UUID(uuidString: id) != nil, appId.hasPrefix("app_"), !rpContext.nonce.isEmpty,
              ["enrollment", "addition", "replacement", "login", "recovery"].contains(purpose),
              ["production", "staging", "sandbox"].contains(environment),
              rpContext.expiresAt > rpContext.createdAt,
              TimeInterval(rpContext.expiresAt) > now.timeIntervalSince1970 else { throw NativeWorldError.invalidContext }
        if let replacesCardId {
            guard purpose == "replacement", UUID(uuidString: replacesCardId) != nil else { throw NativeWorldError.invalidContext }
        }
        if purpose == "enrollment" {
            guard sessionId == nil else { throw NativeWorldError.invalidContext }
        } else {
            guard let sessionId, sessionId.range(of: "^session_[A-Fa-f0-9]{128}$", options: .regularExpression) != nil else { throw NativeWorldError.invalidContext }
        }
    }
}

enum NativeWorldError: LocalizedError {
    case invalidContext, invalidConnector, incompleteProof
    var errorDescription: String? {
        switch self {
        case .invalidContext: return "This World verification request is invalid or expired. Start this check again."
        case .invalidConnector: return "World couldn’t provide a valid app link. Start this check again."
        case .incompleteProof: return "The World SDK returned an incomplete verification result. Your account has not been verified. Please contact the IC Pay team."
        }
    }
}

enum NativeWorldEvent: Sendable {
    case waiting
    case awaitingConfirmation
    case proofJSON(String)
    case failed(String)
    case networkError(String)
}

/// Thin adapter over public bindings built from unmodified official World core revision
/// 16bc527f52ec297a041fed9debfa6d17dea5ed28. See Vendor/IDKit provenance; not the 4.0.11 release binary.
/// All Rust networking runs on a dedicated serial queue, never on the main actor.
final class NativeWorldSession: @unchecked Sendable {
    let connectorURL: URL
    let requestID: String
    private let request: IdKitRequestWrapper
    private let queue: DispatchQueue
    private let context: NativeWorldContext

    private init(request: IdKitRequestWrapper, queue: DispatchQueue, context: NativeWorldContext) throws {
        guard let url = URL(string: request.connectUrl()), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else { throw NativeWorldError.invalidConnector }
        connectorURL = url
        requestID = request.requestId()
        self.request = request
        self.queue = queue
        self.context = context
    }

    static func start(context: NativeWorldContext, returnTo: String = "suicapay://verify-return") async throws -> NativeWorldSession {
        try context.validate()
        try Task.checkCancellation()
        let queue = DispatchQueue(label: "app.suicapay.world-session", qos: .userInitiated)
        let session: NativeWorldSession = try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let rp = try RpContext(rpId: context.rpContext.rpID, nonce: context.rpContext.nonce,
                                           createdAt: context.rpContext.createdAt, expiresAt: context.rpContext.expiresAt,
                                           signature: context.rpContext.signature)
                    let environment: Environment = context.environment == "production" ? .production : context.environment == "staging" ? .staging : .sandbox
                    let config = IdKitSessionConfig(appId: context.appId, packageName: "idkit_swift", packageVersion: IDKit.version,
                        rpContext: rp, actionDescription: nil, bridgeUrl: nil, requireUserPresence: nil,
                        overrideConnectBaseUrl: nil, returnTo: returnTo, environment: environment)
                    let builder = context.sessionId.map { IdKitBuilder.fromProveSession(sessionId: $0, config: config) }
                        ?? IdKitBuilder.fromCreateSession(config: config)
                    let credential = CredentialRequest.withStringSignal(credentialType: .selfie, signal: nil)
                    let request = try builder.constraints(constraints: ConstraintNode.item(request: credential))
                    continuation.resume(returning: try NativeWorldSession(request: request, queue: queue, context: context))
                } catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
        return session
    }

    func pollOnce() async throws -> NativeWorldEvent {
        try Task.checkCancellation()
        let event: NativeWorldEvent = try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                do {
                    let event: NativeWorldEvent
                    switch request.pollStatusOnce() {
                    case .waitingForConnection: event = .waiting
                    case .awaitingConfirmation: event = .awaitingConfirmation
                    case .failed(let error): event = .failed(String(describing: error))
                    case .networkingError(let error): event = .networkError(String(describing: error))
                    case .confirmed(let result):
                        let json = try idkitResultToJson(result: result)
                        try Self.validateCompleteProof(json, context: context)
                        event = .proofJSON(json)
                    }
                    continuation.resume(returning: event)
                } catch { continuation.resume(throwing: error) }
            }
        }
        try Task.checkCancellation()
        return event
    }

    /// Refuse SDK serialization that drops fields required for the backend's intact Selfie proof verification.
    static func validateCompleteProof(_ json: String, context: NativeWorldContext) throws {
        guard let data = json.data(using: .utf8), let proof = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              proof["protocol_version"] as? String == "4.0", proof["nonce"] as? String == context.rpContext.nonce,
              let session = proof["session_id"] as? String, !session.isEmpty,
              context.sessionId == nil || context.sessionId == session,
              let responses = proof["responses"] as? [[String: Any]], !responses.isEmpty,
              responses.allSatisfy({ $0["issuer_schema_id"] as? Int == 11 && $0["sybil_score"] != nil }),
              let integrity = proof["integrity_bundle"] as? [String: Any], integrity["version"] as? Int == 2
        else { throw NativeWorldError.incompleteProof }
    }
}


struct NativeWorldOperation: Equatable, Sendable {
    let id: String
    let accountGeneration: UInt
    let attempt: UInt
    func matches(id: String?, accountGeneration: UInt, attempt: UInt) -> Bool {
        self.id == id && self.accountGeneration == accountGeneration && self.attempt == attempt
    }
}
