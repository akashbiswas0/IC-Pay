import SwiftUI

struct LoyaltyPreview: View {
    let cardID: String
    @Environment(AppStore.self) private var store
    var body: some View {
        Section("Shop points") {
            NavigationLink { LoyaltyView(cardID: cardID) } label: { Label("Points for this card", systemImage: "star.circle") }
            if let response = store.loyalty(for: cardID), response.readable {
                ForEach(Array((response.balances ?? []).prefix(2))) { balance in
                    NavigationLink { LoyaltyDetailView(cardID: cardID, balance: balance) } label: {
                        LabeledContent(balance.merchantName, value: balance.spendablePoints + " points")
                    }
                }
                if response.balances?.isEmpty == true { Text("Earn points on eligible purchases. 1 point = 1 \(response.token.symbol) at that shop.").font(.subheadline).foregroundStyle(.secondary) }
            } else if let error = store.loyaltyError(for: cardID) { Text(error).font(.subheadline) }
        }.task { await store.loadLoyalty(cardID: cardID) }
    }
}
struct LoyaltyView: View {
    let cardID: String
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    private var response: LoyaltyResponse? { store.loyalty(for: cardID) }
    var body: some View {
        List {
            Section {
                Text("One balance per shop").font(.headline)
                Text("1 point = 1 \(response?.token.symbol ?? store.config?.token.symbol ?? "icUSD"). These points belong to this card’s wallet and can be used only at the shop that issued them.").font(.subheadline)
                NavigationLink { PolicyView(cardID: cardID) } label: { Label("Choose how points are used", systemImage: "slider.horizontal.3") }
            }
            if !store.loyaltyAvailable {
                ContentUnavailableView("Points are not available yet", systemImage: "star.circle", description: Text("Your wallet funds and IC Vouchers remain separate."))
            } else if let response, response.readable {
                if response.balances?.isEmpty == true {
                    ContentUnavailableView("No shop points yet", systemImage: "star.circle", description: Text("Make an eligible purchase at a shop with an active points program. Fractional earnings carry toward your next whole point."))
                }
                Section {
                    ForEach(response.balances ?? []) { balance in
                        NavigationLink { LoyaltyDetailView(cardID: cardID, balance: balance) } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                LabeledContent(balance.merchantName, value: balance.spendablePoints + " points")
                                if let progress = balance.fractionalProgress, progress > 0 { Text(progress, format: .percent.precision(.fractionLength(0...2))) + Text(" toward the next point") }
                                if let date = balance.expiresAt.flatMap(AppDates.date) { Text("Next expiry: \(date.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary) }
                            }
                        }
                    }
                } header: { Text("Available points").accessibilityIdentifier("loyalty.available") }
            } else if store.isLoadingLoyalty(for: cardID) { LoadingPlaceholder(label: "Loading points", rows: 2) }
            else {
                StatusMessage(title: response?.status == "pending_setup" ? "Points setup pending" : "Points unavailable", detail: store.loyaltyError(for: cardID) ?? "Try again to check your points.", systemImage: "wifi.exclamationmark")
                AsyncAction("Try again", loadingTitle: "Loading points…", systemImage: "arrow.clockwise") { await store.loadLoyalty(cardID: cardID) }
            }
            Section { NavigationLink { RewardsView(cardID: cardID) } label: { Label("IC Voucher collection", systemImage: "photo.on.rectangle") } }
        }.navigationTitle("Shop points").navigationBarTitleDisplayMode(.inline)
            .task(id: scenePhase) { if scenePhase == .active { await store.loadLoyalty(cardID: cardID) } }
            .refreshable { await store.loadLoyalty(cardID: cardID) }
    }
}
struct LoyaltyDetailView: View {
    let cardID: String
    let balance: LoyaltyBalance
    @Environment(AppStore.self) private var store
    private var response: LoyaltyResponse? { store.loyalty(for: cardID) }
    private var current: LoyaltyBalance { response?.balances?.first { $0.id == balance.id } ?? balance }
    private var events: [LoyaltyEvent] { (response?.history ?? []).filter { $0.merchantId == balance.merchantId && $0.walletAddress.lowercased() == balance.walletAddress.lowercased() }.sorted { $0.createdAt > $1.createdAt } }
    var body: some View {
        List {
            if response?.readable != true { Section { StatusMessage(title: "Showing last loaded points", detail: store.loyaltyError(for: cardID) ?? "The latest points balance is unavailable. Refresh to try again.", systemImage: "wifi.exclamationmark") } }
            Section {
                LabeledContent("Available to use", value: current.spendablePoints + " points")
                Text("1 point = 1 \(response?.token.symbol ?? store.config?.token.symbol ?? "icUSD") at \(current.merchantName).").font(.subheadline)
                if current.reservedPoints != "0" { LabeledContent("In pending payments", value: current.reservedPoints + " points") }
                if let progress = current.fractionalProgress {
                    ProgressView(value: progress) { Text("Toward the next point") } currentValueLabel: { Text(progress, format: .percent.precision(.fractionLength(0...2))) }
                    Text("Only whole points can be spent. Fractional progress carries forward.").font(.footnote).foregroundStyle(.secondary)
                }
                if let date = current.expiresAt.flatMap(AppDates.date) { LabeledContent("Next expiry", value: date.formatted(date: .abbreviated, time: .shortened)) }
                if !current.merchantEnabled { Text("This shop is currently unavailable.").font(.subheadline) }
                NavigationLink { PolicyView(cardID: cardID) } label: { Text("Manage automatic use & limits") }
            }
            if let program = current.program {
                Section("Earning rules") {
                    Text(program.summary(decimals: response?.token.decimals ?? 18, symbol: response?.token.symbol ?? "icUSD")).font(.subheadline)
                    if !program.enabled { Text("New earning is paused.").font(.subheadline) }
                    Text("Points are earned on tokens actually paid, including the paid part of a partly redeemed purchase. A fully points-funded payment earns none.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("Points history") {
                if response?.readable != true { Text("History is unavailable. Refresh to try again.") }
                else if events.isEmpty { Text("No confirmed points events yet.") }
                ForEach(events) { event in
                    VStack(alignment: .leading, spacing: 5) {
                        LabeledContent(event.title, value: TokenAmount.display(event.pointsUnits, decimals: response?.token.decimals ?? 18) + " points")
                        if let recovered = event.debtRepaidUnits, recovered != "0" {
                            Text(TokenAmount.display(recovered, decimals: response?.token.decimals ?? 18) + " points applied to a prior refund adjustment").font(.caption).foregroundStyle(.secondary)
                        }
                        if let date = AppDates.date(event.createdAt) { Text(date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary) }
                        if let value = event.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View transaction", destination: url).font(.caption) }
                    }
                }
            }
            Section {
                DisclosureGroup("Balance details") {
                    LabeledContent("Confirmed whole points", value: current.availablePoints)
                    if let debt = current.debtUnits, debt != "0" { LabeledContent("Earnings to recover after refunds", value: TokenAmount.display(debt, decimals: response?.token.decimals ?? 18) + " points") }
                    WalletAddressRow(address: current.walletAddress)
                    Text("Separate from wallet funds and IC Voucher credit.").font(.footnote)
                }
            }
        }.navigationTitle(current.merchantName).navigationBarTitleDisplayMode(.inline)
            .task { await store.loadLoyalty(cardID: cardID) }
            .refreshable { await store.loadLoyalty(cardID: cardID) }
    }
}

struct MerchantLoyaltyProgramView: View {
    @Environment(AppStore.self) private var store
    @State private var form = LoyaltyProgramDraft()
    @State private var loaded = false
    private var locked: Bool { store.loyaltyProgramRequestPending || store.loyaltyProgram?.operation?.isPending == true }
    private var hasChanges: Bool { store.loyaltyProgram?.program.map { !form.matches($0, decimals: store.config?.token.decimals ?? 18) } ?? true }
    private var canSubmit: Bool { store.loyaltyProgramRequestPending || (store.loyaltyAvailable && store.loyaltyProgram?.status == "available" && store.loyaltyProgramError == nil) }
    private var symbol: String { store.config?.token.symbol ?? "tokens" }
    private var decimals: Int { store.config?.token.decimals ?? 18 }
    private var offerState: String {
        if locked { return "Update pending" }
        if hasChanges { return "Draft · not saved" }
        return store.loyaltyProgram?.program?.enabled == true ? "Active for this shop" : "Paused"
    }
    private var actionTitle: String {
        if store.loyaltyProgramRequestPending { return "Recover update" }
        if form.enabled && store.loyaltyProgram?.program?.enabled != true { return "Enable shop points" }
        if !form.enabled && store.loyaltyProgram?.program?.enabled == true { return "Pause rewards" }
        return "Save changes"
    }
    var body: some View {
        Form {
            Section {
                Toggle("Enable shop points", isOn: $form.enabled)
                    .disabled(!loaded || locked || store.busy || !store.loyaltyAvailable)
            } footer: {
                Text("Set up once for your shop. Eligible purchases earn points for later visits.")
            }
            if !store.loyaltyAvailable || store.loyaltyProgram?.status == "pending_setup" {
                Section { StatusMessage(title: "Rewards setup pending", detail: "You can enable your offer when rewards are available on this network.", systemImage: "clock") }
            }
            if !loaded && store.isLoadingLoyaltyProgram {
                Section { LoadingPlaceholder(label: "Loading your offer", rows: 2) }
            } else if loaded {
                Section("Offer") {
                    Text(offerState).accessibilityIdentifier("loyalty.program.state").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text((try? form.normalized(decimals: decimals))?.summary(decimals: decimals, symbol: symbol) ?? "Complete the offer details below to see your summary.")
                    DisclosureGroup("How points are earned") {
                        Text("1 point = 1 \(symbol) at this shop. Fractional earnings carry to whole points. Only tokens actually paid earn more points.").font(.subheadline)
                    }
                    DisclosureGroup("Customize offer") {
                        offerField("Qualifying purchase", unit: symbol, text: $form.minimumPurchase)
                        offerField("Points earned per purchase", unit: "%", text: $form.earnPercent)
                        offerField("Maximum points earned", unit: "points", text: $form.maximumPoints)
                        offerField("Points valid for", unit: "days", text: $form.validityDays)
                    }.disabled(locked || store.busy || !store.loyaltyAvailable)
                }
                if let campaign = store.loyaltyProgram?.program, hasChanges || locked {
                    Section(campaign.enabled ? "Currently active" : "Currently paused") {
                        Text(campaign.summary(decimals: decimals, symbol: symbol)).font(.subheadline)
                        Text("Your changes apply after confirmation. Existing rewards keep their original terms.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if store.loyaltyProgram?.program != nil {
                    Section { Text("Pausing stops new rewards. Existing points keep their expiry, and existing collectibles stay separate.").font(.footnote).foregroundStyle(.secondary) }
                }
            }
            if let operation = store.loyaltyProgram?.operation {
                Section {
                    if operation.isPending {
                        ProgressStatus(title: "Updating your offer", detail: "Waiting for confirmation. You can leave this screen.")
                    } else if operation.status == "failed" {
                        StatusMessage(title: "Offer update did not complete", detail: "Your previous offer is unchanged. Review the details and retry.", systemImage: "exclamationmark.circle")
                    } else if !hasChanges && !store.loyaltyProgramRequestPending {
                        Label("Offer saved", systemImage: "checkmark.circle")
                    }
                    DisclosureGroup("Transaction details") {
                        LabeledContent("Status", value: operation.status.replacingOccurrences(of: "_", with: " ").capitalized)
                        if let error = operation.errorCode { Text(error.replacingOccurrences(of: "_", with: " ")).font(.footnote).textSelection(.enabled) }
                        if let hash = operation.txHash {
                            Text(hash).font(.footnote.monospaced()).textSelection(.enabled)
                            if let value = store.config?.explorerUrl, let base = URL(string: value), base.scheme == "https" {
                                Link("View transaction", destination: base.appendingPathComponent("tx").appendingPathComponent(hash))
                            }
                        }
                    }
                }
            } else if store.loyaltyProgramRequestPending {
                Section { StatusMessage(title: "Checking your last update", detail: "Recover the update to check whether it was received. Your offer will not be submitted twice.", systemImage: "clock") }
            }
            if let error = store.loyaltyProgramError { Section { StatusMessage(title: error, systemImage: "wifi.exclamationmark") } }
            Section {
                if CampaignRecovery.showsSubmit(hasPendingRequest: store.loyaltyProgramRequestPending, operation: store.loyaltyProgram?.operation, hasReadError: store.loyaltyProgramError != nil) {
                    AsyncAction(actionTitle, loadingTitle: "Submitting update…", prominent: true) { await store.saveLoyaltyProgram(form) }
                        .disabled(!loaded || store.busy || !canSubmit || (!hasChanges && !store.loyaltyProgramRequestPending))
                }
                if store.loyaltyProgramError != nil || locked {
                    AsyncAction("Check status", loadingTitle: "Checking…", systemImage: "arrow.clockwise") { await store.loadLoyaltyProgram() }.disabled(store.busy || store.isLoadingLoyaltyProgram)
                }
                if hasChanges && !locked { Text("Save to apply this offer to your shop.").font(.footnote).foregroundStyle(.secondary) }
                NoticeView()
            }
            if let summary = store.loyaltyProgram?.summary {
                Section {
                    DisclosureGroup("Program totals") {
                        LabeledContent("Outstanding reward value", value: TokenAmount.display(summary.outstandingUnits, decimals: decimals) + " " + symbol)
                        LabeledContent("Outstanding whole points", value: summary.outstandingPoints)
                        LabeledContent("Earned", value: TokenAmount.display(summary.earnedUnits, decimals: decimals) + " points")
                        LabeledContent("Redeemed", value: summary.redeemedPoints + " points")
                        LabeledContent("Expired", value: TokenAmount.display(summary.expiredUnits, decimals: decimals) + " points")
                        LabeledContent("Returned by refunds", value: TokenAmount.display(summary.refundedUnits, decimals: decimals) + " points")
                        LabeledContent("Earning reversed", value: TokenAmount.display(summary.reversedUnits, decimals: decimals) + " points")
                        LabeledContent("Customer wallets", value: String(summary.customerWallets))
                    }
                }
            }
            Section {
                DisclosureGroup("Earlier IC Voucher offers") {
                    Text("Existing credit and percentage IC Vouchers keep their original terms, separate from the points program.").font(.footnote)
                    NavigationLink("Manage earlier offers") { MerchantRewardsView() }
                }
            }
        }.navigationTitle("Shop points").navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.loadLoyaltyProgram() }
            .modifier(FormKeyboardActions())
            .task {
                await store.loadLoyaltyProgram()
                guard !loaded else { return }
                do {
                    var restored = try store.savedLoyaltyProgramDraft()
                    restored.requestID = nil // The store, not editable form state, owns durable request identity.
                    form = restored; loaded = true
                }
                catch { store.error = error.localizedDescription }
            }
            .onChange(of: form) { _, value in
                guard loaded, !locked else { return }
                do { try store.saveLoyaltyProgramDraft(value) }
                catch { store.error = error.localizedDescription }
            }
            .task(id: store.loyaltyProgram?.operation?.id) {
                while !Task.isCancelled, store.loyaltyProgram?.operation?.isPending == true {
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    guard !Task.isCancelled else { return }
                    await store.loadLoyaltyProgram()
                }
            }
    }
    private func offerField(_ label: String, unit: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline)
            HStack {
                TextField(label, text: text).keyboardType(.decimalPad)
                    .accessibilityLabel("\(label), \(unit)")
                Text(unit).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 4)
    }
}


struct MerchantRefundSection: View {
    let invoice: Invoice
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmsRefund = false
    private var amount: String { TokenAmount.display(invoice.amount, decimals: store.config?.token.decimals ?? 18) + " " + (store.config?.token.symbol ?? "icUSD") }
    var body: some View {
        Section("Refund") {
            if let refund = invoice.refund {
                if refund.isPending { ProgressStatus(title: "Refund in progress", detail: "Wait for confirmation before completing the return.") }
                else if refund.status == "confirmed" { Label("Payment refunded", systemImage: "checkmark.circle") }
                else { StatusMessage(title: "Refund needs attention", detail: "The refund has not been confirmed. Check the details before taking further action.", systemImage: "exclamationmark.circle") }
                DisclosureGroup("Refund details") {
                    LabeledContent("Token return", value: TokenAmount.display(refund.amount, decimals: store.config?.token.decimals ?? 18) + " " + (store.config?.token.symbol ?? "icUSD"))
                    LabeledContent("Status", value: refund.status.capitalized)
                    if let code = refund.errorCode { Text(code.replacingOccurrences(of: "_", with: " ")).font(.footnote) }
                    if let value = refund.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View refund transaction", destination: url) }
                }
            }
            if store.refundRequestPending {
                AsyncAction("Recover refund", loadingTitle: "Recovering refund…", systemImage: "arrow.clockwise") { await store.requestFullRefund() }.disabled(store.busy)
            } else if invoice.canRequestNewRefund {
                Button(invoice.refund?.status == "failed" ? "Retry full refund" : "Refund full payment", role: .destructive) { confirmsRefund = true }.disabled(store.busy)
                Text("Return the full token charge from your shop wallet. Points are reconciled with the confirmed refund.").font(.footnote).foregroundStyle(.secondary)
            }
            if invoice.refund != nil || store.refundRequestPending {
                AsyncAction("Check refund", loadingTitle: "Checking refund…", systemImage: "arrow.clockwise") { await store.refreshRefundStatus() }.disabled(store.busy)
            }
            if let error = store.refundError { Text(error).font(.subheadline) }
        }
        .confirmationDialog("Refund this full payment?", isPresented: $confirmsRefund, titleVisibility: .visible) {
            Button("Refund " + amount, role: .destructive) { Task { await store.requestFullRefund() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The shop wallet will return " + amount + ". Redeemed points and earned points will be reconciled by the refund transaction.") }
        .task(id: "\(invoice.id)-\(scenePhase == .active)") {
            guard scenePhase == .active else { return }
            await store.refreshRefundStatus()
            while !Task.isCancelled, scenePhase == .active {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if store.invoice?.refund?.isPending == true { await store.refreshRefundStatus() }
            }
        }
    }
}
