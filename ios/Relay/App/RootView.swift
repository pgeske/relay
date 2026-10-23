import SwiftUI

struct RootView: View {
    @State private var model = AppModel()
    @AppStorage(ThemePreference.storageKey) private var themeID = CatppuccinFlavor.default.rawValue

    private var theme: AppTheme {
        AppTheme(flavor: CatppuccinFlavor(rawValue: themeID) ?? .default)
    }

    var body: some View {
        NavigationStack {
            content
        }
        .appTheme(theme)
        .sheet(isPresented: $model.isShowingSessions) {
            SessionsView(model: model)
                .banners(model)
                .appTheme(theme)
        }
        .sheet(isPresented: $model.isShowingSettings) {
            SettingsView(model: model)
                .banners(model)
                .appTheme(theme)
        }
        .banners(model)
        .onOpenURL { url in
            model.handlePairingLink(url)
        }
        .task {
            await model.start()
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.hosts.isEmpty {
            NoHostsView {
                model.isShowingSettings = true
            }
        } else if let session = model.currentSession {
            ChatScreen(session: session, model: model)
                .id("\(session.hostID)/\(session.session.id)-\(model.configRevision)")
        } else if model.didFinishLaunching {
            NoSessionView(
                model: model,
                onRetry: { Task { await model.retry() } },
                onSettings: { model.isShowingSettings = true }
            )
        } else {
            ProgressView("Connecting…")
                .tint(theme.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.background)
        }
    }
}

private extension View {
    /// Shows the model's banner over this view. Sheets install it too, since they
    /// would otherwise cover the root's banner.
    func banners(_ model: AppModel) -> some View {
        modifier(BannerOverlay(model: model))
    }
}

private struct BannerOverlay: ViewModifier {
    let model: AppModel

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let banner = model.banner {
                    BannerView(banner: banner)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                        .task(id: banner.id) {
                            try? await Task.sleep(for: .seconds(4))
                            if model.banner?.id == banner.id {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    model.banner = nil
                                }
                            }
                        }
                }
            }
            .animation(.snappy(duration: 0.25), value: model.banner)
    }
}

private struct BannerView: View {
    let banner: Banner

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: banner.kind == .success ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .font(.footnote)
            Text(banner.message)
                .font(.footnote)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .foregroundStyle(theme.errorForeground)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(banner.kind == .success ? theme.connected : theme.error, in: RoundedRectangle(cornerRadius: 12))
        .shadow(color: theme.palette.crust.opacity(0.25), radius: 8, y: 2)
    }
}

/// Shown before any host is set up.
private struct NoHostsView: View {
    let onAddManually: () -> Void

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(theme.tertiaryText)
                .padding(.bottom, 4)

            Text("Pair a computer")
                .font(.title2.weight(.semibold))
                .foregroundStyle(theme.primaryText)

            Text("Run `relay pair` on your computer and scan the code with the Camera app, or add a host manually.")
                .font(.subheadline)
                .foregroundStyle(theme.secondaryText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            Button(action: onAddManually) {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                    Text("Add host manually")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: 260)
                .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 8)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
        .toolbarBackground(theme.secondaryBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

/// Shown when no host has a tmux window running `omp`.
private struct NoSessionView: View {
    let model: AppModel
    let onRetry: () -> Void
    let onSettings: () -> Void

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(theme.tertiaryText)
                .padding(.bottom, 4)

            Text("No sessions yet")
                .font(.title2.weight(.semibold))
                .foregroundStyle(theme.primaryText)

            Text("Start a coding session on your computer, or create one here.")
                .font(.subheadline)
                .foregroundStyle(theme.secondaryText)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)

            NewSessionButton(model: model) {
                HStack(spacing: 8) {
                    if model.isCreatingSession {
                        ProgressView()
                            .tint(theme.accentForeground)
                    } else {
                        Image(systemName: "plus")
                    }
                    Text("New session")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: 260)
                .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isCreatingSession)
            .padding(.top, 8)

            Button("Refresh", action: onRetry)
                .font(.footnote)
                .foregroundStyle(theme.secondaryText)

            Button(action: onSettings) {
                Label("Hosts and settings", systemImage: "gearshape")
                    .font(.footnote)
            }
            .foregroundStyle(theme.secondaryText)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
        .toolbarBackground(theme.secondaryBackground, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}
