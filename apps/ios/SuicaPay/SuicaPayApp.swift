import SwiftUI

@main struct SuicaPayApp: App {
    @State private var store = AppStore()
    var body: some Scene {
        WindowGroup {
            RootView().environment(store).tint(Color("AccentColor"))
                .task { await store.bootstrap() }
        }
    }
}
private enum AppTab: Hashable { case wallet, activity, collect, account }
struct RootView: View {
    @State private var selectedTab = AppTab.wallet
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    private var walletRefreshID: String {
        guard scenePhase == .active, !store.preparingCardWalletIDs.isEmpty else { return "" }
        return store.sessionViewID + store.preparingCardWalletIDs.joined(separator: ",")
    }
    var body: some View {
        Group {
            if store.isSignedIn {
                if store.account?.role == "merchant", store.merchantSetup?.ready != true || !store.terminalEnrolled {
                    NavigationStack { MerchantSetupView() }.id(store.sessionViewID)
                } else {
                  TabView(selection: $selectedTab) {
                    Tab("Wallet", systemImage: "creditcard", value: AppTab.wallet) { NavigationStack { WalletView() } }
                    Tab("Activity", systemImage: "list.bullet.rectangle", value: AppTab.activity) { NavigationStack { ActivityView() } }
                    if store.isMerchant { Tab("Collect", systemImage: "wave.3.right", value: AppTab.collect) { NavigationStack { MerchantView() } } }
                    Tab("Account", systemImage: "person.crop.circle", value: AppTab.account) { NavigationStack { AccountView() } }
                }.id(store.sessionViewID)
                }
            } else {
                NavigationStack { WelcomeView() }.id(store.sessionViewID)
            }
        }
        .alert("Couldn’t complete request", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("Dismiss") { store.error = nil }
        } message: { Text(store.error ?? "") }
        .sheet(isPresented: Binding(get: { store.approvalCode != nil && store.isSignedIn }, set: { if !$0 { store.approvalCode = nil } })) {
            NavigationStack { ApproveDeviceView(initialCode: store.approvalCode ?? "") }
        }
        .onOpenURL { url in
            if url.scheme == "suicapay", url.host == "verify-return" {
                store.setWorldForeground(true)
            } else { store.receiveDeviceLink(url) }
        }
        .onChange(of: store.verificationURL) { old, new in
            if new != nil, old != new, scenePhase == .active { store.openWorldApp() }
        }
        .onChange(of: scenePhase) { _, phase in
            store.setWorldForeground(phase == .active)
            if phase == .active { Task { await store.refreshOnForeground() } }
        }
        .task(id: walletRefreshID) {
            guard !walletRefreshID.isEmpty else { return }
            while !Task.isCancelled, !store.preparingCardWalletIDs.isEmpty {
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                guard !Task.isCancelled else { return }
                await store.refreshPreparingCardWallets()
            }
        }
        .sensoryFeedback(.success, trigger: store.actionSuccessSequence) { old, new in
            scenePhase == .active && new > old
        }
        .onChange(of: store.notice) { _, notice in
            if let notice { UIAccessibility.post(notification: .announcement, argument: notice) }
        }
    }
}
struct PrimaryAction: View {
    let title: String
    var systemImage: String? = nil
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).fontWeight(.semibold)
            }.frame(maxWidth: .infinity, minHeight: 28)
                .fixedSize(horizontal: false, vertical: true)
        }.buttonStyle(ProminentActionStyle()).disabled(disabled)
    }
}
struct NoticeView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.isSignedIn, let unavailable = store.serviceUnavailable {
            StatusMessage(title: unavailable, systemImage: "wifi.exclamationmark")
            AsyncAction("Try again", loadingTitle: "Reconnecting…", systemImage: "arrow.clockwise") {
                await store.run { try await store.refresh() }
            }.disabled(store.busy)
        }
        if let notice = store.notice {
            HStack(alignment: .top, spacing: 8) {
                StatusMessage(title: notice)
                Spacer(minLength: 0)
                Button { store.notice = nil } label: {
                    Image(systemName: "xmark").font(.subheadline).frame(width: 44, height: 44)
                }.buttonStyle(.borderless).accessibilityLabel("Dismiss update")
            }
        }
    }
}
struct WalletView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.account?.role == "customer" { LinkedCardWalletsView() }
        else { LegacyWalletView() }
    }
}

struct LinkedCardWalletsView: View {
    @Environment(AppStore.self) private var store
    @State private var selectedCardID: String?
    @State private var openedCardID: String?
    private var cards: [LinkedCard] { store.dashboard?.cards ?? [] }
    private var selectedCard: LinkedCard? {
        cards.first { $0.id == selectedCardID } ?? cards.first
    }
    var body: some View {
        List {
            if store.dashboard?.cards != nil {
                if cards.isEmpty {
                    Section {
                        ContentUnavailableView("No linked IC cards", systemImage: "creditcard", description: Text("Open Account to add your physical transit card."))
                    }
                } else {
                    Section {
                        WalletCardCarousel(cards: cards, selectedCardID: $selectedCardID) { openedCardID = $0 }
                            // Keep the artwork below the grouped row's rounded top mask.
                            .padding(.top, 12)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                    if let card = selectedCard {
                        Section {
                            if let address = card.wallet?.address ?? store.walletCreation(for: card.id)?.readyAddress {
                                WalletAddressRow(address: address, showsLabel: true).id(card.id)
                            } else if card.walletStatus == "provisioning" {
                                ProgressStatus(title: "Preparing wallet…")
                            } else {
                                Text("This card’s wallet is not ready yet.").font(.subheadline).foregroundStyle(.secondary)
                            }
                            NavigationLink { CardWalletView(cardID: card.id) } label: {
                                Label(card.wallet == nil && card.walletStatus != "provisioning" ? "Set up wallet" : "Card details", systemImage: "wallet.bifold")
                            }
                        }
                        if card.wallet != nil {
                            if store.config?.capabilities.loyalty != nil { LoyaltyPreview(cardID: card.id).id("points-" + card.id) }
                            CollectiblePreview(cardID: card.id).id(card.id)
                        }
                    }
                }
            } else if store.isStarting || store.isRefreshing {
                Section { LoadingPlaceholder(label: "Loading your cards", rows: 2) }
            } else {
                Section {
                    ContentUnavailableView("Cards unavailable", systemImage: "wifi.exclamationmark")
                    AsyncAction("Try again", loadingTitle: "Loading cards…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                }
            }
            Section { NoticeView() }
        }.navigationTitle("Wallet")
            .navigationDestination(item: $openedCardID) { CardWalletView(cardID: $0) }
            .onChange(of: cards.map(\.id), initial: true) { _, ids in
                if !ids.contains(selectedCardID ?? "") { selectedCardID = ids.first }
            }
            .modifier(AccountRefreshActions(refreshFunding: false))
    }
}

struct WalletCardCarousel: View {
    let cards: [LinkedCard]
    @Binding var selectedCardID: String?
    let openCard: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(AppStore.self) private var store
    @State private var scrollID: String?
    private var selectedIndex: Int { cards.firstIndex { $0.id == selectedCardID } ?? 0 }
    var body: some View {
        VStack(spacing: 8) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(cards) { card in
                        Button { openCard(card.id) } label: {
                            CardWalletSummary(card: card, usesSuicaArtwork: card.id == cards.first?.id, presentation: .artworkOnly)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(card.nickname), card ending in \(card.last4)")
                        .accessibilityValue(cardDescription(card))
                        .accessibilityHint("Opens this card’s wallet.")
                        .containerRelativeFrame(.horizontal)
                        .id(card.id)
                    }
                }.scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $scrollID, anchor: .leading)
            .scrollIndicators(.hidden)
            .modifier(CardCarouselEdgeVisibility())
            .onScrollGeometryChange(for: Int.self) { geometry in
                let stride = geometry.containerSize.width + 16
                guard stride > 0 else { return 0 }
                return Int(((geometry.contentOffset.x + geometry.contentInsets.leading) / stride).rounded())
            } action: { _, index in
                guard cards.indices.contains(index) else { return }
                selectedCardID = cards[index].id
            }
            .onChange(of: cards.map(\.id), initial: true) { _, ids in
                if !ids.contains(scrollID ?? "") {
                    scrollID = ids.contains(selectedCardID ?? "") ? selectedCardID : ids.first
                }
            }
            // Only the selected card contributes expanded details; offscreen pages
            // must never stretch the carousel and leave empty space on another page.
            if let card = cards.first(where: { $0.id == selectedCardID }) ?? cards.first {
                CardWalletSummary(card: card, usesSuicaArtwork: card.id == cards.first?.id, presentation: .detailsOnly)
                    .padding(.top, 4)
            }
            if cards.count > 1 {
                HStack {
                    Button { move(by: -1) } label: {
                        Image(systemName: "chevron.left").frame(width: 44, height: 44)
                    }.disabled(selectedIndex == 0).accessibilityLabel("Previous card")
                    Spacer()
                    VStack(spacing: 5) {
                        Text("Card \(selectedIndex + 1) of \(cards.count)")
                            .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        if cards.count <= 8 {
                            HStack(spacing: 6) {
                                ForEach(cards.indices, id: \.self) { index in
                                    Circle().fill(index == selectedIndex ? Color.accentColor : Color.secondary.opacity(0.3))
                                        .frame(width: 6, height: 6)
                                }
                            }.accessibilityHidden(true)
                        }
                    }
                    .accessibilityLabel("Card \(selectedIndex + 1) of \(cards.count)")
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: move(by: 1)
                        case .decrement: move(by: -1)
                        @unknown default: break
                        }
                    }
                    Spacer()
                    Button { move(by: 1) } label: {
                        Image(systemName: "chevron.right").frame(width: 44, height: 44)
                    }.disabled(selectedIndex == cards.count - 1).accessibilityLabel("Next card")
                }.buttonStyle(.borderless)
            }
        }
        .sensoryFeedback(.selection, trigger: selectedCardID) { old, new in
            guard scenePhase == .active, let old, let new, old != new else { return false }
            return cards.contains { $0.id == old } && cards.contains { $0.id == new }
        }
    }
    private func cardDescription(_ card: LinkedCard) -> String {
        let status = card.isFrozen ? "Frozen" : "Active"
        return "\(status), \(CardWalletSummary.walletStateDescription(card, creation: store.walletCreation(for: card.id)))"
    }
    private func move(by offset: Int) {
        let index = selectedIndex + offset
        guard cards.indices.contains(index) else { return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
            scrollID = cards[index].id
            selectedCardID = cards[index].id
        }
    }
}

/// Preserve the physical card's border when iOS adds effects to scroll edges.
private struct CardCarouselEdgeVisibility: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.scrollEdgeEffectHidden(true, for: .horizontal)
        } else {
            content
        }
    }
}

struct CardContextRow: View {
    let card: LinkedCard
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: card.isFrozen ? "pause.circle" : "creditcard").foregroundStyle(.tint).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(card.nickname).font(.headline)
                Text("•••• \(card.last4) · \(card.isFrozen ? "Frozen" : "Active")").font(.subheadline).foregroundStyle(.secondary)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
}

/// Demo presentation: the first linked card uses Suica artwork; other cards use neutral IC artwork.
struct CardWalletSummary: View {
    enum Presentation { case complete, artworkOnly, detailsOnly }
    let card: LinkedCard
    var usesSuicaArtwork = false
    var presentation: Presentation = .complete
    var showsDisclosure = false
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var cardInk: Color { Color(red: 0.10, green: 0.19, blue: 0.08) }
    private var usesArtworkOverlay: Bool {
        guard dynamicTypeSize <= .large, card.nickname.count <= 18 else { return false }
        if let wallet = card.wallet, let amount = wallet.displayBalance {
            return "\(amount) \(wallet.symbol)".count <= 14
        }
        // Neutral artwork has room for setup copy. Keep longer state descriptions
        // clear of the Suica wordmark; selected details no longer size other pages.
        return !usesSuicaArtwork
    }
    private var setupTitle: String {
        Self.walletStateDescription(card, creation: store.walletCreation(for: card.id))
    }
    static func walletStateDescription(_ card: LinkedCard, creation: WalletCreationResult?) -> String {
        if let wallet = card.wallet {
            if let amount = wallet.displayBalance { return "Crypto balance \(amount) \(wallet.symbol)" }
            return wallet.availability == .pendingSetup ? "Wallet setup pending" : "Balance unavailable"
        }
        if card.walletStatus == "none", creation == nil { return "Set up card wallet" }
        if card.walletStatus == "provisioning" || creation?.status == "provisioning" { return "Wallet setup pending" }
        if card.walletStatus == "needs_attention" { return "Wallet setup needs attention" }
        return "Wallet unavailable"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if presentation != .detailsOnly {
                artwork.overlay {
                    if usesArtworkOverlay {
                        GeometryReader { geometry in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(card.nickname).font(.headline).lineLimit(2)
                                cardNumber
                                balance.padding(.top, 8)
                            }
                            .frame(width: geometry.size.width * (usesSuicaArtwork ? 0.38 : 0.62), alignment: .leading)
                            .padding(.leading, geometry.size.width * 0.065)
                            .padding(.top, geometry.size.height * 0.13)
                            .foregroundStyle(cardInk)
                            cardStatus
                                .font(.caption.weight(.medium))
                                .foregroundStyle(cardInk)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .padding(.trailing, geometry.size.width * 0.06)
                                .padding(.top, geometry.size.height * (usesSuicaArtwork ? 0.29 : 0.58))
                        }
                    }
                }
            }
            if presentation != .artworkOnly {
                // Preserve the artwork's proportions without squeezing large accessibility text.
                if !usesArtworkOverlay {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(card.nickname).font(.headline)
                        cardNumber
                        cardStatus
                        balance
                    }
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 4)
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Test tokens · Separate from transit balance")
                        .font(.footnote).foregroundStyle(Color.primary.opacity(0.7))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if showsDisclosure {
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                    }
                }.padding(.horizontal, 4)
            }
        }
        .padding(.bottom, presentation == .artworkOnly ? 0 : 4)
        .fixedSize(horizontal: false, vertical: true)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private var artwork: some View {
        Image(usesSuicaArtwork ? "SuicaCardArtwork" : "ICCardArtwork")
            .renderingMode(.original)
            .resizable()
            .aspectRatio(280.0 / 176.0, contentMode: .fit)
            .accessibilityHidden(true)
    }
    private var balance: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let wallet = card.wallet {
                if let balance = wallet.displayBalance {
                    Text("Crypto balance").font(.caption)
                    Text("\(balance) \(wallet.symbol)")
                        .font(.title3.weight(.semibold)).monospacedDigit()
                        .lineLimit(usesArtworkOverlay ? 1 : nil)
                        .minimumScaleFactor(0.7)
                } else {
                    Text(setupTitle)
                        .font(.subheadline.weight(.semibold))
                }
            } else {
                HStack(spacing: 8) {
                    if card.walletStatus == "provisioning" {
                        ProgressView().controlSize(.small).tint(usesArtworkOverlay ? .white : Color.accentColor)
                    }
                    Text(setupTitle).font(.subheadline.weight(.semibold))
                }
            }
        }
    }
    private var cardNumber: some View {
        Text("•••• \(card.last4)").font(.caption.monospaced())
            .accessibilityLabel("Card ending in \(card.last4)")
    }
    private var cardStatus: some View {
        Label(card.isFrozen ? "Frozen" : "Active", systemImage: card.isFrozen ? "pause.circle.fill" : "checkmark.circle.fill")
    }
}

struct CardWalletIdentity: View {
    let card: LinkedCard
    let usesSuicaArtwork: Bool
    @ScaledMetric(relativeTo: .body) private var thumbnailWidth = 78
    var body: some View {
        HStack(spacing: 12) {
            Image(usesSuicaArtwork ? "SuicaCardArtwork" : "ICCardArtwork")
                .resizable().scaledToFit().frame(width: min(thumbnailWidth, 100))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(card.nickname).font(.title2.weight(.semibold))
                Text("•••• \(card.last4) · \(card.isFrozen ? "Frozen" : "Active")")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }.fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}

struct CardWalletView: View {
    let cardID: String
    @Environment(AppStore.self) private var store
    @State private var confirmExistingWallet = false
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    var body: some View {
        List {
            if let card {
                Section {
                    CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                }
                if let wallet = card.wallet {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Crypto balance").font(.subheadline).foregroundStyle(.secondary)
                            if let amount = wallet.displayBalance {
                                Text("\(amount) \(wallet.symbol)").font(.largeTitle.weight(.semibold)).monospacedDigit()
                                    .fixedSize(horizontal: false, vertical: true)
                            } else {
                                Text(wallet.availability == .pendingSetup ? "Wallet setup pending" : "Balance unavailable").font(.headline)
                            }
                            NavigationLink { FundingView(cardID: cardID) } label: {
                                Label("Add funds", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 28)
                            }.buttonStyle(ProminentActionStyle()).padding(.top, 8)
                            Text("Test tokens · Separate from transit balance").font(.footnote).foregroundStyle(.secondary)
                        }.padding(.vertical, 8)
                    }
                    Section("Payments") {
                        NavigationLink { PolicyView(cardID: cardID) } label: { Label("Spending permission", systemImage: "slider.horizontal.3") }
                            .disabled(!store.paymentsAvailable)
                        NavigationLink { ActivityView(cardID: cardID) } label: { Label("Activity", systemImage: "list.bullet.rectangle") }
                    }
                    if store.config?.capabilities.loyalty != nil { LoyaltyPreview(cardID: cardID) }
                    CollectiblePreview(cardID: cardID)
                } else if card.walletStatus == "none", store.walletCreation(for: cardID) == nil {
                    Section {
                        if store.dashboard?.unassignedWalletAvailable == true {
                            PrimaryAction(title: "Use existing wallet", systemImage: "wallet.bifold", disabled: store.busy) { confirmExistingWallet = true }
                            AsyncAction("Create new wallet", loadingTitle: "Creating wallet…", systemImage: "plus.circle") { await store.createWallet(cardID: cardID) }.disabled(store.busy)
                        } else {
                            AsyncAction("Create wallet", loadingTitle: "Creating wallet…", systemImage: "plus.circle", prominent: true) { await store.createWallet(cardID: cardID) }.disabled(store.busy)
                        }
                    }
                } else {
                    Section {
                        if card.walletStatus == "needs_attention" {
                            Text("Wallet setup needs attention. Refresh to check its status.").font(.subheadline)
                        }
                        AsyncAction("Refresh wallet", loadingTitle: "Refreshing wallet…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                    }
                }
                if let address = card.wallet?.address ?? store.walletCreation(for: cardID)?.readyAddress {
                    Section { WalletAddressRow(address: address, showsLabel: true) }
                }
                Section {
                    NavigationLink { CardDetailView(cardID: cardID) } label: { Label("Manage card", systemImage: "creditcard") }
                }
            } else {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            }
            Section { NoticeView() }
        }.navigationTitle("Card details").navigationBarTitleDisplayMode(.inline)
            .modifier(AccountRefreshActions(cardID: cardID))
            .confirmationDialog("Use your existing wallet?", isPresented: $confirmExistingWallet, titleVisibility: .visible) {
                Button("Use existing wallet") { Task { await store.claimExistingWallet(cardID: cardID) } }
                    .disabled(card?.walletStatus != "none" || card?.wallet != nil || store.walletCreation(for: cardID) != nil || store.dashboard?.unassignedWalletAvailable != true)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Its funds and wallet will belong only to this card. Other cards keep their own wallets.")
            }
    }
}

struct LegacyWalletView: View {
    @Environment(AppStore.self) private var store
    private var activity: [WalletActivity] { WalletActivity.timeline(payments: store.dashboard?.payments ?? [], funding: store.funding ?? []) }
    var body: some View {
        List {
            if let wallet = store.dashboard?.wallet {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        if let balance = wallet.displayBalance {
                            Text("Available balance").font(.subheadline).foregroundStyle(.secondary)
                            Text("\(balance) \(wallet.symbol)").font(.largeTitle.weight(.semibold)).monospacedDigit().minimumScaleFactor(0.7)
                        } else {
                            Label(wallet.availability == .pendingSetup ? "Payment setup pending" : "Balance unavailable", systemImage: wallet.availability == .pendingSetup ? "clock" : "wifi.exclamationmark")
                                .font(.headline)
                        }
                        Text("Test tokens · Separate from transit balance").font(.footnote).foregroundStyle(.secondary)
                    }.padding(.vertical, 14)
                    NavigationLink { FundingView() } label: { Label("Add funds", systemImage: "plus.circle") }
                }
                Section("Wallet address") { WalletAddressRow(address: wallet.address) }
                if !store.isMerchant {
                    if store.dashboard?.cards?.isEmpty == true {
                        Section {
                            NavigationLink { AccountView() } label: { Label("Add IC card", systemImage: "plus.circle") }
                        } footer: { Text("Your balance stays in this account. Add a card to pay.") }
                    }
                    Section {
                        NavigationLink { PolicyView() } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Label("Tap payments", systemImage: "wave.3.right")
                                Text(store.paymentsAvailable ? paymentState : "Setup pending").font(.subheadline).foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }.disabled(!store.paymentsAvailable)
                        if store.dashboard?.policy?.enabled == true { AsyncAction("Freeze payments", loadingTitle: "Freezing payments…", systemImage: "pause.circle", role: .destructive) { await store.freeze() }.disabled(store.busy) }
                    }
                }
                Section("Latest activity") {
                    if let latest = activity.first { ActivityRow(activity: latest) }
                    else if store.funding == nil && (store.isLoadingFunding || store.fundingStatus == nil) { LoadingPlaceholder(rows: 1) }
                    else if store.fundingStatus == "available", store.funding != nil { StatusMessage(title: store.fundingHistoryComplete == false ? "No recent activity returned" : "No activity yet", systemImage: "receipt") }
                    else { FundingActivityStatus(loading: false) }
                    FundingHistoryNotice()
                }
            } else if let address = store.walletCreation?.readyAddress {
                Section {
                    Label("Wallet created", systemImage: "checkmark.circle.fill").font(.title2.weight(.semibold)).foregroundStyle(.tint)
                    Text(store.paymentsAvailable ? "Balance unavailable. Refresh to check." : "Funding and payments pending.").font(.subheadline)
                    AsyncAction("Refresh wallet", loadingTitle: "Refreshing wallet…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                    NavigationLink { FundingView() } label: { Label("Add funds", systemImage: "plus.circle") }
                }
                Section("Wallet address") { WalletAddressRow(address: address) }
            } else if store.dashboard != nil, !store.isMerchant {
                Section {
                    VStack(alignment: .leading, spacing: 14) {
                        Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundStyle(.tint)
                        Text("IC card linked").font(.title2.weight(.semibold))
                        AsyncAction("Create wallet", loadingTitle: "Creating wallet…", systemImage: "plus.circle", prominent: true) { await store.createWallet() }.disabled(store.busy)
                        Text("Managed by IC Pay. Separate from the transit balance.").font(.footnote)
                    }.padding(.vertical, 12)
                }
            } else if store.isStarting || store.isRefreshing {
                Section { LoadingPlaceholder(label: "Loading your wallet", rows: 2, balance: true) }
            } else {
                Section {
                    ContentUnavailableView("Wallet unavailable", systemImage: "wifi.exclamationmark", description: Text("Check your connection and try again."))
                    AsyncAction("Try again", loadingTitle: "Trying again…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                }
            }
            if let merchant = store.dashboard?.merchant {
                Section(merchant.name) {
                    LabeledContent("Confirmed payments", value: String(merchant.confirmedCount))
                }
            }
            if let warning = store.walletRefreshError {
                Section { StatusMessage(title: warning, systemImage: "wifi.exclamationmark") }
            }
            Section { NoticeView() }
        }.navigationTitle("Wallet")
            .task { await store.loadFunding() }
            .modifier(AccountRefreshActions())
    }
    private var paymentState: String {
        if store.dashboard?.cards?.isEmpty == true { return "Add an IC card to pay" }
        guard let policy = store.dashboard?.policy else { return "Set spending limits" }
        guard policy.enabled else { return "Frozen · no new payments" }
        if let expiry = AppDates.date(policy.expiresAt), expiry <= Date() { return "Expired · review limits" }
        return "Enabled"
    }
}
struct WalletAddressRow: View {
    let address: String
    var showsLabel = false
    @State private var copied = false
    @State private var copySequence = 0
    private var shortAddress: String {
        address.count > 14 ? "\(address.prefix(6))…\(address.suffix(4))" : address
    }
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                if showsLabel { Text("Wallet address").font(.caption).foregroundStyle(.secondary) }
                Text(shortAddress).font(.body.monospaced())
                    .lineLimit(1).truncationMode(.middle)
                    .accessibilityLabel("Wallet address").accessibilityValue(address)
                if copied { Text("Copied").font(.caption).foregroundStyle(.tint) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Button {
                UIPasteboard.general.string = address
                copied = true; copySequence += 1
                UIAccessibility.post(notification: .announcement, argument: "Wallet address copied.")
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.body.weight(.medium)).frame(width: 44, height: 44).contentShape(Rectangle())
            }.buttonStyle(.borderless)
                .accessibilityLabel("Copy wallet address")
                .accessibilityHint("Copies the complete address to the clipboard.")
        }.task(id: copySequence) {
            guard copySequence > 0 else { return }
            do { try await Task.sleep(for: .seconds(3)); copied = false } catch {}
        }.onChange(of: address) { _, _ in copied = false }
            .sensoryFeedback(.success, trigger: copySequence)
    }
}
struct FundingNetworkSummary: View {
    let networkName: String
    let symbol: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(networkName, systemImage: "network").font(.headline)
            if !symbol.isEmpty {
                Text("\(symbol) · Test tokens").font(.subheadline).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 4).fixedSize(horizontal: false, vertical: true)
    }
}

struct FundingView: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    private var cardMissing: Bool { cardID != nil && card == nil }
    private var address: String? { store.wallet(for: cardID)?.address ?? store.walletCreation(for: cardID)?.readyAddress }
    private var chainID: String {
        if let value = store.wallet(for: cardID)?.chainId, !value.isEmpty { return value }
        return store.config?.chainId ?? ""
    }
    private var networkName: String { chainID == "11155111" ? "Ethereum Sepolia" : chainID.isEmpty ? "Network details unavailable" : "Chain ID \(chainID)" }
    private var symbol: String { store.wallet(for: cardID)?.symbol ?? store.config?.token.symbol ?? "" }
    private var tokenContract: String? {
        guard let value = store.config?.token.address,
              value.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil,
              value.lowercased() != "0x" + String(repeating: "0", count: 40) else { return nil }
        return value
    }
    var body: some View {
        List {
            if cardMissing {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            } else {
                if let card {
                    Section {
                        CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id)
                    }.listRowBackground(Color.clear)
                }
                if let address {
                    if store.account?.role == "customer", store.account?.verified == true {
                        TestFundingSection(cardID: cardID, address: address)
                    }
                    Section {
                        if !store.paymentsAvailable || store.wallet(for: cardID) == nil || store.wallet(for: cardID)?.availability == .pendingSetup {
                            Label(store.paymentsAvailable ? "Funding details unavailable" : "Funding setup pending", systemImage: "clock")
                                .font(.headline)
                            Text(store.paymentsAvailable ? "Refresh before sending funds." : "Wait for setup before sending funds.")
                                .font(.subheadline)
                            AsyncAction("Refresh details", loadingTitle: "Refreshing details…", systemImage: "arrow.clockwise") {
                                await store.run { try await store.refresh() }; await store.loadFunding(cardID: cardID)
                            }.disabled(store.busy)
                        }
                        FundingNetworkSummary(networkName: networkName, symbol: symbol)
                        WalletAddressRow(address: address, showsLabel: true)
                        ShareLink(item: address) { Label("Share address", systemImage: "square.and.arrow.up") }
                    } header: {
                        Text(symbol.isEmpty ? "Receive tokens" : "Receive \(symbol)")
                    } footer: {
                        Text("Use \(networkName) only. Test tokens have no cash value or USD backing.")
                    }
                    Section {
                        DisclosureGroup("Network fees & token details") {
                            Text("Keep a small native-token balance for network fees.").font(.subheadline)
                            LabeledContent("App token name", value: store.config?.token.name ?? "IC Stablecoin")
                            LabeledContent("App symbol", value: symbol.isEmpty ? "icUSD" : symbol)
                            if let original = store.config?.token.onchainSymbol ?? store.wallet(for: cardID)?.onchainSymbol {
                                LabeledContent("On-chain symbol", value: original)
                                Text("The app name does not change this existing token contract or convert its units. This test token has no cash value or USD backing.").font(.footnote)
                            }
                            if let tokenContract {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Token contract").font(.caption).foregroundStyle(.secondary)
                                    Text(tokenContract).font(.footnote.monospaced()).textSelection(.enabled)
                                        .accessibilityLabel("Token contract").accessibilityValue(tokenContract)
                                }
                            } else { Text("Token contract unavailable.").font(.subheadline) }
                        }
                    }
                    Section("Recent funding") {
                        FundingHistoryNotice(cardID: cardID)
                        if let transfers = store.funding(for: cardID), !transfers.isEmpty {
                            ForEach(transfers) { FundingRow(transfer: $0) }
                        } else if store.fundingStatus(for: cardID) == "available", store.funding(for: cardID) != nil {
                            StatusMessage(title: store.fundingHistoryComplete(for: cardID) == false ? "No recent incoming transfers returned" : "No incoming funds yet", systemImage: "arrow.down.circle")
                        } else { FundingActivityStatus(loading: store.isLoadingFunding(for: cardID), cardID: cardID) }
                    }
                } else if store.isRefreshing {
                    LoadingPlaceholder(label: "Loading funding details", rows: 2, balance: true)
                } else {
                    ContentUnavailableView("Wallet unavailable", systemImage: "wallet.bifold")
                    AsyncAction("Refresh wallet", loadingTitle: "Refreshing wallet…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                }
            }
            Section { NoticeView() }
        }.navigationTitle("Add funds").navigationBarTitleDisplayMode(.inline).task { await store.loadFunding(cardID: cardID) }
            .modifier(AccountRefreshActions(cardID: cardID))
    }
}
struct ActivityView: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    private var cardMissing: Bool { cardID != nil && card == nil }
    private var payments: [Payment] { (store.dashboard?.payments ?? []).filter { cardID == nil || $0.cardId == cardID } }
    private var activity: [WalletActivity] { WalletActivity.timeline(payments: payments, funding: store.funding(for: cardID) ?? [], rewards: store.rewards(for: cardID) ?? []) }
    private var hasCompleteHistory: Bool { store.dashboard != nil && store.fundingStatus(for: cardID) == "available" && store.funding(for: cardID) != nil && store.fundingHistoryComplete(for: cardID) != false && (store.account?.role != "customer" || !store.rewardsAvailable || (store.rewardsStatus(for: cardID) == "available" && store.rewards(for: cardID) != nil)) }
    var body: some View {
        List {
            if cardMissing {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            } else {
                if let card {
                    Section { CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id) }
                        .listRowBackground(Color.clear)
                }
                if !activity.isEmpty { ForEach(activity) { ActivityRow(activity: $0) } }
                else if hasCompleteHistory {
                    MascotEmptyState(title: "No activity yet", detail: "Payments, funding and rewards appear here.")
                }
                if store.dashboard == nil && !store.isStarting && !store.isRefreshing {
                    Section("Payment history unavailable") {
                        AsyncAction("Retry payment history", loadingTitle: "Loading payments…", systemImage: "arrow.clockwise") { await store.run { try await store.refresh() } }.disabled(store.busy)
                    }
                }
                if store.fundingHistoryComplete(for: cardID) == false, store.fundingStatus(for: cardID) == "available" {
                    Section { FundingHistoryNotice(cardID: cardID) }
                }
                if store.fundingStatus(for: cardID) != "available" || store.funding(for: cardID) == nil {
                    Section { FundingActivityStatus(loading: store.isLoadingFunding(for: cardID), cardID: cardID) }
                }
                if store.account?.role == "customer", store.rewardsAvailable, store.rewardsStatus(for: cardID) != "available" || store.rewards(for: cardID) == nil {
                    Section { RewardsLoadStatus(cardID: cardID) }
                }
            }
            Section { NoticeView() }
        }.navigationTitle("Activity")
            .navigationBarTitleDisplayMode(cardID == nil ? .automatic : .inline)
            .task { await store.loadFunding(cardID: cardID); await store.loadRewards(cardID: cardID) }
            .modifier(AccountRefreshActions(cardID: cardID, refreshRewards: true))
    }
}
struct ActivityRow: View {
    let activity: WalletActivity
    var body: some View {
        switch activity {
        case .payment(let payment): PaymentRow(payment: payment)
        case .funding(let transfer): FundingRow(transfer: transfer)
        case .reward(let event): RewardActivityRow(event: event)
        }
    }
}
struct FundingHistoryNotice: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.fundingHistoryComplete(for: cardID) == false, store.fundingStatus(for: cardID) == "available" {
            StatusMessage(title: "Funding history is incomplete", detail: "Older transfers may be missing. Recent results are shown.", systemImage: "exclamationmark.circle")
        }
    }
}
struct FundingActivityStatus: View {
    @Environment(AppStore.self) private var store
    let loading: Bool
    var cardID: String? = nil
    var body: some View {
        if loading || store.isLoadingFunding(for: cardID) || store.fundingStatus(for: cardID) == nil {
            LoadingPlaceholder(label: "Loading incoming funds", rows: 2)
        } else if store.fundingStatus(for: cardID) == "pending_setup" {
            StatusMessage(title: "Funding setup pending", systemImage: "clock")
        } else if store.fundingStatus(for: cardID) == "unavailable" || store.funding(for: cardID) == nil {
            StatusMessage(title: "Couldn’t load incoming funds", detail: "Check your connection and try again.", systemImage: "wifi.exclamationmark")
            AsyncAction("Retry incoming funds", loadingTitle: "Checking incoming funds…", systemImage: "arrow.clockwise") { await store.loadFunding(cardID: cardID) }
        }
    }
}
/// One adaptive hierarchy for payments, funding and reward activity.
struct ActivitySummary: View {
    let title: String
    let amount: String
    let status: String
    let createdAt: String
    let symbol: String
    var incoming = false
    var detail: String? = nil
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.body.weight(.medium))
                .foregroundStyle(.tint).frame(width: 28, height: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(title).font(.body).fixedSize()
                        Spacer(minLength: 0)
                        amountLabel.fixedSize()
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.body)
                        amountLabel
                    }
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) { metadata.fixedSize() }
                    VStack(alignment: .leading, spacing: 3) { metadata }
                }.font(.caption).foregroundStyle(Color.primary.opacity(0.7))
                if let detail { Text(detail).font(.footnote).fixedSize(horizontal: false, vertical: true) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.padding(.vertical, 6).accessibilityElement(children: .combine)
    }
    private var amountLabel: some View {
        Text(amount).font(.body.weight(.semibold)).monospacedDigit()
            .foregroundStyle(incoming ? Color("AccentColor") : .primary)
    }
    @ViewBuilder private var metadata: some View {
        Text(status)
        if let date = AppDates.date(createdAt) { Text(date, format: .dateTime.month().day().hour().minute()) }
    }
}

struct FundingRow: View {
    let transfer: FundingTransfer
    var body: some View {
        NavigationLink {
            Form {
                Section {
                    Label("Incoming funds", systemImage: "arrow.down.circle")
                    LabeledContent("Type", value: "Test-token funding")
                    if let name = transfer.name { LabeledContent("Token", value: name) }
                    if let original = transfer.onchainSymbol { LabeledContent("On-chain symbol", value: original) }
                    LabeledContent("Amount", value: "+\(TokenAmount.display(transfer.amount, decimals: transfer.decimals)) \(transfer.symbol)")
                    LabeledContent("Status", value: transfer.status.capitalized)
                    if let date = AppDates.date(transfer.createdAt) { LabeledContent("Date", value: date.formatted(date: .abbreviated, time: .shortened)) }
                }
                Section("From") { Text(transfer.from).font(.footnote.monospaced()).textSelection(.enabled) }
                Section("Transaction") {
                    Text(transfer.txHash).font(.footnote.monospaced()).textSelection(.enabled)
                    if let value = transfer.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View on block explorer", destination: url) }
                }
            }.navigationTitle("Incoming funds").navigationBarTitleDisplayMode(.inline)
        } label: {
            ActivitySummary(title: "Incoming funds", amount: "+\(TokenAmount.display(transfer.amount, decimals: transfer.decimals)) \(transfer.symbol)", status: transfer.status.capitalized, createdAt: transfer.createdAt, symbol: "arrow.down.left", incoming: transfer.status == "confirmed")
        }
    }
}
struct PaymentRow: View {
    let payment: Payment
    var body: some View {
        NavigationLink {
            Form {
                LabeledContent("Merchant", value: payment.merchantName)
                PaymentTotals(gross: payment.grossAmount, discount: payment.discountAmount, total: payment.amount, decimals: payment.decimals, symbol: payment.symbol, final: payment.status == "confirmed")
                LabeledContent("Status", value: payment.status.replacingOccurrences(of: "_", with: " ").capitalized)
                if let reason = PaymentIssue.message(code: payment.errorCode, status: payment.status) { Text(reason).font(.subheadline) }
                if let date = AppDates.date(payment.createdAt) { Text(date, format: .dateTime.month().day().hour().minute()).foregroundStyle(.secondary) }
                DisclosureGroup("Transaction details") {
                    if let reward = payment.rewardId { LabeledContent(payment.status == "confirmed" ? "Reward used" : "Reward selected", value: reward) }
                    if let hash = payment.txHash { Text(hash).font(.footnote.monospaced()).textSelection(.enabled) }
                    if let value = payment.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View on block explorer", destination: url) }
                }
            }.navigationTitle("Payment").navigationBarTitleDisplayMode(.inline)
        } label: {
            ActivitySummary(title: payment.merchantName, amount: "\(TokenAmount.display(payment.amount, decimals: payment.decimals)) \(payment.symbol)", status: payment.status.replacingOccurrences(of: "_", with: " ").capitalized, createdAt: payment.createdAt, symbol: "arrow.up.right", detail: PaymentIssue.message(code: payment.errorCode, status: payment.status))
        }
    }
}

struct TestFundingSection: View {
    let cardID: String?
    let address: String
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var checkedOnOpen = false
    private var response: TestFundingResponse? { store.testFunding(for: cardID) }
    private var enabled: Bool { store.config?.capabilities.testFunding == true }
    private var pending: Bool { response?.claim?.isPending == true }
    private var amount: String {
        guard let response else { return "1,000 test " + (store.config?.token.symbol ?? "icUSD") }
        let value = TokenAmount.display(response.amount, decimals: store.config?.token.decimals ?? 18)
        return (value == "1000" ? "1,000" : value) + " test " + response.symbol
    }
    private var canClaim: Bool {
        enabled && checkedOnOpen && scenePhase == .active && response?.permitsNewClaim == true &&
        !store.isClaimingTestFunding && !store.isLoadingTestFunding(for: cardID) && store.testFundingError(for: cardID) == nil
    }
    private var pollingIdentity: String {
        "\(scenePhase == .active)-\(cardID ?? "account")-\(enabled)"
    }
    var body: some View {
        Section {

            if let claim = response?.claim {
                let matches = claim.belongsTo(cardID: cardID, address: address)
                if !matches {
                    StatusMessage(title: "Grant belongs to another card", detail: "This account’s grant is assigned to a different wallet. It will not be added to the card shown here.", systemImage: "creditcard")
                    DisclosureGroup("Grant destination") {
                        if let linked = store.dashboard?.cards?.first(where: { $0.id == claim.cardId }) { Text("\(linked.nickname) · ending \(linked.last4)") }
                        WalletAddressRow(address: claim.walletAddress)
                    }
                }
                if claim.status == "confirmed" {
                    Label(matches ? "Test tokens received" : "Grant confirmed in the other wallet", systemImage: "checkmark.circle")
                } else if claim.isPending {
                    ProgressStatus(title: "Test-token request saved", detail: claim.progressMessage)
                } else {
                    StatusMessage(title: "Test-token request needs attention", detail: claim.progressMessage, systemImage: "exclamationmark.circle")
                }
                if claim.txHash != nil || claim.errorCode != nil {
                    DisclosureGroup("Transfer details") {
                        if let value = claim.explorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View transfer", destination: url) }
                        if let hash = claim.txHash { Text(hash).font(.footnote.monospaced()).textSelection(.enabled) }
                        if let code = claim.errorCode { Text(code.replacingOccurrences(of: "_", with: " ")).font(.footnote) }
                    }
                }
            } else if store.isClaimingTestFunding {
                ProgressStatus(title: "Saving your request", detail: "You can leave this screen. Check status when you return.")
            } else if !checkedOnOpen || store.isLoadingTestFunding(for: cardID) {
                LoadingPlaceholder(label: "Checking test-token availability", rows: 1)
            } else if !enabled {
                StatusMessage(title: "Test funding is not available yet", detail: "Check again later.", systemImage: "clock")
            } else if let response, !response.permitsNewClaim {
                StatusMessage(title: "Test funding unavailable", detail: response.unavailableMessage, systemImage: "clock")
            } else {
                AsyncAction("Get \(amount)", loadingTitle: "Requesting test tokens…", prominent: true) { await store.claimTestFunding(cardID: cardID) }
                    .disabled(!canClaim)
            }
            if let error = store.testFundingError(for: cardID) { StatusMessage(title: error, systemImage: "wifi.exclamationmark") }
            if checkedOnOpen, !store.isClaimingTestFunding, !store.isLoadingTestFunding(for: cardID), (!canClaim || response?.claim != nil) {
                AsyncAction("Check status", loadingTitle: "Checking…", systemImage: "arrow.clockwise") { await store.loadTestFunding(cardID: cardID) }
            }
        } header: {
            Text("Test funds")
        } footer: {
            Text("Free test tokens, no cash value. One grant per verified account across all cards. Network fees and spending permission are separate.")
        }
        .task(id: pollingIdentity) {
            guard scenePhase == .active else { checkedOnOpen = false; return }
            checkedOnOpen = false
            await store.loadTestFunding(cardID: cardID)
            guard !Task.isCancelled else { return }
            checkedOnOpen = true
            // Claim changes must not cancel the GET that is refreshing a newly confirmed balance.
            // Stay ready for a POST made on this screen, without sending requests when no claim is pending.
            while !Task.isCancelled, scenePhase == .active {
                do { try await Task.sleep(for: .seconds(4)) } catch { return }
                if pending, !store.isLoadingTestFunding(for: cardID) { await store.loadTestFunding(cardID: cardID) }
            }
        }
    }
}
