import AppKit
import SwiftUI

/// Chats: your omp sessions as conversations, like a chat app. The list of them on the left (open
/// ones first, then the rest by day), and the one you picked on the right, live as it works.
struct ChatsView: View {
    @Environment(BoardModel.self) private var model

    var body: some View {
        let chats = model.chats
        HStack(spacing: 0) {
            ChatList()
                .frame(width: 290 * Zoom.shared.scale)
            Divider()
            Group {
                switch chats.selection {
                case .new:
                    NewChatPage()
                case .chat:
                    if let conversation = chats.conversation {
                        ConversationPage(conversation: conversation, chat: chats.selectedChat)
                            .id(conversation.sessionFile)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { chats.isVisible = true }
        .onDisappear { chats.isVisible = false }
    }
}

// MARK: - The list

private struct ChatList: View {
    @Environment(BoardModel.self) private var model

    var body: some View {
        @Bindable var chats = model.chats
        let shown = chats.shownChats
        let selection = Binding<ChatSelection?>(get: { chats.selection }, set: { chats.select($0 ?? .new) })
        List(selection: selection) {
            ForEach(ChatGroup.groups(of: shown), id: \.title) { group in
                Section(group.title) {
                    ForEach(group.chats) { chat in
                        ChatRow(chat: chat).tag(ChatSelection.chat(chat.sessionFile))
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        .overlay {
            if !chats.loaded {
                ProgressView().controlSize(.small)
            } else if shown.isEmpty {
                Text(chats.search.isEmpty ? "No chats yet" : "No chats match “\(chats.search)”")
                    .font(.zoomed(.callout))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 10) {
                Button { chats.select(.new) } label: {
                    Label("New Chat", systemImage: "square.and.pencil")
                        .font(.zoomed(.body).weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 3)
                }
                .buttonStyle(.glass)
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .help("Start a new chat (⇧⌘N)")
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search chats", text: $chats.search)
                        .textFieldStyle(.plain)
                    if !chats.search.isEmpty {
                        Button { chats.search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                            .buttonStyle(.plain)
                    }
                }
                .font(.zoomed(.body))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8))
            }
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 6)
        }
    }
}

/// A day's worth of chats in the list, with the open ones first whatever their day.
private struct ChatGroup {
    let title: String
    let chats: [Chat]

    static func groups(of chats: [Chat], now: Date = .now) -> [ChatGroup] {
        let calendar = Calendar.current
        let open = chats.filter(\.isOpen)
        let closed = chats.filter { !$0.isOpen }
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now)) ?? now
        let days: [(String, (Date) -> Bool)] = [
            ("Today", { calendar.isDateInToday($0) }),
            ("Yesterday", { calendar.isDateInYesterday($0) }),
            ("Previous 7 Days", { $0 >= weekAgo }),
            ("Earlier", { _ in true }),
        ]
        var rest = closed
        var groups = open.isEmpty ? [] : [ChatGroup(title: "Open", chats: open)]
        for (title, contains) in days {
            let matching = rest.filter { contains($0.updatedAt) }
            rest.removeAll { contains($0.updatedAt) }
            if !matching.isEmpty { groups.append(ChatGroup(title: title, chats: matching)) }
        }
        return groups
    }
}

private struct ChatRow: View {
    let chat: Chat

    var body: some View {
        HStack(spacing: 7) {
            StateIndicator(state: chat.state)
            SessionIcon(icon: chat.icon)
            Text(chat.title)
                .font(.zoomed(.body).weight(chat.state == .closed ? .regular : .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            Text(Self.age(chat.updatedAt))
                .font(.zoomed(.caption))
                .monospacedDigit()
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .help(chat.task.map { "\(chat.title)\nOn \($0.ref): \($0.title)" } ?? chat.title)
    }

    /// "now", "12m", "3h", "Tue", "Oct 28": how long ago, as short as a list row needs.
    static func age(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        if seconds < 6 * 86_400 { return date.formatted(.dateTime.weekday(.abbreviated)) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// Working (an amber spinner), open and waiting for you (a green dot), or closed (nothing).
private struct StateIndicator: View {
    let state: Chat.State

    var body: some View {
        let size = 14 * Zoom.shared.scale
        Group {
            switch state {
            case .working:
                Image(systemName: "progress.indicator")
                    .font(.system(size: size - 1, weight: .bold))
                    .foregroundStyle(Color.boardAmber)
                    .symbolEffect(.variableColor.iterative, options: .repeat(.continuous))
            case .idle: Circle().fill(Color.boardGreen).frame(width: 7, height: 7)
            case .closed: Color.clear
            }
        }
        .frame(width: size, height: size)
        .help(state == .working ? "Working" : state == .idle ? "Open, waiting for you" : "Closed; sending a message reopens it")
    }
}

/// The icon omp put in front of the session's title, a Nerd Font glyph; a plain bubble when it has none.
struct SessionIcon: View {
    let icon: String?
    var size: CGFloat = 13

    var body: some View {
        let scaled = size * Zoom.shared.scale
        Group {
            if let icon {
                Text(icon).font(.custom("SymbolsNF", fixedSize: scaled))
            } else {
                Image(systemName: "bubble.left").font(.system(size: scaled - 2))
            }
        }
        .foregroundStyle(.secondary)
        .frame(width: scaled + 3)
    }
}

// MARK: - A conversation

private struct ConversationPage: View {
    let conversation: Conversation
    let chat: Chat?

    @Environment(BoardModel.self) private var model
    @State private var draft = ""
    @State private var screenshots: [Screenshot] = []

    var body: some View {
        VStack(spacing: 0) {
            ConversationHeader(conversation: conversation, chat: chat)
            Divider()
            if conversation.isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TranscriptView(conversation: conversation)
                    .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
            }
        }
        .task { await model.loadModelChoices() }
    }

    @ViewBuilder private var bottom: some View {
        VStack(spacing: 10) {
            if let ask = conversation.pendingAsk {
                AskPanel(conversation: conversation, call: ask).id(ask.id)
            }
            if let phase = conversation.livePhase {
                LiveBar(conversation: conversation, phase: phase)
            }
            ChatComposer(
                placeholder: conversation.isOpen ? "Message the agent" : "Message to pick this chat back up",
                text: $draft,
                screenshots: $screenshots,
                working: conversation.working,
                sending: conversation.isSending,
                onSend: send,
                onStop: conversation.isOpen ? { Task { await conversation.stop() } } : nil
            ) {
                if let choices = model.modelChoices, conversation.isOpen {
                    ModelChip(choices: choices, model: modelBinding, level: levelBinding, offersDefault: false, help: "Switch its model or thinking level, like omp's /switch and /effort")
                }
                if conversation.isOpen, conversation.livePhase == nil {
                    Button { Task { await conversation.setLive(true) } } label: {
                        Label("Live", systemImage: "waveform")
                    }
                    .buttonStyle(.plain)
                    .modifier(ComposerChip())
                    .disabled(conversation.isSwitchingLive)
                    .help("Talk to it out loud with omp's live mode, on this Mac's microphone and speakers")
                }
            }
        }
        .frame(maxWidth: 820 * Zoom.shared.scale)
        .padding(.horizontal, 20)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
    }

    private var modelBinding: Binding<String?> {
        Binding(get: { conversation.model }, set: { selector in
            if let selector { Task { await conversation.switchModel(selector) } }
        })
    }

    private var levelBinding: Binding<String?> {
        Binding(get: { conversation.thinkingLevel }, set: { level in
            if let level { Task { await conversation.switchThinking(level) } }
        })
    }

    private func send() {
        let text = draft
        let images = screenshots.map { NewTask.Image(base64: $0.data.base64EncodedString(), mimeType: $0.mimeType) }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return }
        draft = ""
        screenshots = []
        Task {
            if await !conversation.send(text, images: images) {
                draft = text
            }
        }
    }
}

/// The chat's name, where it runs and on what task, and its controls.
private struct ConversationHeader: View {
    let conversation: Conversation
    let chat: Chat?

    @Environment(BoardModel.self) private var model
    @State private var confirmingClose = false

    var body: some View {
        HStack(spacing: 10) {
            SessionIcon(icon: chat?.icon, size: 17)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.zoomed(.title3).weight(.semibold))
                    .lineLimit(1)
                Text(stateText)
                    .font(.zoomed(.caption))
                    .foregroundStyle(conversation.working ? Color.boardAmber : .secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 12)
            if let task = chat?.task {
                Button { model.showTasks() } label: { TaskChipView(chip: task) }
                    .buttonStyle(.plain)
                    .help("\(task.ref): \(task.title) — show your tasks")
            }
            Menu {
                menuItems
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 22, height: 22)
            }
            .menuStyle(.button)
            .buttonStyle(.glass)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .confirmationDialog("Close “\(title)”?", isPresented: $confirmingClose) {
            Button("Close Session", role: .destructive) { closeSession() }
        } message: {
            Text("It's working right now; closing stops what it's doing. omp keeps the conversation, so you can pick it back up here.")
        }
    }

    @ViewBuilder private var menuItems: some View {
        if let chat {
            Menu("Add to Task") {
                ForEach(openTasks) { card in
                    Button("\(card.ref)  \(card.title)") { Task { await model.chats.link(chat, to: card) } }
                        .disabled(chat.task?.id == card.id)
                }
            }
            .disabled(openTasks.isEmpty)
            if chat.task == nil, conversation.isOpen {
                Button("Make a Task from This Chat", systemImage: "plus.circle") {
                    model.request(trackAction, on: .session(chat.sessionFile))
                }
                .disabled(conversation.working)
            }
            Button("Open in Terminal", systemImage: "terminal") { Task { await model.chats.openInTerminal(chat) } }
            Button("Copy Session File Path", systemImage: "doc.on.doc") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(chat.sessionFile, forType: .string)
            }
            if conversation.isOpen {
                Divider()
                Button("Close Session", systemImage: "xmark.circle", role: .destructive) {
                    if conversation.working { confirmingClose = true } else { closeSession() }
                }
            }
        }
    }

    /// Tasks not shipped yet, newest first, to put this chat on.
    private var openTasks: [TaskCard] {
        model.taskColumns.filter { $0.id != "done" }.flatMap(\.cards).sorted { $0.id > $1.id }
    }

    private var trackAction: BoardAction {
        BoardAction(action: "track", label: "Track as Task", hint: "Ask the session to register what it's working on as a task")
    }

    private func closeSession() {
        guard let chat else { return }
        model.request(BoardAction(action: "close-session", label: "Close Session", hint: ""), on: .session(chat.sessionFile))
    }

    private var title: String { chat?.title ?? "New chat" }

    private var stateText: String {
        if conversation.livePhase != nil { return "Live" }
        if conversation.working { return "Working" }
        return conversation.isOpen ? "Open" : "Closed · send a message to reopen it"
    }
}

/// omp's live voice mode while it's on: what it's doing (listening, speaking), mute, and end.
private struct LiveBar: View {
    let conversation: Conversation
    let phase: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: phase == "muted" ? "mic.slash.fill" : "waveform")
                .symbolEffect(.variableColor.iterative, isActive: phase == "listening" || phase == "speaking")
                .foregroundStyle(phase == "error" ? Color.boardRed : .accentColor)
                .font(.zoomed(size: 16, weight: .semibold))
            VStack(alignment: .leading, spacing: 1) {
                Text("Live · \(phase.capitalized)").font(.zoomed(.body).weight(.semibold))
                Text("Talk to it out loud; it answers through this Mac's speakers.")
                    .font(.zoomed(.caption))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(phase == "muted" ? "Unmute" : "Mute", systemImage: phase == "muted" ? "mic.fill" : "mic.slash") {
                Task { await conversation.toggleMute() }
            }
            .buttonStyle(.glass)
            Button("End", systemImage: "phone.down.fill") { Task { await conversation.setLive(false) } }
                .buttonStyle(.glassProminent)
                .tint(.red)
                .disabled(conversation.isSwitchingLive)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .glassEffect(.regular.tint(.accentColor.opacity(0.12)), in: .rect(cornerRadius: 18))
    }
}

/// The agent's open `ask` question, answered with a click: the keys go to its terminal for you.
private struct AskPanel: View {
    let conversation: Conversation
    let call: ChatBlock.ToolCall

    @State private var picks: [Int: Set<Int>] = [:]
    @State private var typed: [Int: String] = [:]
    @State private var isSending = false

    private var questions: [ChatBlock.AskQuestion] { call.ask ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("The agent is asking", systemImage: "questionmark.bubble.fill")
                .font(.zoomed(.caption).weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            ForEach(Array(questions.enumerated()), id: \.offset) { index, question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(question.question)
                        .font(.zoomed(.body).weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(Array(question.options.enumerated()), id: \.offset) { optionIndex, option in
                        optionRow(option, recommended: question.recommended == optionIndex, multi: question.multi, selected: picks[index, default: []].contains(optionIndex)) {
                            toggle(optionIndex, in: index, multi: question.multi)
                        }
                    }
                    TextField("Or type your own answer", text: typedBinding(index, multi: question.multi))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { if canSubmit { Task { await submit() } } }
                }
            }
            HStack {
                Spacer()
                Button {
                    Task { await submit() }
                } label: {
                    if isSending { ProgressView().controlSize(.small) } else { Text("Answer") }
                }
                .buttonStyle(.glassProminent)
                .disabled(!canSubmit)
            }
        }
        .padding(16)
        .glassEffect(.regular, in: .rect(cornerRadius: 18))
    }

    private func optionRow(_ option: ChatBlock.AskQuestion.Option, recommended: Bool, multi: Bool, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: multi ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle"))
                    .foregroundStyle(selected ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(option.label)
                        if recommended {
                            Text("Recommended").font(.zoomed(.caption)).foregroundStyle(Color.boardGreen)
                        }
                    }
                    if let description = option.description, !description.isEmpty {
                        Text(description).font(.zoomed(.caption)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .font(.zoomed(.body))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.04), in: .rect(cornerRadius: 8))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    /// One pick, or typed text, for a single-choice question (typing replaces the pick, like the terminal).
    private func toggle(_ option: Int, in question: Int, multi: Bool) {
        if multi {
            picks[question, default: []].formSymmetricDifference([option])
        } else {
            picks[question] = [option]
            typed[question] = nil
        }
    }

    private func typedBinding(_ question: Int, multi: Bool) -> Binding<String> {
        Binding(get: { typed[question] ?? "" }, set: { text in
            typed[question] = text
            if !multi, !text.trimmingCharacters(in: .whitespaces).isEmpty { picks[question] = [] }
        })
    }

    private var answers: [AskAnswer] {
        questions.indices.map { index in
            let custom = typed[index]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return AskAnswer(options: picks[index, default: []].sorted(), custom: custom.isEmpty ? nil : custom)
        }
    }

    private var canSubmit: Bool {
        !isSending && !questions.isEmpty && answers.allSatisfy { !$0.options.isEmpty || $0.custom != nil }
    }

    private func submit() async {
        isSending = true
        guard await conversation.answer(call, with: answers) else {
            isSending = false
            return
        }
        // The panel goes once omp writes the answer down; if that never happens, let you try again.
        try? await Task.sleep(for: .seconds(10))
        isSending = false
    }
}

// MARK: - A new chat

/// An empty chat waiting for its first message, which starts a new omp session.
private struct NewChatPage: View {
    @Environment(BoardModel.self) private var model
    @State private var draft = ""
    @State private var screenshots: [Screenshot] = []
    @State private var chosenModel: String?
    @State private var chosenLevel: String?

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.zoomed(size: 34, weight: .regular))
                    .foregroundStyle(.tint)
                Text("What should we work on?")
                    .font(.zoomed(size: 26, weight: .semibold))
                Text("Your message starts a new omp session. Add it to a task anytime.")
                    .font(.zoomed(.body))
                    .foregroundStyle(.secondary)
            }
            ChatComposer(
                placeholder: "Ask anything, or describe what you want done",
                text: $draft,
                screenshots: $screenshots,
                working: false,
                sending: model.chats.isStarting,
                onSend: start,
                onStop: nil
            ) {
                if let choices = model.modelChoices {
                    ModelChip(choices: choices, model: $chosenModel, level: $chosenLevel, help: "The model and thinking level it starts on")
                }
            }
            .frame(maxWidth: 760 * Zoom.shared.scale)
            Spacer()
            Spacer()
        }
        .padding(.horizontal, 32)
        .task { await model.loadModelChoices() }
    }

    private func start() {
        let images = screenshots.map { NewTask.Image(base64: $0.data.base64EncodedString(), mimeType: $0.mimeType) }
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return }
        let chat = NewChat(text: draft, images: images, model: chosenModel, thinkingLevel: chosenLevel)
        Task {
            if await model.chats.startChat(chat) {
                draft = ""
                screenshots = []
            }
        }
    }
}

// MARK: - The message box

/// The message box: what you type (↩ sends, ⇧↩ for a new line), screenshots you paste, chips for
/// the chat's options, and Send, or Stop while the agent works and the box is empty.
private struct ChatComposer<Accessories: View>: View {
    let placeholder: String
    @Binding var text: String
    @Binding var screenshots: [Screenshot]
    let working: Bool
    let sending: Bool
    let onSend: () -> Void
    let onStop: (() -> Void)?
    @ViewBuilder let accessories: Accessories

    var body: some View {
        let scale = Zoom.shared.scale
        VStack(alignment: .leading, spacing: 10 * scale) {
            if !screenshots.isEmpty { screenshotStrip }
            DetailsEditor(text: $text, placeholder: placeholder, sendsOnReturn: true, focusOnAppear: true, onSubmit: onSend) { pasted in
                screenshots += pasted
            }
            HStack(spacing: 8) {
                accessories
                Spacer(minLength: 8)
                if sending {
                    ProgressView().controlSize(.small)
                }
                if let onStop, working, isEmpty {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill")
                            .font(.zoomed(size: 11, weight: .bold))
                            .frame(width: 28 * scale, height: 28 * scale)
                    }
                    .buttonStyle(RoundButtonStyle(fill: .primary))
                    .help("Stop the agent (like Esc in its terminal)")
                } else {
                    Button(action: onSend) {
                        Image(systemName: "arrow.up")
                            .font(.zoomed(size: 13, weight: .bold))
                            .frame(width: 28 * scale, height: 28 * scale)
                    }
                    .buttonStyle(RoundButtonStyle(fill: .accentColor))
                    .disabled(isEmpty || sending)
                    .help("Send (↩)")
                }
            }
        }
        .padding(.horizontal, 16 * scale)
        .padding(.top, 14 * scale)
        .padding(.bottom, 10 * scale)
        .glassEffect(.regular, in: .rect(cornerRadius: 22 * scale))
    }

    private var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && screenshots.isEmpty }

    private var screenshotStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(screenshots) { screenshot in
                    Image(nsImage: screenshot.image)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 80, height: 56)
                        .clipShape(.rect(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
                        .overlay(alignment: .topTrailing) {
                            Button { screenshots.removeAll { $0.id == screenshot.id } } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .padding(3)
                            .help("Remove this screenshot")
                        }
                }
            }
        }
        .scrollIndicators(.never)
    }
}

/// A round icon button in a solid color that dims while it can't be pressed.
private struct RoundButtonStyle: ButtonStyle {
    let fill: Color
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(fill == .primary ? AnyShapeStyle(.background) : AnyShapeStyle(.white))
            .background(fill.opacity(configuration.isPressed ? 0.75 : 1), in: .circle)
            .opacity(isEnabled ? 1 : 0.3)
            .contentShape(.circle)
    }
}

/// A small capsule for an option beside the message box, like the model chip.
private struct ComposerChip: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.zoomed(.callout).weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.quaternary.opacity(0.6), in: .capsule)
            .contentShape(.capsule)
    }
}
