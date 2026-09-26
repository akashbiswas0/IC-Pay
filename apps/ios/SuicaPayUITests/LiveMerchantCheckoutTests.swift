import XCTest

/// Explicitly opt-in, real Sepolia checkout. Never uses card fixtures or direct payment API calls.
/// Inject SUICA_LIVE_CHECKOUT=earn100 or use20 into this test runner's EnvironmentVariables.
/// Run ONLY this test after the operator confirms the customer's permission and physical-card readiness.
final class LiveMerchantCheckoutTests: XCTestCase {
    @MainActor func testFinishAlreadyApprovedPermission() async throws {
        guard ProcessInfo.processInfo.environment["SUICA_FINISH_APPROVED_PERMISSION"] == "true" else {
            throw XCTSkip("Finalizing a user-approved permission requires an explicit opt-in.")
        }
        continueAfterFailure = false
        try await requireLiveSepoliaConfiguration()
        let app = XCUIApplication()
        app.launch()
        defer { capture(app, name: "customer-approved-permission-final", hierarchy: true) }
        XCTAssertTrue(app.tabBars.buttons["Wallet"].waitForExistence(timeout: 45))
        XCTAssertFalse(app.tabBars.buttons["Collect"].exists)
        app.tabBars.buttons["Wallet"].tap()
        try tap(app.buttons["Points for this card"], app: app)
        try tap(app.buttons["Choose how points are used"], app: app)
        XCTAssertTrue(app.navigationBars["Spending permission"].waitForExistence(timeout: 15))
        // Only complete an already-authorized, already-confirmed pending approval.
        // Do not edit a field or toggle fresh consent.
        for _ in 0..<9 {
            if app.staticTexts["Tap payments enabled"].exists { return }
            let save = app.buttons["Save spending settings"]
            if save.exists && save.isHittable {
                XCTAssertTrue(app.staticTexts["Wallet approval confirmed"].exists)
                capture(app, name: "customer-already-approved-terms", hierarchy: true)
                save.tap()
                XCTAssertTrue(app.staticTexts["Tap payments enabled"].waitForExistence(timeout: 45))
                return
            }
            app.swipeUp()
        }
        XCTFail("No already-confirmed permission is ready to save; no new authorization was made.")
    }
    private enum Mode: String {
        case earn100, use20
        var amount: String { self == .earn100 ? "100" : "20" }
        var usePoints: Bool { self == .use20 }
    }
    @MainActor func testUserAssistedPhysicalSuicaCheckout() async throws {
        guard let raw = ProcessInfo.processInfo.environment["SUICA_LIVE_CHECKOUT"], let mode = Mode(rawValue: raw) else {
            throw XCTSkip("Real-money-path test disabled. Explicitly set SUICA_LIVE_CHECKOUT=earn100 or use20 for the approved Sepolia test-token purchase.")
        }
        continueAfterFailure = false
        try await requireLiveSepoliaConfiguration()
        let app = XCUIApplication()
        app.launch()
        defer { capture(app, name: "checkout-final-" + mode.rawValue, hierarchy: true) }
        let collectTab = app.tabBars.buttons["Collect"]
        XCTAssertTrue(collectTab.waitForExistence(timeout: 45), "This must be the already signed-in, enrolled merchant iPhone.")
        collectTab.tap()
        XCTAssertFalse(app.buttons["Activate this iPhone"].exists, "The merchant terminal must already be enrolled.")
        XCTAssertFalse(app.buttons["Recover payment"].exists, "An ambiguous older request must be recovered by the user first.")
        for title in ["Ready to collect", "Processing payment", "Checking payment"] {
            XCTAssertFalse(app.staticTexts[title].exists, "Unexpected unfinished invoice: \(title). This test never cancels or replaces it.")
        }
        if app.buttons["New payment"].exists {
            // This button is exposed by the app only for server-terminal invoice states.
            try tap(app.buttons["New payment"], app: app)
        }
        let amount = app.textFields["merchant.amount"]
        XCTAssertTrue(amount.waitForExistence(timeout: 15), "A fresh, editable payment form is required.")
        XCTAssertTrue(amount.isEnabled)
        // A stale earlier-voucher selection must not silently change the intended payment system.
        let points = app.switches["Use available points"]
        XCTAssertTrue(points.waitForExistence(timeout: 10), "Select the Points payment type manually before running this test.")
        XCTAssertTrue(points.isEnabled)
        let existing = try XCTUnwrap(points.value as? String)
        XCTAssertTrue(["0", "1"].contains(existing), "Unexpected switch representation; refusing to guess.")
        capture(app, name: "merchant-points-switch-before-" + mode.rawValue, hierarchy: true)
        if (existing == "1") != mode.usePoints {
            // SwiftUI exposes the entire labelled row as the switch. Use its
            // actual accessibility frame to tap the trailing native control.
            points.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
        }
        let expectedValue = mode.usePoints ? "1" : "0"
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expectedValue), object: points)
        let changedResult = XCTWaiter.wait(for: [changed], timeout: 5)
        capture(app, name: "merchant-points-switch-after-" + mode.rawValue, hierarchy: true)
        XCTAssertEqual(changedResult, .completed, "Point use did not reach the explicitly requested state.")
        // The amount is right-aligned. A center tap can place the caret before
        // existing digits, so move it to the trailing end before deleting.
        amount.coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.5)).tap()
        if let old = amount.value as? String, old != "0", !old.isEmpty {
            amount.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        capture(app, name: "merchant-amount-cleared-" + mode.rawValue, hierarchy: true)
        XCTAssertTrue(["", "0"].contains(amount.value as? String ?? "invalid"), "The old amount was not cleared; no invoice was created.")
        amount.typeText(mode.amount)
        XCTAssertEqual(amount.value as? String, mode.amount)
        if app.toolbars.buttons["Done"].exists { app.toolbars.buttons["Done"].tap() }
        capture(app, name: "merchant-terms-" + mode.rawValue, hierarchy: true)
        try tap(app.buttons["Create payment"], app: app)
        XCTAssertTrue(app.staticTexts["Ready to collect"].waitForExistence(timeout: 45), "Creation must return a new awaiting-tap invoice; no automatic retry after an uncertain result.")
        XCTAssertTrue(app.staticTexts[mode.amount + " MJPY"].exists, "The awaiting-tap gross must match the approved amount.")
        XCTAssertFalse(app.staticTexts["Paid"].exists)
        capture(app, name: "invoice-awaiting-physical-card-" + mode.rawValue, hierarchy: true)
        XCTContext.runActivity(named: "USER ACTION: hold the physical Suica at the top of the merchant iPhone when its NFC sheet appears") { _ in }
        try tap(app.buttons["Collect payment"], app: app)
        capture(app, name: "native-NFC-request-" + mode.rawValue, hierarchy: true)
        XCTAssertTrue(app.staticTexts["Paid"].waitForExistence(timeout: 180), "Payment did not become Paid within 180 seconds. Do not retap or create another invoice until the real backend state is checked.")
        XCTAssertTrue(app.buttons["New payment"].exists)
        capture(app, name: "confirmed-paid-" + mode.rawValue, hierarchy: true)
    }
    private func requireLiveSepoliaConfiguration() async throws {
        // This is the same fixed production API origin bundled into the signed app, not a test server.
        let url = URL(string: "https://main.d21bivg674x6ke.amplifyapp.com/v1/config")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let config = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(config["chainId"] as? String, "11155111", "Only Ethereum Sepolia is authorized by this smoke test.")
        let token = try XCTUnwrap(config["token"] as? [String: Any])
        XCTAssertEqual(token["symbol"] as? String, "MJPY")
        let capabilities = try XCTUnwrap(config["capabilities"] as? [String: Any])
        XCTAssertEqual(capabilities["payments"] as? Bool, true)
        XCTAssertEqual(capabilities["loyalty"] as? Bool, true)
        let router = try XCTUnwrap(config["paymentRouter"] as? [String: Any])
        XCTAssertEqual(router["kind"] as? String, "loyalty")
    }
    @MainActor private func tap(_ element: XCUIElement, app: XCUIApplication) throws {
        for _ in 0..<5 {
            if element.exists && element.isHittable {
                XCTAssertTrue(element.isEnabled)
                element.tap()
                return
            }
            app.swipeUp()
        }
        XCTFail("Expected checkout control is not available. Refusing an alternative action.")
        throw CheckoutControlUnavailable()
    }
    @MainActor private func capture(_ app: XCUIApplication, name: String, hierarchy: Bool) {
        let screen = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screen.name = name; screen.lifetime = .keepAlways; add(screen)
        if hierarchy {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
        }
    }
    private struct CheckoutControlUnavailable: Error {}
}
