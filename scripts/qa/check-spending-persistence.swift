import Foundation

@main enum SpendingPersistenceCheck {
    static func main() throws {
        let form = SpendingForm(perPayment: "7.25", total: "20", expires: Date(timeIntervalSince1970: 2_000_000_000), merchantIDs: ["TEST"])
        // A new screen/process reads the serialized input, rather than retaining the original instance.
        let stored = try JSONEncoder().encode(form)
        let reopened = SpendingForm.restored(draft: try JSONDecoder().decode(SpendingForm.self, from: stored), pending: nil, policy: nil, decimals: 18)
        guard reopened == form else {
            fputs("FAIL: reopening Spending permission loses edited limits, merchant selection, or expiry.\n", stderr)
            exit(1)
        }
        print("PASS: edited spending input survives reconstruction from storage")
        let policy = try JSONDecoder().decode(Policy.self, from: Data(#"{"enabled":true,"perPaymentLimit":"7250000000000000000","totalLimit":"20000000000000000000","spent":"0","expiresAt":"2033-05-18T03:33:20Z","merchantIds":["TEST"]}"#.utf8))
        let saved = SpendingForm.restored(draft: nil, pending: nil, policy: policy, decimals: 18)
        precondition(saved == form, "Existing server permission must restore limits, expiry, and merchants")
        print("PASS: confirmed server permission restores every editable field")
        precondition(form.isEnabled(in: policy, decimals: 18, now: Date(timeIntervalSince1970: 1_900_000_000)))
        var changed = form
        changed.merchantIDs.insert("another-merchant")
        precondition(!changed.isEnabled(in: policy, decimals: 18))
        var frozen = policy
        frozen.enabled = false
        precondition(!form.isEnabled(in: frozen, decimals: 18))
        precondition(!form.isEnabled(in: policy, decimals: 18, now: Date(timeIntervalSince1970: 2_000_000_001)))
        print("PASS: saved permission is enabled; changed, frozen and expired settings are not")
        let partial = SpendingForm(perPayment: "0.", total: "", expires: form.expires, merchantIDs: [])
        let partialData = try JSONEncoder().encode(partial)
        let partialReloaded = try JSONDecoder().decode(SpendingForm.self, from: partialData)
        precondition(SpendingForm.restored(draft: partialReloaded, pending: nil, policy: policy, decimals: 18) == partial)
        precondition(SpendingForm.restored(draft: partial, pending: form, policy: policy, decimals: 18) == form)
        print("PASS: incomplete edits survive; in-flight approval terms take precedence")
        let fields = try JSONSerialization.jsonObject(with: stored) as! [String: Any]
        precondition(fields["consent"] == nil && fields["enabled"] == nil && fields["authorized"] == nil)
        print("PASS: saved input contains no payment authorization")
    }
}
