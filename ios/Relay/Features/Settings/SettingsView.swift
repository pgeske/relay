import SwiftUI

struct SettingsView: View {
    let model: AppModel

    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    @AppStorage(ThemePreference.storageKey) private var themeID = CatppuccinFlavor.default.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(model.hosts) { host in
                        NavigationLink {
                            HostEditor(model: model, host: host)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(host.name)
                                    .foregroundStyle(theme.primaryText)
                                Text(host.baseURL.absoluteString)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(theme.secondaryText)
                                    .lineLimit(1)
                            }
                        }
                        .listRowBackground(theme.elevatedSurface)
                    }
                    .onDelete { offsets in
                        offsets.map { model.hosts[$0] }.forEach(model.delete)
                    }

                    NavigationLink {
                        HostEditor(model: model, host: nil)
                    } label: {
                        Label("Add host", systemImage: "plus")
                            .foregroundStyle(theme.accent)
                    }
                    .listRowBackground(theme.elevatedSurface)
                } header: {
                    Text("Hosts")
                        .foregroundStyle(theme.secondaryText)
                } footer: {
                    Text("To pair a computer, run `relay pair` on it and scan the QR code with the Camera app.")
                        .foregroundStyle(theme.secondaryText)
                }

                Section {
                    Picker("Theme", selection: $themeID) {
                        ForEach(CatppuccinFlavor.allCases) { flavor in
                            Text(flavor.title).tag(flavor.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    .foregroundStyle(theme.primaryText)
                    .listRowBackground(theme.elevatedSurface)

                    HStack(spacing: 6) {
                        ForEach(CatppuccinFlavor.allCases) { flavor in
                            Circle()
                                .fill(flavor.palette.mauve)
                                .frame(width: 12, height: 12)
                                .overlay {
                                    Circle()
                                        .strokeBorder(
                                            flavor.rawValue == themeID ? theme.primaryText : .clear,
                                            lineWidth: 1.5
                                        )
                                }
                                .accessibilityHidden(true)
                        }
                        Spacer(minLength: 0)
                        Text(theme.flavor.title)
                            .font(.caption)
                            .foregroundStyle(theme.secondaryText)
                    }
                    .listRowBackground(theme.elevatedSurface)
                } header: {
                    Text("Appearance")
                        .foregroundStyle(theme.secondaryText)
                }
            }
            .scrollContentBackground(.hidden)
            .background(theme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.secondaryBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Adds a host (when `host` is nil) or edits an existing one.
private struct HostEditor: View {
    let model: AppModel
    let host: Host?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
    @State private var name: String
    @State private var serverURL: String
    @State private var token: String
    @State private var isTesting = false
    @State private var testResult: String?
    @State private var testSucceeded = false
    @State private var isConfirmingDelete = false

    init(model: AppModel, host: Host?) {
        self.model = model
        self.host = host
        _name = State(initialValue: host?.name ?? "")
        _serverURL = State(initialValue: host?.baseURL.absoluteString ?? "")
        _token = State(initialValue: host?.token ?? "")
    }

    var body: some View {
        Form {
            Section {
                TextField("Name", text: $name, prompt: Text(namePlaceholder))
                    .foregroundStyle(theme.primaryText)
                    .listRowBackground(theme.elevatedSurface)

                TextField("Server URL", text: $serverURL, prompt: Text("http://computer:7878"))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .font(.body.monospaced())
                    .foregroundStyle(theme.primaryText)
                    .listRowBackground(theme.elevatedSurface)

                TextField("Token", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.footnote.monospaced())
                    .foregroundStyle(theme.primaryText)
                    .listRowBackground(theme.elevatedSurface)
            } footer: {
                Text("Easier: run `relay pair` on the computer and scan the QR code with the Camera app. It fills all of this in.")
                    .foregroundStyle(theme.secondaryText)
            }

            Section {
                Button {
                    Task { await testConnection() }
                } label: {
                    HStack {
                        if isTesting {
                            ProgressView()
                                .padding(.trailing, 4)
                        }
                        Text(isTesting ? "Testing…" : "Test connection")
                    }
                }
                .disabled(isTesting || draft == nil)
                .listRowBackground(theme.elevatedSurface)

                if let testResult {
                    Text(testResult)
                        .font(.footnote)
                        .foregroundStyle(testSucceeded ? theme.connected : theme.error)
                        .listRowBackground(theme.elevatedSurface)
                }
            }

            if let host {
                Section {
                    Button("Delete host", role: .destructive) {
                        isConfirmingDelete = true
                    }
                    .listRowBackground(theme.elevatedSurface)
                    .confirmationDialog(
                        "Delete \(host.name)?",
                        isPresented: $isConfirmingDelete,
                        titleVisibility: .visible
                    ) {
                        Button("Delete host", role: .destructive) {
                            dismiss()
                            model.delete(host)
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Its sessions keep running on the computer; this phone just stops showing them.")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(theme.background)
        .navigationTitle(host == nil ? "Add host" : "Edit host")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    if let draft {
                        model.save(draft)
                        dismiss()
                    }
                }
                .disabled(draft == nil)
            }
        }
    }

    private var namePlaceholder: String {
        Host.baseURL(from: serverURL).map(Host.defaultName) ?? "Name"
    }

    /// The host as currently entered, or nil while the URL or token is unusable.
    private var draft: Host? {
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = Host.baseURL(from: serverURL), !trimmedToken.isEmpty else { return nil }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return Host(
            id: host?.id ?? UUID(),
            name: trimmedName.isEmpty ? Host.defaultName(for: url) : trimmedName,
            baseURL: url,
            token: trimmedToken
        )
    }

    /// Checks reachability with the unauthenticated health call, then the token with a real one.
    private func testConnection() async {
        guard let draft else { return }
        isTesting = true
        testResult = nil
        defer { isTesting = false }

        let client = APIClient(host: draft)
        do {
            let health = try await client.health()
            do {
                _ = try await client.fetchSessions()
                testSucceeded = true
                testResult = "Connected to relay \(health.version)."
            } catch let error as APIError where error.statusCode == 401 || error.statusCode == 403 {
                testSucceeded = false
                testResult = "Reached relay \(health.version), but it rejected the token."
            }
        } catch {
            testSucceeded = false
            testResult = APIError.describe(error)
        }
    }
}
