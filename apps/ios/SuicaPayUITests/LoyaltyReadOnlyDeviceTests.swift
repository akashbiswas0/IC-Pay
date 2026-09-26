import XCTest

/// Uses the real installed account, bundled HTTPS backend and actual device Keychain.
/// Only navigation and read-only refreshes are performed; no launch fixtures or network stubs.
final class LoyaltyReadOnlyDeviceTests: XCTestCase {
    @MainActor func testLivePointsAndEarlierCollection() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        defer { capture(app, name: "final-device-state") }
        XCTAssertTrue(app.tabBars.buttons["Account"].waitForExistence(timeout: 45), "Unlock the signed-in customer or merchant phone. This smoke test never creates an account.")
        capture(app, name: "signed-in-home")
        if app.tabBars.buttons["Collect"].exists {
            app.tabBars.buttons["Collect"].tap()
            try tapLink("Shop points", in: app)
            XCTAssertTrue(app.navigationBars["Shop points"].waitForExistence(timeout: 15))
            XCTAssertTrue(app.staticTexts["loyalty.program.state"].waitForExistence(timeout: 45), "The real merchant program must finish loading.")
            assertNoReadFailure(app)
            capture(app, name: "merchant-points-program")
            try tapLink("Customize offer", in: app)
            XCTAssertTrue(app.textFields.matching(NSPredicate(format: "label CONTAINS[c] %@", "Points earned per purchase")).firstMatch.exists)
            capture(app, name: "merchant-points-terms")
            // Disclosure/navigation only: do not touch any switch, field or submit button.
            try tapLink("Earlier IC Voucher offers", in: app)
            try tapLink("Manage earlier offers", in: app)
            XCTAssertTrue(app.navigationBars["Earlier IC Voucher offer"].waitForExistence(timeout: 15))
            XCTAssertTrue(app.switches["Enable purchase rewards"].waitForExistence(timeout: 20))
            capture(app, name: "merchant-earlier-voucher-offer")
        } else {
            app.tabBars.buttons["Wallet"].tap()
            try tapLink("Points for this card", in: app)
            XCTAssertTrue(app.navigationBars["Shop points"].waitForExistence(timeout: 15))
            let loaded = NSPredicate { _, _ in
                app.staticTexts["loyalty.available"].exists || app.staticTexts["No shop points yet"].exists
            }
            let expectation = XCTNSPredicateExpectation(predicate: loaded, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 45), .completed, "The live points API must return a real balance or a confirmed empty ledger.")
            assertNoReadFailure(app)
            capture(app, name: "customer-shop-points")
            try tapLink("IC Voucher collection", in: app)
            XCTAssertTrue(app.navigationBars["IC Voucher"].waitForExistence(timeout: 15))
            // This route loads the actual existing collectibles; none are seeded by this test.
            let loadedCollection = NSPredicate { _, _ in
                !app.staticTexts["Loading IC Vouchers"].exists &&
                (app.staticTexts["Your IC Voucher collection"].exists ||
                 app.staticTexts["Available to use"].exists || app.staticTexts["IC Voucher collection"].exists || app.staticTexts["Previous IC Vouchers"].exists)
            }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: loadedCollection, object: nil)], timeout: 45), .completed)
            capture(app, name: "customer-existing-collection")
        }
    }
    @MainActor private func tapLink(_ label: String, in app: XCUIApplication) throws {
        let target = app.buttons[label].firstMatch
        for _ in 0..<7 {
            if target.exists && target.isHittable { target.tap(); return }
            app.swipeUp()
        }
        capture(app, name: "missing-navigation-" + label)
        XCTFail("Read-only navigation is unavailable: \(label). A pending sale or setup state may need user attention.")
        throw NavigationUnavailable()
    }
    @MainActor private func assertNoReadFailure(_ app: XCUIApplication) {
        let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@ OR label CONTAINS[c] %@", "Couldn’t load", "unavailable", "setup pending")).firstMatch
        XCTAssertFalse(failure.exists, "The live service did not provide a usable read.")
    }
    @MainActor private func capture(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = name + "-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }
    private struct NavigationUnavailable: Error {}
}
