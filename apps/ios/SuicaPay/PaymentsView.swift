import SwiftUI

/// Persistent labels keep amounts understandable after typing; large text stacks.
struct SpendingAmountField: View {
    let title: String
    @Binding var amount: String
    let symbol: String
    var identifier: String = ""
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Text(title).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                TextField("0", text: $amount).keyboardType(.decimalPad)
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
                    .monospacedDigit()
                    .accessibilityLabel(title + " in " + symbol)
                    .accessibilityIdentifier(identifier)
                Text(symbol).font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize().accessibilityHidden(true)
            }
        }.padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 4 : 0)
    }
}

struct PolicyView: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    @State private var form = SpendingForm()
    @State private var formLoaded = false
    @State private var consent = false
    @State private var hasEdits = false
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    private var cardMissing: Bool { cardID != nil && card == nil }
    private var canConfigure: Bool { !cardMissing && store.paymentsAvailable && (cardID == nil || card?.walletStatus == "ready") }
    private var savedAndEnabled: Bool { store.paymentsEnabled(form: form, cardID: cardID) }
    var body: some View {
        Form {
            if cardMissing {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            } else {
                if let card {
                    Section { CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id) }
                        .listRowBackground(Color.clear)
                }
                if !canConfigure {
                    Section { Label("Payments unavailable", systemImage: "clock") }
                }
                if let policy = store.policy(for: cardID) {
                    Section {
                        LabeledContent("Tap payments", value: permissionStatus(policy))
                        DisclosureGroup("Saved permission") {
                            LabeledContent("Merchants", value: policy.effectiveMerchantScope == .all ? "All participating" : "Selected only")
                            if let date = AppDates.date(policy.expiresAt) { LabeledContent("Expires", value: date.formatted(date: .abbreviated, time: .shortened)) }
                        }
                        if policy.enabled { AsyncAction("Freeze payments", loadingTitle: "Freezing payments…", systemImage: "pause.circle", role: .destructive) { await store.freeze(cardID: cardID) }.disabled(store.busy) }
                    }
                }
                Section {
                    SpendingAmountField(title: "Per payment", amount: input(\.perPayment), symbol: store.config?.token.symbol ?? "tokens", identifier: "spending.perPayment")
                    SpendingAmountField(title: "Total limit", amount: input(\.total), symbol: store.config?.token.symbol ?? "tokens", identifier: "spending.total")
                    DatePicker("Valid until", selection: input(\.expires))
                } header: {
                    Text("Spending limits")
                } footer: {
                    Text("Per-payment limits apply before discounts. The total counts tokens actually charged.")
                }.disabled(!formLoaded || store.busy || store.preparingPermission(for: cardID) || !canConfigure)
                Section {
                    Label(form.merchantScope == .selected ? "Selected merchants only" : "All participating merchants", systemImage: "storefront")
                    if form.merchantScope == .selected {
                        Button("Use all participating merchants") {
                            edit { $0 = $0.editingAllMerchants(pending: false) }
                        }.disabled(!formLoaded || store.busy || store.preparingPermission(for: cardID) || !canConfigure)
                    }
                } header: {
                    Text("Where you can pay")
                } footer: {
                    if form.merchantScope == .selected {
                        Text(store.preparingPermission(for: cardID)
                            ? "This pending approval keeps its selected merchants. After it finishes, you can choose all participating merchants."
                            : "Your saved merchant selection is kept. Switching to all participating merchants requires saving with fresh consent.")
                    } else {
                        Text("Includes shops added later.")
                        if store.policy(for: cardID)?.effectiveMerchantScope == .selected {
                            Text("Saving replaces your current selected-merchants restriction.")
                        }
                    }
                }
                Section {
                    Toggle(store.loyaltyAvailable ? "Use available points & rewards" : "Use available rewards", isOn: input(\.useRewards))
                        .disabled(!formLoaded || store.busy || store.preparingPermission(for: cardID) || !canConfigure || !store.rewardsAvailable)
                    if !store.rewardsAvailable { Text("Reward redemption is not available yet.").font(.subheadline).foregroundStyle(.secondary) }
                    if store.loyaltyAvailable, form.useRewards {
                        Toggle("Limit points used per payment", isOn: Binding(get: { form.maxPointsPerPayment != nil }, set: { selected in edit { $0.maxPointsPerPayment = selected ? "0" : nil } }))
                            .disabled(!formLoaded || store.busy || store.preparingPermission(for: cardID) || !canConfigure)
                        if form.maxPointsPerPayment != nil {
                            SpendingAmountField(title: "Maximum points", amount: Binding(get: { form.maxPointsPerPayment ?? "" }, set: { value in edit { $0.maxPointsPerPayment = value } }), symbol: "points")
                                .disabled(!formLoaded || store.busy || store.preparingPermission(for: cardID) || !canConfigure)
                        }
                        Text(form.maxPointsPerPayment == nil ? "Use as many whole points as the purchase allows. Each point covers 1 \(store.config?.token.symbol ?? "icUSD") at its issuing shop." : "Use up to this many whole points. Zero keeps points for another payment.").font(.footnote)
                    }
                } header: {
                    Text("Automatic rewards")
                } footer: {
                    Text("Optional: use this card’s valid rewards where the merchant accepts them. Separate from tap-payment consent.")
                }
                Section {
                    if savedAndEnabled {
                        if card?.isFrozen == true {
                            Label("Card frozen", systemImage: "pause.circle")
                            Text("Unfreeze this card in card settings to resume taps.").font(.footnote)
                        } else {
                            Label("Tap payments enabled", systemImage: "checkmark.circle.fill").foregroundStyle(.tint)
                        }
                    } else if store.preparingPermission(for: cardID) {
                        if store.allowanceStatus(for: cardID) == "confirmed" {
                            Label("Wallet approval confirmed", systemImage: "checkmark.circle")
                            AsyncAction("Save spending settings", loadingTitle: "Saving settings…", prominent: true) { await store.confirmPayments(cardID: cardID) }.disabled(store.busy || !canConfigure)
                        } else {
                            ProgressStatus(title: "Preparing wallet approval")
                            AsyncAction("Check progress", loadingTitle: "Checking progress…", systemImage: "arrow.clockwise") { await store.resumePermission(cardID: cardID) }.disabled(store.busy)
                        }
                    } else {
                        Toggle("I authorize these tap payments", isOn: $consent)
                        Text(form.merchantScope == .all
                            ? "Allow this card to pay all participating merchants, including shops added later, within these limits without phone approval."
                            : "Allow this card to pay only your selected merchants within these limits without phone approval.")
                            .font(.subheadline).foregroundStyle(Color.primary.opacity(0.8))
                        AsyncAction(store.policy(for: cardID)?.enabled == true ? "Save spending changes" : "Enable tap payments", loadingTitle: "Saving permission…", prominent: true) { await store.enablePayments(perPayment: form.perPayment, total: form.total, expiry: form.expires, merchantIDs: form.merchantIDs, useRewards: form.useRewards, merchantScope: form.merchantScope, maxPointsPerPayment: form.maxPointsPerPayment, cardID: cardID) }.disabled(!consent || store.busy || !canConfigure || form.perPayment.isEmpty || form.total.isEmpty)
                    }
                    if !savedAndEnabled {
                        Text("Draft saved on this iPhone. Not applied yet.").font(.footnote)
                    }
                }
                Section {
                    DisclosureGroup("How tap payments work") {
                        Text("IC Pay manages your wallet and payment allowance. Freeze new payments at any time. Your transit balance stays separate.").font(.subheadline)
                    }
                    NoticeView()
                }
            }
        }.navigationTitle("Spending permission").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
            .modifier(AccountSessionActions())
            .task {
                // Opening or refreshing the screen must preserve the saved scope.
                guard !formLoaded, !cardMissing else { return }
                do {
                    form = try Self.restoredForm(from: store, cardID: cardID)
                    hasEdits = !form.matches(store.policy(for: cardID), decimals: store.config?.token.decimals ?? 18)
                    formLoaded = true
                } catch {
                    store.error = error.localizedDescription
                    return
                }
                await store.resumePermission(cardID: cardID)
            }
            .onChange(of: store.policy(for: cardID)) { _, policy in
                guard !cardMissing else { return }
                if form.matches(policy, decimals: store.config?.token.decimals ?? 18) {
                    hasEdits = false; consent = false
                } else if !hasEdits {
                    do { form = try Self.restoredForm(from: store, cardID: cardID) }
                    catch { store.error = error.localizedDescription }
                }
            }
            .onChange(of: store.preparingPermission(for: cardID)) { old, pending in
                guard old && !pending, !cardMissing else { return }
                hasEdits = !form.matches(store.policy(for: cardID), decimals: store.config?.token.decimals ?? 18)
                consent = false
            }
            .task(id: store.allowanceJobID(for: cardID)) {
                while !Task.isCancelled, !cardMissing, store.preparingPermission(for: cardID), store.allowanceStatus(for: cardID) != "confirmed" {
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled && !cardMissing && !store.busy { await store.resumePermission(cardID: cardID) }
                }
            }
    }
    @MainActor static func restoredForm(from store: AppStore, cardID: String?) throws -> SpendingForm {
        try store.savedSpendingForm(cardID: cardID)
    }
    private func permissionStatus(_ policy: Policy) -> String {
        guard policy.enabled else { return "Frozen" }
        guard (AppDates.date(policy.expiresAt) ?? .distantPast) > Date() else { return "Expired" }
        if policy.requiresApproval == true || !store.policyRouterMatchesActive(cardID: cardID) || (cardID != nil && card?.allowanceSufficient != true) { return "Wallet approval required" }
        return "Enabled"
    }
    private func input<Value>(_ keyPath: WritableKeyPath<SpendingForm, Value>) -> Binding<Value> {
        Binding(get: { form[keyPath: keyPath] }, set: { value in edit { $0[keyPath: keyPath] = value } })
    }
    private func edit(_ change: (inout SpendingForm) -> Void) {
        guard !cardMissing else { return }
        change(&form)
        hasEdits = true; consent = false
        do { try store.saveSpendingForm(form, cardID: cardID) }
        catch { store.error = error.localizedDescription }
    }
}
struct MerchantView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var celebrationInvoiceID: String?
    @State private var celebrationSequence = 0
    @State private var amount = ""
    @State private var description = ""
    @State private var useReward = false
    @State private var invoiceRouter: String?
    @State private var maximumPoints: String?
    @State private var draftLoaded = false
    @State private var paymentActionLoadingTitle: String?
    var body: some View {
        Form {
            if !store.terminalEnrolled {
                Section {
                    Label("Set up this iPhone", systemImage: "iphone")
                    AsyncAction("Activate this iPhone", loadingTitle: "Activating iPhone…", systemImage: "iphone") { await store.enrollTerminal() }.disabled(store.busy)
                }
            }
            if store.invoice == nil || store.invoiceRequestPending {
              Section(store.dashboard?.merchant?.name ?? "New payment") {
                SpendingAmountField(title: "Amount", amount: $amount, symbol: store.config?.token.symbol ?? "tokens", identifier: "merchant.amount")
                    .disabled(store.invoiceRequestPending || store.invoice?.isFinished == false)
                LabeledContent("Note") {
                    TextField("Optional", text: $description).multilineTextAlignment(.trailing)
                        .accessibilityLabel("Payment note, optional")
                        .disabled(store.invoiceRequestPending || store.invoice?.isFinished == false)
                }
                if store.loyaltyAvailable, !store.invoiceRequestPending {
                    Picker("Payment type", selection: $invoiceRouter) {
                        Text("Points").tag(String?.none)
                        if store.collectiblesAvailable { Text("Earlier credit IC Voucher").tag(String?.some("collectibles")) }
                        if store.config?.capabilities.rewards == true { Text("Earlier percentage IC Voucher").tag(String?.some("rewards")) }
                    }.disabled(store.invoiceRequestPending || store.invoice?.isFinished == false)
                }
                Toggle(store.loyaltyAvailable && invoiceRouter == nil ? "Use available points" : "Apply available rewards", isOn: $useReward).disabled(!store.rewardsAvailable || store.invoiceRequestPending || store.invoice?.isFinished == false || ["collectibles", "rewards"].contains(invoiceRouter ?? ""))
                if useReward { Text(store.loyaltyAvailable && invoiceRouter == nil
                    ? "Uses available whole points within the customer’s saved limit and consent. The final total appears after the tap."
                    : "Requires the customer’s opt-in and an eligible earlier IC Voucher. The final total appears after the tap.").font(.footnote) }
                AsyncAction(store.invoiceRequestPending ? "Recover payment" : "Create payment", loadingTitle: paymentActionLoadingTitle ?? (store.invoiceRequestPending ? "Recovering payment…" : "Creating payment…"), prominent: true) {
                    paymentActionLoadingTitle = store.invoiceRequestPending ? "Recovering payment…" : "Creating payment…"
                    defer { paymentActionLoadingTitle = nil }
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    await store.createInvoice(amount: amount, description: description, useReward: useReward, router: invoiceRouter, maxPoints: maximumPoints)
                }.disabled(store.busy || !store.paymentsAvailable || !store.terminalEnrolled || amount.isEmpty || (store.invoice != nil && store.invoice?.isFinished == false))
            }
            }
            if let invoice = store.invoice {
                Section {
                    MerchantPaymentSummary(invoice: invoice, decimals: store.config?.token.decimals ?? 18, symbol: store.config?.token.symbol ?? "tokens", celebrates: celebrationInvoiceID == invoice.id)
                    if invoice.status == "awaiting_tap", invoice.useReward == true { Text("Before reward · final discount is determined after the tap.").font(.subheadline) }
                    if invoice.status != "awaiting_tap", let gross = invoice.grossAmount {
                        LabeledContent("Before rewards", value: "\(TokenAmount.display(gross, decimals: store.config?.token.decimals ?? 18)) \(store.config?.token.symbol ?? "")")
                        if let discount = invoice.discountAmount {
                            LabeledContent("Reward discount", value: "\(TokenAmount.display(discount, decimals: store.config?.token.decimals ?? 18)) \(store.config?.token.symbol ?? "")")
                        }
                    }
                    if let reason = PaymentIssue.message(code: invoice.errorCode, status: invoice.status) { Text(reason).font(.subheadline) }
                    if invoice.status == "awaiting_tap" {
                        AsyncAction("Collect payment", loadingTitle: "Reading card…", systemImage: "wave.3.right", prominent: true) { await store.collect() }.disabled(store.busy || !store.paymentsAvailable)
                        AsyncAction("Cancel payment", loadingTitle: "Cancelling payment…", role: .destructive) { await store.cancelInvoice() }.disabled(store.busy)
                        if let expires = AppDates.date(invoice.expiresAt) { Text("Expires \(expires.formatted(date: .omitted, time: .shortened))").font(.footnote) }
                    }
                    if !invoice.isFinished {
                        AsyncAction("Check status", loadingTitle: "Checking payment…", systemImage: "arrow.clockwise") { await store.refreshInvoice() }.disabled(store.busy)
                    }
                    if invoice.txHash != nil || invoice.rewardId != nil || invoice.explorerUrl != nil {
                        DisclosureGroup("Transaction details") {
                            if let reward = invoice.rewardId { LabeledContent(invoice.status == "confirmed" ? "Reward used" : "Reward selected", value: reward) }
                            if let hash = invoice.txHash { Text(hash).font(.footnote.monospaced()).textSelection(.enabled) }
                            if let value = invoice.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View transaction", destination: url) }
                        }
                    }
                    if invoice.isFinished {
                        Button {
                            if store.newInvoice() { amount = ""; description = ""; useReward = false; invoiceRouter = nil; maximumPoints = nil }
                        } label: { Text("New payment").frame(maxWidth: .infinity, minHeight: 28) }.buttonStyle(ProminentActionStyle()).disabled(store.busy || store.invoiceRequestPending)
                    }
                    if !invoice.isFinished {
                        Text("Wait for Paid before completing the sale.").font(.footnote)
                    }
                }
            }
            if let invoice = store.invoice, invoice.status == "confirmed", invoice.refundEligible == true || invoice.refund != nil || store.refundRequestPending {
                MerchantRefundSection(invoice: invoice)
            }
            if store.invoice == nil || store.invoice?.isFinished == true {
                Section {
                    NavigationLink {
                        if store.config?.capabilities.loyalty != nil { MerchantLoyaltyProgramView() } else { MerchantRewardsView() }
                    } label: { Label(store.config?.capabilities.loyalty != nil ? "Shop points" : "Shop rewards", systemImage: "star.circle") }
                }
            }
            Section { NoticeView() }
        }.navigationTitle("Collect")
            .modifier(FormKeyboardActions())
            .sensoryFeedback(trigger: store.invoice.map(PaymentFeedbackState.init)) { old, new in
                guard scenePhase == .active else { return nil }
                switch PaymentFeedbackState.outcome(from: old, to: new) {
                case .success: return .success
                case .error: return .error
                case .warning: return .warning
                case nil: return nil
                }
            }
            .onChange(of: store.invoice.map(PaymentFeedbackState.init)) { old, new in
                guard scenePhase == .active, PaymentFeedbackState.outcome(from: old, to: new) == .success else {
                    if old?.invoiceID != new?.invoiceID || new?.status != "confirmed" { celebrationInvoiceID = nil }
                    return
                }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { celebrationInvoiceID = new?.invoiceID }
                celebrationSequence += 1
            }
            .task(id: celebrationSequence) {
                guard celebrationInvoiceID != nil else { return }
                do { try await Task.sleep(for: .milliseconds(1400)) } catch { celebrationInvoiceID = nil; return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { celebrationInvoiceID = nil }
            }
            .onChange(of: scenePhase) { _, phase in if phase != .active { celebrationInvoiceID = nil } }
            .onDisappear { celebrationInvoiceID = nil }
            .task {
                do { let draft = try store.savedInvoiceDraft(); amount = draft.amount; description = draft.description; useReward = draft.useReward; invoiceRouter = draft.router; maximumPoints = draft.maxPoints; draftLoaded = true }
                catch { store.error = error.localizedDescription }
            }
            .onChange(of: amount) { _, _ in saveDraft() }
            .onChange(of: description) { _, _ in saveDraft() }
            .onChange(of: useReward) { _, _ in saveDraft() }
            .onChange(of: invoiceRouter) { _, value in
                guard draftLoaded, !store.invoiceRequestPending else { return }
                if value == "collectibles" || value == "rewards" { useReward = true; maximumPoints = nil }
                saveDraft()
            }
            .task(id: store.invoice?.id) {
                while !Task.isCancelled, let invoice = store.invoice, !invoice.isFinished {
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled && !store.busy { await store.refreshInvoice() }
                }
            }
    }
    private func saveDraft() {
        guard draftLoaded else { return }
        do { try store.saveInvoiceDraft(amount: amount, description: description, useReward: useReward, router: invoiceRouter, maxPoints: maximumPoints) }
        catch { store.error = error.localizedDescription }
    }
}

struct MerchantPaymentSummary: View {
    let invoice: Invoice
    let decimals: Int
    let symbol: String
    var celebrates = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var processing: Bool { ["authorised", "submitting", "pending", "reconciling"].contains(invoice.status) }
    private var title: String {
        switch invoice.status {
        case "confirmed": return "Paid"
        case "awaiting_tap": return "Ready to collect"
        case "authorised", "submitting", "pending": return "Processing payment"
        case "reconciling": return "Checking payment"
        default: return invoice.status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                if processing { ProgressView().accessibilityHidden(true) }
                else {
                    Image(systemName: invoice.status == "confirmed" ? "checkmark.circle.fill" : invoice.status == "awaiting_tap" ? "wave.3.right" : "exclamationmark.circle")
                        .foregroundStyle(invoice.status == "confirmed" ? Color("AccentColor") : .primary).accessibilityHidden(true)
                }
                Text(title).font(.headline)
                Spacer(minLength: 0)
                // Reserve the space so the amount/actions never jump on confirmation.
                if !dynamicTypeSize.isAccessibilitySize {
                    Image("MascotSuccess").resizable().scaledToFit().frame(width: 52, height: 56)
                        .opacity(celebrates && invoice.status == "confirmed" ? 1 : 0).accessibilityHidden(true)
                }
            }
            Text("\(TokenAmount.display(invoice.amount, decimals: decimals)) \(symbol)")
                .font(.largeTitle.weight(.semibold)).monospacedDigit().fixedSize(horizontal: false, vertical: true)
            if invoice.status != "confirmed" { Text("Test-token payment").font(.footnote).foregroundStyle(.secondary) }
        }.padding(.vertical, 8)
    }
}
