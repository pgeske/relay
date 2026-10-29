import SwiftUI

/// Full-screen voice call with the session's agent, like ChatGPT's voice mode.
/// The orb grows with whoever is talking; the label shows what omp is doing.
struct LiveCallView: View {
    let chat: ChatStore

    @State private var call = LiveCallController()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            Text(chat.info.displayTitle)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(theme.secondaryText)
                .lineLimit(1)
                .padding(.top, 24)
                .padding(.horizontal, 24)

            Spacer()

            orb

            Text(statusText)
                .font(.title3.weight(.medium))
                .foregroundStyle(call.errorMessage == nil ? theme.primaryText : theme.error)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.top, 40)
                .animation(.easeInOut, value: statusText)

            Spacer()

            controls
                .padding(.bottom, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(theme.background)
        .task { await call.start(chat: chat) }
        .onDisappear { call.hangUp() }
        .onChange(of: call.isEnded) { _, ended in
            // A clean hang-up closes the screen; an error stays up so it can be read.
            if ended && call.errorMessage == nil { dismiss() }
        }
    }

    private var orb: some View {
        let level = CGFloat(max(call.agentLevel, call.micLevel * 0.6))
        return Circle()
            .fill(
                RadialGradient(
                    colors: [theme.accent.opacity(0.95), theme.accent.opacity(0.45)],
                    center: .center,
                    startRadius: 10,
                    endRadius: 120
                )
            )
            .frame(width: 180, height: 180)
            .scaleEffect(call.isEnded ? 0.6 : 0.85 + level * 0.45)
            .opacity(call.phase == "connecting" || call.isEnded ? 0.45 : 1)
            .animation(.easeOut(duration: 0.12), value: level)
            .animation(.easeInOut(duration: 0.4), value: call.phase)
    }

    private var statusText: String {
        if let error = call.errorMessage { return error }
        if call.isEnded { return "Call ended" }
        if call.isMuted { return "You're muted" }
        switch call.phase {
        case "connecting": return "Connecting…"
        case "listening": return "Listening"
        case "working": return "Working on it…"
        case "speaking": return "Speaking"
        case "muted": return "Muted on the computer"
        case "error": return "Something went wrong"
        default: return call.phase.capitalized
        }
    }

    private var controls: some View {
        HStack(spacing: 56) {
            Button {
                call.toggleMute()
            } label: {
                Image(systemName: call.isMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(call.isMuted ? theme.accentForeground : theme.primaryText)
                    .frame(width: 68, height: 68)
                    .background(call.isMuted ? theme.accent : theme.elevatedSurface, in: Circle())
            }
            .disabled(call.isEnded)
            .accessibilityLabel(call.isMuted ? "Unmute" : "Mute")

            Button {
                call.hangUp()
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(theme.errorForeground)
                    .frame(width: 68, height: 68)
                    .background(theme.error, in: Circle())
            }
            .accessibilityLabel(call.isEnded ? "Close" : "End call")
        }
        .buttonStyle(.plain)
    }
}
