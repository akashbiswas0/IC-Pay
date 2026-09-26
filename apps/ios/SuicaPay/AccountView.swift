import SwiftUI

struct AccountView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        List {
            if store.isMerchant {
                Section("Merchant account") {
                    Text(store.dashboard?.merchant?.name ?? "Merchant").font(.headline)
                    Label(store.terminalEnrolled ? "Ready to collect" : "Activation required", systemImage: store.terminalEnrolled ? "checkmark.circle" : "iphone")
                    if !store.terminalEnrolled { AsyncAction("Activate this iPhone", loadingTitle: "Activating iPhone…", systemImage: "iphone") { await store.enrollTerminal() }.disabled(store.busy) }
                    NavigationLink("Get invite code") { MerchantInviteView() }
                }
            } else if store.account?.role == "customer" {
                Section {
                    if let cards = store.dashboard?.cards {
                        ForEach(cards) { card in
                            NavigationLink { CardDetailView(cardID: card.id) } label: {
                                AccountCardRow(card: card, usesSuicaArtwork: card.id == cards.first?.id)
                            }
                        }
                        if cards.isEmpty { StatusMessage(title: "No linked cards", systemImage: "creditcard") }
                    } else if let card = store.dashboard?.card {
                        LabeledContent("Linked card", value: card.linked ? "•••• \(card.last4 ?? "")" : "No linked card")
                    } else if store.isRefreshing {
                        LoadingPlaceholder(label: "Loading linked card", rows: 1)
                    } else {
                        StatusMessage(title: "Card details unavailable", detail: "Pull to refresh.", systemImage: "wifi.exclamationmark")
                    }
                    AsyncAction("Add IC card", loadingTitle: "Reading your card…", systemImage: "plus.circle") {
                        await store.beginEnrollment(intent: .addition)
                    }.disabled(store.busy || store.verificationID != nil || !store.supportsMultipleCards || store.config?.capabilities.world != true || !CardReader.available)
                    if !store.supportsMultipleCards {
                        Text("Card management needs a service update.").font(.footnote)
                    } else if !CardReader.available {
                        Text("Adding a card requires an NFC-enabled iPhone.").font(.footnote)
                    } else if store.config?.capabilities.world != true {
                        Text("Card verification is unavailable. Try again later.").font(.footnote)
                    }
                } header: { Text("Cards") }
                  footer: { Text("Each card has its own crypto wallet and spending limits.").foregroundStyle(Color.primary.opacity(0.75)) }
                Section("Payments") {
                    NavigationLink { CardSpendingListView() } label: { Label("Spending permission", systemImage: "slider.horizontal.3") }.disabled(!store.paymentsAvailable)
                    if !store.paymentsAvailable { Text("Payment setup required.").font(.footnote) }
                }
            }
            if store.account?.role == "admin", !store.isMerchant {
                Section("Account") { Label("Signed in", systemImage: "checkmark.shield") }
            }
            if store.verificationID != nil {
                Section("World verification") { WorldVerificationControls() }
            }
            Section("Devices") {
                NavigationLink { ApproveDeviceView(initialCode: "") } label: { Label("Connect another device", systemImage: "laptopcomputer.and.iphone") }
            }
            Section {
                AccountSignOutRow()
            } footer: {
                Text("IC Pay · Test tokens only. Separate from your transit balance.")
            }
            Section { NoticeView() }
        }.navigationTitle("Account")
            .refreshable { await store.run { try await store.refresh() } }
    }
}

struct AccountCardRow: View {
    let card: LinkedCard
    let usesSuicaArtwork: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Image(usesSuicaArtwork ? "SuicaCardArtwork" : "ICCardArtwork")
                .resizable().scaledToFit().frame(width: 48).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(card.nickname).font(.body)
                Text("•••• \(card.last4) · \(card.isFrozen ? "Frozen" : "Active")")
                    .font(.subheadline).foregroundStyle(Color.primary.opacity(0.7))
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4).accessibilityElement(children: .combine)
    }
}

private struct AccountSignOutRow: View {
    @Environment(AppStore.self) private var store
    @State private var confirming = false
    var body: some View {
        Button("Sign out", role: .destructive) { confirming = true }
            .frame(minHeight: 44).disabled(store.busy)
            .accessibilityIdentifier("account.signOut")
            .confirmationDialog("Sign out of this iPhone?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await store.signOut() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your spending permission stays active.")
            }
    }
}

struct CardSpendingListView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        List {
            if let cards = store.dashboard?.cards {
                if cards.isEmpty {
                    ContentUnavailableView("No linked IC cards", systemImage: "creditcard")
                    NavigationLink { AccountView() } label: { Label("Add IC card", systemImage: "plus.circle") }
                } else {
                    ForEach(cards) { card in
                        NavigationLink { PolicyView(cardID: card.id) } label: { CardContextRow(card: card) }
                    }
                }
            } else if store.isRefreshing {
                LoadingPlaceholder(label: "Loading your cards", rows: 2)
            } else {
                StatusMessage(title: "Cards unavailable", detail: "Pull to refresh.", systemImage: "wifi.exclamationmark")
            }
        }.navigationTitle("Choose card").navigationBarTitleDisplayMode(.inline)
            .modifier(AccountRefreshActions(refreshFunding: false))
    }
}

struct CardDetailView: View {
    let cardID: String
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var nickname = ""
    @State private var confirmRemoval = false
    @State private var confirmReplacement = false
    @State private var actionProgress: String?
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    private var cleanName: String { nickname.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        Form {
            if let card {
                Section {
                    CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id)
                }.listRowBackground(Color.clear)
                Section("Card name") {
                    LabeledContent("Name") {
                        TextField("Card name", text: $nickname).textInputAutocapitalization(.words)
                            .multilineTextAlignment(.trailing)
                            .accessibilityIdentifier("card.nickname")
                            .disabled(store.busy)
                    }
                    AsyncAction("Save name", loadingTitle: "Saving…") { await store.updateCard(id: card.id, nickname: cleanName) }
                        .disabled(store.busy || cleanName.isEmpty || cleanName.count > 32 || cleanName == card.nickname)
                    if cleanName.count > 32 { Text("Use 32 characters or fewer.").font(.footnote) }
                }
                Section {
                    AsyncAction(card.isFrozen ? "Unfreeze card" : "Freeze card", loadingTitle: card.isFrozen ? "Unfreezing…" : "Freezing…", systemImage: card.isFrozen ? "play.circle" : "pause.circle") {
                        await store.updateCard(id: card.id, frozen: !card.isFrozen)
                    }.disabled(store.busy)
                } footer: { Text("Freezing stops new taps. World recovery remains available. Submitted payments may still complete.").foregroundStyle(Color.primary.opacity(0.75)) }
                Section("Card management") {
                    Button("Replace card") { confirmReplacement = true }
                        .frame(minHeight: 44).disabled(store.busy || store.verificationID != nil || !CardReader.available || store.config?.capabilities.world != true)
                    Button("Remove card", role: .destructive) { confirmRemoval = true }
                        .frame(minHeight: 44).disabled(store.busy)
                    if let actionProgress { ProgressStatus(title: actionProgress) }
                }
                Section { NoticeView() }
            } else {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            }
        }
        .navigationTitle("Manage card").navigationBarTitleDisplayMode(.inline)
        .modifier(FormKeyboardActions())
        .sensoryFeedback(.warning, trigger: confirmRemoval) { _, shown in shown }
        .sensoryFeedback(.warning, trigger: confirmReplacement) { _, shown in shown }
        .task { nickname = card?.nickname ?? "" }
        .onChange(of: card?.id) { _, id in if id == nil { dismiss() } }
        .confirmationDialog("Remove this IC card?", isPresented: $confirmRemoval, titleVisibility: .visible) {
            Button("Remove card", role: .destructive) {
                actionProgress = "Removing card…"
                Task { await store.removeCard(id: cardID); actionProgress = nil; if store.error == nil { dismiss() } }
            }
            Button("Keep card", role: .cancel) {}
        } message: {
            Text(store.dashboard?.cards?.count == 1
                ? "This card’s wallet is preserved. Link the same card again to restore it. Keep this card and access to World, or another signed-in device, for recovery. Submitted payments may still complete."
                : "This card’s wallet is preserved. Link the same card again to restore it. Your other cards stay unchanged. Submitted payments may still complete.")
        }
        .confirmationDialog("Replace this IC card?", isPresented: $confirmReplacement, titleVisibility: .visible) {
            Button("Scan replacement") {
                actionProgress = "Reading replacement…"
                Task {
                    await store.beginEnrollment(intent: .replacement(cardID))
                    actionProgress = nil
                    if store.verificationID != nil { dismiss() }
                }
            }
            Button("Keep card", role: .cancel) {}
        } message: {
            Text("Verify the new card with World. Its wallet stays with the replacement card. Review this card’s spending permission to resume taps.")
        }
    }
}

/// Keep session controls reachable above long forms and the floating tab bar.
struct AccountSessionActions: ViewModifier {
    @Environment(AppStore.self) private var store
    @State private var signingOut = false
    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { signingOut = true }
                        .disabled(store.busy)
                        .accessibilityIdentifier("account.signOut")
                }
            }
            .confirmationDialog("Sign out of this iPhone?", isPresented: $signingOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await store.signOut() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your spending permission stays active.")
            }
    }
}
struct ApproveDeviceView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var code: String
    init(initialCode: String) { _code = State(initialValue: initialCode) }
    var body: some View {
        Form {
            Section {
                Text("Enter the code from your other device to grant account access.")
                TextField("XXXX-XXXX", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled().textContentType(.oneTimeCode).font(.title3.monospaced())
                AsyncAction("Approve this device", loadingTitle: "Approving device…", prominent: true) {
                    await store.approveDevice(code: code); if store.error == nil { dismiss() }
                }.disabled(code.replacingOccurrences(of: "-", with: "").count != 8 || store.busy)
            }
            Section { Text("Only approve your own devices. Never enter a code sent by someone else.").font(.footnote); NoticeView() }
        }.navigationTitle("Connect another device").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(store.busy) } }
    }
}
