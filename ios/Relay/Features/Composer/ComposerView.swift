import SwiftUI
import PhotosUI
import UIKit

struct ComposerView: View {
    let chat: ChatStore
    let onError: (String) -> Void

    @State private var text = ""
    @State private var attachments: [ComposerAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var isShowingLibrary = false
    @State private var isShowingCamera = false
    @State private var isSending = false
    @State private var voice = VoiceController()
    @State private var isShowingLiveCall = false

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 8) {
            if voice.state == .recording || voice.statusText != nil {
                voiceStatusRow
            }

            VStack(alignment: .leading, spacing: 10) {
                if !attachments.isEmpty {
                    attachmentStrip
                }

                textField

                HStack(spacing: 8) {
                    attachMenu
                    ModelPicker(chat: chat)
                    Spacer(minLength: 0)
                    micButton

                    if chat.working {
                        stopButton
                    }

                    // Like ChatGPT: with nothing typed, the send slot starts a voice call instead.
                    if canTapSend || isSending {
                        sendButton
                    } else {
                        liveCallButton
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 12)
            .padding(.bottom, 10)
            .background(theme.elevatedSurface, in: composerShape)
            .overlay(composerShape.strokeBorder(theme.separator, lineWidth: 1))
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .background(theme.background)
        .photosPicker(
            isPresented: $isShowingLibrary,
            selection: $pickerItems,
            maxSelectionCount: 6,
            matching: .images
        )
        .onChange(of: pickerItems) { _, items in
            Task { await addPicked(items) }
        }
        .fullScreenCover(isPresented: $isShowingCamera) {
            CameraPicker { image in
                attachments.append(ComposerAttachment(image: image))
            }
            .ignoresSafeArea()
        }
        .fullScreenCover(isPresented: $isShowingLiveCall) {
            LiveCallView(chat: chat)
                .appTheme(theme)
        }
        .onChange(of: voice.errorMessage) { _, message in
            guard let message else { return }
            onError(message)
            voice.errorMessage = nil
        }
    }

    // MARK: - Input

    private var textField: some View {
        ComposerTextField(
            text: $text,
            textColor: theme.primaryText,
            maxLines: 6
        ) { images in
            attachments.append(contentsOf: images.map { ComposerAttachment(image: $0) })
        }
        .overlay(alignment: .topLeading) {
            if text.isEmpty {
                Text("Message")
                    .font(.body)
                    .foregroundStyle(theme.tertiaryText)
                    .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, 6)
    }

    private var composerShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
    }

    /// The round, softly filled buttons along the bottom of the composer card.
    private func circleIcon(_ systemName: String, size: CGFloat, foreground: Color, fill: Color) -> some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(foreground)
            .frame(width: 36, height: 36)
            .background(fill, in: Circle())
    }

    private var attachMenu: some View {
        Menu {
            Button {
                isShowingLibrary = true
            } label: {
                Label("Photo Library", systemImage: "photo.on.rectangle")
            }

            Button {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    isShowingCamera = true
                } else {
                    onError("Camera isn't available on this device.")
                }
            } label: {
                Label("Take Photo", systemImage: "camera")
            }
        } label: {
            circleIcon("plus", size: 17, foreground: theme.primaryText, fill: theme.separator)
        }
        .accessibilityLabel("Add attachment")
    }

    private var micButton: some View {
        Button {
            Task { await toggleVoice() }
        } label: {
            if voice.state == .preparing || voice.state == .transcribing {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 36, height: 36)
                    .background(theme.separator, in: Circle())
            } else if voice.state == .recording {
                // A steady stop button, not a pulsing mic: the level meter above already
                // shows it's listening. Accent fill keeps it apart from the gray agent Stop.
                circleIcon("stop.fill", size: 13, foreground: theme.accentForeground, fill: theme.accent)
            } else {
                circleIcon("mic", size: 16, foreground: theme.primaryText, fill: theme.separator)
            }
        }
        .buttonStyle(.plain)
        .disabled(voice.state == .preparing || voice.state == .transcribing)
        .accessibilityLabel(voice.state == .recording ? "Stop dictation" : "Dictate")
    }

    private var stopButton: some View {
        Button {
            Task { await chat.sendKeys(["Escape"]) }
        } label: {
            circleIcon("stop.fill", size: 13, foreground: theme.primaryText, fill: theme.separator)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Stop")
    }

    private var sendButton: some View {
        Button {
            Task { await sendTapped() }
        } label: {
            circleIcon(
                "arrow.up",
                size: 16,
                foreground: canTapSend ? theme.accentForeground : theme.tertiaryText,
                fill: canTapSend ? theme.accent : theme.separator
            )
        }
        .buttonStyle(.plain)
        .disabled(!canTapSend || isSending)
        .accessibilityLabel("Send")
    }

    private var liveCallButton: some View {
        Button {
            isShowingLiveCall = true
        } label: {
            circleIcon("waveform", size: 16, foreground: theme.accentForeground, fill: theme.accent)
        }
        .buttonStyle(.plain)
        .disabled(voice.state != .idle)
        .accessibilityLabel("Start a voice call")
    }

    // MARK: - Voice

    private var voiceStatusRow: some View {
        HStack(spacing: 8) {
            if voice.state == .recording {
                HStack(spacing: 2) {
                    ForEach(0..<14, id: \.self) { index in
                        Capsule()
                            .fill(levelColor(index: index))
                            .frame(width: 3, height: 12)
                    }
                }
                .animation(.linear(duration: 0.08), value: voice.level)

                Text("Listening… tap stop to review, or send to send now")
                    .font(.caption2)
                    .foregroundStyle(theme.secondaryText)
            } else {
                ProgressView()
                    .controlSize(.mini)
                Text(voice.statusText ?? "")
                    .font(.caption2)
                    .foregroundStyle(theme.secondaryText)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
    }

    private func levelColor(index: Int) -> Color {
        let threshold = Float(index + 1) / 14
        return voice.level >= threshold ? theme.accent : theme.tertiaryText.opacity(0.35)
    }

    private func toggleVoice() async {
        switch voice.state {
        case .idle:
            if let error = await voice.start() {
                onError(error)
            }

        case .recording:
            await finishDictation()

        case .preparing, .transcribing:
            break
        }
    }

    /// Stops recording and appends the transcript to the text field.
    private func finishDictation() async {
        guard let transcript = await voice.stopAndTranscribe() else { return }
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            text = trimmed
        } else {
            if !text.hasSuffix(" ") {
                text += " "
            }
            text += trimmed
        }
    }

    // MARK: - Attachments

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: attachment.image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                        Button {
                            attachments.removeAll { $0.id == attachment.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 17))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.55))
                        }
                        .offset(x: 5, y: -5)
                    }
                }
            }
            .padding(.top, 4)
            .padding(.horizontal, 2)
        }
    }

    private func addPicked(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }

        var added: [ComposerAttachment] = []
        for item in items {
            if let data = try? await item.loadTransferable(type: Data.self),
               let image = UIImage(data: data) {
                added.append(ComposerAttachment(image: image))
            }
        }

        if added.isEmpty {
            onError("Couldn't load those photos.")
        }
        attachments.append(contentsOf: added)
        pickerItems = []
    }

    // MARK: - Sending

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    /// While dictating, Send is live too: it finishes the recording and sends in one tap.
    private var canTapSend: Bool {
        canSend || voice.state == .recording
    }

    private func sendTapped() async {
        if voice.state == .recording {
            await finishDictation()
        }
        send()
    }

    private func send() {
        guard canSend, !isSending else { return }

        let outgoingText = text
        let images = attachments.compactMap { ImageEncoder.encode($0.image) }
        let hasText = !outgoingText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        guard hasText || !images.isEmpty else {
            onError("Couldn't encode those photos.")
            return
        }

        isSending = true
        Task {
            let sent = await chat.send(text: outgoingText, images: images)
            isSending = false

            guard sent else { return }
            text = ""
            attachments = []
        }
    }
}
