import XCTest
import SwiftUI
@testable import SuicaPay

final class WalletAvailabilityTests: XCTestCase {
    private let address = "0x" + String(repeating: "1", count: 40)
    private func wallet(balance: Any, status: String) throws -> Wallet {
        let data = try JSONSerialization.data(withJSONObject: ["address": address, "balance": balance, "balanceStatus": status, "symbol": "MJPY", "decimals": 18, "chainId": "11155111"])
        return try JSONDecoder().decode(Wallet.self, from: data)
    }
    func testUnavailableBalancePreservesAddressWithoutInventingZero() throws {
        for status in ["pending_setup", "unavailable", "unknown_future_status"] {
            let result = try wallet(balance: NSNull(), status: status)
            XCTAssertEqual(result.address, address)
            XCTAssertNil(result.balance)
            XCTAssertNil(result.displayBalance)
        }
    }
    func testRealReportedZeroRemainsDifferentFromUnavailable() throws {
        let zero = try wallet(balance: "0", status: "available")
        XCTAssertEqual(zero.displayBalance, "0")
        XCTAssertEqual(zero.availability, .available)
        XCTAssertNil(try wallet(balance: NSNull(), status: "available").displayBalance)
        XCTAssertNil(try wallet(balance: "0", status: "pending_setup").displayBalance)
        XCTAssertNil(try wallet(balance: "not-a-balance", status: "available").displayBalance)
    }
    func testReadyCreationResponseRetainsItsAddressIndependentlyOfDashboard() throws {
        let data = try JSONSerialization.data(withJSONObject: ["address": address, "status": "ready"])
        let result = try JSONDecoder().decode(WalletCreationResult.self, from: data)
        XCTAssertEqual(result.readyAddress, address)
        XCTAssertEqual(result.status, "ready")
        let provisioning = try JSONDecoder().decode(WalletCreationResult.self, from: Data(#"{"address":null,"status":"provisioning"}"#.utf8))
        XCTAssertNil(provisioning.readyAddress)
    }
    func testFundingDistinguishesUnavailableReadFromActualEmptyResult() throws {
        let decoder = JSONDecoder()
        for state in ["pending_setup", "unavailable"] {
            let data = try JSONSerialization.data(withJSONObject: ["status": state, "transfers": NSNull()])
            let result = try decoder.decode(FundingHistory.self, from: data)
            XCTAssertNil(result.availableTransfers)
        }
        let empty = try decoder.decode(FundingHistory.self, from: Data(#"{"status":"available","transfers":[]}"#.utf8))
        XCTAssertNotNil(empty.availableTransfers)
        XCTAssertEqual(empty.availableTransfers?.count, 0)
        let missing = try decoder.decode(FundingHistory.self, from: Data(#"{"status":"available","transfers":null}"#.utf8))
        XCTAssertEqual(missing.availability, .unavailable)
    }
}

final class WalletActivityTests: XCTestCase {
    private func payment(id: String, date: String) -> Payment {
        Payment(id: id, merchantName: "Receipt fixture", amount: "500000000000000000000", symbol: "MJPY", decimals: 18, status: "confirmed", createdAt: date, txHash: nil, explorerUrl: nil, errorCode: nil)
    }
    private func transfer(id: String, date: String) -> FundingTransfer {
        FundingTransfer(id: id, from: "0x" + String(repeating: "0", count: 40), amount: "1000000000000000000000", symbol: "MJPY", decimals: 18, createdAt: date, txHash: "0x" + String(repeating: "a", count: 64), explorerUrl: nil, status: "confirmed")
    }
    func testTimelineOrdersActualInstantsAcrossPaymentAndFundingSources() {
        let charge = payment(id: "invoice", date: "2026-09-26T13:00:00+09:00")
        let deposit = transfer(id: "tx:0", date: "2026-09-26T04:30:00.000Z")
        let entries = WalletActivity.timeline(payments: [charge], funding: [deposit])
        XCTAssertEqual(entries.map(\.id), ["funding:tx:0", "payment:invoice"])
        if case .funding(let value) = entries[0] { XCTAssertEqual(TokenAmount.display(value.amount, decimals: value.decimals), "1000") }
        else { XCTFail("Incoming funding must retain its own type, not become a merchant payment") }
    }
    func testDuplicateTransferIsRemovedButSeparateLogsInOneTransactionRemain() {
        let first = transfer(id: "0xABC:0", date: "2026-09-26T04:30:00Z")
        let duplicate = transfer(id: "0xabc:0", date: "2026-09-26T04:30:00Z")
        let secondLog = transfer(id: "0xabc:1", date: "2026-09-26T04:30:00Z")
        let entries = WalletActivity.timeline(payments: [], funding: [first, duplicate, secondLog])
        XCTAssertEqual(entries.map(\.id), ["funding:0xabc:0", "funding:0xabc:1"])
    }
    func testIncompleteTimestampDoesNotDropRealActivityAndEmptySourcesStayEmpty() {
        let unknownDate = transfer(id: "unknown-date", date: "not-a-timestamp")
        let knownDate = payment(id: "receipt", date: "2026-09-26T04:30:00Z")
        XCTAssertEqual(WalletActivity.timeline(payments: [knownDate], funding: [unknownDate]).map(\.id), ["payment:receipt", "funding:unknown-date"])
        XCTAssertTrue(WalletActivity.timeline(payments: [], funding: []).isEmpty)
    }
}

// Exercise the actual SwiftUI carousel inside its grouped list; iOS edge effects
// can obscure artwork even when its layout bounds are correct.
@MainActor final class CarouselEdgeTests: XCTestCase {
    func testHorizontalEdgesStayUnobscuredAfterScrolling() async throws {
        guard #available(iOS 26, *) else { throw XCTSkip("Scroll edge effects were introduced in iOS 26") }
        let url = URL(string: "https://edge-qa.example")!
        let store = AppStore(deployment: BuildConfiguration(apiURL: url, webURL: url, previousAPIURL: nil), credentialNamespace: "edge-qa.")
        let account = Account(id: "fixture", role: "customer", verified: true)
        func card(_ id: String) -> LinkedCard {
            LinkedCard(id: id, nickname: "Suica", last4: id == "first" ? "7E06" : "7D06", status: "active", linkedAt: "", wallet: Wallet(address: "0x1111111111111111111111111111111111111111", balance: "950", balanceStatus: "available", symbol: "MJPY", decimals: 0, chainId: "11155111"), walletStatus: "ready")
        }
        store.account = account
        store.dashboard = Dashboard(account: account, wallet: nil, card: Card(linked: true, last4: "7E06"), policy: nil, cards: [card("first"), card("second")], payments: [], merchant: nil)
        let window = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow })
        let previous = window.rootViewController
        defer { window.rootViewController = previous }
        let host = UIHostingController(rootView: NavigationStack { LinkedCardWalletsView() }.environment(store))
        window.rootViewController = host; window.makeKeyAndVisible()
        try await Task.sleep(for: .seconds(1))
        func findScroll(_ view: UIView) -> UIScrollView? {
            if let scroll = view as? UIScrollView, scroll.contentSize.width > scroll.bounds.width * 1.5 { return scroll }
            return view.subviews.lazy.compactMap { findScroll($0) }.first
        }
        let scroll = try XCTUnwrap(findScroll(host.view))
        for position in [scroll.bounds.width + 16, CGFloat(0)] {
            scroll.setContentOffset(CGPoint(x: position, y: 0), animated: false)
            try await Task.sleep(for: .milliseconds(350))
            XCTAssertTrue(scroll.leftEdgeEffect.isHidden, "The leading edge fade obscures the physical card border after paging")
            XCTAssertTrue(scroll.rightEdgeEffect.isHidden, "The trailing edge must also keep the card border visible")
            XCTAssertEqual(scroll.bounds.height, scroll.bounds.width * 176 / 280, accuracy: 1)
        }
    }
}
