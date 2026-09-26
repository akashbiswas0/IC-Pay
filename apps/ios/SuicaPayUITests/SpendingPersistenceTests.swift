import XCTest

/// Run on a signed-in test iPhone. Edits a draft only; never authorizes payments.
final class SpendingPersistenceTests: XCTestCase {
    @MainActor func testDraftSurvivesNavigationAndRelaunch() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let account = app.tabBars.buttons["Account"]
        XCTAssertTrue(account.waitForExistence(timeout: 30), "Sign in with the test customer before running this device regression.")
        account.tap()
        app.buttons["Spending permission"].tap()
        let perPayment = app.textFields["spending.perPayment"]
        XCTAssertTrue(perPayment.waitForExistence(timeout: 15))
        perPayment.tap()
        if let old = perPayment.value as? String, old != "0" {
            perPayment.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        perPayment.typeText("7.25")
        let total = app.textFields["spending.total"]
        total.tap()
        if let old = total.value as? String, old != "0" {
            total.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count))
        }
        total.typeText("20")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["Spending permission"].tap()
        XCTAssertEqual(perPayment.value as? String, "7.25", "Leaving Spending permission must preserve the edited limit.")
        XCTAssertEqual(total.value as? String, "20")
        app.terminate()
        app.launch()
        XCTAssertTrue(account.waitForExistence(timeout: 30))
        account.tap()
        app.buttons["Spending permission"].tap()
        XCTAssertTrue(perPayment.waitForExistence(timeout: 15))
        XCTAssertEqual(perPayment.value as? String, "7.25", "A fresh app process must restore the saved draft.")
        XCTAssertEqual(total.value as? String, "20")
    }
}
