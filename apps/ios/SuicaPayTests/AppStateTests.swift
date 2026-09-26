import XCTest
import CryptoKit
@testable import SuicaPay

private final class StateFixtureProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> Data)?
    static var responseHandler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "state-tests.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let response = try Self.responseHandler?(request) ?? (200, Self.handler!(request))
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: response.0, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: response.1)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor final class AppStateTests: XCTestCase {
    private let origin = "https://state-tests.example"
    private let token = "state-regression-session"
    private var namespace = ""
    private var session: URLSession!
    private let policy: [String: Any] = ["enabled": true, "perPaymentLimit": "200", "totalLimit": "500", "spent": "30", "expiresAt": "2033-05-18T03:33:20Z", "merchantIds": ["merchant-a", "merchant-b"]]
    private func digest(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func store() throws -> AppStore {
        namespace = "app-state-test." + UUID().uuidString + "."
        try Keychain.save(Data(token.utf8), key: namespace + "app-session." + digest(origin))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StateFixtureProtocol.self]
        session = URLSession(configuration: configuration)
        return AppStore(deployment: BuildConfiguration(apiURL: URL(string: origin)!, webURL: URL(string: origin)!, previousAPIURL: nil), credentialNamespace: namespace, urlSession: session)
    }
    private func response(_ path: String, policy: [String: Any]?) throws -> Data {
        let account: [String: Any] = ["id": "customer-a", "role": "customer", "verified": true]
        let object: Any
        switch path {
        case "/v1/config": object = ["chainId": "11155111", "token": ["address": "token", "symbol": "MJPY", "decimals": 0], "capabilities": ["payments": true, "world": true]]
        case "/v1/me": object = account
        case "/v1/dashboard": object = ["account": account, "card": ["linked": true], "payments": [], "policy": policy as Any? ?? NSNull()]
        case "/v1/jobs/job-a": object = ["status": "confirmed"]
        case "/v1/policy": object = self.policy
        case "/v1/freeze": object = ["enabled": false]
        default: throw URLError(.unsupportedURL)
        }
        return try JSONSerialization.data(withJSONObject: object)
    }
    private func fixtures(policy: [String: Any]?) throws -> [String: Data] {
        try Dictionary(uniqueKeysWithValues: ["/v1/config", "/v1/me", "/v1/dashboard", "/v1/jobs/job-a", "/v1/policy", "/v1/freeze"].map { ($0, try response($0, policy: policy)) })
    }
    private func cardFixtures() throws -> [String: Data] {
        var responses = try fixtures(policy: policy)
        var configuration = try XCTUnwrap(JSONSerialization.jsonObject(with: responses["/v1/config"]!) as? [String: Any])
        configuration["capabilities"] = ["payments": true, "world": true, "multipleCards": true]
        responses["/v1/config"] = try JSONSerialization.data(withJSONObject: configuration)
        var dashboard = try XCTUnwrap(JSONSerialization.jsonObject(with: responses["/v1/dashboard"]!) as? [String: Any])
        dashboard["cards"] = [
            ["id": "11111111-2222-4333-8444-555555555555", "nickname": "Daily", "last4": "0708", "status": "active", "linkedAt": "2026-09-26T00:00:00Z"],
            ["id": "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "nickname": "Travel", "last4": "1718", "status": "active", "linkedAt": "2026-09-26T01:00:00Z"],
        ]
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: dashboard)
        return responses
    }
    private let dailyCardID = "11111111-2222-4333-8444-555555555555"
    private let travelCardID = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"
    private func separateWalletFixtures() throws -> [String: Data] {
        var responses = try cardFixtures()
        var dashboard = try XCTUnwrap(JSONSerialization.jsonObject(with: responses["/v1/dashboard"]!) as? [String: Any])
        var cards = try XCTUnwrap(dashboard["cards"] as? [[String: Any]])
        for index in cards.indices {
            cards[index]["wallet"] = ["address": "0x" + String(repeating: String(index + 1), count: 40), "balance": index == 0 ? "120" : "450", "balanceStatus": "available", "symbol": "MJPY", "decimals": 0, "chainId": "11155111"]
            cards[index]["walletStatus"] = "ready"
            cards[index]["policy"] = policy
            cards[index]["allowanceSufficient"] = index == 0
        }
        dashboard["cards"] = cards
        dashboard["wallet"] = ["address": "legacy-account-address", "balance": "999", "balanceStatus": "available", "symbol": "MJPY", "decimals": 0, "chainId": "11155111"]
        dashboard["unassignedWalletAvailable"] = true
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: dashboard)
        return responses
    }
    func testCardBalancesStaySeparateAndNeverFallBackToAccountWallet() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        XCTAssertEqual(store.wallet(for: dailyCardID)?.displayBalance, "120")
        XCTAssertEqual(store.wallet(for: travelCardID)?.displayBalance, "450")
        XCTAssertEqual(store.wallet(for: nil)?.displayBalance, "999")
        XCTAssertNil(store.wallet(for: "missing-card"))
        let form = try store.savedSpendingForm(cardID: dailyCardID)
        XCTAssertTrue(store.paymentsEnabled(form: form, cardID: dailyCardID))
        XCTAssertFalse(store.paymentsEnabled(form: form, cardID: travelCardID), "An enabled policy cannot skip this card's wallet approval")
        StateFixtureProtocol.handler = { _ in Data(#"{"removed":true}"#.utf8) }
        await store.removeCard(id: dailyCardID)
        XCTAssertNil(store.wallet(for: dailyCardID))
        XCTAssertNil(store.policy(for: dailyCardID))
        XCTAssertEqual(store.wallet(for: travelCardID)?.displayBalance, "450")
        XCTAssertEqual(store.wallet(for: nil)?.displayBalance, "999")
    }
    func testAutomaticWalletRefreshReplacesProgressWithReadyAddress() async throws {
        let store = try store()
        defer { cleanup(store) }
        let ready = try separateWalletFixtures()
        var pending = ready
        var dashboard = try XCTUnwrap(JSONSerialization.jsonObject(with: ready["/v1/dashboard"]!) as? [String: Any])
        var cards = try XCTUnwrap(dashboard["cards"] as? [[String: Any]])
        cards[0]["wallet"] = NSNull()
        cards[0]["walletStatus"] = "provisioning"
        dashboard["cards"] = cards
        pending["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: dashboard)
        StateFixtureProtocol.handler = { pending[$0.url!.path]! }
        await store.bootstrap()
        XCTAssertEqual(store.preparingCardWalletIDs, [dailyCardID])
        XCTAssertNil(store.wallet(for: dailyCardID))
        StateFixtureProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET", "Polling must never create or claim a wallet")
            return ready[request.url!.path]!
        }
        await store.refreshPreparingCardWallets()
        XCTAssertTrue(store.preparingCardWalletIDs.isEmpty)
        XCTAssertEqual(store.wallet(for: dailyCardID)?.address, "0x" + String(repeating: "1", count: 40))
        XCTAssertEqual(store.wallet(for: travelCardID)?.displayBalance, "450")
    }
    func testAutomaticWalletRefreshDoesNotClaimExistingFundsOrPollRemovedCards() async throws {
        let store = try store()
        defer { cleanup(store) }
        var responses = try cardFixtures()
        var dashboard = try XCTUnwrap(JSONSerialization.jsonObject(with: responses["/v1/dashboard"]!) as? [String: Any])
        dashboard["unassignedWalletAvailable"] = true
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: dashboard)
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        StateFixtureProtocol.handler = { _ in XCTFail("An unassigned wallet needs an explicit choice"); throw URLError(.unsupportedURL) }
        await store.refreshPreparingCardWallets()
        XCTAssertEqual(store.dashboard?.unassignedWalletAvailable, true)
        store.dashboard?.cards = []
        await store.refreshPreparingCardWallets()
        XCTAssertTrue(store.preparingCardWalletIDs.isEmpty)
    }
    func testCardDraftsAndFundingAreScopedAndRemovedWithCard() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        var daily = try store.savedSpendingForm(cardID: dailyCardID)
        daily.perPayment = "12"
        var travel = daily
        travel.perPayment = "34"
        try store.saveSpendingForm(daily, cardID: dailyCardID)
        try store.saveSpendingForm(travel, cardID: travelCardID)
        XCTAssertEqual(try store.savedSpendingForm(cardID: dailyCardID).perPayment, "12")
        XCTAssertEqual(try store.savedSpendingForm(cardID: travelCardID).perPayment, "34")
        XCTAssertEqual(try store.savedSpendingForm().perPayment, "200")
        StateFixtureProtocol.handler = { request in
            if request.httpMethod == "DELETE" { return Data(#"{"removed":true}"#.utf8) }
            let path = request.url!.path
            if path == "/v1/cards/" + self.dailyCardID + "/funding" {
                return Data(#"{"status":"available","transfers":[{"id":"daily-funding","from":"sender","amount":"12","symbol":"MJPY","decimals":0,"createdAt":"2026-09-26T00:00:00Z","txHash":"tx-a","status":"confirmed"}]}"#.utf8)
            }
            XCTAssertEqual(path, "/v1/cards/" + self.travelCardID + "/funding")
            return Data(#"{"status":"available","transfers":[]}"#.utf8)
        }
        await store.loadFunding(cardID: dailyCardID)
        await store.loadFunding(cardID: travelCardID)
        XCTAssertEqual(store.funding(for: dailyCardID)?.first?.id, "daily-funding")
        XCTAssertEqual(store.funding(for: travelCardID)?.count, 0)
        XCTAssertNil(store.funding, "Card loads must not overwrite account-wide activity")
        await store.removeCard(id: dailyCardID)
        XCTAssertNil(store.funding(for: dailyCardID))
        XCTAssertNil(store.fundingStatus(for: dailyCardID))
        XCTAssertThrowsError(try store.savedSpendingForm(cardID: dailyCardID))
        XCTAssertEqual(try store.savedSpendingForm(cardID: travelCardID).perPayment, "34")
        XCTAssertNil(try Keychain.read(namespace + "spending-form." + store.sessionViewID + ".card." + dailyCardID))
    }
    private func requestBody(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    func testAllowanceRequestsAndPendingPermissionsStayWithTheirCards() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        StateFixtureProtocol.responseHandler = { request in
            let body = try self.requestBody(request)
            let cardID = try XCTUnwrap(body["cardId"] as? String)
            XCTAssertTrue([self.dailyCardID, self.travelCardID].contains(cardID))
            if request.url!.path == "/v1/policy" {
                return (409, Data(#"{"error":{"code":"allowance_required","message":"Approval required"}}"#.utf8))
            }
            XCTAssertEqual(request.url!.path, "/v1/wallet/allowance")
            XCTAssertNotNil(body["requestId"])
            return (200, try JSONSerialization.data(withJSONObject: ["id": "job-" + cardID, "status": "queued"]))
        }
        await store.enablePayments(perPayment: "12", total: "100", expiry: Date().addingTimeInterval(3600), merchantIDs: ["merchant-a"], cardID: dailyCardID)
        XCTAssertNil(store.error)
        await store.enablePayments(perPayment: "34", total: "200", expiry: Date().addingTimeInterval(3600), merchantIDs: ["merchant-b"], cardID: travelCardID)
        XCTAssertNil(store.error)
        XCTAssertEqual(try store.permissionDraft(cardID: dailyCardID)?.perPayment, "12")
        XCTAssertEqual(try store.permissionDraft(cardID: travelCardID)?.perPayment, "34")
        XCTAssertNil(try store.permissionDraft())
        XCTAssertEqual(store.allowanceJobID(for: dailyCardID), "job-" + dailyCardID)
        XCTAssertEqual(store.allowanceJobID(for: travelCardID), "job-" + travelCardID)
        XCTAssertTrue(store.preparingPermission(for: dailyCardID))
        XCTAssertFalse(store.preparingPermission)
    }
    func testLateFundingCannotRestoreRemovedCardData() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        let started = expectation(description: "Card funding started")
        let release = DispatchSemaphore(value: 0)
        StateFixtureProtocol.handler = { _ in
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
            return Data(#"{"status":"available","transfers":[]}"#.utf8)
        }
        let task = Task { await store.loadFunding(cardID: dailyCardID) }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(store.isLoadingFunding(for: dailyCardID))
        // Simulate a refreshed dashboard after removal on another device.
        store.dashboard?.cards = []
        release.signal()
        await task.value
        XCTAssertNil(store.funding(for: dailyCardID))
        XCTAssertNil(store.wallet(for: dailyCardID))
        XCTAssertFalse(store.isLoadingFunding(for: dailyCardID))
    }
    func testBasicCardPatchPreservesItsWalletAndPolicy() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await store.bootstrap()
        let before = store.wallet(for: dailyCardID)
        StateFixtureProtocol.handler = { _ in Data(#"{"id":"11111111-2222-4333-8444-555555555555","nickname":"Renamed","last4":"0708","status":"frozen","linkedAt":"2026-09-26T00:00:00Z"}"#.utf8) }
        await store.updateCard(id: dailyCardID, frozen: true)
        XCTAssertEqual(store.wallet(for: dailyCardID), before)
        XCTAssertEqual(store.policy(for: dailyCardID)?.enabled, true)
        XCTAssertEqual(store.dashboard?.cards?.first?.allowanceSufficient, true)
    }
    func testSelectedCardChangesPreserveOtherCardsAndSharedSpending() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try cardFixtures()
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        XCTAssertTrue(store.supportsMultipleCards)
        XCTAssertEqual(store.actionSuccessSequence, 0, "Loading an existing account must not celebrate old state")
        let cardID = "11111111-2222-4333-8444-555555555555"
        let previousPolicy = store.dashboard?.policy
        StateFixtureProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/cards/" + cardID)
            XCTAssertEqual(request.httpMethod, "PATCH")
            return Data(#"{"id":"11111111-2222-4333-8444-555555555555","nickname":"Daily","last4":"0708","status":"frozen","linkedAt":"2026-09-26T02:00:00Z"}"#.utf8)
        }
        await store.updateCard(id: cardID, frozen: true)
        XCTAssertEqual(store.actionSuccessSequence, 1)
        XCTAssertEqual(store.dashboard?.cards?.first?.status, "frozen")
        XCTAssertEqual(store.dashboard?.cards?.last?.status, "active")
        XCTAssertEqual(store.dashboard?.card.last4, "1718")
        XCTAssertEqual(store.dashboard?.policy, previousPolicy)
        StateFixtureProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/cards/" + cardID)
            XCTAssertEqual(request.httpMethod, "DELETE")
            return Data(#"{"removed":true}"#.utf8)
        }
        await store.removeCard(id: cardID)
        XCTAssertEqual(store.actionSuccessSequence, 2)
        XCTAssertEqual(store.dashboard?.cards?.map(\.nickname), ["Travel"])
        XCTAssertEqual(store.dashboard?.policy, previousPolicy)
    }
    func testFailedCardMutationRetainsTheDisplayedCards() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try cardFixtures()
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        let before = store.dashboard?.cards
        StateFixtureProtocol.handler = { _ in throw URLError(.networkConnectionLost) }
        await store.removeCard(id: "11111111-2222-4333-8444-555555555555")
        XCTAssertEqual(store.dashboard?.cards, before)
        XCTAssertNotNil(store.error)
        XCTAssertEqual(store.actionSuccessSequence, 0, "A rejected action must never signal success")
        XCTAssertFalse(store.busy)
    }
    private func cleanup(_ store: AppStore) {
        for id in [dailyCardID, travelCardID] {
            for prefix in ["pending-permission.", "spending-form."] {
                try? Keychain.save(nil, key: namespace + prefix + store.sessionViewID + ".card." + id)
            }
        }
        for key in ["app-session." + digest(origin), "pending-permission." + store.sessionViewID, "pending-world." + store.sessionViewID, "spending-form." + store.sessionViewID] { try? Keychain.save(nil, key: namespace + key) }
        for prefix in ["active-invoice.", "invoice-draft.", "merchant-invite.", "merchant-activation."] { try? Keychain.save(nil, key: namespace + prefix + digest(origin + "\nmerchant-a")) }
        try? Keychain.save(nil, key: namespace + "terminal." + origin + ".merchant-a")
        session.invalidateAndCancel()
        StateFixtureProtocol.handler = nil
        StateFixtureProtocol.responseHandler = nil
    }
    private func recoveryResponses(firstPath: String, firstCode: String, contextRequested: XCTestExpectation) -> (URLRequest) throws -> (Int, Data) {
        return { request in
            let path = request.url!.path
            if path == firstPath {
                return (409, Data("{\"error\":{\"code\":\"\(firstCode)\",\"message\":\"Recover your account\"}}".utf8))
            }
            if path == "/v1/auth/card/recover" {
                return (200, Data("{\"id\":\"AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\",\"handoffToken\":\"\(String(repeating: "x", count: 43))\",\"exchangeSecret\":\"\(String(repeating: "s", count: 43))\"}".utf8))
            }
            if path.hasSuffix("/context") {
                contextRequested.fulfill()
                // The fixture stops before SDK/network verification and never grants access.
                return (503, Data(#"{"error":{"code":"test_offline","message":"No live World request in this test"}}"#.utf8))
            }
            XCTFail("Unexpected recovery request: \(path)")
            throw URLError(.unsupportedURL)
        }
    }
    func testRemovedCardSignInAutomaticallyStartsWorldRecovery() async throws {
        let store = try store()
        defer { cleanup(store) }
        let contextRequested = expectation(description: "Recovery context requested")
        StateFixtureProtocol.responseHandler = recoveryResponses(firstPath: "/v1/auth/card/start", firstCode: "card_recovery_required", contextRequested: contextRequested)
        try await store.requestCardAccess(cardID: "0102030405060708", purpose: .login)
        await fulfillment(of: [contextRequested], timeout: 2)
        XCTAssertEqual(store.accountAccessPurpose, .recovery)
        XCTAssertFalse(store.isSignedIn, "Locating the account cannot replace a verified World proof")
        XCTAssertEqual(store.sessionToken, token)
    }
    func testFailedSignupSessionCanRecoverOriginalAccountWithoutCreatingAnotherWallet() async throws {
        let store = try store()
        defer { cleanup(store) }
        let contextRequested = expectation(description: "Recovery context requested")
        StateFixtureProtocol.responseHandler = recoveryResponses(firstPath: "/v1/world/requests", firstCode: "card_linked", contextRequested: contextRequested)
        try await store.enrollScannedCard(cardID: "0102030405060708", intent: .enrollment)
        await fulfillment(of: [contextRequested], timeout: 2)
        XCTAssertEqual(store.accountAccessPurpose, .recovery)
        let data = try XCTUnwrap(Keychain.read(namespace + "pending-world." + store.sessionViewID))
        let pending = try JSONDecoder().decode(PendingWorldHandoff.self, from: data)
        XCTAssertEqual(pending.resolvedAccountAccess, .recovery)
        XCTAssertNil(pending.cardLink)
        XCTAssertNil(store.dashboard?.wallet, "Recovery must not create or fabricate a wallet")
    }
    func testAlreadyAppliedPermissionDoesNotReopenConfirmation() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: policy)
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        let pending = AppStore.PendingPermission(perPayment: "200", total: "500", expiresAt: "2033-05-18T03:33:20Z", merchantIDs: ["merchant-b", "merchant-a"], jobID: "job-a")
        try Keychain.save(JSONEncoder().encode(pending), key: namespace + "pending-permission." + store.sessionViewID)
        await store.resumePermission()
        XCTAssertNil(store.allowanceJobID, "A policy already saved on the server must not ask to enable again")
        XCTAssertNil(try store.permissionDraft())
    }
    func testRefreshShowsProgressWithoutRemovingLoadedAccountAndStopsAfterFailure() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: policy)
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        let started = expectation(description: "Refresh request started")
        let release = DispatchSemaphore(value: 0)
        StateFixtureProtocol.handler = { _ in
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
            throw URLError(.networkConnectionLost)
        }
        let task = Task { await store.run { try await store.refresh() } }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(store.isRefreshing)
        XCTAssertTrue(store.isSignedIn)
        XCTAssertEqual(store.dashboard?.policy?.enabled, true)
        release.signal()
        await task.value
        XCTAssertFalse(store.isRefreshing)
        XCTAssertFalse(store.busy)
        XCTAssertNotNil(store.error)
        XCTAssertEqual(store.dashboard?.policy?.enabled, true)
    }
    func testFundingRefreshKeepsLoadedHistoryAndClearsProgressOnCompletion() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: policy)
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        store.funding = []; store.fundingStatus = "available"
        let started = expectation(description: "Funding request started")
        let release = DispatchSemaphore(value: 0)
        StateFixtureProtocol.handler = { _ in
            started.fulfill()
            _ = release.wait(timeout: .now() + 5)
            return Data(#"{"status":"available","transfers":[]}"#.utf8)
        }
        let task = Task { await store.loadFunding() }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(store.isLoadingFunding)
        XCTAssertNotNil(store.funding, "Refreshing must not replace loaded history with initial-load placeholders")
        release.signal()
        await task.value
        XCTAssertFalse(store.isLoadingFunding)
        XCTAssertEqual(store.fundingStatus, "available")
        XCTAssertNotNil(store.funding)
    }
    func testSuccessfulSaveRemainsAppliedWhenDashboardRefreshFails() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: nil)
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        StateFixtureProtocol.handler = { request in
            if request.url!.path == "/v1/dashboard" { throw URLError(.networkConnectionLost) }
            return responses[request.url!.path]!
        }
        await store.enablePayments(perPayment: "200", total: "500", expiry: Date(timeIntervalSince1970: 2_000_000_000), merchantIDs: ["merchant-a", "merchant-b"])
        XCTAssertEqual(store.dashboard?.policy?.enabled, true, "A failed refresh must not erase the successful PUT response")
        XCTAssertEqual(Set(store.dashboard?.policy?.merchantIds ?? []), ["merchant-a", "merchant-b"])
        XCTAssertNil(store.error)
    }
    func testFreezeRemainsAppliedWhenRefreshFails() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: policy)
        StateFixtureProtocol.handler = { request in responses[request.url!.path]! }
        await store.bootstrap()
        StateFixtureProtocol.handler = { request in
            if request.url!.path == "/v1/dashboard" { throw URLError(.networkConnectionLost) }
            return responses[request.url!.path]!
        }
        await store.freeze()
        XCTAssertEqual(store.actionSuccessSequence, 1, "Confirmed freeze should acknowledge once even if balance refresh fails")
        XCTAssertEqual(store.dashboard?.policy?.enabled, false)
        XCTAssertNil(store.error)
    }
    func testInvitationExchangeKeepsSessionWhenAccountRefreshFails() async throws {
        let store = try store()
        defer { cleanup(store) }
        let responses = try fixtures(policy: nil)
        StateFixtureProtocol.handler = { request in
            if request.url!.path == "/v1/invitations/exchange" { return Data(#"{"token":"accepted-test-session"}"#.utf8) }
            if request.url!.path == "/v1/dashboard" { throw URLError(.networkConnectionLost) }
            return responses[request.url!.path]!
        }
        await store.activateInvitation(code: "test-code")
        XCTAssertEqual(store.sessionToken, "accepted-test-session")
        XCTAssertNil(store.error, "Successful sign-in must not ask to reuse an already consumed code")
        XCTAssertNotNil(store.serviceUnavailable)
    }
    func testMerchantRestoresInvoiceInviteAndRevokedTerminalFromServer() async throws {
        let store = try store()
        defer { cleanup(store) }
        let stateScope = digest(origin + "\nmerchant-a")
        try Keychain.save(Data("invoice-a".utf8), key: namespace + "active-invoice." + stateScope)
        try Keychain.save(Data("terminal-a".utf8), key: namespace + "terminal." + origin + ".merchant-a")
        let invite = MerchantInvite(code: "ABCD-EFGH-JKLM-NPQR", expiresAt: "2033-05-18T03:33:20Z", merchantName: "State test merchant")
        try Keychain.save(JSONEncoder().encode(invite), key: namespace + "merchant-invite." + stateScope)
        var responses = try fixtures(policy: nil)
        let account: [String: Any] = ["id": "merchant-a", "role": "merchant", "verified": false]
        let merchant: [String: Any] = ["id": "merchant-a", "name": "State test merchant", "recipient": "recipient", "confirmedCount": 0, "receivedTotal": "0"]
        responses["/v1/me"] = try JSONSerialization.data(withJSONObject: account)
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: ["account": account, "card": ["linked": false], "payments": [], "merchant": merchant])
        responses["/v1/merchant/setup"] = Data(#"{"name":"State test merchant","status":"ready","message":"Ready"}"#.utf8)
        responses["/v1/terminals/terminal-a"] = Data(#"{"id":"terminal-a","merchantId":"merchant-a","publicKey":"unused-revoked-key","active":false}"#.utf8)
        responses["/v1/invoices/invoice-a"] = Data(#"{"id":"invoice-a","merchantId":"merchant-a","recipient":"recipient","amount":"20","token":"token","chainId":"11155111","expiresAt":"2033-05-18T03:33:20Z","status":"confirmed"}"#.utf8)
        let stableResponses = responses
        StateFixtureProtocol.handler = { request in stableResponses[request.url!.path]! }
        await store.bootstrap()
        XCTAssertEqual(store.invoice?.id, "invoice-a")
        XCTAssertEqual(store.invoice?.status, "confirmed")
        XCTAssertEqual(store.merchantInvite?.code, invite.code)
        XCTAssertFalse(store.terminalEnrolled, "A saved terminal ID cannot override server revocation")
        XCTAssertNil(try Keychain.read(namespace + "terminal." + origin + ".merchant-a"))
    }
}

// Persistence regressions use isolated Keychain namespaces and fixture transport.
extension AppStateTests {
    func testRewardOptInSurvivesNewStoreAndCardSwitch() async throws {
        let first = try store()
        defer { cleanup(first) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await first.bootstrap()
        let edited = SpendingForm(perPayment: "7.25", total: "20", expires: Date(timeIntervalSince1970: 2_000_000_000), merchantIDs: [], useRewards: true, merchantScope: .all)
        try first.saveSpendingForm(edited, cardID: dailyCardID)
        XCTAssertFalse(try first.savedSpendingForm(cardID: travelCardID).useRewards)
        let reopened = AppStore(deployment: BuildConfiguration(apiURL: URL(string: origin)!, webURL: URL(string: origin)!, previousAPIURL: nil), credentialNamespace: namespace, urlSession: session)
        await reopened.bootstrap()
        XCTAssertEqual(try reopened.savedSpendingForm(cardID: dailyCardID), edited)
        XCTAssertFalse(try reopened.savedSpendingForm(cardID: travelCardID).useRewards)
    }
    func testMerchantRewardTogglesSurviveNewStore() async throws {
        let first = try store()
        defer {
            for prefix in ["reward-campaign-draft.", "collectible-campaign-draft."] { try? Keychain.save(nil, key: namespace + prefix + digest(origin + "\nmerchant-a")) }
            cleanup(first)
        }
        var responses = try fixtures(policy: nil)
        let account: [String: Any] = ["id": "merchant-a", "role": "merchant", "verified": false]
        let merchant: [String: Any] = ["id": "merchant-a", "name": "Audit merchant", "recipient": "recipient", "confirmedCount": 0, "receivedTotal": "0"]
        responses["/v1/me"] = try JSONSerialization.data(withJSONObject: account)
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: ["account": account, "card": ["linked": false], "payments": [], "merchant": merchant])
        responses["/v1/merchant/setup"] = Data(#"{"name":"Audit merchant","status":"ready","message":"Ready"}"#.utf8)
        let fixed = responses
        StateFixtureProtocol.handler = { fixed[$0.url!.path]! }
        await first.bootstrap()
        try first.saveInvoiceDraft(amount: "7.25", description: "draft", useReward: true)
        var percentage = RewardCampaignDraft(); percentage.enabled = true
        try first.saveRewardCampaignDraft(percentage)
        var credit = CollectibleCampaignDraft(); credit.enabled = true
        try first.saveCollectibleCampaignDraft(credit)
        let reopened = AppStore(deployment: BuildConfiguration(apiURL: URL(string: origin)!, webURL: URL(string: origin)!, previousAPIURL: nil), credentialNamespace: namespace, urlSession: session)
        await reopened.bootstrap()
        XCTAssertTrue(try reopened.savedInvoiceDraft().useReward)
        XCTAssertTrue(try reopened.savedRewardCampaignDraft().enabled)
        XCTAssertTrue(try reopened.savedCollectibleCampaignDraft().enabled)
    }
    func testSpendingScreenPreservesSavedMerchantChoice() async throws {
        let first = try store()
        defer { cleanup(first) }
        let responses = try separateWalletFixtures()
        StateFixtureProtocol.handler = { responses[$0.url!.path]! }
        await first.bootstrap()
        let restored = try first.savedSpendingForm(cardID: dailyCardID)
        XCTAssertEqual(restored.merchantScope, .selected)
        // Exercise the same restore path used on screen entry and policy refresh.
        let displayed = try PolicyView.restoredForm(from: first, cardID: dailyCardID)
        XCTAssertEqual(displayed.merchantScope, restored.merchantScope, "Opening the screen silently changes the displayed merchant scope")
        XCTAssertEqual(displayed.merchantIDs, restored.merchantIDs)
        var edited = displayed
        edited.perPayment = "7"
        edited.useRewards = true
        try first.saveSpendingForm(edited, cardID: dailyCardID)
        await first.resumePermission(cardID: dailyCardID)
        XCTAssertEqual(try PolicyView.restoredForm(from: first, cardID: dailyCardID), edited, "Refreshing must also preserve the selected-merchant draft")
        let allMerchants = edited.editingAllMerchants(pending: false)
        try first.saveSpendingForm(allMerchants, cardID: dailyCardID)
        XCTAssertEqual(try PolicyView.restoredForm(from: first, cardID: dailyCardID), allMerchants, "An explicit change to all merchants must survive reopening")
    }
}


extension AppStateTests {
    func testRewardChoiceAfterCancelSurvivesFailedRefresh() async throws {
        let first = try store()
        defer { cleanup(first) }
        var responses = try fixtures(policy: nil)
        let account: [String: Any] = ["id": "merchant-a", "role": "merchant", "verified": false]
        let merchant: [String: Any] = ["id": "merchant-a", "name": "Audit merchant", "recipient": "recipient", "confirmedCount": 0, "receivedTotal": "0"]
        responses["/v1/me"] = try JSONSerialization.data(withJSONObject: account)
        responses["/v1/dashboard"] = try JSONSerialization.data(withJSONObject: ["account": account, "card": ["linked": false], "payments": [], "merchant": merchant])
        responses["/v1/merchant/setup"] = Data(#"{"name":"Audit merchant","status":"ready","message":"Ready"}"#.utf8)
        responses["/v1/config"] = Data(#"{"chainId":"11155111","token":{"address":"token","symbol":"MJPY","decimals":0},"capabilities":{"payments":true,"world":true,"rewards":true}}"#.utf8)
        responses["/v1/invoices"] = Data(#"{"id":"invoice-a","merchantId":"merchant-a","recipient":"recipient","amount":"20","token":"token","chainId":"11155111","expiresAt":"2033-05-18T03:33:20Z","status":"awaiting_tap"}"#.utf8)
        let fixed = responses
        StateFixtureProtocol.handler = { fixed[$0.url!.path]! }
        await first.bootstrap()
        await first.createInvoice(amount: "20", description: "old", useReward: false)
        XCTAssertEqual(first.invoice?.status, "awaiting_tap")
        let originalDraft = try first.savedInvoiceDraft()
        XCTAssertNotNil(originalDraft.requestID)
        StateFixtureProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        await first.cancelInvoice()
        XCTAssertEqual(first.invoice?.status, "awaiting_tap", "An unconfirmed cancellation must retain the active request")
        XCTAssertEqual(try first.savedInvoiceDraft(), originalDraft)
        StateFixtureProtocol.handler = { request in
            if request.url!.path == "/v1/invoices/invoice-a/cancel" { return Data("{}".utf8) }
            throw URLError(.notConnectedToInternet)
        }
        await first.cancelInvoice()
        XCTAssertEqual(first.invoice?.status, "cancelled")
        XCTAssertFalse(first.invoiceRequestPending)
        XCTAssertNil(try first.savedInvoiceDraft().requestID)
        XCTAssertNil(try Keychain.read(namespace + "active-invoice." + digest(origin + "\nmerchant-a")))
        XCTAssertEqual(try first.savedInvoiceDraft().amount, originalDraft.amount)
        // MerchantView enables editing when isFinished is true; saveDraft uses this method.
        try first.saveInvoiceDraft(amount: "30", description: "next", useReward: true)
        let reopened = try first.savedInvoiceDraft()
        XCTAssertTrue(reopened.useReward, "Leaving and returning must restore the newly selected reward option")
        XCTAssertEqual(reopened.amount, "30", "Newly edited amount must not silently revert")
        XCTAssertEqual(reopened.description, "next")
        StateFixtureProtocol.handler = { fixed[$0.url!.path]! }
        let relaunched = AppStore(deployment: BuildConfiguration(apiURL: URL(string: origin)!, webURL: URL(string: origin)!, previousAPIURL: nil), credentialNamespace: namespace, urlSession: session)
        await relaunched.bootstrap()
        XCTAssertEqual(try relaunched.savedInvoiceDraft(), reopened, "A new app store must keep the edited draft without replaying the cancelled invoice")
    }
}
