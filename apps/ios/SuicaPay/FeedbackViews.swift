import SwiftUI

/// Progress belongs to the action that started it, not every button sharing AppStore.busy.
struct AsyncAction: View {
    let title: String
    var loadingTitle: String = "Working…"
    var systemImage: String? = nil
    var role: ButtonRole? = nil
    var prominent = false
    let action: () async -> Void
    @State private var running = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ title: String, loadingTitle: String = "Working…", systemImage: String? = nil,
         role: ButtonRole? = nil, prominent: Bool = false, action: @escaping () async -> Void) {
        self.title = title; self.loadingTitle = loadingTitle; self.systemImage = systemImage
        self.role = role; self.prominent = prominent; self.action = action
    }

    var body: some View {
        Group {
            if prominent {
                button.buttonStyle(ProminentActionStyle(working: running))
            }
            else { button }
        }
        .disabled(running)
        .accessibilityLabel(title)
        .accessibilityValue(running ? loadingTitle : "")
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: running)
    }

    private var button: some View {
        Button(role: role) {
            guard !running else { return }
            running = true
            Task { await action(); running = false }
        } label: {
            HStack(spacing: 10) {
                if running { ProgressView().tint(prominent ? Color(uiColor: .systemBackground) : role == .destructive ? .red : .accentColor).accessibilityHidden(true) }
                else if let systemImage { Image(systemName: systemImage).accessibilityHidden(true) }
                Text(running ? loadingTitle : title)
                    .fontWeight(prominent ? .semibold : .regular)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: prominent ? .infinity : nil, minHeight: prominent ? 28 : 44, alignment: prominent ? .center : .leading)
            .contentShape(Rectangle())
        }
    }
}

/// Keep multiline Dynamic Type labels inside the button and retain contrast while disabled.
struct ProminentActionStyle: ButtonStyle {
    var working = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 18).padding(.vertical, 14)
            .foregroundStyle(isEnabled || working ? Color(uiColor: .systemBackground) : .primary)
            .background(isEnabled || working ? Color("AccentColor") : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .fixedSize(horizontal: false, vertical: true)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

struct ProgressStatus: View {
    let title: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ProgressView().tint(.primary).padding(.top, 3).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail { Text(detail).font(.subheadline).foregroundStyle(Color.primary.opacity(0.75)) }
            }.fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 8).accessibilityElement(children: .combine)
    }
}

struct StatusMessage: View {
    let title: String
    var detail: String? = nil
    var systemImage = "info.circle"
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage).font(.title3).foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.semibold))
                if let detail { Text(detail).font(.subheadline).foregroundStyle(Color.primary.opacity(0.75)) }
            }.fixedSize(horizontal: false, vertical: true)
        }.padding(.vertical, 6).accessibilityElement(children: .combine)
    }
}

/// No placeholder amounts: loading must never look like a reported zero balance.
struct LoadingPlaceholder: View {
    var label = "Loading activity"
    var rows = 3
    var balance = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var lineHeight = 14
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if balance {
                VStack(alignment: .leading, spacing: 14) {
                    bar(width: 120, height: lineHeight)
                    bar(width: 210, height: lineHeight * 2.5)
                    bar(width: 165, height: lineHeight)
                }.padding(.vertical, 8)
            }
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: 14) {
                    RoundedRectangle(cornerRadius: 10).fill(.quaternary).frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 10) {
                        bar(width: index.isMultiple(of: 2) ? 150 : 120, height: lineHeight)
                        bar(width: 100, height: lineHeight * 0.75)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.vertical, 10)
        .phaseAnimator(reduceMotion ? [false] : [false, true]) { content, phase in
            content.opacity(phase ? 0.5 : 1)
        } animation: { _ in .easeInOut(duration: 0.9) }
        .accessibilityElement(children: .ignore).accessibilityLabel(label)
        .allowsHitTesting(false)
    }
    private func bar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(maxWidth: width).frame(height: height)
    }
}

struct RefreshButton: View {
    var refreshing: Bool
    let action: () async -> Void
    @State private var running = false
    var body: some View {
        Button {
            guard !running, !refreshing else { return }
            running = true
            Task { await action(); running = false }
        } label: {
            ZStack {
                Image(systemName: "arrow.clockwise").opacity(refreshing || running ? 0 : 1)
                if refreshing || running { ProgressView().accessibilityHidden(true) }
            }.frame(width: 44, height: 44)
        }
        .disabled(refreshing || running)
        .accessibilityLabel(refreshing || running ? "Refreshing" : "Refresh")
        .accessibilityHint("Updates the latest account information.")
    }
}

struct CopyCodeButton: View {
    let code: String
    @State private var copied = false
    @State private var sequence = 0
    var body: some View {
        Button {
            UIPasteboard.general.string = code
            copied = true; sequence += 1
            UIAccessibility.post(notification: .announcement, argument: "Code copied")
        } label: {
            Label(copied ? "Code copied" : "Copy code", systemImage: copied ? "checkmark" : "doc.on.doc")
                .frame(minHeight: 44)
        }
        .sensoryFeedback(.success, trigger: sequence)
        .task(id: sequence) {
            guard sequence > 0 else { return }
            do { try await Task.sleep(for: .seconds(3)); copied = false } catch {}
        }
        .onChange(of: code) { _, _ in copied = false }
    }
}

struct AccountRefreshActions: ViewModifier {
    var cardID: String? = nil
    var refreshFunding = true
    var refreshRewards = false
    @Environment(AppStore.self) private var store
    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    RefreshButton(refreshing: store.isRefreshing || (refreshFunding && store.isLoadingFunding(for: cardID)) || (refreshRewards && store.isLoadingRewards(for: cardID))) { await refresh() }
                        .disabled(store.busy)
                }
            }
            .refreshable { await refresh() }
    }
    private func refresh() async {
        guard !store.busy, !store.isRefreshing, !refreshFunding || !store.isLoadingFunding(for: cardID) else { return }
        await store.run { try await store.refresh() }
        if refreshFunding { await store.loadFunding(cardID: cardID) }
        if refreshRewards { await store.loadRewards(cardID: cardID) }
    }
}

struct FormKeyboardActions: ViewModifier {
    func body(content: Content) -> some View {
        content.scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    }
                }
            }
    }
}

/// A receipt loaded from history is not a newly completed payment. Match identity
/// as well as status, and remain quiet for pending/submitted transactions.
struct PaymentFeedbackState: Equatable {
    enum Outcome: Equatable { case success, warning, error }
    let invoiceID: String
    let status: String
    init(_ invoice: Invoice) {
        invoiceID = invoice.id
        status = invoice.status.lowercased()
    }
    init(invoiceID: String, status: String) {
        self.invoiceID = invoiceID
        self.status = status.lowercased()
    }
    static func outcome(from old: Self?, to new: Self?) -> Outcome? {
        guard let old, let new, old.invoiceID == new.invoiceID, old.status != new.status else { return nil }
        switch new.status {
        case "confirmed": return .success
        case "failed": return .error
        case "expired": return .warning
        default: return nil
        }
    }
}
