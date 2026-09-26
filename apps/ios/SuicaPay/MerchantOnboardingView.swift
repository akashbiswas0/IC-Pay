import SwiftUI

struct MerchantSignupView: View {
    @Environment(AppStore.self) private var store
    @State private var name = ""
    @State private var resuming = false
    var body: some View {
        Form {
            Section("Your business") {
                LabeledContent("Name") {
                    TextField("Business name", text: $name).textContentType(.organizationName)
                        .multilineTextAlignment(.trailing).accessibilityLabel("Business name")
                        .disabled(resuming || store.busy)
                }
                AsyncAction(resuming ? "Continue setup" : "Create merchant account", loadingTitle: "Preparing your account…", prominent: true) {
                    await store.registerMerchant(name: name)
                    if let draft = try? store.pendingMerchantSignup() { name = draft.name; resuming = true }
                }.disabled(store.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.paymentsAvailable)
            }
            Section {
                Text("Test tokens only.").font(.footnote)
                NoticeView()
            }
        }.navigationTitle("New merchant").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
            .task {
                do {
                    if let draft = try store.pendingMerchantSignup() { name = draft.name; resuming = true }
                } catch { store.error = error.localizedDescription }
            }
    }
}

struct MerchantSetupView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        Form {
            if store.merchantSetup?.ready == true {
                MerchantActivationSections()
            } else {
                Section(store.merchantSetup?.name ?? "Your business") {
                    if store.merchantSetup?.status != "needs_attention" {
                        ProgressStatus(title: "Setting up your account")
                    } else {
                        StatusMessage(title: "Setup needs attention", detail: store.merchantSetup?.message, systemImage: "exclamationmark.circle")
                    }
                    AsyncAction("Check progress", loadingTitle: "Checking setup…", systemImage: "arrow.clockwise") { await store.refreshMerchantSetup() }.disabled(store.busy)
                }
            }
            Section { NoticeView() }
        }.navigationTitle("Merchant setup").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
            .modifier(AccountSessionActions())
            .task {
                while !Task.isCancelled, store.account?.role == "merchant", store.merchantSetup?.ready != true {
                    try? await Task.sleep(for: .seconds(5))
                    if !Task.isCancelled && !store.busy { await store.refreshMerchantSetup() }
                }
            }
    }
}

struct MerchantActivationSections: View {
    @Environment(AppStore.self) private var store
    @State private var code = ""
    var body: some View {
        Section {
            Label("Activate this iPhone", systemImage: "iphone").font(.headline)
            AsyncAction("Get invite code", loadingTitle: "Creating invite…", systemImage: "ticket") { await store.getMerchantInvite() }.disabled(store.busy)
        } header: {
            Text(store.dashboard?.merchant?.name ?? "Your merchant")
        } footer: {
            Text("Get a code, then copy and paste it below.")
        }
        if let invite = store.merchantInvite {
            Section("Your invite code") {
                Text(invite.code).font(.title2.monospaced().weight(.semibold)).textSelection(.enabled)
                    .accessibilityLabel("Invitation code \(invite.code)")
                CopyCodeButton(code: invite.code)
                if let date = AppDates.date(invite.expiresAt) {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(date > context.date ? "Expires \(date.formatted(date: .omitted, time: .shortened)) · Single use" : "Code expired. Get a new invite code.").font(.footnote)
                    }
                }
            }
        }
        Section("Enter invite code") {
            LabeledContent("Code") {
                TextField("Invite code", text: $code).textInputAutocapitalization(.characters)
                    .autocorrectionDisabled().textContentType(.oneTimeCode)
                    .font(.body.monospaced()).multilineTextAlignment(.trailing)
            }
            PasteButton(payloadType: String.self) { values in
                if let pasted = values.first { code = pasted }
            }
            AsyncAction("Activate merchant account", loadingTitle: "Activating account…", prominent: true) { await store.activateMerchantHere(code: code) }
                .disabled(store.busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .task {
            do { code = try store.savedMerchantActivationCode() }
            catch { store.error = error.localizedDescription }
        }
        .onChange(of: code) { _, value in
            do { try store.saveMerchantActivationCode(value) }
            catch { store.error = error.localizedDescription }
        }
    }
}

struct MerchantInviteView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        Form {
            if store.terminalEnrolled {
                Section { Label("iPhone activated", systemImage: "checkmark.circle") }
            }
            MerchantActivationSections()
            Section { NoticeView() }
        }.navigationTitle("Activate merchant").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
    }
}
