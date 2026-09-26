import SwiftUI

struct RewardsView: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    private var card: LinkedCard? { store.dashboard?.cards?.first { $0.id == cardID } }
    private var missingCard: Bool { cardID != nil && card == nil }
    private var items: [RewardVoucher] { store.rewards(for: cardID) ?? [] }
    private var available: [RewardVoucher] { items.filter(\.hasSpendableValue) }
    private var collection: [RewardVoucher] { items.filter { !$0.hasSpendableValue && $0.nftOwned == true } }
    private var history: [RewardVoucher] { items.filter { !$0.hasSpendableValue && $0.nftOwned != true } }
    var body: some View {
        List {
            if missingCard {
                ContentUnavailableView("Card no longer linked", systemImage: "creditcard")
            } else {
                if let card {
                    Section { CardWalletIdentity(card: card, usesSuicaArtwork: card.id == store.dashboard?.cards?.first?.id) }
                        .listRowBackground(Color.clear)
                }
                Section {
                    NavigationLink { PolicyView(cardID: cardID) } label: {
                        LabeledContent("Use rewards automatically", value: store.policy(for: cardID)?.useRewards == true ? "Enabled" : "Off")
                    }.disabled(!store.paymentsAvailable)
                    if let policy = store.policy(for: cardID), policy.requiresApproval == true || !store.policyRouterMatchesActive(cardID: cardID) || card?.allowanceSufficient == false {
                        StatusMessage(title: "Wallet approval needed", detail: "Review spending permission to use credit with the current payment system.", systemImage: "hand.raised")
                    }
                }
                if store.rewardsStatus(for: cardID) == "available", store.rewards(for: cardID) != nil {
                    if items.isEmpty {
                        MascotEmptyState(title: "Your IC Voucher collection", detail: store.loyaltyAvailable ? "Existing IC Vouchers and their artwork appear here. New shop points have their own balance." : "Qualifying purchases can earn credit and collectible art.")
                    }
                    if !available.isEmpty { Section("Available to use") { ForEach(available, id: \.collectionIdentity) { RewardRow(reward: $0) } } }
                    if !collection.isEmpty { Section("IC Voucher collection") { ForEach(collection, id: \.collectionIdentity) { RewardRow(reward: $0) } } }
                    if !history.isEmpty { Section("Previous IC Vouchers") { ForEach(history, id: \.collectionIdentity) { RewardRow(reward: $0) } } }
                } else { Section { RewardsLoadStatus(cardID: cardID) } }
            }
            if !missingCard {
                Section {
                    DisclosureGroup("How rewards work") {
                        Text(store.loyaltyAvailable ? "Earlier IC Voucher credit keeps its original terms. New purchases earn shop points separately; points payments do not issue a new monetary IC Voucher." : "Qualifying purchases can earn credit for a later visit to the same shop. Your collectible stays after you use its credit.").font(.subheadline)
                        Text("Credit is separate from your wallet and transit balances. Percentage rewards keep their original terms.").font(.subheadline)
                    }
                }
            }
            Section { NoticeView() }
        }.navigationTitle("IC Voucher").navigationBarTitleDisplayMode(cardID == nil ? .automatic : .inline)
            .task { await store.loadRewards(cardID: cardID) }
            .modifier(AccountRefreshActions(cardID: cardID, refreshFunding: false, refreshRewards: true))
    }
}
struct CollectibleArtwork: View {
    let reward: RewardVoucher
    var thumbnail = false
    var body: some View {
        Group {
            if let url = reward.artworkURL {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFit()
                    case .empty: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                    default: unavailable
                    }
                }
            } else { unavailable }
        }
        .frame(width: thumbnail ? 68 : nil, height: thumbnail ? 84 : 240)
        .frame(maxWidth: thumbnail ? nil : .infinity)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(thumbnail ? "Collectible artwork" : "Collectible artwork from \(reward.merchantName)")
    }
    private var unavailable: some View {
        VStack(spacing: 6) {
            Image(systemName: "photo").font(thumbnail ? .title3 : .largeTitle)
            if !thumbnail { Text("Artwork unavailable").font(.caption) }
        }.foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
struct RewardRow: View {
    let reward: RewardVoucher
    @Environment(AppStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var decimals: Int { reward.decimals ?? store.config?.token.decimals ?? 18 }
    private var unit: String { reward.symbol ?? store.config?.token.symbol ?? "tokens" }
    var body: some View {
        NavigationLink { RewardDetailView(reward: reward) } label: {
            let layout = dynamicTypeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
            layout {
                if reward.imageUrl != nil || reward.isCredit { CollectibleArtwork(reward: reward, thumbnail: true).accessibilityHidden(true) }
                VStack(alignment: .leading, spacing: 5) {
                    Text(reward.merchantName).font(.body)
                    if reward.isCredit {
                        if let remaining = reward.remainingCredit {
                            Text(TokenAmount.display(remaining, decimals: decimals) + " " + unit + " credit left").font(.headline)
                        } else { Text("Credit unavailable").font(.subheadline) }
                    } else {
                        Text(reward.percentage + " off").font(.headline)
                        if let maxDiscount = reward.maxDiscount { Text("Up to \(TokenAmount.display(maxDiscount, decimals: decimals)) \(unit)").font(.caption) }
                    }
                    Text(reward.statusTitle).font(.caption).foregroundStyle(Color.primary.opacity(0.7))
                    if reward.hasSpendableValue, let expiry = AppDates.date(reward.expiresAt) { Text("Use by \(expiry.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(Color.primary.opacity(0.7)) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, 5)
        }
    }
}
struct CollectiblePreview: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    private var items: [RewardVoucher] { (store.rewards(for: cardID) ?? []).filter { $0.nftOwned == true || $0.hasSpendableValue } }
    private var subtitle: String {
        let emptyTitle = store.loyaltyAvailable ? "Earlier IC Vouchers and art" : "Credit and collectible art"
        guard store.rewardsStatus(for: cardID) == "available" else { return emptyTitle }
        return items.isEmpty ? emptyTitle : "\(items.count) in your collection"
    }
    var body: some View {
        Section {
            NavigationLink { RewardsView(cardID: cardID) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "photo.on.rectangle").foregroundStyle(.tint).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("IC Voucher collection").font(.body)
                        Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 4)
            }
        }.task { await store.loadRewards(cardID: cardID) }
    }
}
struct RewardDetailView: View {
    let reward: RewardVoucher
    @Environment(AppStore.self) private var store
    private var unit: String { reward.symbol ?? store.config?.token.symbol ?? "tokens" }
    private func amount(_ value: String) -> String { TokenAmount.display(value, decimals: reward.decimals ?? store.config?.token.decimals ?? 18) + " " + unit }
    var body: some View {
        Form {
            if reward.imageUrl != nil || reward.isCredit { Section { CollectibleArtwork(reward: reward) }.listRowInsets(EdgeInsets()) }
            Section {
                Text(reward.merchantName).font(.headline)
                if reward.isCredit {
                    if let remaining = reward.remainingCredit { Text(amount(remaining) + " credit left").font(.title2.weight(.semibold)) }
                    if let credit = reward.creditAmount { LabeledContent("Credit earned", value: amount(credit)) }
                } else {
                    Text(reward.percentage + " off your next visit").font(.title2.weight(.semibold))
                    if let cap = reward.maxDiscount { LabeledContent("Maximum discount", value: amount(cap)) }
                }
                LabeledContent("Status", value: reward.statusTitle)
                if let expiry = AppDates.date(reward.expiresAt) { LabeledContent(reward.isCredit ? "Credit expires" : "Expires", value: expiry.formatted(date: .abbreviated, time: .shortened)) }
                DisclosureGroup("Using this reward") {
                    Text(reward.isCredit
                        ? "Use credit on a later purchase at this shop. Unused credit remains until expiry; the collectible stays after redemption."
                        : "This percentage reward keeps its original terms and is consumed when redeemed.").font(.subheadline)
                    Text("Automatic use requires your separate opt-in. Purchases using a reward do not earn another reward.").font(.subheadline)
                }
            }
            Section("Earned from a purchase") {
                if let purchase = reward.purchaseAmount { LabeledContent("Purchase", value: amount(purchase)) }
                if let date = reward.earnedAt.flatMap(AppDates.date) { LabeledContent("Earned", value: date.formatted(date: .abbreviated, time: .shortened)) }
                if let value = reward.earnedExplorerUrl, let url = URL(string: value), url.scheme == "https" { Link("View purchase", destination: url) }
            }
            if !RewardActivity.events(reward).isEmpty {
                Section("Credit & reward history") {
                    ForEach(RewardActivity.events(reward)) { event in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(event.kind == .earned ? (reward.isCredit ? "Credit earned" : "Reward earned") : (reward.isCredit ? "Credit used" : "Reward used"))
                            if let value = event.discountAmount { Text(amount(value)).font(.subheadline) }
                            if let remaining = event.remainingCredit { Text(amount(remaining) + " remaining").font(.caption) }
                            if let date = AppDates.date(event.createdAt) { Text(date, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary) }
                            if let value = event.explorerURL, let url = URL(string: value), url.scheme == "https" { Link("View transaction", destination: url).font(.subheadline) }
                        }
                    }
                }
            }
            Section {
                DisclosureGroup("IC Voucher details") {
                    LabeledContent("Token ID", value: reward.tokenId ?? reward.id)
                    if let address = reward.contractAddress { Text(address).font(.footnote.monospaced()).textSelection(.enabled) }
                    Text(reward.walletAddress).font(.footnote.monospaced()).textSelection(.enabled)
                    if let owned = reward.nftOwned { LabeledContent("Held in wallet", value: owned ? "Yes" : "No") }
                    Text("IC Voucher credit is separate from your wallet balance and Suica yen balance.").font(.footnote)
                }
            }
        }.navigationTitle(reward.isCredit ? "IC Voucher" : "Percentage IC Voucher").navigationBarTitleDisplayMode(.inline)
    }
}
struct RewardsLoadStatus: View {
    var cardID: String? = nil
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.isLoadingRewards(for: cardID) || store.rewardsStatus(for: cardID) == nil {
            LoadingPlaceholder(label: "Loading IC Vouchers", rows: 2)
        } else if store.rewardsStatus(for: cardID) == "pending_setup" {
            StatusMessage(title: "Rewards setup pending", detail: "Your wallet and normal payment history remain available.", systemImage: "gift")
        } else {
            StatusMessage(title: "Rewards unavailable", detail: store.rewardsError(for: cardID) ?? "Try again to load the latest rewards.", systemImage: "wifi.exclamationmark")
            AsyncAction("Retry rewards", loadingTitle: "Loading rewards…", systemImage: "arrow.clockwise") { await store.loadRewards(cardID: cardID) }
        }
    }
}
struct RewardActivityRow: View {
    let event: RewardActivity
    @Environment(AppStore.self) private var store
    private var title: String { event.reward.isCredit ? (event.kind == .earned ? "Credit earned" : "Credit used") : (event.kind == .earned ? "Reward earned" : "Reward redeemed") }
    private var amount: String {
        if event.reward.isCredit, let value = event.kind == .earned ? event.reward.creditAmount : event.discountAmount {
            return TokenAmount.display(value, decimals: event.reward.decimals ?? store.config?.token.decimals ?? 18) + " " + (event.reward.symbol ?? store.config?.token.symbol ?? "tokens")
        }
        return event.reward.isCredit ? "Credit unavailable" : event.reward.percentage + " off"
    }
    var body: some View {
        NavigationLink { RewardDetailView(reward: event.reward) } label: {
            ActivitySummary(title: event.reward.merchantName, amount: amount, status: title, createdAt: event.createdAt, symbol: event.kind == .earned ? "gift" : "tag")
        }
    }
}

struct MerchantPercentageRewardsView: View {
    @Environment(AppStore.self) private var store
    @State private var form = RewardCampaignDraft()
    @State private var loaded = false
    private var locked: Bool { store.campaignRequestPending || store.rewardCampaign?.operation?.isPending == true }
    private var hasChanges: Bool { store.rewardCampaign?.campaign.map { !form.matches($0, decimals: store.config?.token.decimals ?? 18) } ?? true }
    private var canSubmit: Bool { store.campaignRequestPending || (store.rewardsAvailable && store.rewardCampaign?.status == "available" && store.campaignError == nil) }
    private var symbol: String { store.config?.token.symbol ?? "tokens" }
    private var decimals: Int { store.config?.token.decimals ?? 18 }
    private var offerState: String {
        if locked { return "Update pending" }
        if hasChanges { return "Draft · not saved" }
        return store.rewardCampaign?.campaign?.enabled == true ? "Active for this shop" : "Paused"
    }
    private var actionTitle: String {
        if store.campaignRequestPending { return "Recover update" }
        if form.enabled && store.rewardCampaign?.campaign?.enabled != true { return "Enable rewards" }
        if !form.enabled && store.rewardCampaign?.campaign?.enabled == true { return "Pause rewards" }
        return "Save changes"
    }
    var body: some View {
        Form {
            Section {
                Toggle("Enable rewards", isOn: $form.enabled)
                    .disabled(!loaded || locked || store.busy || !store.rewardsAvailable)
            } footer: {
                Text(store.loyaltyAvailable ? "Earlier percentage offer. New points payments use your points program instead." : "One offer for your shop. Customers earn rewards on qualifying purchases.")
            }
            if !store.rewardsAvailable || store.rewardCampaign?.status == "pending_setup" {
                Section { StatusMessage(title: "Rewards setup pending", detail: "You can enable your offer when rewards are available on this network.", systemImage: "clock") }
            }
            if !loaded && store.isLoadingCampaign {
                Section { LoadingPlaceholder(label: "Loading your offer", rows: 2) }
            } else if loaded {
                Section("Offer") {
                    Text(offerState).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text(form.offerSummary(decimals: decimals, symbol: symbol) ?? "Complete the offer details below to see your summary.")
                    DisclosureGroup("How rewards are earned") {
                        Text("A full-price qualifying payment earns one reward. A discounted payment does not earn another.").font(.subheadline)
                    }
                    DisclosureGroup("Customize offer") {
                        offerField("Qualifying purchase", unit: symbol, text: $form.minimumPurchase)
                        offerField("Next-visit discount", unit: "%", text: $form.discountPercent)
                        offerField("Maximum discount", unit: symbol, text: $form.maximumDiscount)
                        offerField("Reward valid for", unit: "days", text: $form.validityDays)
                    }.disabled(locked || store.busy || !store.rewardsAvailable)
                }
                if let campaign = store.rewardCampaign?.campaign, hasChanges || locked {
                    Section(campaign.enabled ? "Currently active" : "Currently paused") {
                        Text(RewardFormatting.offer(campaign, decimals: decimals, symbol: symbol)).font(.subheadline)
                        Text("Your changes apply after confirmation. Existing rewards keep their original terms.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if store.rewardCampaign?.campaign != nil {
                    Section { Text("Pausing stops new rewards. Already-earned rewards remain valid until they expire.").font(.footnote).foregroundStyle(.secondary) }
                }
            }
            if let operation = store.rewardCampaign?.operation {
                Section {
                    if operation.isPending {
                        ProgressStatus(title: "Updating your offer", detail: "Waiting for confirmation. You can leave this screen.")
                    } else if operation.status == "failed" {
                        StatusMessage(title: "Offer update did not complete", detail: "Your previous offer is unchanged. Review the details and retry.", systemImage: "exclamationmark.circle")
                    } else if !hasChanges && !store.campaignRequestPending {
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
            } else if store.campaignRequestPending {
                Section { StatusMessage(title: "Checking your last update", detail: "Recover the update to check whether it was received. Your offer will not be submitted twice.", systemImage: "clock") }
            }
            if let error = store.campaignError { Section { StatusMessage(title: error, systemImage: "wifi.exclamationmark") } }
            Section {
                if CampaignRecovery.showsSubmit(hasPendingRequest: store.campaignRequestPending, operation: store.rewardCampaign?.operation, hasReadError: store.campaignError != nil) {
                    AsyncAction(actionTitle, loadingTitle: "Submitting update…", prominent: true) { await store.saveRewardCampaign(form) }
                        .disabled(!loaded || store.busy || !canSubmit || (!hasChanges && !store.campaignRequestPending))
                }
                if store.campaignError != nil || locked {
                    AsyncAction("Check status", loadingTitle: "Checking…", systemImage: "arrow.clockwise") { await store.loadRewardCampaign() }.disabled(store.busy || store.isLoadingCampaign)
                }
                if hasChanges && !locked { Text("Save to apply this offer to your shop.").font(.footnote).foregroundStyle(.secondary) }
                NoticeView()
            }
        }.navigationTitle(store.loyaltyAvailable ? "Earlier IC Voucher offer" : "Shop rewards").navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.loadRewardCampaign() }
            .modifier(FormKeyboardActions())
            .task {
                await store.loadRewardCampaign()
                guard !loaded else { return }
                do {
                    var restored = try store.savedRewardCampaignDraft()
                    restored.requestID = nil // The store, not editable form state, owns durable request identity.
                    form = restored; loaded = true
                }
                catch { store.error = error.localizedDescription }
            }
            .onChange(of: form) { _, value in
                guard loaded, !locked else { return }
                do { try store.saveRewardCampaignDraft(value) }
                catch { store.error = error.localizedDescription }
            }
            .task(id: store.rewardCampaign?.operation?.id) {
                while !Task.isCancelled, store.rewardCampaign?.operation?.isPending == true {
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    guard !Task.isCancelled else { return }
                    await store.loadRewardCampaign()
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

struct MerchantRewardsView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        if store.config?.capabilities.collectibles != nil {
            MerchantCollectibleCampaignView()
        } else { MerchantPercentageRewardsView() }
    }
}

struct MerchantCollectibleCampaignView: View {
    @Environment(AppStore.self) private var store
    @State private var form = CollectibleCampaignDraft()
    @State private var loaded = false
    private var locked: Bool { store.collectibleCampaignRequestPending || store.collectibleCampaign?.operation?.isPending == true }
    private var hasChanges: Bool { store.collectibleCampaign?.campaign.map { !form.matches($0, decimals: store.config?.token.decimals ?? 18) } ?? true }
    private var canSubmit: Bool { store.collectibleCampaignRequestPending || (store.collectiblesAvailable && store.collectibleCampaign?.status == "available" && store.collectibleCampaignError == nil) }
    private var symbol: String { store.config?.token.symbol ?? "tokens" }
    private var decimals: Int { store.config?.token.decimals ?? 18 }
    private var offerState: String {
        if locked { return "Update pending" }
        if hasChanges { return "Draft · not saved" }
        return store.collectibleCampaign?.campaign?.enabled == true ? "Active for this shop" : "Paused"
    }
    private var actionTitle: String {
        if store.collectibleCampaignRequestPending { return "Recover update" }
        if form.enabled && store.collectibleCampaign?.campaign?.enabled != true { return "Enable purchase rewards" }
        if !form.enabled && store.collectibleCampaign?.campaign?.enabled == true { return "Pause rewards" }
        return "Save changes"
    }
    var body: some View {
        Form {
            Section {
                Toggle("Enable purchase rewards", isOn: $form.enabled)
                    .disabled(!loaded || locked || store.busy || !store.collectiblesAvailable)
            } footer: {
                Text(store.loyaltyAvailable ? "Earlier IC Voucher program. It does not add voucher credit to new points payments." : "One offer for your shop. Qualifying purchases earn credit and collectible art.")
            }
            if !store.collectiblesAvailable || store.collectibleCampaign?.status == "pending_setup" {
                Section { StatusMessage(title: "Rewards setup pending", detail: "You can enable your offer when rewards are available on this network.", systemImage: "clock") }
            }
            if !loaded && store.isLoadingCollectibleCampaign {
                Section { LoadingPlaceholder(label: "Loading your offer", rows: 2) }
            } else if loaded {
                Section("Offer") {
                    Text(offerState).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                    Text(form.summary(decimals: decimals, symbol: symbol) ?? "Complete the offer details below to see your summary.")
                    DisclosureGroup("How credit is earned") {
                        Text("Credit is based on the purchase amount. Customers keep the collectible after using its credit. Reward-funded purchases do not earn more credit.").font(.subheadline)
                    }
                    DisclosureGroup("Customize offer") {
                        offerField("Qualifying purchase", unit: symbol, text: $form.minimumPurchase)
                        offerField("Credit earned per purchase", unit: "%", text: $form.earnPercent)
                        offerField("Maximum credit earned", unit: symbol, text: $form.maximumCredit)
                        offerField("Credit valid for", unit: "days", text: $form.validityDays)
                    }.disabled(locked || store.busy || !store.collectiblesAvailable)
                }
                if let campaign = store.collectibleCampaign?.campaign, hasChanges || locked {
                    Section(campaign.enabled ? "Currently active" : "Currently paused") {
                        Text(campaign.summary(decimals: decimals, symbol: symbol)).font(.subheadline)
                        Text("Your changes apply after confirmation. Existing rewards keep their original terms.").font(.footnote).foregroundStyle(.secondary)
                    }
                } else if store.collectibleCampaign?.campaign != nil {
                    Section { Text("Pausing stops new rewards. Existing credit keeps its expiry, and collectibles stay owned.").font(.footnote).foregroundStyle(.secondary) }
                }
            }
            if let operation = store.collectibleCampaign?.operation {
                Section {
                    if operation.isPending {
                        ProgressStatus(title: "Updating your offer", detail: "Waiting for confirmation. You can leave this screen.")
                    } else if operation.status == "failed" {
                        StatusMessage(title: "Offer update did not complete", detail: "Your previous offer is unchanged. Review the details and retry.", systemImage: "exclamationmark.circle")
                    } else if !hasChanges && !store.collectibleCampaignRequestPending {
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
            } else if store.collectibleCampaignRequestPending {
                Section { StatusMessage(title: "Checking your last update", detail: "Recover the update to check whether it was received. Your offer will not be submitted twice.", systemImage: "clock") }
            }
            if let error = store.collectibleCampaignError { Section { StatusMessage(title: error, systemImage: "wifi.exclamationmark") } }
            Section {
                if CampaignRecovery.showsSubmit(hasPendingRequest: store.collectibleCampaignRequestPending, operation: store.collectibleCampaign?.operation, hasReadError: store.collectibleCampaignError != nil) {
                    AsyncAction(actionTitle, loadingTitle: "Submitting update…", prominent: true) { await store.saveCollectibleCampaign(form) }
                        .disabled(!loaded || store.busy || !canSubmit || (!hasChanges && !store.collectibleCampaignRequestPending))
                }
                if store.collectibleCampaignError != nil || locked {
                    AsyncAction("Check status", loadingTitle: "Checking…", systemImage: "arrow.clockwise") { await store.loadCollectibleCampaign() }.disabled(store.busy || store.isLoadingCollectibleCampaign)
                }
                if hasChanges && !locked { Text("Save to apply this offer to your shop.").font(.footnote).foregroundStyle(.secondary) }
                NoticeView()
            }
            Section {
                DisclosureGroup("Previous percentage rewards") {
                    Text("Percentage offers keep their original terms and are managed separately from purchase credit.").font(.footnote)
                    NavigationLink("Manage percentage offer") { MerchantPercentageRewardsView() }
                }
            }
        }.navigationTitle(store.loyaltyAvailable ? "Earlier IC Voucher offer" : "Shop rewards").navigationBarTitleDisplayMode(.inline)
            .refreshable { await store.loadCollectibleCampaign() }
            .modifier(FormKeyboardActions())
            .task {
                await store.loadCollectibleCampaign()
                guard !loaded else { return }
                do {
                    var restored = try store.savedCollectibleCampaignDraft()
                    restored.requestID = nil // The store, not editable form state, owns durable request identity.
                    form = restored; loaded = true
                }
                catch { store.error = error.localizedDescription }
            }
            .onChange(of: form) { _, value in
                guard loaded, !locked else { return }
                do { try store.saveCollectibleCampaignDraft(value) }
                catch { store.error = error.localizedDescription }
            }
            .task(id: store.collectibleCampaign?.operation?.id) {
                while !Task.isCancelled, store.collectibleCampaign?.operation?.isPending == true {
                    do { try await Task.sleep(for: .seconds(4)) } catch { return }
                    guard !Task.isCancelled else { return }
                    await store.loadCollectibleCampaign()
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

struct PaymentTotals: View {
    let gross: String?
    let discount: String?
    let total: String
    let decimals: Int
    let symbol: String
    var final = true
    var body: some View {
        if let gross {
            LabeledContent("Original amount", value: amount(gross))
            if let discount { LabeledContent("Reward discount", value: (discount == "0" ? "" : "−") + amount(discount)) }
            LabeledContent(final ? "Paid" : "Payment total", value: amount(total))
        } else { LabeledContent("Amount", value: amount(total)) }
    }
    private func amount(_ units: String) -> String { TokenAmount.display(units, decimals: decimals) + " " + symbol }
}
