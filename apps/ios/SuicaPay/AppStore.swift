import Foundation
import Observation
import CryptoKit
import UIKit

@MainActor @Observable final class AppStore {
    private let credentialNamespace: String
    private let urlSession: URLSession
    private func secureRead(_ key: String) throws -> Data? { try Keychain.read(credentialNamespace + key) }
    private func secureSave(_ data: Data?, key: String) throws { try Keychain.save(data, key: credentialNamespace + key) }
    private(set) var serverURL = ""
    private(set) var dashboardURL = ""
    private(set) var sessionToken = ""
    var account: Account?
    // Emitted only after an explicit action has been confirmed, never by balance polling.
    private(set) var actionSuccessSequence = 0
    var isStarting = true
    var serviceUnavailable: String?
    var approvalCode: String?
    var deviceLink: DeviceLink?
    var deviceLinkMessage: String?
    var terminalEnrolled = false
    var dashboard: Dashboard?
    var config: AppConfig?
    var invoice: Invoice?
    var invoiceRequestPending = false
    private(set) var refundRequestPending = false
    private(set) var refundError: String?
    private var refundReadRevision: UInt = 0
    var merchants: [Merchant] = []
    var merchantSetup: MerchantSetup?
    var merchantInvite: MerchantInvite?
    var funding: [FundingTransfer]?
    var fundingError: String?
    var fundingStatus: String?
    var fundingHistoryComplete: Bool?
    var fundingHistoryStatus: String?
    private struct TestFundingRead {
        var response: TestFundingResponse?
        var error: String?
        var loading = false
        var revision: UInt = 0
    }
    private var testFundingReads: [String: TestFundingRead] = [:]
    private var testFundingRevision: UInt = 0
    private var testFundingPostID: UUID?
    var isClaimingTestFunding: Bool { testFundingPostID != nil }
    func testFunding(for cardID: String?) -> TestFundingResponse? { testFundingReads[cardID ?? "account"]?.response }
    func testFundingError(for cardID: String?) -> String? { testFundingReads[cardID ?? "account"]?.error }
    func isLoadingTestFunding(for cardID: String?) -> Bool { testFundingReads[cardID ?? "account"]?.loading == true }
    private var fundingRequests = 0
    private var refreshRequests = 0
    var isLoadingFunding: Bool { fundingRequests > 0 }
    var isRefreshing: Bool { refreshRequests > 0 }
    private(set) var merchantsLoaded = false
    private(set) var walletCreation: WalletCreationResult?
    private(set) var walletRefreshError: String?
    var allowanceJobID: String?
    var allowanceStatus: String?
    private struct CardMoneyState {
        var creation: WalletCreationResult?
        var funding: [FundingTransfer]?
        var fundingStatus: String?
        var fundingError: String?
        var fundingHistoryComplete: Bool?
        var fundingHistoryStatus: String?
        var fundingRequests = 0
        var fundingRevision: UInt = 0
        var allowanceJobID: String?
        var allowanceStatus: String?
    }
    private struct LoyaltyReadState {
        var response: LoyaltyResponse?
        var error: String?
        var loading = false
        var revision: UInt = 0
    }
    private var loyaltyReads: [String: LoyaltyReadState] = [:]
    private var loyaltyReadRevision: UInt = 0
    private(set) var loyaltyProgram: LoyaltyProgramResponse?
    private(set) var loyaltyProgramError: String?
    private(set) var loyaltyProgramRequestPending = false
    private var loyaltyProgramReads = 0
    private var loyaltyProgramRevision: UInt = 0
    var isLoadingLoyaltyProgram: Bool { loyaltyProgramReads > 0 }
    private struct RewardsReadState {
        var values: [RewardVoucher]?
        var status: String?
        var error: String?
        var requests = 0
        var revision: UInt = 0
    }
    private var rewardReads: [String: RewardsReadState] = [:]
    private(set) var collectibleCampaign: CollectibleCampaignResponse?
    private(set) var collectibleCampaignError: String?
    private(set) var collectibleCampaignRequestPending = false
    private var collectibleCampaignReads = 0
    private var collectibleCampaignRevision: UInt = 0
    var isLoadingCollectibleCampaign: Bool { collectibleCampaignReads > 0 }
    private(set) var rewardCampaign: RewardCampaignResponse?
    private(set) var campaignError: String?
    private(set) var campaignRequestPending = false
    private var campaignReads = 0
    private var campaignRevision: UInt = 0
    var isLoadingCampaign: Bool { campaignReads > 0 }
    private var cardMoney: [String: CardMoneyState] = [:]
    private var cardRevisions: [String: UInt] = [:]
    private func linkedCard(_ id: String) -> LinkedCard? { dashboard?.cards?.first { $0.id == id } }
    func wallet(for cardID: String?) -> Wallet? {
        if let cardID { return linkedCard(cardID)?.wallet }
        return dashboard?.wallet
    }
    func policy(for cardID: String?) -> Policy? {
        if let cardID { return linkedCard(cardID)?.policy }
        return dashboard?.policy
    }
    func walletCreation(for cardID: String?) -> WalletCreationResult? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.creation }
        return walletCreation
    }
    func funding(for cardID: String?) -> [FundingTransfer]? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.funding }
        return funding
    }
    func fundingStatus(for cardID: String?) -> String? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.fundingStatus }
        return fundingStatus
    }
    func fundingHistoryComplete(for cardID: String?) -> Bool? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.fundingHistoryComplete }
        return fundingHistoryComplete
    }
    func fundingHistoryStatus(for cardID: String?) -> String? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.fundingHistoryStatus }
        return fundingHistoryStatus
    }
    func fundingError(for cardID: String?) -> String? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.fundingError }
        return fundingError
    }
    func isLoadingFunding(for cardID: String?) -> Bool {
        if let cardID { return linkedCard(cardID) != nil && (cardMoney[cardID]?.fundingRequests ?? 0) > 0 }
        return isLoadingFunding
    }
    func allowanceJobID(for cardID: String?) -> String? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.allowanceJobID }
        return allowanceJobID
    }
    func allowanceStatus(for cardID: String?) -> String? {
        if let cardID { return linkedCard(cardID) == nil ? nil : cardMoney[cardID]?.allowanceStatus }
        return allowanceStatus
    }
    func preparingPermission(for cardID: String?) -> Bool {
        allowanceJobID(for: cardID) != nil && allowanceStatus(for: cardID) != "failed"
    }
    func paymentsEnabled(form: SpendingForm, cardID: String? = nil) -> Bool {
        if policy(for: cardID)?.requiresApproval == true || !policyRouterMatchesActive(cardID: cardID) { return false }
        if let cardID, linkedCard(cardID)?.allowanceSufficient != true { return false }
        return form.isEnabled(in: policy(for: cardID), decimals: config?.token.decimals ?? 18)
    }
    func policyRouterMatchesActive(cardID: String?) -> Bool {
        guard let active = config?.paymentRouter?.address else { return true }
        guard let saved = policy(for: cardID)?.routerAddress else { return config?.paymentRouter?.kind == "legacy" }
        return saved.caseInsensitiveCompare(active) == .orderedSame
    }
    private func requireCard(_ cardID: String?) throws {
        if let cardID, linkedCard(cardID) == nil { throw AppError.message("This card is no longer linked. Refresh your cards.") }
    }
    private func moneyOperationCurrent(_ cardID: String?, generation: UInt, revision: UInt) -> Bool {
        guard generation == sessionGeneration else { return false }
        guard let cardID else { return true }
        return linkedCard(cardID) != nil && cardRevisions[cardID, default: 0] == revision
    }
    private func scopedBody(_ body: [String: Any], cardID: String?) -> [String: Any] {
        var result = body
        if let cardID { result["cardId"] = cardID }
        return result
    }
    private func setAllowance(jobID: String?, status: String?, cardID: String?) {
        if let cardID {
            cardMoney[cardID, default: CardMoneyState()].allowanceJobID = jobID
            cardMoney[cardID, default: CardMoneyState()].allowanceStatus = status
        } else { allowanceJobID = jobID; allowanceStatus = status }
    }
    private func invalidateCardMoney(_ id: String) {
        cardMoney[id] = nil
        rewardReads[id] = nil
        loyaltyReads[id] = nil
        cardRevisions[id, default: 0] &+= 1
        try? secureSave(nil, key: permissionKey(for: id))
        try? secureSave(nil, key: spendingFormKey(for: id))
    }
    var busy = false
    var error: String?
    var notice: String?
    private(set) var verificationURL: URL?
    private(set) var worldStatus = ""
    private(set) var worldNeedsRestart = false
    private(set) var worldIsStarting = false
    private(set) var worldIsSubmitting = false
    private(set) var worldAppUnavailable = false
    private var worldSession: NativeWorldSession?
    private var worldTask: Task<Void, Never>?
    private var worldAttempt: UInt = 0
    private var worldTaskSerial: UInt = 0
    private var worldForeground = true
    private var worldCapability: String?
    private var worldContextExpiry: Date?
    private var worldProofJSON: String?
    private var worldSubmissionAttempted = false
    var verificationID: String?
    private var loginExchangeSecret: String?
    private var pendingCardLink: CardLinkIntent?
    private(set) var accountAccessPurpose: AccountAccessPurpose?
    private var sessionGeneration: UInt = 0
    private var operationRevision: UInt = 0
    private var refreshRevision: UInt = 0
    private var previousServerURL: String?
    private func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    var sessionViewID: String { hash(serverURL + "\n" + sessionToken) }
    private var pendingVerificationKey: String { "pending-world." + hash(serverURL + "\n" + sessionToken) }
    private func restoreVerification() throws {
        resetNativeVerification()
        verificationID = nil; verificationURL = nil; loginExchangeSecret = nil; pendingCardLink = nil; accountAccessPurpose = nil
        guard let data = try secureRead(pendingVerificationKey) else { return }
        let pending: PendingWorldHandoff
        do {
            let stored = try JSONDecoder().decode(PendingWorldHandoff.self, from: data)
            pending = try stored.rebased(from: serverURL, session: hash(sessionToken), to: serverURL)
        } catch {
            try secureSave(nil, key: pendingVerificationKey)
            notice = "Scan your card to restart verification."
            return
        }
        try secureSave(JSONEncoder().encode(pending), key: pendingVerificationKey)
        verificationID = pending.id; worldCapability = try pending.capability(); loginExchangeSecret = pending.exchangeSecret
        pendingCardLink = pending.cardLink
        accountAccessPurpose = pending.resolvedAccountAccess
        // The native SDK's in-memory encrypted request cannot be restored. Check server completion first.
        worldNeedsRestart = true
        worldStatus = "Checking verification… Restart if incomplete."
        verificationURL = nil
    }
    private func migrateTrustedDeployment(from previous: String) throws {
        guard previous != serverURL else { return }
        let migrationKey = "deployment-migration." + hash(previous + "\n" + serverURL)
        // A later sign-out must never resurrect a leftover session from the former host.
        guard try secureRead(migrationKey) == nil else { return }
        let oldSessionKey = "app-session." + hash(previous)
        let oldSession = try secureRead(oldSessionKey)
        if sessionToken.isEmpty, let oldSession {
            sessionToken = String(data: oldSession, encoding: .utf8) ?? ""
            if !sessionToken.isEmpty { try secureSave(oldSession, key: activeSessionKey) }
        }
        let oldScope = hash(previous + "\n" + sessionToken)
        let oldPendingKey = "pending-world." + oldScope
        if try secureRead(pendingVerificationKey) == nil, let data = try secureRead(oldPendingKey) {
            let migrated: PendingWorldHandoff?
            do {
                let stored = try JSONDecoder().decode(PendingWorldHandoff.self, from: data)
                migrated = try stored.rebased(from: previous, session: hash(sessionToken), to: serverURL)
            } catch {
                // Invalid legacy records cannot redirect navigation or cross account boundaries.
                migrated = nil
                try secureSave(nil, key: oldPendingKey)
                notice = "Scan your card to restart verification."
            }
            if let migrated {
                try secureSave(JSONEncoder().encode(migrated), key: pendingVerificationKey)
                try secureSave(nil, key: oldPendingKey)
            }
        }
        let oldPermissionKey = "pending-permission." + oldScope
        if try secureRead(permissionKey) == nil, let permission = try secureRead(oldPermissionKey) {
            try secureSave(permission, key: permissionKey)
            try secureSave(nil, key: oldPermissionKey)
        }
        if oldSession == Data(sessionToken.utf8) { try secureSave(nil, key: oldSessionKey) }
        try secureSave(Data("complete".utf8), key: migrationKey)
    }
    private func clearVerification(cancelTask: Bool = true) throws {
        try secureSave(nil, key: pendingVerificationKey)
        resetNativeVerification(cancelTask: cancelTask)
        verificationID = nil; loginExchangeSecret = nil; pendingCardLink = nil; accountAccessPurpose = nil
    }
    private func clearAccountState() {
        resetNativeVerification()
        account = nil; dashboard = nil; invoice = nil; funding = nil; fundingError = nil; fundingStatus = nil; terminalEnrolled = false
        walletCreation = nil; walletRefreshError = nil; fundingHistoryComplete = nil; fundingHistoryStatus = nil
        cardMoney = [:]; cardRevisions = [:]; rewardReads = [:]; testFundingReads = [:]; testFundingPostID = nil
        loyaltyReads = [:]; loyaltyProgram = nil; loyaltyProgramError = nil; loyaltyProgramRequestPending = false; loyaltyProgramRevision &+= 1
        collectibleCampaign = nil; collectibleCampaignError = nil; collectibleCampaignRequestPending = false; collectibleCampaignRevision &+= 1
        rewardCampaign = nil; campaignError = nil; campaignRequestPending = false; campaignRevision &+= 1
        allowanceJobID = nil; allowanceStatus = nil; merchants = []; merchantsLoaded = false
        merchantSetup = nil; merchantInvite = nil; invoiceRequestPending = false; refundRequestPending = false; refundError = nil; refundReadRevision &+= 1
        verificationID = nil; verificationURL = nil; loginExchangeSecret = nil; pendingCardLink = nil; accountAccessPurpose = nil; notice = nil; deviceLink = nil; deviceLinkMessage = nil
    }
    let reader = CardReader()
    private var activeSessionKey: String { "app-session." + hash(serverURL) }
    init(deployment: BuildConfiguration? = nil, credentialNamespace: String = "", urlSession: URLSession = .shared) {
        self.credentialNamespace = credentialNamespace
        self.urlSession = urlSession
        do {
            let deployment = try deployment ?? BuildConfiguration.load()
            serverURL = deployment.apiURL.absoluteString
            dashboardURL = deployment.webURL.absoluteString
            previousServerURL = deployment.previousAPIURL?.absoluteString
            sessionToken = try secureRead(activeSessionKey).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            // Preserve a session from an older build only when its original service is identical.
            if sessionToken.isEmpty, UserDefaults.standard.string(forKey: "serverURL") == serverURL,
               let legacy = try secureRead("app-session") {
                sessionToken = String(data: legacy, encoding: .utf8) ?? ""
                try secureSave(legacy, key: activeSessionKey)
                try secureSave(nil, key: "app-session")
            }
            if let previousServerURL { try migrateTrustedDeployment(from: previousServerURL) }
            try restoreVerification()
            if let data = try secureRead(deviceLinkKey) {
                let stored = try JSONDecoder().decode(DeviceLink.self, from: data)
                if (AppDates.date(stored.expiresAt) ?? .distantPast) > Date() { deviceLink = stored }
                else { try secureSave(nil, key: deviceLinkKey) }
            }
        } catch { serviceUnavailable = "IC Pay is unavailable. Try again shortly." }
    }
    var isSignedIn: Bool { !sessionToken.isEmpty && account?.canAccessApp == true }
    func bootstrap() async {
        guard !busy else { return }
        isStarting = true; serviceUnavailable = nil
        defer { isStarting = false }
        do {
            guard !serverURL.isEmpty else { throw AppError.message("Service unavailable") }
            config = try await api.call("v1/config")
            if verificationID != nil { await checkVerification() }
            try await refresh()
        } catch let failure as APIRequestError where failure.status == 401 {
            clearLocalSession()
            notice = "Sign-in expired. Scan your linked card to continue."
        } catch is CancellationError {
        } catch { serviceUnavailable = "Can’t connect. Check your connection and retry." }
    }
    private func acceptSession(_ token: String, completingWorld: Bool = false) async throws {
        let oldPendingKey = pendingVerificationKey
        try secureSave(Data(token.utf8), key: activeSessionKey)
        try secureSave(nil, key: oldPendingKey)
        sessionGeneration &+= 1; refreshRevision &+= 1
        if completingWorld { resetNativeVerification(cancelTask: false) }
        clearAccountState()
        sessionToken = token
        try secureSave(nil, key: deviceLinkKey)
        let acceptedGeneration = sessionGeneration
        do { try await refresh() }
        catch is CancellationError { throw CancellationError() }
        catch {
            // Token exchange already succeeded. Retrying a consumed invitation is wrong;
            // keep its saved session and let bootstrap retry only the account reads.
            if sessionGeneration == acceptedGeneration {
                serviceUnavailable = "Signed in. Couldn’t refresh account. Try again."
            }
        }
    }
    var api: SessionAPIClient {
        get throws {
            let generation = sessionGeneration
            return try SessionAPIClient(client: APIClient(baseURL: APIClient.validatedURL(serverURL), token: sessionToken, session: urlSession), isCurrent: { [weak self] in self?.sessionGeneration == generation })
        }
    }
    var preparingCardWalletIDs: [String] {
        guard isSignedIn, account?.role == "customer" else { return [] }
        return (dashboard?.cards ?? []).filter { $0.walletStatus == "provisioning" }.map(\.id).sorted()
    }
    func refreshPreparingCardWallets() async {
        guard !preparingCardWalletIDs.isEmpty, !busy, !isRefreshing else { return }
        let generation = sessionGeneration
        do { try await refresh() }
        catch is CancellationError {}
        catch {
            if sessionGeneration == generation { serviceUnavailable = "Couldn’t check wallet setup. Reconnecting…" }
        }
    }
    var paymentsAvailable: Bool { config?.capabilities.payments == true }
    var loyaltyAvailable: Bool { config?.capabilities.loyalty == true }
    var collectiblesAvailable: Bool { config?.capabilities.collectibles == true }
    var rewardsAvailable: Bool { config?.capabilities.rewards == true || collectiblesAvailable || loyaltyAvailable }
    var supportsMultipleCards: Bool { config?.capabilities.multipleCards == true && dashboard?.cards != nil }
    var isMerchant: Bool { ["merchant", "admin"].contains(dashboard?.account.role ?? "") && dashboard?.merchant != nil }
    func run(_ work: () async throws -> Void) async {
        guard !busy else { return }
        busy = true; error = nil; notice = nil
        let operation = operationRevision
        defer { busy = false }
        do { try await work() } catch is CancellationError {} catch let failure as APIRequestError where failure.status == 401 && verificationID == nil {
            if operation == operationRevision { clearLocalSession(); notice = "Sign-in expired. Sign in again." }
        } catch let failure as APIRequestError where failure.status == 410 && verificationID != nil {
            if operation == operationRevision { try? clearVerification(); self.error = "Verification expired. Scan your card again." }
        } catch {
            if operation == operationRevision { self.error = error.localizedDescription }
        }
    }
    func refresh() async throws {
        refreshRequests += 1
        defer { refreshRequests -= 1 }
        let client = try api
        let revision = refreshRevision
        let newConfig: AppConfig = try await client.call("v1/config")
        var newAccount: Account?
        var newDashboard: Dashboard?
        var newSetup: MerchantSetup?
        if !sessionToken.isEmpty {
            newAccount = try await client.call("v1/me")
            newDashboard = try await client.call("v1/dashboard")
            if newAccount?.role == "merchant" { newSetup = try await client.call("v1/merchant/setup") }
        }
        // A response begun before a successful mutation cannot put the old state back.
        guard revision == refreshRevision else { throw CancellationError() }
        let remainingIDs = Set(newDashboard?.cards?.map(\.id) ?? [])
        for id in Set(dashboard?.cards?.map(\.id) ?? []).subtracting(remainingIDs) { invalidateCardMoney(id) }
        config = newConfig; account = newAccount; dashboard = newDashboard; merchantSetup = newSetup
        try reconcileSavedPermission()
        if isMerchant { try await restoreMerchantState(client: client) }
        else { terminalEnrolled = false; merchantInvite = nil }
        serviceUnavailable = nil; walletRefreshError = nil
    }
    func refreshOnForeground() async {
        guard isSignedIn, !busy else { return }
        do { try await refresh() }
        catch is CancellationError {}
        catch let failure as APIRequestError where failure.status == 401 {
            clearLocalSession(); notice = "Sign-in expired. Sign in again."
        } catch { serviceUnavailable = "Couldn’t refresh. Check your connection and retry." }
    }
    private func refreshAfterSave(_ message: String) async {
        do { try await refresh(); notice = message }
        catch is CancellationError {}
        catch { notice = message + " Balances couldn’t refresh." }
    }
    private func clearLocalSession() {
        do {
            operationRevision &+= 1; sessionGeneration &+= 1; refreshRevision &+= 1
            try clearVerification()
            for id in Set(dashboard?.cards?.map(\.id) ?? []).union(cardMoney.keys) { invalidateCardMoney(id) }
            try secureSave(nil, key: permissionKey)
            try secureSave(nil, key: spendingFormKey)
            try secureSave(nil, key: activeSessionKey)
            try secureSave(nil, key: merchantSignupKey)
            try secureSave(nil, key: merchantInviteKey)
            try secureSave(nil, key: merchantActivationKey)
            for role in ["customer", "merchant", "admin"] {
                let key = "saved-session.\(serverURL).\(role)"
                if try secureRead(key) == Data(sessionToken.utf8) { try secureSave(nil, key: key) }
            }
            sessionToken = ""; clearAccountState()
        } catch { self.error = "Couldn’t sign out. Try again." }
    }
    func signOut() async {
        guard !busy else { return }
        resetNativeVerification()
        busy = true
        // Local removal always happens; a network outage must not keep this iPhone signed in.
        if !sessionToken.isEmpty { let _: EmptyResponse? = try? await api.json("v1/logout", body: [:]) }
        clearLocalSession()
        busy = false
    }
    private func resetNativeVerification(cancelTask: Bool = true, keepCapability: Bool = false) {
        worldAttempt &+= 1; worldTaskSerial &+= 1
        if cancelTask { worldTask?.cancel() }
        worldTask = nil; worldSession = nil; worldProofJSON = nil
        worldSubmissionAttempted = false; worldContextExpiry = nil
        worldIsStarting = false; worldIsSubmitting = false; worldAppUnavailable = false
        worldNeedsRestart = false; worldStatus = ""; verificationURL = nil
        if !keepCapability { worldCapability = nil }
    }
    private func worldOperation() -> NativeWorldOperation? {
        verificationID.map { NativeWorldOperation(id: $0, accountGeneration: sessionGeneration, attempt: worldAttempt) }
    }
    private func isCurrent(_ operation: NativeWorldOperation) -> Bool {
        operation.matches(id: verificationID, accountGeneration: sessionGeneration, attempt: worldAttempt)
    }
    private func worldClient(operation: NativeWorldOperation, capability: String? = nil) throws -> SessionAPIClient {
        try SessionAPIClient(client: APIClient(baseURL: APIClient.validatedURL(serverURL), token: capability ?? sessionToken, session: urlSession),
            isCurrent: { [weak self] in self?.isCurrent(operation) == true })
    }
    private func startNativeWorldRequest() {
        guard let operation = worldOperation(), let capability = worldCapability, worldTask == nil else { return }
        worldIsStarting = true; worldNeedsRestart = false
        worldStatus = "Preparing World verification…"
        worldTaskSerial &+= 1
        let serial = worldTaskSerial
        worldTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.worldTaskSerial == serial { self.worldTask = nil; self.worldIsStarting = false } }
            do {
                let context: NativeWorldContext = try await self.worldClient(operation: operation, capability: capability).call("v1/world/requests/\(operation.id)/context")
                guard context.id == operation.id,
                      (self.loginExchangeSecret == nil || context.purpose == (self.accountAccessPurpose ?? .login).rawValue) else { throw NativeWorldError.invalidContext }
                if let intent = self.pendingCardLink {
                    guard context.purpose == intent.purpose.rawValue,
                          intent.replacesCardId == nil || context.replacesCardId == intent.replacesCardId else { throw NativeWorldError.invalidContext }
                }
                let session = try await NativeWorldSession.start(context: context)
                guard self.isCurrent(operation), !Task.isCancelled else { return }
                self.worldSession = session
                self.worldContextExpiry = Date(timeIntervalSince1970: TimeInterval(context.rpContext.expiresAt))
                self.verificationURL = session.connectorURL
                self.worldStatus = "Open World to confirm it’s you."
                self.worldIsStarting = false
                self.worldTask = nil
                self.startNativeWorldPolling()
            } catch is CancellationError {
            } catch {
                guard self.isCurrent(operation), !Task.isCancelled else { return }
                self.worldNeedsRestart = true
                self.worldStatus = "Couldn’t start verification. Start again."
            }
        }
    }
    private func startNativeWorldPolling() {
        guard worldForeground, !worldNeedsRestart, worldTask == nil, !worldIsStarting,
              let session = worldSession, let operation = worldOperation(), let capability = worldCapability else { return }
        worldTaskSerial &+= 1
        let serial = worldTaskSerial
        worldTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.worldTaskSerial == serial { self.worldTask = nil; self.worldIsSubmitting = false } }
            do {
                while self.worldForeground, self.isCurrent(operation), !Task.isCancelled {
                    if let expiry = self.worldContextExpiry, expiry <= Date() {
                        self.worldNeedsRestart = true
                        self.worldStatus = "Verification expired. Start again."
                        return
                    }
                    if let json = self.worldProofJSON {
                        // If the previous response was lost, first reconcile server completion.
                        if self.worldSubmissionAttempted, try await self.completeWorldFromBackend() { return }
                        guard self.isCurrent(operation), !Task.isCancelled else { return }
                        self.worldIsSubmitting = true
                        self.worldStatus = "Confirming verification…"
                        self.worldSubmissionAttempted = true
                        var body = Data("{\"result\":".utf8)
                        body.append(Data(json.utf8)); body.append(Data("}".utf8))
                        struct Verified: Decodable { let verified: Bool }
                        let result: Verified = try await self.worldClient(operation: operation, capability: capability).call("v1/world/requests/\(operation.id)/verify", method: "POST", body: body)
                        guard result.verified else { throw AppError.message("Couldn’t confirm World verification.") }
                        _ = try await self.completeWorldFromBackend()
                        return
                    }
                    let event = try await session.pollOnce()
                    guard self.isCurrent(operation), !Task.isCancelled else { return }
                    switch event {
                    case .waiting: self.worldStatus = "Waiting for World…"
                    case .awaitingConfirmation: self.worldStatus = "Verify in World, then return here."
                    case .networkError: self.worldStatus = "Reconnecting to World…"
                    case .failed(let code):
                        self.worldNeedsRestart = true
                        self.worldStatus = ["userRejected", "verificationRejected"].contains(code)
                            ? "Verification cancelled. Start again when ready."
                            : "World verification failed. Start again."
                        return
                    case .proofJSON(let json): self.worldProofJSON = json; continue
                    }
                    try await Task.sleep(for: .seconds(2))
                }
            } catch is CancellationError {
            } catch let failure as APIRequestError where failure.status == 410 {
                guard self.isCurrent(operation) else { return }
                try? self.clearVerification(cancelTask: false)
                self.notice = "Verification expired. Scan your card again."
            } catch {
                guard self.isCurrent(operation), !Task.isCancelled else { return }
                self.worldStatus = error is NativeWorldError
                    ? error.localizedDescription
                    : "Couldn’t confirm verification. Check again or restart."
                if error is NativeWorldError { self.worldNeedsRestart = true }
            }
        }
    }
    /// Only authenticated backend confirmation can finish an operation; a deep link or SDK result alone cannot.
    private func completeWorldFromBackend() async throws -> Bool {
        guard let operation = worldOperation() else { return false }
        let client = try worldClient(operation: operation)
        if let secret = loginExchangeSecret {
            let recovering = accountAccessPurpose == .recovery
            struct Login: Decodable { let status: String; let token: String? }
            let response: Login = try await client.json("v1/auth/card/\(operation.id)/exchange", body: ["exchangeSecret": secret])
            guard response.status == "verified", let token = response.token else { return false }
            try await acceptSession(token, completingWorld: true)
            notice = recovering ? "Account recovered. Your cards are unchanged." : "Welcome back."
            actionSuccessSequence += 1
            return true
        }
        struct Status: Decodable { let id: String; let status: String }
        let response: Status = try await client.call("v1/world/requests/\(operation.id)")
        guard response.id == operation.id else { throw NativeWorldError.invalidContext }
        if response.status == "verified" {
            try clearVerification(cancelTask: false)
            let completedGeneration = sessionGeneration
            actionSuccessSequence += 1
            do { try await refresh(); notice = "Verified. Card linked." }
            catch {
                if sessionGeneration == completedGeneration {
                    serviceUnavailable = "Verified. Couldn’t refresh account. Try again."
                }
            }
            return true
        }
        if response.status == "expired" {
            try clearVerification(cancelTask: false)
            notice = "Verification expired. Scan your card again."
            return true
        }
        return false
    }
    func setWorldForeground(_ active: Bool) {
        worldForeground = active
        // An in-flight FFI poll may finish in the background; its single task stops before its next poll.
        if active, verificationID != nil { Task { await checkVerification() } }
    }
    func openWorldApp() {
        guard let url = verificationURL, let operation = worldOperation(), !worldNeedsRestart else { return }
        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { [weak self] opened in
            Task { @MainActor in
                guard let self, self.isCurrent(operation) else { return }
                self.worldAppUnavailable = !opened
                if !opened { self.worldStatus = "Can’t open World. Install or update it, then retry." }
            }
        }
    }
    private func saveVerification(id: String, handoffToken: String, exchangeSecret: String? = nil, cardLink: CardLinkIntent? = nil, accountAccess: AccountAccessPurpose? = nil) throws {
        resetNativeVerification()
        let pending = PendingWorldHandoff(id: id, handoffToken: handoffToken, url: nil, server: serverURL, sessionHash: hash(sessionToken), exchangeSecret: exchangeSecret, nativeStarted: true, cardLink: cardLink, accountAccess: accountAccess)
        _ = try pending.capability()
        try secureSave(JSONEncoder().encode(pending), key: pendingVerificationKey)
        verificationID = id; worldCapability = handoffToken; loginExchangeSecret = exchangeSecret
        pendingCardLink = cardLink
        accountAccessPurpose = pending.resolvedAccountAccess
        startNativeWorldRequest()
    }
    func beginSignIn(recovery: Bool = false) async {
        await run {
            if verificationID != nil { return }
            let generation = sessionGeneration
            let card = try await reader.scan(message: recovery ? "Hold an IC card previously linked to your account near the top of this iPhone." : "Hold your linked IC card near the top of this iPhone.")
            guard generation == sessionGeneration else { throw CancellationError() }
            try await requestCardAccess(cardID: card, purpose: recovery ? .recovery : .login)
        }
    }
    // Takes the result of the physical NFC scan; account access still requires backend-verified World proof.
    func requestCardAccess(cardID: String, purpose: AccountAccessPurpose) async throws {
        struct Response: Decodable { let id: String; let handoffToken: String; let exchangeSecret: String }
        do {
            let response: Response = try await api.json(purpose == .recovery ? "v1/auth/card/recover" : "v1/auth/card/start", body: ["cardId": cardID])
            try saveVerification(id: response.id, handoffToken: response.handoffToken, exchangeSecret: response.exchangeSecret, accountAccess: purpose)
            if purpose == .recovery { notice = "Verify with World to sign in. Cards stay unchanged." }
        } catch let failure as APIRequestError where purpose == .login && failure.code == "card_recovery_required" {
            try await requestCardAccess(cardID: cardID, purpose: .recovery)
        }
    }
    func beginEnrollment(intent: CardLinkIntent = .enrollment) async {
        await run {
            if verificationID != nil {
                notice = "Continue verification or check its status."
                return
            }
            let generation = sessionGeneration
            guard config?.capabilities.world == true else { throw AppError.message("Verification unavailable. Try again shortly.") }
            if intent.purpose == .addition || intent.replacesCardId != nil {
                guard supportsMultipleCards else { throw AppError.message("Card management needs a service update. Try again later.") }
            }
            let card = try await reader.scan(message: intent.purpose == .replacement ? "Hold your replacement IC card near the top of this iPhone." : "Hold your physical transit IC card near the top of this iPhone to link it.")
            guard generation == sessionGeneration else { throw CancellationError() }
            try await enrollScannedCard(cardID: card, intent: intent)
        }
    }
    func enrollScannedCard(cardID: String, intent: CardLinkIntent) async throws {
        do {
            if intent.purpose == .enrollment && sessionToken.isEmpty {
                struct Enrollment: Decodable { let token: String; let accountId: String }
                let enrollment: Enrollment = try await api.json("v1/enrollments", body: ["cardId": cardID])
                try secureSave(Data(enrollment.token.utf8), key: activeSessionKey)
                sessionGeneration &+= 1
                clearAccountState()
                sessionToken = enrollment.token

            }
            struct Request: Decodable { let id: String; let handoffToken: String }
            var body: [String: Any] = ["purpose": intent.purpose.rawValue, "cardId": cardID]
            if let id = intent.replacesCardId { body["replacesCardId"] = id }
            let request: Request = try await api.json("v1/world/requests", body: body)
            try saveVerification(id: request.id, handoffToken: request.handoffToken, cardLink: intent)
            notice = "Verify in World to confirm this card link."
        } catch let failure as APIRequestError where intent.purpose == .enrollment && !isSignedIn && ["card_sign_in_required", "card_recovery_required", "card_linked", "card_already_linked"].contains(failure.code) {
            // Also handles a provisional session left by a failed signup on older builds.
            try await requestCardAccess(cardID: cardID, purpose: failure.code == "card_sign_in_required" ? .login : .recovery)
        }
    }
    func cancelVerification() async {
        guard let id = verificationID else { return }
        resetNativeVerification(keepCapability: true)
        worldNeedsRestart = true
        var completed = false
        await run {
            let body: [String: Any] = loginExchangeSecret.map { ["exchangeSecret": $0] } ?? [:]
            let result: VerificationCancellation = try await api.json("v1/world/requests/\(id)/cancel", body: body)
            if result.status == .cancelled {
                try clearVerification(); notice = "Verification cancelled. Card link unchanged."
            } else { completed = true }
        }
        if completed { await checkVerification() }
    }
    func restartVerification() async {
        guard let id = verificationID else { return }
        let returningLogin = loginExchangeSecret != nil
        let recovering = accountAccessPurpose == .recovery
        // Legacy pending records retain the old single-card replacement semantics.
        let intent = pendingCardLink ?? (account?.verified == true ? .replacement() : .enrollment)
        var result: VerificationCancellation.Status?
        resetNativeVerification(keepCapability: true)
        worldNeedsRestart = true
        await run {
            let body: [String: Any] = loginExchangeSecret.map { ["exchangeSecret": $0] } ?? [:]
            let response: VerificationCancellation = try await api.json("v1/world/requests/\(id)/cancel", body: body)
            if response.status == .cancelled { try clearVerification() }
            result = response.status
        }
        switch result {
        case .cancelled:
            if returningLogin { await beginSignIn(recovery: recovering) }
            else { await beginEnrollment(intent: intent) }
        case .verified:
            // A proof that won the server race must be consumed/refreshed, never discarded.
            await checkVerification()
        case nil: break
        }
    }
    func checkVerification() async {
        guard verificationID != nil, worldTask == nil, !worldIsStarting else { return }
        if worldSession != nil, !worldNeedsRestart {
            startNativeWorldPolling()
            return
        }
        await run {
            if try await completeWorldFromBackend() { return }
            worldNeedsRestart = true
            worldStatus = "Verification interrupted. Start a new check."
        }
    }
    func updateCard(id: String, nickname: String? = nil, frozen: Bool? = nil) async {
        await run {
            guard supportsMultipleCards, UUID(uuidString: id) != nil else { throw AppError.message("Refresh your cards and try again.") }
            var body: [String: Any] = [:]
            if let nickname { body["nickname"] = nickname.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let frozen { body["frozen"] = frozen }
            let updated: LinkedCard = try await api.json("v1/cards/\(id)", method: "PATCH", body: body)
            refreshRevision &+= 1
            if var cards = dashboard?.cards, let index = cards.firstIndex(where: { $0.id == updated.id }) {
                var merged = updated
                // PATCH returns identity/status only; keep the card's enriched dashboard data.
                merged.wallet = cards[index].wallet
                merged.policy = cards[index].policy
                merged.walletStatus = cards[index].walletStatus
                merged.allowanceSufficient = cards[index].allowanceSufficient
                cards[index] = merged
                updateLocalCards(cards)
            }
            notice = frozen.map { $0 ? "Card frozen. Submitted payments may still complete." : "Card unfrozen." } ?? "Card name saved."
            actionSuccessSequence += 1
        }
    }
    func removeCard(id: String) async {
        await run {
            guard supportsMultipleCards, UUID(uuidString: id) != nil else { throw AppError.message("Refresh your cards and try again.") }
            let _: EmptyResponse = try await api.call("v1/cards/\(id)", method: "DELETE")
            refreshRevision &+= 1
            if let cards = dashboard?.cards { updateLocalCards(cards.filter { $0.id != id }) }
            notice = "Card removed. Submitted payments may still complete."
            actionSuccessSequence += 1
        }
    }
    private func updateLocalCards(_ cards: [LinkedCard]) {
        let remainingIDs = Set(cards.map(\.id))
        for id in Set(dashboard?.cards?.map(\.id) ?? []).subtracting(remainingIDs) { invalidateCardMoney(id) }
        dashboard?.cards = cards
        dashboard?.card = Card(linked: cards.contains { !$0.isFrozen }, last4: cards.first { !$0.isFrozen }?.last4)
    }
    private var deviceLinkKey: String { "device-link." + hash(serverURL) }
    func createDeviceLink() async {
        await run {
            let link: DeviceLink = try await api.json("v1/device-links", body: [:])
            try secureSave(JSONEncoder().encode(link), key: deviceLinkKey)
            deviceLink = link
            deviceLinkMessage = nil
        }
    }
    func pollDeviceLink() async {
        guard let link = deviceLink else { return }
        await run {
            struct Poll: Decodable { let status: String; let token: String? }
            do {
                let result: Poll = try await api.json("v1/device-links/\(link.id)/poll", body: ["deviceSecret": link.deviceSecret])
                if result.status == "approved", let token = result.token {
                    try await acceptSession(token)
                    notice = "Signed in on this iPhone."
                    actionSuccessSequence += 1
                } else { deviceLinkMessage = "Approve on your signed-in device." }
            } catch let failure as APIRequestError where failure.status == 410 {
                try secureSave(nil, key: deviceLinkKey)
                deviceLink = nil; deviceLinkMessage = "Code expired. Get a new code."
            }
        }
    }
    func approveDevice(code: String) async {
        await run {
            let _: EmptyResponse = try await api.json("v1/device-links/approve", body: ["userCode": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()])
            approvalCode = nil
            notice = "Device approved for sign-in."
            actionSuccessSequence += 1
        }
    }
    func activateInvitation(code: String) async {
        await run {
            struct Response: Decodable { let token: String }
            let result: Response = try await api.json("v1/invitations/exchange", body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines)])
            try await acceptSession(result.token)
        }
    }
    private var merchantSignupKey: String { "merchant-signup." + hash(serverURL) }
    func pendingMerchantSignup() throws -> MerchantSignupDraft? {
        try secureRead(merchantSignupKey).map { try JSONDecoder().decode(MerchantSignupDraft.self, from: $0) }
    }
    func registerMerchant(name: String) async {
        await run {
            let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.count <= 80 else { throw AppError.message("Enter a merchant name (up to 80 characters).") }
            let draft: MerchantSignupDraft
            if let existing = try pendingMerchantSignup() {
                guard existing.name == name else { throw AppError.message("Continue your existing merchant signup.") }
                draft = existing
            } else {
                let secret = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
                draft = MerchantSignupDraft(name: name, signupSecret: secret)
                // Persist before sending so network retries cannot create another account or wallet.
                try secureSave(JSONEncoder().encode(draft), key: merchantSignupKey)
            }
            struct Response: Decodable { let token: String }
            let result: Response = try await api.json("v1/merchants/register", body: ["name": draft.name, "signupSecret": draft.signupSecret])
            try await acceptSession(result.token)
            try secureSave(nil, key: merchantSignupKey)
        }
    }
    func refreshMerchantSetup() async {
        await run { try await refresh() }
    }
    func getMerchantInvite() async {
        await run {
            let invite: MerchantInvite = try await api.json("v1/merchant/invitations", body: [:])
            try secureSave(JSONEncoder().encode(invite), key: merchantInviteKey)
            merchantInvite = invite
        }
    }
    func activateMerchantHere(code: String) async {
        await run {
            guard isMerchant else { throw AppError.message("Sign in to your merchant account.") }
            let signer = try TerminalSigner()
            try saveMerchantActivationCode(code)
            let terminal: Terminal = try await api.json("v1/merchant/activate", body: ["code": code, "publicKey": signer.publicKey])
            guard terminal.merchantId == dashboard?.merchant?.id else { throw AppError.message("Activation is for another merchant.") }
            try secureSave(Data(terminal.id.utf8), key: terminalStorageKey)
            refreshRevision &+= 1
            terminalEnrolled = true
            merchantInvite = nil
            try secureSave(nil, key: merchantInviteKey)
            try secureSave(nil, key: merchantActivationKey)
            notice = "Merchant activated. Open Collect to take payments."
            actionSuccessSequence += 1
        }
    }
    func receiveDeviceLink(_ url: URL) {
        guard url.scheme == "suicapay", url.host == "connect",
              let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$", options: .regularExpression) != nil else { return }
        approvalCode = code.uppercased()
        if !isSignedIn { notice = "Sign in to approve the other device." }
    }
    func createWallet(cardID: String? = nil) async {
        await provisionWallet(cardID: cardID, claim: false)
    }
    func claimExistingWallet(cardID: String) async {
        await provisionWallet(cardID: cardID, claim: true)
    }
    private func provisionWallet(cardID: String?, claim: Bool) async {
        await run {
            try requireCard(cardID)
            let generation = sessionGeneration
            let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
            let result: WalletCreationResult = try await api.json(claim ? "v1/wallet/claim" : "v1/wallet", body: scopedBody([:], cardID: cardID))
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
            refreshRevision &+= 1
            if let cardID { cardMoney[cardID, default: CardMoneyState()].creation = result }
            else { walletCreation = result }
            if claim, result.status == "ready" { dashboard?.unassignedWalletAvailable = false }
            if result.status == "ready" { actionSuccessSequence += 1 }
            switch result.status {
            case "ready": notice = claim ? "Existing funds assigned to this card." : paymentsAvailable ? "Wallet ready." : "Wallet created. Payments aren’t ready yet."
            case "provisioning": notice = "Preparing wallet. Check again shortly."
            default: notice = "Wallet setup needs attention. Contact IC Pay."
            }
            do { try await refresh() }
            catch is CancellationError { throw CancellationError() }
            catch {
                guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { return }
                walletRefreshError = result.status == "ready"
                    ? (cardID == nil ? "Wallet created. Details couldn’t refresh; address saved below." : "Wallet created. Refresh this card to view its details.")
                    : "Couldn’t refresh wallet setup. Check again."
            }
        }
    }
    func loadTestFunding(cardID: String? = nil) async {
        guard account?.role == "customer", account?.verified == true, !sessionToken.isEmpty else { return }
        let key = cardID ?? "account", generation = sessionGeneration
        let cardRevision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
        testFundingRevision &+= 1
        let revision = testFundingRevision
        testFundingReads[key, default: TestFundingRead()].revision = revision
        testFundingReads[key, default: TestFundingRead()].loading = true
        testFundingReads[key, default: TestFundingRead()].error = nil
        defer {
            if generation == sessionGeneration, testFundingReads[key]?.revision == revision { testFundingReads[key]?.loading = false }
        }
        do {
            try requireCard(cardID)
            let response: TestFundingResponse = try await api.call("v1/test-funding", query: cardID.map { [URLQueryItem(name: "cardId", value: $0)] } ?? [])
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), testFundingReads[key]?.revision == revision, !Task.isCancelled else { return }
            testFundingReads[key]?.response = response
            // Reopening/checking must retry a refresh interrupted by backgrounding or a network failure.
            // Merely caching a confirmed claim is not evidence that its balance/history refresh completed.
            if response.claim?.status == "confirmed" {
                try? await refresh()
                guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision) else { return }
                await loadFunding(cardID: cardID)
                if cardID != nil { await loadFunding() }
            }
        } catch {
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), testFundingReads[key]?.revision == revision, !Task.isCancelled else { return }
            testFundingReads[key]?.error = "Couldn’t check your test-token request. Check status before trying again."
        }
    }
    func claimTestFunding(cardID: String? = nil) async {
        guard testFundingPostID == nil, config?.capabilities.testFunding == true,
              account?.role == "customer", account?.verified == true,
              testFunding(for: cardID)?.permitsNewClaim == true, testFundingError(for: cardID) == nil,
              !isLoadingTestFunding(for: cardID), wallet(for: cardID) != nil || walletCreation(for: cardID)?.readyAddress != nil else { return }
        let operation = UUID(), generation = sessionGeneration
        let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
        testFundingPostID = operation
        // Any GET issued before this mutation must not restore an obsolete claimable state.
        testFundingReads = [:]
        defer { if testFundingPostID == operation { testFundingPostID = nil } }
        var submissionError: String?
        do {
            try requireCard(cardID)
            let _: TestFundingResponse = try await api.json("v1/test-funding", body: scopedBody([:], cardID: cardID))
        } catch let error as APIRequestError {
            submissionError = error.message
        } catch {
            submissionError = "The request could not be confirmed. Check status before trying again."
            // A timeout can still have created the durable claim. Recover exclusively through GET.
        }
        guard moneyOperationCurrent(cardID, generation: generation, revision: revision), testFundingPostID == operation else { return }
        await loadTestFunding(cardID: cardID)
        guard moneyOperationCurrent(cardID, generation: generation, revision: revision), testFundingPostID == operation else { return }
        if let submissionError, testFunding(for: cardID)?.claim == nil {
            testFundingReads[cardID ?? "account", default: TestFundingRead()].error = submissionError
        }
    }
    func loadFunding(cardID: String? = nil) async {
        if let cardID { await loadCardFunding(cardID); return }
        guard !sessionToken.isEmpty else { funding = nil; fundingStatus = nil; fundingHistoryComplete = nil; fundingHistoryStatus = nil; return }
        guard paymentsAvailable else { funding = nil; fundingStatus = "pending_setup"; fundingError = nil; fundingHistoryComplete = false; fundingHistoryStatus = "unavailable"; return }
        fundingRequests += 1
        defer { fundingRequests -= 1 }
        let expectedSession = sessionToken
        let generation = sessionGeneration
        do {
            let result: FundingHistory = try await api.call("v1/funding")
            guard expectedSession == sessionToken, generation == sessionGeneration else { return }
            funding = result.availableTransfers
            fundingStatus = Self.fundingStatus(result)
            fundingHistoryComplete = result.historyComplete; fundingHistoryStatus = result.historyStatus
            fundingError = fundingStatus == "unavailable" ? "Funding history unavailable. Try again." : nil
        } catch {
            guard expectedSession == sessionToken, generation == sessionGeneration, !Task.isCancelled else { return }
            funding = nil; fundingStatus = "unavailable"; fundingHistoryComplete = false; fundingHistoryStatus = "unavailable"
            fundingError = "Funding history unavailable. Try again."
        }
    }
    private static func fundingStatus(_ history: FundingHistory) -> String {
        switch history.availability {
        case .available: return "available"
        case .pendingSetup: return "pending_setup"
        case .unavailable: return "unavailable"
        }
    }
    private func loadCardFunding(_ cardID: String) async {
        guard !sessionToken.isEmpty, linkedCard(cardID) != nil else { return }
        guard paymentsAvailable else {
            cardMoney[cardID, default: CardMoneyState()].funding = nil
            cardMoney[cardID, default: CardMoneyState()].fundingStatus = "pending_setup"
            cardMoney[cardID, default: CardMoneyState()].fundingError = nil
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryComplete = false
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryStatus = "unavailable"
            return
        }
        let generation = sessionGeneration
        let revision = cardRevisions[cardID, default: 0]
        cardMoney[cardID, default: CardMoneyState()].fundingRequests += 1
        cardMoney[cardID, default: CardMoneyState()].fundingRevision &+= 1
        let requestRevision = cardMoney[cardID]!.fundingRevision
        defer {
            if moneyOperationCurrent(cardID, generation: generation, revision: revision) {
                cardMoney[cardID, default: CardMoneyState()].fundingRequests -= 1
            }
        }
        do {
            let result: FundingHistory = try await api.call("v1/cards/\(cardID)/funding")
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision), cardMoney[cardID]?.fundingRevision == requestRevision else { return }
            cardMoney[cardID, default: CardMoneyState()].funding = result.availableTransfers
            cardMoney[cardID, default: CardMoneyState()].fundingStatus = Self.fundingStatus(result)
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryComplete = result.historyComplete
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryStatus = result.historyStatus
            cardMoney[cardID, default: CardMoneyState()].fundingError = result.availability == .unavailable ? "Funding history unavailable. Try again." : nil
        } catch {
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision), cardMoney[cardID]?.fundingRevision == requestRevision, !Task.isCancelled else { return }
            cardMoney[cardID, default: CardMoneyState()].funding = nil
            cardMoney[cardID, default: CardMoneyState()].fundingStatus = "unavailable"
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryComplete = false
            cardMoney[cardID, default: CardMoneyState()].fundingHistoryStatus = "unavailable"
            cardMoney[cardID, default: CardMoneyState()].fundingError = "Funding history unavailable. Try again."
        }
    }
    func loyalty(for cardID: String?) -> LoyaltyResponse? { loyaltyReads[cardID ?? "account"]?.response }
    func loyaltyError(for cardID: String?) -> String? { loyaltyReads[cardID ?? "account"]?.error }
    func isLoadingLoyalty(for cardID: String?) -> Bool { loyaltyReads[cardID ?? "account"]?.loading == true }
    func loadLoyalty(cardID: String?) async {
        guard account?.role == "customer", account?.verified == true, loyaltyAvailable else { return }
        let scope = cardID ?? "account", generation = sessionGeneration
        let cardRevision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
        loyaltyReadRevision &+= 1
        let revision = loyaltyReadRevision
        loyaltyReads[scope, default: LoyaltyReadState()].revision = revision
        loyaltyReads[scope]?.loading = true
        defer { if sessionGeneration == generation, loyaltyReads[scope]?.revision == revision { loyaltyReads[scope]?.loading = false } }
        do {
            try requireCard(cardID)
            let result: LoyaltyResponse = try await api.call("v1/loyalty", query: cardID.map { [URLQueryItem(name: "cardId", value: $0)] } ?? [])
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), loyaltyReads[scope]?.revision == revision, !Task.isCancelled else { return }
            if let cardID, result.readable {
                guard let address = wallet(for: cardID)?.address,
                      result.balances!.allSatisfy({ $0.belongsTo(cardID: cardID, walletAddress: address) }),
                      result.history!.allSatisfy({ $0.cardId?.lowercased() == cardID.lowercased() && $0.walletAddress.lowercased() == address.lowercased() }) else { throw AppError.message("Points do not match this card wallet.") }
            }
            loyaltyReads[scope]?.response = result
            loyaltyReads[scope]?.error = result.status == "available" && !result.readable ? "Points data is incomplete. Try again." : nil
        } catch {
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), loyaltyReads[scope]?.revision == revision, !Task.isCancelled else { return }
            loyaltyReads[scope]?.response = nil
            loyaltyReads[scope]?.error = "Couldn’t load points. Try again."
        }
    }
    private func rewardScope(_ cardID: String?) -> String { cardID ?? "account" }
    func rewards(for cardID: String? = nil) -> [RewardVoucher]? {
        if let cardID, linkedCard(cardID) == nil { return nil }
        return rewardReads[rewardScope(cardID)]?.values
    }
    func rewardsStatus(for cardID: String? = nil) -> String? { rewardReads[rewardScope(cardID)]?.status }
    func rewardsError(for cardID: String? = nil) -> String? { rewardReads[rewardScope(cardID)]?.error }
    func isLoadingRewards(for cardID: String? = nil) -> Bool { (rewardReads[rewardScope(cardID)]?.requests ?? 0) > 0 }
    func loadRewards(cardID: String? = nil) async {
        guard isSignedIn, account?.role == "customer" else { return }
        if let cardID, linkedCard(cardID) == nil { return }
        let scope = rewardScope(cardID)
        guard rewardsAvailable else {
            rewardReads[scope, default: RewardsReadState()].status = "pending_setup"
            rewardReads[scope, default: RewardsReadState()].values = nil
            return
        }
        let generation = sessionGeneration
        let cardRevision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
        rewardReads[scope, default: RewardsReadState()].requests += 1
        rewardReads[scope, default: RewardsReadState()].revision &+= 1
        let requestRevision = rewardReads[scope]!.revision
        defer { if moneyOperationCurrent(cardID, generation: generation, revision: cardRevision) { rewardReads[scope, default: RewardsReadState()].requests -= 1 } }
        do {
            let query = cardID.map { [URLQueryItem(name: "cardId", value: $0)] } ?? []
            let values: [RewardVoucher]?, status: String
            if config?.capabilities.collectibles != nil {
                let response: CollectiblesResponse = try await api.call("v1/collectibles", query: query)
                values = response.availableItems
                status = response.status == "available" && response.items == nil ? "unavailable" : response.status
            } else {
                let response: RewardsResponse = try await api.call("v1/rewards", query: query)
                values = response.availableRewards
                status = response.status == "available" && response.rewards == nil ? "unavailable" : response.status
            }
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), rewardReads[scope]?.revision == requestRevision else { return }
            if let cardID, let values, !values.isEmpty {
                guard let address = wallet(for: cardID)?.address,
                      values.allSatisfy({ $0.walletAddress.lowercased() == address.lowercased() && ($0.cardId == nil || $0.cardId?.lowercased() == cardID.lowercased()) }) else {
                    throw AppError.message("Collectibles don’t match this card wallet. Refresh and try again.")
                }
            }
            rewardReads[scope, default: RewardsReadState()].values = values
            rewardReads[scope, default: RewardsReadState()].status = status
            rewardReads[scope, default: RewardsReadState()].error = status == "unavailable" ? "Collectibles are temporarily unavailable." : nil
        } catch {
            guard moneyOperationCurrent(cardID, generation: generation, revision: cardRevision), rewardReads[scope]?.revision == requestRevision, !Task.isCancelled else { return }
            rewardReads[scope, default: RewardsReadState()].values = nil
            rewardReads[scope, default: RewardsReadState()].status = "unavailable"
            rewardReads[scope, default: RewardsReadState()].error = "Couldn’t load rewards. Try again."
        }
    }
    private var campaignDraftKey: String { "reward-campaign-draft." + accountStateScope }
    private var campaignOperationKey: String { "reward-campaign-operation." + accountStateScope }
    private var campaignPayloadKey: String { "reward-campaign-payload." + accountStateScope }
    func savedRewardCampaignDraft() throws -> RewardCampaignDraft {
        if let saved = try secureRead(campaignDraftKey) { return try JSONDecoder().decode(RewardCampaignDraft.self, from: saved) }
        if let campaign = rewardCampaign?.campaign { return RewardCampaignDraft(campaign: campaign, decimals: config?.token.decimals ?? 18) }
        return RewardCampaignDraft()
    }
    func saveRewardCampaignDraft(_ draft: RewardCampaignDraft) throws {
        guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
        if let stored = try secureRead(campaignDraftKey), try JSONDecoder().decode(RewardCampaignDraft.self, from: stored).requestID != nil { return }
        try secureSave(JSONEncoder().encode(draft), key: campaignDraftKey)
    }
    func loadRewardCampaign() async {
        guard isMerchant else { return }
        campaignReads += 1
        defer { campaignReads -= 1 }
        let generation = sessionGeneration
        campaignRevision &+= 1
        let revision = campaignRevision
        do {
            campaignRequestPending = try savedRewardCampaignDraft().requestID != nil
            let knownID = try secureRead(campaignOperationKey).flatMap { String(data: $0, encoding: .utf8) }
            let query = knownID.map { [URLQueryItem(name: "operationId", value: $0)] } ?? []
            let response: RewardCampaignResponse = try await api.call("v1/merchant/rewards/campaign", query: query)
            guard generation == sessionGeneration, revision == campaignRevision else { return }
            rewardCampaign = response
            campaignError = ["available", "pending_setup"].contains(response.status) ? nil : "Current campaign unavailable. Your draft is kept; retry before saving a new update."
            var draft = try savedRewardCampaignDraft()
            campaignRequestPending = draft.requestID != nil
            if CampaignRecovery.shouldRetire(hasPendingRequest: draft.requestID != nil, knownOperationID: knownID, operation: response.operation), let operation = response.operation {
                if operation.status == "confirmed" { actionSuccessSequence += campaignRequestPending ? 1 : 0 }
                draft.requestID = nil
                try secureSave(JSONEncoder().encode(draft), key: campaignDraftKey)
                try secureSave(nil, key: campaignOperationKey)
                try secureSave(nil, key: campaignPayloadKey)
                campaignRequestPending = false
            }
        } catch {
            guard generation == sessionGeneration, revision == campaignRevision, !Task.isCancelled else { return }
            campaignError = "Couldn’t load the rewards campaign. Try again."
        }
    }
    func saveRewardCampaign(_ input: RewardCampaignDraft) async {
        await run {
            guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
            var draft = try savedRewardCampaignDraft()
            let body: Data
            if let requestID = draft.requestID {
                body = try CampaignRecovery.replayPayload(secureRead(campaignPayloadKey), requestID: requestID)
            } else {
                guard rewardsAvailable, rewardCampaign?.status == "available", campaignError == nil, let decimals = config?.token.decimals else {
                    throw AppError.message("Load the current campaign before saving a new update. Your draft is kept.")
                }
                draft = input; draft.requestID = UUID().uuidString
                body = try JSONSerialization.data(withJSONObject: draft.requestBody(decimals: decimals, requestID: draft.requestID!))
                try secureSave(body, key: campaignPayloadKey)
                try secureSave(JSONEncoder().encode(draft), key: campaignDraftKey)
            }
            campaignRequestPending = true
            struct Accepted: Decodable { let id: String; let status: String }
            let accepted: Accepted = try await api.call("v1/merchant/rewards/campaign", method: "PUT", body: body)
            try secureSave(Data(accepted.id.utf8), key: campaignOperationKey)
            notice = "Campaign update submitted. Waiting for onchain confirmation."
            await loadRewardCampaign()
        }
    }
    private var collectibleCampaignDraftKey: String { "collectible-campaign-draft." + accountStateScope }
    private var collectibleCampaignOperationKey: String { "collectible-campaign-operation." + accountStateScope }
    private var collectibleCampaignPayloadKey: String { "collectible-campaign-payload." + accountStateScope }
    func savedCollectibleCampaignDraft() throws -> CollectibleCampaignDraft {
        if let saved = try secureRead(collectibleCampaignDraftKey) { return try JSONDecoder().decode(CollectibleCampaignDraft.self, from: saved) }
        if let campaign = collectibleCampaign?.campaign { return CollectibleCampaignDraft(campaign: campaign, decimals: config?.token.decimals ?? 18) }
        return CollectibleCampaignDraft()
    }
    func saveCollectibleCampaignDraft(_ draft: CollectibleCampaignDraft) throws {
        guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
        if let stored = try secureRead(collectibleCampaignDraftKey), try JSONDecoder().decode(CollectibleCampaignDraft.self, from: stored).requestID != nil { return }
        try secureSave(JSONEncoder().encode(draft), key: collectibleCampaignDraftKey)
    }
    func loadCollectibleCampaign() async {
        guard isMerchant else { return }
        collectibleCampaignReads += 1
        defer { collectibleCampaignReads -= 1 }
        let generation = sessionGeneration
        collectibleCampaignRevision &+= 1
        let revision = collectibleCampaignRevision
        do {
            collectibleCampaignRequestPending = try savedCollectibleCampaignDraft().requestID != nil
            let knownID = try secureRead(collectibleCampaignOperationKey).flatMap { String(data: $0, encoding: .utf8) }
            let query = knownID.map { [URLQueryItem(name: "operationId", value: $0)] } ?? []
            let response: CollectibleCampaignResponse = try await api.call("v1/merchant/collectibles/campaign", query: query)
            guard generation == sessionGeneration, revision == collectibleCampaignRevision else { return }
            collectibleCampaign = response
            collectibleCampaignError = ["available", "pending_setup"].contains(response.status) ? nil : "Current campaign unavailable. Your draft is kept; retry before saving a new update."
            var draft = try savedCollectibleCampaignDraft()
            collectibleCampaignRequestPending = draft.requestID != nil
            if CampaignRecovery.shouldRetire(hasPendingRequest: draft.requestID != nil, knownOperationID: knownID, operation: response.operation), let operation = response.operation {
                if operation.status == "confirmed" { actionSuccessSequence += collectibleCampaignRequestPending ? 1 : 0 }
                draft.requestID = nil
                try secureSave(JSONEncoder().encode(draft), key: collectibleCampaignDraftKey)
                try secureSave(nil, key: collectibleCampaignOperationKey)
                try secureSave(nil, key: collectibleCampaignPayloadKey)
                collectibleCampaignRequestPending = false
            }
        } catch {
            guard generation == sessionGeneration, revision == collectibleCampaignRevision, !Task.isCancelled else { return }
            collectibleCampaignError = "Couldn’t load the rewards campaign. Try again."
        }
    }
    func saveCollectibleCampaign(_ input: CollectibleCampaignDraft) async {
        await run {
            guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
            var draft = try savedCollectibleCampaignDraft()
            let body: Data
            if let requestID = draft.requestID {
                body = try CampaignRecovery.replayPayload(secureRead(collectibleCampaignPayloadKey), requestID: requestID)
            } else {
                guard collectiblesAvailable, collectibleCampaign?.status == "available", collectibleCampaignError == nil, let decimals = config?.token.decimals else {
                    throw AppError.message("Load the current campaign before saving a new update. Your draft is kept.")
                }
                draft = input; draft.requestID = UUID().uuidString
                body = try JSONSerialization.data(withJSONObject: draft.requestBody(decimals: decimals, requestID: draft.requestID!))
                try secureSave(body, key: collectibleCampaignPayloadKey)
                try secureSave(JSONEncoder().encode(draft), key: collectibleCampaignDraftKey)
            }
            collectibleCampaignRequestPending = true
            struct Accepted: Decodable { let id: String; let status: String }
            let accepted: Accepted = try await api.call("v1/merchant/collectibles/campaign", method: "PUT", body: body)
            try secureSave(Data(accepted.id.utf8), key: collectibleCampaignOperationKey)
            notice = "Campaign update submitted. Waiting for onchain confirmation."
            await loadCollectibleCampaign()
        }
    }
    private var loyaltyProgramDraftKey: String { "loyalty-program-draft." + accountStateScope }
    private var loyaltyProgramOperationKey: String { "loyalty-program-operation." + accountStateScope }
    private var loyaltyProgramPayloadKey: String { "loyalty-program-payload." + accountStateScope }
    func savedLoyaltyProgramDraft() throws -> LoyaltyProgramDraft {
        if let saved = try secureRead(loyaltyProgramDraftKey) { return try JSONDecoder().decode(LoyaltyProgramDraft.self, from: saved) }
        if let campaign = loyaltyProgram?.program { return LoyaltyProgramDraft(program: campaign, decimals: config?.token.decimals ?? 18) }
        return LoyaltyProgramDraft()
    }
    func saveLoyaltyProgramDraft(_ draft: LoyaltyProgramDraft) throws {
        guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
        if let stored = try secureRead(loyaltyProgramDraftKey), try JSONDecoder().decode(LoyaltyProgramDraft.self, from: stored).requestID != nil { return }
        try secureSave(JSONEncoder().encode(draft), key: loyaltyProgramDraftKey)
    }
    func loadLoyaltyProgram() async {
        guard isMerchant else { return }
        loyaltyProgramReads += 1
        defer { loyaltyProgramReads -= 1 }
        let generation = sessionGeneration
        loyaltyProgramRevision &+= 1
        let revision = loyaltyProgramRevision
        do {
            loyaltyProgramRequestPending = try savedLoyaltyProgramDraft().requestID != nil
            let knownID = try secureRead(loyaltyProgramOperationKey).flatMap { String(data: $0, encoding: .utf8) }
            let query = knownID.map { [URLQueryItem(name: "operationId", value: $0)] } ?? []
            let response: LoyaltyProgramResponse = try await api.call("v1/merchant/loyalty/program", query: query)
            guard generation == sessionGeneration, revision == loyaltyProgramRevision else { return }
            loyaltyProgram = response
            loyaltyProgramError = ["available", "pending_setup"].contains(response.status) ? nil : "Current campaign unavailable. Your draft is kept; retry before saving a new update."
            var draft = try savedLoyaltyProgramDraft()
            loyaltyProgramRequestPending = draft.requestID != nil
            if CampaignRecovery.shouldRetire(hasPendingRequest: draft.requestID != nil, knownOperationID: knownID, operation: response.operation), let operation = response.operation {
                if operation.status == "confirmed" { actionSuccessSequence += loyaltyProgramRequestPending ? 1 : 0 }
                draft.requestID = nil
                try secureSave(JSONEncoder().encode(draft), key: loyaltyProgramDraftKey)
                try secureSave(nil, key: loyaltyProgramOperationKey)
                try secureSave(nil, key: loyaltyProgramPayloadKey)
                loyaltyProgramRequestPending = false
            }
        } catch {
            guard generation == sessionGeneration, revision == loyaltyProgramRevision, !Task.isCancelled else { return }
            loyaltyProgramError = "Couldn’t load the rewards campaign. Try again."
        }
    }
    func saveLoyaltyProgram(_ input: LoyaltyProgramDraft) async {
        await run {
            guard isMerchant else { throw AppError.message("Sign in with an enrolled merchant account.") }
            var draft = try savedLoyaltyProgramDraft()
            let body: Data
            if let requestID = draft.requestID {
                body = try CampaignRecovery.replayPayload(secureRead(loyaltyProgramPayloadKey), requestID: requestID)
            } else {
                guard loyaltyAvailable, loyaltyProgram?.status == "available", loyaltyProgramError == nil, let decimals = config?.token.decimals else {
                    throw AppError.message("Load the current campaign before saving a new update. Your draft is kept.")
                }
                draft = input; draft.requestID = UUID().uuidString
                body = try JSONSerialization.data(withJSONObject: draft.requestBody(decimals: decimals, requestID: draft.requestID!))
                try secureSave(body, key: loyaltyProgramPayloadKey)
                try secureSave(JSONEncoder().encode(draft), key: loyaltyProgramDraftKey)
            }
            loyaltyProgramRequestPending = true
            struct Accepted: Decodable { let id: String; let status: String }
            let accepted: Accepted = try await api.call("v1/merchant/loyalty/program", method: "PUT", body: body)
            try secureSave(Data(accepted.id.utf8), key: loyaltyProgramOperationKey)
            notice = "Campaign update submitted. Waiting for onchain confirmation."
            await loadLoyaltyProgram()
        }
    }
    func loadMerchants() async {
        await run {
            struct Result: Decodable { let merchants: [Merchant] }
            let result: Result = try await api.call("v1/merchants")
            merchants = result.merchants
            merchantsLoaded = true
        }
    }
    typealias PendingPermission = PendingSpendingPermission
    private var permissionKey: String { permissionKey(for: nil) }
    private var spendingFormKey: String { spendingFormKey(for: nil) }
    private func permissionKey(for cardID: String?) -> String { "pending-permission." + sessionViewID + (cardID.map { ".card." + $0 } ?? "") }
    private func spendingFormKey(for cardID: String?) -> String { "spending-form." + sessionViewID + (cardID.map { ".card." + $0 } ?? "") }
    func savedSpendingForm(cardID: String? = nil) throws -> SpendingForm {
        try requireCard(cardID)
        let draft = try secureRead(spendingFormKey(for: cardID)).map { try JSONDecoder().decode(SpendingForm.self, from: $0) }
        let decimals = config?.token.decimals ?? 18
        let pending = try permissionDraft(cardID: cardID).map { pendingForm($0) }
        return SpendingForm.restored(draft: draft, pending: pending, policy: policy(for: cardID), decimals: decimals)
    }
    func saveSpendingForm(_ form: SpendingForm, cardID: String? = nil) throws {
        guard isSignedIn, account?.role == "customer" else { throw AppError.message("Sign in to edit spending settings.") }
        try requireCard(cardID)
        if form.matches(policy(for: cardID), decimals: config?.token.decimals ?? 18) {
            try secureSave(nil, key: spendingFormKey(for: cardID))
        } else { try secureSave(JSONEncoder().encode(form), key: spendingFormKey(for: cardID)) }
    }
    var preparingPermission: Bool { preparingPermission(for: nil) }
    func permissionDraft(cardID: String? = nil) throws -> PendingPermission? {
        if let cardID, linkedCard(cardID) == nil { return nil }
        guard let data = try secureRead(permissionKey(for: cardID)) else { return nil }
        return try JSONDecoder().decode(PendingPermission.self, from: data)
    }
    private func pendingForm(_ pending: PendingPermission) -> SpendingForm {
        let decimals = config?.token.decimals ?? 18
        return SpendingForm(perPayment: TokenAmount.display(pending.perPayment, decimals: decimals), total: TokenAmount.display(pending.total, decimals: decimals), expires: AppDates.date(pending.expiresAt) ?? .now, merchantIDs: Set(pending.merchantIDs), useRewards: pending.useRewards == true, merchantScope: pending.effectiveMerchantScope, maxPointsPerPayment: pending.maxPointsPerPayment)
    }
    private func clearPendingPermission(clearDraft: Bool, cardID: String? = nil) throws {
        setAllowance(jobID: nil, status: nil, cardID: cardID)
        try secureSave(nil, key: permissionKey(for: cardID))
        if clearDraft { try secureSave(nil, key: spendingFormKey(for: cardID)) }
    }
    private func reconcileSavedPermission() throws {
        guard account?.role == "customer" else { return }
        let scopes: [String?] = [nil] + (dashboard?.cards ?? []).map { Optional($0.id) }
        for cardID in scopes {
            guard let pending = try permissionDraft(cardID: cardID), paymentsEnabled(form: pendingForm(pending), cardID: cardID) else { continue }
            let draft = try secureRead(spendingFormKey(for: cardID)).map { try JSONDecoder().decode(SpendingForm.self, from: $0) }
            try clearPendingPermission(clearDraft: draft == nil || draft!.matches(policy(for: cardID), decimals: config?.token.decimals ?? 18), cardID: cardID)
            notice = "Tap payments enabled."
        }
    }
    private func applySavedPolicy(_ policy: Policy, cardID: String? = nil) throws {
        try requireCard(cardID)
        refreshRevision &+= 1
        if let cardID, let index = dashboard?.cards?.firstIndex(where: { $0.id == cardID }) {
            dashboard?.cards?[index].policy = policy
            if policy.enabled { dashboard?.cards?[index].allowanceSufficient = true }
        } else if cardID == nil { dashboard?.policy = policy }
        let draft = try secureRead(spendingFormKey(for: cardID)).map { try JSONDecoder().decode(SpendingForm.self, from: $0) }
        try clearPendingPermission(clearDraft: draft == nil || draft!.matches(policy, decimals: config?.token.decimals ?? 18), cardID: cardID)
    }
    private func submitPendingAllowance(_ proposed: PendingPermission, cardID: String? = nil) async throws -> PendingPermission {
        try requireCard(cardID)
        let generation = sessionGeneration
        let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
        var pending = proposed
        struct Job: Decodable { let id: String; let status: String }
        var body: [String: Any] = ["amount": pending.total]
        if let id = pending.requestID { body["requestId"] = id }
        if let router = pending.router { body["router"] = router }
        let job: Job = try await api.json("v1/wallet/allowance", body: scopedBody(body, cardID: cardID))
        guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
        pending.jobID = job.id
        try secureSave(JSONEncoder().encode(pending), key: permissionKey(for: cardID))
        setAllowance(jobID: job.id, status: job.status, cardID: cardID)
        return pending
    }
    func enablePayments(perPayment: String, total: String, expiry: Date, merchantIDs: Set<String>, useRewards: Bool = false, merchantScope: MerchantScope = .selected, maxPointsPerPayment: String? = nil, cardID: String? = nil) async {
        await run {
            try requireCard(cardID)
            let generation = sessionGeneration
            let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
            guard paymentsAvailable else { throw AppError.message("Payments aren’t ready yet. Wallet still available.") }
            guard !useRewards || rewardsAvailable else { throw AppError.message("Rewards aren’t available yet. You can still use normal tap payments.") }
            let pointsLimit = try WholePoints.limit(maxPointsPerPayment)
            let form = SpendingForm(perPayment: perPayment, total: total, expires: expiry, merchantIDs: merchantIDs, useRewards: useRewards, merchantScope: merchantScope, maxPointsPerPayment: pointsLimit)
            if paymentsEnabled(form: form, cardID: cardID) {
                notice = "These spending settings are already active."; return
            }
            guard try permissionDraft(cardID: cardID) == nil else { throw AppError.message("Finish the saved wallet approval before changing its terms.") }
            try saveSpendingForm(form, cardID: cardID)
            guard let decimals = config?.token.decimals else { throw AppError.message("Token details are unavailable. Refresh and try again.") }
            guard merchantScope == .all ? merchantIDs.isEmpty : !merchantIDs.isEmpty else { throw AppError.message("Review your spending permission before saving.") }
            let per = try TokenAmount.units(perPayment, decimals: decimals)
            let cap = try TokenAmount.units(total, decimals: decimals)
            let expires = ISO8601DateFormatter().string(from: expiry)
            var values: [String: Any] = ["enabled": true, "perPaymentLimit": per, "totalLimit": cap, "expiresAt": expires, "merchantIds": Array(merchantIDs), "merchantScope": merchantScope.rawValue, "useRewards": useRewards, "maxPointsPerPayment": pointsLimit as Any? ?? NSNull()]
            if let router = config?.paymentRouter?.kind { values["router"] = router }
            let body = scopedBody(values, cardID: cardID)
            do {
                let saved: Policy = try await api.json("v1/policy", method: "PUT", body: body)
                guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
                try applySavedPolicy(saved, cardID: cardID)
                actionSuccessSequence += 1
                await refreshAfterSave("Tap payments enabled.")
            } catch let failure as APIRequestError where failure.code == "allowance_required" {
                guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
                let pending = PendingPermission(perPayment: per, total: cap, expiresAt: expires, merchantIDs: Array(merchantIDs), jobID: "", requestID: UUID().uuidString, useRewards: useRewards, router: config?.paymentRouter?.kind, routerAddress: config?.paymentRouter?.address, merchantScope: merchantScope, maxPointsPerPayment: pointsLimit)
                try secureSave(JSONEncoder().encode(pending), key: permissionKey(for: cardID))
                setAllowance(jobID: "", status: "queued", cardID: cardID)
                _ = try await submitPendingAllowance(pending, cardID: cardID)
                notice = "Preparing wallet approval. Save spending settings once confirmed."
            }
        }
    }
    func resumePermission(cardID: String? = nil) async {
        await run {
            try requireCard(cardID)
            let generation = sessionGeneration
            let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
            // The server may already have applied this exact request.
            try await refresh()
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
            guard var pending = try permissionDraft(cardID: cardID) else { setAllowance(jobID: nil, status: nil, cardID: cardID); return }
            guard (AppDates.date(pending.expiresAt) ?? .distantPast) > Date() else {
                try clearPendingPermission(clearDraft: false, cardID: cardID)
                throw AppError.message("Spending permission expired. Choose new limits.")
            }
            if pending.jobID.isEmpty { pending = try await submitPendingAllowance(pending, cardID: cardID) }
            struct Job: Decodable { let status: String; let errorCode: String? }
            let job: Job = try await api.call("v1/jobs/\(pending.jobID)")
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
            setAllowance(jobID: pending.jobID, status: job.status, cardID: cardID)
            if job.status == "confirmed" {
                notice = "Wallet approval confirmed. Save spending settings to enable payments."
            } else if job.status == "failed" {
                try clearPendingPermission(clearDraft: false, cardID: cardID)
                throw AppError.message(PaymentIssue.message(code: job.errorCode, status: job.status) ?? "Couldn’t prepare payment permission. Try again.")
            } else { notice = "Wallet approval pending. No need to resubmit." }
        }
    }
    func confirmPayments(cardID: String? = nil) async {
        await run {
            try requireCard(cardID)
            let generation = sessionGeneration
            let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
            guard paymentsAvailable else { throw AppError.message("Payments aren’t ready yet. Wallet still available.") }
            guard let pending = try permissionDraft(cardID: cardID) else {
                notice = policy(for: cardID)?.enabled == true ? "Tap payments already enabled." : "Choose your spending settings first."
                return
            }
            if !pending.matchesRouter(kind: config?.paymentRouter?.kind, address: config?.paymentRouter?.address) {
                guard ["confirmed", "failed"].contains(allowanceStatus(for: cardID) ?? "") else {
                    throw AppError.message("Check the existing wallet approval before changing payment systems.")
                }
                try clearPendingPermission(clearDraft: false, cardID: cardID)
                throw AppError.message("Payment approval changed. Review your settings and approve again.")
            }
            var values: [String: Any] = ["enabled": true, "perPaymentLimit": pending.perPayment, "totalLimit": pending.total, "expiresAt": pending.expiresAt, "merchantIds": pending.merchantIDs, "merchantScope": pending.effectiveMerchantScope.rawValue, "useRewards": pending.useRewards == true, "maxPointsPerPayment": pending.maxPointsPerPayment as Any? ?? NSNull()]
            if let router = pending.router { values["router"] = router }
            let body = scopedBody(values, cardID: cardID)
            do {
                let saved: Policy = try await api.json("v1/policy", method: "PUT", body: body)
                guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
                try applySavedPolicy(saved, cardID: cardID)
                actionSuccessSequence += 1
                await refreshAfterSave("Tap payments enabled.")
            } catch let failure as APIRequestError where failure.code == "allowance_required" {
                guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
                try clearPendingPermission(clearDraft: false, cardID: cardID)
                notice = "A new wallet approval is required. Review your settings and enable payments again."
            }
        }
    }
    func cancelInvoice() async {
        guard let invoice else { return }
        await run {
            let generation = sessionGeneration
            let _: EmptyResponse = try await api.json("v1/invoices/\(invoice.id)/cancel", body: [:])
            guard generation == sessionGeneration, self.invoice?.id == invoice.id else { throw CancellationError() }
            var cancelled = invoice
            cancelled.status = "cancelled"
            // Retire the request before allowing edits, even when the next read fails.
            try applyInvoicePersistence(InvoiceCreationPlan.retirement(knownInvoice: cancelled, savedDraft: savedInvoiceDraft()))
            self.invoice = cancelled
            invoiceRequestPending = false
            await refreshAfterSave("Payment request cancelled.")
        }
    }
    func freeze(cardID: String? = nil) async {
        await run {
            try requireCard(cardID)
            let generation = sessionGeneration
            let revision = cardID.map { cardRevisions[$0, default: 0] } ?? 0
            let _: EmptyResponse = try await api.json("v1/freeze", body: scopedBody([:], cardID: cardID))
            guard moneyOperationCurrent(cardID, generation: generation, revision: revision) else { throw CancellationError() }
            refreshRevision &+= 1
            if let cardID, let index = dashboard?.cards?.firstIndex(where: { $0.id == cardID }) {
                dashboard?.cards?[index].policy?.enabled = false
            } else if cardID == nil { dashboard?.policy?.enabled = false }
            try clearPendingPermission(clearDraft: true, cardID: cardID)
            actionSuccessSequence += 1
            await refreshAfterSave("New payments frozen. Submitted payments may still complete.")
        }
    }
    private var terminalStorageKey: String { "terminal.\(serverURL).\(dashboard?.merchant?.id ?? "")" }
    func enrollTerminal() async {
        await run {
            guard isMerchant else { throw AppError.message("Sign in to an authorized merchant account.") }
            let signer = try TerminalSigner()
            let terminal: Terminal = try await api.json("v1/terminals", body: ["publicKey": signer.publicKey, "name": "IC Pay iPhone"])
            try secureSave(Data(terminal.id.utf8), key: terminalStorageKey)
            terminalEnrolled = true
            notice = "This iPhone is ready to collect payments."
            actionSuccessSequence += 1
        }
    }
    private var accountStateScope: String { hash(serverURL + "\n" + (account?.id ?? "signed-out")) }
    private var invoiceDraftKey: String { "invoice-draft." + accountStateScope }
    private var activeInvoiceKey: String { "active-invoice." + accountStateScope }
    private var merchantInviteKey: String { "merchant-invite." + accountStateScope }
    private var merchantActivationKey: String { "merchant-activation." + accountStateScope }
    func savedInvoiceDraft() throws -> InvoiceDraft {
        try secureRead(invoiceDraftKey).map { try JSONDecoder().decode(InvoiceDraft.self, from: $0) } ?? InvoiceDraft()
    }
    func saveInvoiceDraft(amount: String, description: String, useReward: Bool = false, router: String? = nil, maxPoints: String? = nil) throws {
        let previous = try savedInvoiceDraft()
        guard previous.requestID == nil else { return }
        try secureSave(JSONEncoder().encode(InvoiceDraft(amount: amount, description: description, useReward: useReward, router: router, maxPoints: maxPoints)), key: invoiceDraftKey)
    }
    func savedMerchantActivationCode() throws -> String {
        try secureRead(merchantActivationKey).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    func saveMerchantActivationCode(_ code: String) throws {
        try secureSave(Data(code.utf8), key: merchantActivationKey)
    }
    private func restoreMerchantState(client: SessionAPIClient) async throws {
        let revision = refreshRevision
        if let merchant = dashboard?.merchant, let previousServerURL,
           try secureRead(terminalStorageKey) == nil,
           let old = try secureRead("terminal.\(previousServerURL).\(merchant.id)") {
            try secureSave(old, key: terminalStorageKey)
        }
        if let data = try secureRead(merchantInviteKey) {
            let invite = try JSONDecoder().decode(MerchantInvite.self, from: data)
            if (AppDates.date(invite.expiresAt) ?? .distantPast) > Date() { merchantInvite = invite }
            else { merchantInvite = nil; try secureSave(nil, key: merchantInviteKey) }
        }
        if let id = try secureRead(terminalStorageKey).flatMap({ String(data: $0, encoding: .utf8) }) {
            do {
                let terminal: TerminalStatus = try await client.call("v1/terminals/\(id)")
                guard revision == refreshRevision else { throw CancellationError() }
                let valid: Bool
                if terminal.active && terminal.merchantId == dashboard?.merchant?.id {
                    valid = terminal.publicKey == (try TerminalSigner()).publicKey
                } else { valid = false }
                terminalEnrolled = valid
                if !valid { try secureSave(nil, key: terminalStorageKey) }
            } catch let failure as APIRequestError where failure.status == 404 {
                guard revision == refreshRevision else { throw CancellationError() }
                terminalEnrolled = false; try secureSave(nil, key: terminalStorageKey)
            }
        } else { terminalEnrolled = false }
        if let id = try secureRead(activeInvoiceKey).flatMap({ String(data: $0, encoding: .utf8) }) {
            do {
                let restored: Invoice = try await client.call("v1/invoices/\(id)")
                guard revision == refreshRevision else { throw CancellationError() }
                if restored.isFinished {
                    try applyInvoicePersistence(InvoiceCreationPlan.retirement(knownInvoice: restored, savedDraft: savedInvoiceDraft()))
                }
                invoice = restored; invoiceRequestPending = false
                refundRequestPending = try pendingRefund(for: restored.id) != nil
            } catch let failure as APIRequestError where failure.status == 404 {
                guard revision == refreshRevision else { throw CancellationError() }
                try secureSave(nil, key: activeInvoiceKey); invoice = nil
            }
        } else {
            let draft = try savedInvoiceDraft()
            if draft.requestID != nil { try await submitInvoice(draft) }
        }
    }
    private func submitInvoice(_ draft: InvoiceDraft) async throws {
        guard let config, config.capabilities.payments, let requestID = draft.requestID else { throw AppError.message("Payments are temporarily unavailable.") }
        let completion = InvoiceCompletionTicket(revision: refreshRevision, requestID: requestID)
        invoiceRequestPending = true
        var body: [String: Any] = ["amount": try TokenAmount.units(draft.amount, decimals: config.token.decimals), "description": draft.description, "requestId": requestID, "useReward": draft.useReward]
        if let router = draft.router { body["router"] = router }
        if let points = draft.maxPoints { body["maxPoints"] = try WholePoints.normalized(points) }
        let created: Invoice = try await api.json("v1/invoices", body: body)
        guard completion.canApply(currentRevision: refreshRevision, persistedRequestID: try savedInvoiceDraft().requestID) else { throw CancellationError() }
        refreshRevision &+= 1
        if created.isFinished {
            try applyInvoicePersistence(InvoiceCreationPlan.retirement(knownInvoice: created, savedDraft: draft))
        } else {
            try secureSave(Data(created.id.utf8), key: activeInvoiceKey)
        }
        invoice = created
        invoiceRequestPending = false
        refundRequestPending = try pendingRefund(for: created.id) != nil
    }
    private func applyInvoicePersistence(_ mutations: [InvoicePersistenceMutation]) throws {
        for mutation in mutations {
            switch mutation {
            case .clearActiveInvoice:
                try secureSave(nil, key: activeInvoiceKey)
                refreshRevision &+= 1
                invoice = nil; refundRequestPending = false; refundError = nil; refundReadRevision &+= 1
            case .saveDraft(let draft): try secureSave(JSONEncoder().encode(draft), key: invoiceDraftKey)
            case .clearDraft: try secureSave(nil, key: invoiceDraftKey)
            }
        }
    }
    func createInvoice(amount: String, description: String, useReward: Bool = false, router: String? = nil, maxPoints: String? = nil) async {
        await run {
            let plan = try InvoiceCreationPlan.make(knownInvoice: invoice, savedDraft: savedInvoiceDraft(),
                entered: InvoiceDraft(amount: amount, description: description, useReward: useReward, router: router, maxPoints: maxPoints),
                hasPersistedActiveInvoice: secureRead(activeInvoiceKey) != nil)
            if plan.isNewRequest {
                guard let config, config.capabilities.payments else { throw AppError.message("Payments are temporarily unavailable.") }
                _ = try TokenAmount.units(plan.draft.amount, decimals: config.token.decimals)
                guard !plan.draft.useReward || rewardsAvailable else { throw AppError.message("Reward redemption is not available yet.") }
                if ["collectibles", "rewards"].contains(plan.draft.router ?? "") {
                    guard plan.draft.useReward, plan.draft.maxPoints == nil else { throw AppError.message("Earlier voucher payments must apply that voucher without a points limit.") }
                }
                if let maxPoints = plan.draft.maxPoints { _ = try WholePoints.normalized(maxPoints) }
            }
            try applyInvoicePersistence(plan.mutations)
            try await submitInvoice(plan.draft)
        }
    }
    @discardableResult func newInvoice() -> Bool {
        guard !busy, !invoiceRequestPending, invoice?.isFinished == true else { return false }
        do {
            try applyInvoicePersistence([.clearActiveInvoice, .clearDraft])
            invoiceRequestPending = false
            return true
        } catch { self.error = error.localizedDescription; return false }
    }
    func collect() async {
        await run {
            guard paymentsAvailable else { throw AppError.message("Payments unavailable. Try again shortly.") }
            guard let invoice, invoice.status.lowercased() == "awaiting_tap" || invoice.status.lowercased() == "awaitingtap" else { throw AppError.message("Create a payment request before scanning.") }
            guard let terminalID = try secureRead(terminalStorageKey).flatMap({ String(data: $0, encoding: .utf8) }) else { throw AppError.message("Activate this iPhone to collect payments.") }
            let signer = try TerminalSigner()
            let challenge: Challenge = try await api.json("v1/invoices/\(invoice.id)/challenge", body: ["terminalId": terminalID])
            let generation = sessionGeneration
            let card = try await reader.scan(message: "Tap the customer's physical transit IC card to pay this invoice.")
            guard generation == sessionGeneration else { throw CancellationError() }
            let version = invoice.scanVersion ?? 1
            if version >= 2, invoice.grossAmount == nil || invoice.routerAddress == nil || invoice.useReward == nil { throw AppError.message("Reward payment terms are incomplete. Create a new payment request.") }
            let payload = ScanPayload(version: version, terminalId: terminalID, invoiceId: invoice.id, challenge: challenge.challenge, cardId: card, chainId: invoice.chainId, token: invoice.token.lowercased(), amount: version >= 2 ? invoice.grossAmount! : invoice.amount, expiresAt: challenge.expiresAt, routerAddress: version >= 2 ? invoice.routerAddress?.lowercased() : nil, useReward: version >= 2 ? invoice.useReward : nil, maxPoints: version == 3 ? invoice.maxPoints : nil)
            let report = ScanReport(payload: payload, signature: try signer.sign(payload))
            let _: EmptyResponse = try await api.call("v1/scans", method: "POST", body: JSONEncoder().encode(report))
            self.invoice = try await api.call("v1/invoices/\(invoice.id)")
            notice = "Card accepted. Payment confirmation pending."
        }
    }
    private func refundKey(for invoiceID: String) -> String { "refund-request." + sessionViewID + "." + invoiceID }
    private func pendingRefund(for invoiceID: String) throws -> PendingRefundRequest? {
        try secureRead(refundKey(for: invoiceID)).map { try JSONDecoder().decode(PendingRefundRequest.self, from: $0) }
    }
    func requestFullRefund() async {
        await run {
            guard isMerchant, let current = invoice, current.status == "confirmed" else { throw AppError.message("Open a confirmed payment to request a refund.") }
            let generation = sessionGeneration, invoiceID = current.id
            var pending = try pendingRefund(for: invoiceID)
            if pending == nil {
                guard current.canRequestNewRefund else { throw AppError.message("This payment is not eligible for a new refund.") }
                pending = PendingRefundRequest(requestID: UUID().uuidString)
                try secureSave(JSONEncoder().encode(pending!), key: refundKey(for: invoiceID))
            }
            refundRequestPending = true; refundError = nil
            struct Accepted: Decodable { let id: String; let status: String }
            let accepted: Accepted = try await api.json("v1/invoices/\(invoiceID)/refund", body: pending!.requestBody())
            guard generation == sessionGeneration else { throw CancellationError() }
            pending!.operationID = accepted.id
            try secureSave(JSONEncoder().encode(pending!), key: refundKey(for: invoiceID))
            guard invoice?.id == invoiceID else { return }
            await refreshRefundStatus()
        }
    }
    func refreshRefundStatus() async {
        guard isMerchant, let current = invoice else { return }
        let generation = sessionGeneration, invoiceID = current.id
        refundReadRevision &+= 1
        let revision = refundReadRevision
        do {
            let pending = try pendingRefund(for: invoiceID)
            refundRequestPending = pending != nil
            guard let operationID = pending?.operationID ?? current.refund?.id else { return }
            let result: PaymentRefund = try await api.call("v1/refunds/\(operationID)")
            guard generation == sessionGeneration, revision == refundReadRevision, invoice?.id == invoiceID, result.invoiceId == invoiceID, !Task.isCancelled else { return }
            invoice?.refund = result; refundError = nil
            if let pending, pending.canRetire(result) {
                try secureSave(nil, key: refundKey(for: invoiceID))
                refundRequestPending = false
            }
            if result.status == "confirmed" { invoice?.refundEligible = false }
            if result.isTerminal {
                let updated: Invoice = try await api.call("v1/invoices/\(invoiceID)")
                guard generation == sessionGeneration, revision == refundReadRevision, invoice?.id == invoiceID, updated.id == invoiceID, !Task.isCancelled else { return }
                invoice?.refundEligible = updated.refundEligible
                invoice?.refund = updated.refund
            }
        } catch {
            guard generation == sessionGeneration, revision == refundReadRevision, invoice?.id == invoiceID, !Task.isCancelled else { return }
            refundError = "Couldn’t check the refund. Your request is saved; check again."
        }
    }
    func refreshInvoice() async {
        guard invoice != nil || invoiceRequestPending else { return }
        await run { try await refresh() }
    }
}
