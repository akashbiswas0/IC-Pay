import SwiftUI

/// Decorative companion: one greeting per appearance, never a loading indicator.
struct ICPayMascot: View {
    var size: CGFloat = 196
    var animatesGreeting = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var greeting = false
    @State private var greeted = false
    var body: some View {
        ZStack {
            Image("MascotIdle").resizable().scaledToFit().opacity(greeting ? 0 : 1)
            Image("MascotWelcome").resizable().scaledToFit().opacity(greeting ? 1 : 0)
        }
        .frame(width: size, height: size * 214 / 196)
        .accessibilityHidden(true)
        .allowsHitTesting(false)
        .task(id: scenePhase) {
            guard scenePhase == .active, animatesGreeting, !reduceMotion, !greeted else { greeting = false; return }
            greeted = true
            withAnimation(.easeOut(duration: 0.2)) { greeting = true }
            do { try await Task.sleep(for: .milliseconds(900)) } catch { greeting = false; return }
            withAnimation(.easeOut(duration: 0.25)) { greeting = false }
        }
        .onChange(of: reduceMotion) { _, reduced in if reduced { greeting = false } }
        .onDisappear { greeting = false }
    }
}

struct MascotEmptyState: View {
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 12) {
            ICPayMascot(size: 108, animatesGreeting: false)
            Text(title).font(.title3.weight(.semibold))
            Text(detail).font(.subheadline).foregroundStyle(Color.primary.opacity(0.7))
        }.multilineTextAlignment(.center)
            .frame(maxWidth: .infinity).padding(.vertical, 24)
            .accessibilityElement(children: .combine)
    }
}

struct WelcomeView: View {
    var body: some View {
        ScrollView { WelcomeContent() }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("IC Pay").navigationBarTitleDisplayMode(.inline)
    }
}

struct WelcomeContent: View {
    @Environment(AppStore.self) private var store
    var body: some View {
            VStack(alignment: .leading, spacing: 24) {
                if store.verificationID == nil {
                    ICPayMascot().frame(maxWidth: .infinity).padding(.top, 8)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text(store.verificationID == nil ? "Pay with a tap." : "Verify with World")
                        .font(.largeTitle.bold()).fixedSize(horizontal: false, vertical: true)
                    if store.verificationID == nil {
                        Text("Link a compatible IC card. Verify with World, then add funds and set your spending limits.")
                            .font(.body).foregroundStyle(Color.primary.opacity(0.7))
                    }
                }
                if store.verificationID != nil {
                    WorldVerificationControls()
                } else if store.isStarting {
                    ProgressStatus(title: "Connecting…")
                } else if let unavailable = store.serviceUnavailable {
                    VStack(alignment: .leading, spacing: 12) {
                        StatusMessage(title: unavailable, systemImage: "wifi.exclamationmark")
                        AsyncAction("Try again", loadingTitle: "Connecting…", systemImage: "arrow.clockwise", prominent: true) { await store.bootstrap() }.disabled(store.busy)
                    }
                } else {
                    VStack(spacing: 8) {
                        AsyncAction("Link a card", loadingTitle: "Reading your card…", systemImage: "wave.3.right", prominent: true) { await store.beginEnrollment() }
                            .disabled(store.busy || store.config?.capabilities.world != true || !CardReader.available)
                        AsyncAction("Sign in", loadingTitle: "Reading your card…") { await store.beginSignIn() }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(store.busy || store.config?.capabilities.world != true || !CardReader.available)
                        if !CardReader.available {
                            Text("Card linking and sign-in require an NFC-enabled iPhone.").font(.footnote).foregroundStyle(Color.primary.opacity(0.7))
                        } else if store.config?.capabilities.world != true {
                            Text("Account setup unavailable. Try again shortly.").font(.footnote).foregroundStyle(Color.primary.opacity(0.7))
                        }
                    }
                }
                NoticeView()
                Text("Test tokens only. Separate from your transit balance.")
                    .font(.footnote).foregroundStyle(Color.primary.opacity(0.7))
                DisclosureGroup("More sign-in options") {
                    VStack(alignment: .leading, spacing: 4) {
                        NavigationLink("Use another signed-in device") { DeviceSignInView() }.frame(minHeight: 44)
                        NavigationLink("Create merchant account") { MerchantSignupView() }.frame(minHeight: 44)
                        NavigationLink("Join an existing merchant") { MerchantInvitationView() }.frame(minHeight: 44)
                    }.padding(.top, 8)
                }.font(.subheadline)
            }.padding(.horizontal, 24).padding(.bottom, 32)
    }
}

struct DeviceSignInView: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        Form {
            Section {
                Text("On your signed-in device, open Account → Connect another device.")
                if let link = store.deviceLink {
                    Text(link.userCode).font(.largeTitle.monospaced().weight(.semibold)).textSelection(.enabled).frame(maxWidth: .infinity).padding(.vertical, 12).accessibilityLabel("Sign in code \(link.userCode)")
                    if let date = AppDates.date(link.expiresAt) { Text("Expires \(date.formatted(date: .omitted, time: .shortened))").font(.footnote).foregroundStyle(.secondary) }
                    CopyCodeButton(code: link.userCode)
                    ProgressStatus(title: "Waiting for approval", detail: "Enter this code on your other device.")
                    AsyncAction("Check approval", loadingTitle: "Checking approval…", systemImage: "arrow.clockwise") { await store.pollDeviceLink() }.disabled(store.busy)
                } else {
                    AsyncAction("Get a sign-in code", loadingTitle: "Creating your code…", prominent: true) { await store.createDeviceLink() }.disabled(store.busy || store.config == nil)
                }
                if let message = store.deviceLinkMessage, store.deviceLink == nil { StatusMessage(title: message) }
            }
            Section { Text("Only approve your own devices. Approval grants account access.").font(.footnote); NoticeView() }
        }.navigationTitle("Sign in with a device").navigationBarTitleDisplayMode(.inline)
            .task(id: store.deviceLink?.id) {
                while !Task.isCancelled, store.deviceLink != nil, !store.isSignedIn {
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled && !store.busy { await store.pollDeviceLink() }
                }
            }
    }
}
struct MerchantInvitationView: View {
    @Environment(AppStore.self) private var store
    @State private var invitation = ""
    var body: some View {
        Form {
            Section {
                Text("Ask your merchant for an invite code.")
                TextField("Invitation code", text: $invitation).textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.oneTimeCode)
                AsyncAction("Accept invitation", loadingTitle: "Joining merchant…", prominent: true) { await store.activateInvitation(code: invitation) }.disabled(invitation.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.busy)
            }
            Section {
                Text("Joining gives this iPhone access to the merchant’s wallet and payments.").font(.footnote)
                Text("Codes expire in 10 minutes and work once.").font(.footnote)
                NoticeView()
            }
        }.navigationTitle("Merchant invitation").navigationBarTitleDisplayMode(.inline)
            .modifier(FormKeyboardActions())
    }
}


struct WorldVerificationControls: View {
    @Environment(AppStore.self) private var store
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Card read", systemImage: "checkmark.circle.fill").foregroundStyle(.tint)
            if store.worldIsStarting { ProgressStatus(title: "Opening World…") }
            else if store.worldIsSubmitting { ProgressStatus(title: "Confirming verification…") }
            if !store.worldStatus.isEmpty, !store.worldIsStarting, !store.worldIsSubmitting {
                StatusMessage(title: store.worldStatus, systemImage: store.worldNeedsRestart ? "arrow.clockwise.circle" : "person.crop.circle.badge.clock")
            }
            if let connector = store.verificationURL, !store.worldNeedsRestart {
                PrimaryAction(title: "Open World", disabled: store.busy) { store.openWorldApp() }
                if store.worldAppUnavailable {
                    Link("Get or update World", destination: connector).frame(minHeight: 44)
                    Text("After installing, return here to open World.").font(.footnote)
                }
            }
            AsyncAction("Check status", loadingTitle: "Checking verification…", systemImage: "arrow.clockwise") { await store.checkVerification() }.frame(minHeight: 44).disabled(store.busy || store.worldIsStarting || store.worldIsSubmitting)
            AsyncAction("Restart check", loadingTitle: "Restarting verification…") { await store.restartVerification() }.frame(minHeight: 44).disabled(store.isStarting || store.busy)
            AsyncAction("Cancel check", loadingTitle: "Cancelling check…", role: .cancel) { await store.cancelVerification() }.frame(minHeight: 44).disabled(store.isStarting || store.busy)
        }
    }
}
