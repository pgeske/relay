import SwiftUI

struct MessageListView: View {
    let store: ChatStore
    let api: APIClient

    @State private var isNearBottom = true
    /// Whether the list should stay pinned to the newest message. Changes only when the
    /// user scrolls (or sends), so a growing composer shrinking the viewport doesn't unpin it.
    @State private var followsBottom = true
    @State private var topVisibleID: String?
    @State private var showJumpButton = false
    @State private var isPrepending = false

    @Environment(\.appTheme) private var theme

    private let bottomID = "chat-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if store.hasMore || store.isLoadingOlder {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 2)
                            .onAppear {
                                loadOlderIfNeeded(proxy: proxy)
                            }
                    }

                    ForEach(store.items) { item in
                        ChatItemView(item: item, store: store, api: api)
                            .id(item.id)
                    }

                    if store.working {
                        WorkingRow()
                            .id("working")
                    }

                    Color.clear
                        .frame(height: 1)
                        .id(bottomID)
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 8)
            }
            .background(theme.background)
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .scrollPosition(id: $topVisibleID, anchor: .top)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.containerSize.height
                    >= geometry.contentSize.height - 120
            } action: { _, nearBottom in
                isNearBottom = nearBottom
                showJumpButton = !nearBottom && !followsBottom && !store.items.isEmpty
            }
            .onScrollPhaseChange { oldPhase, newPhase in
                let userScrolled = oldPhase == .interacting || oldPhase == .decelerating
                if newPhase == .idle && userScrolled {
                    followsBottom = isNearBottom
                }
            }
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.containerSize.height
            } action: { oldHeight, newHeight in
                // The composer grew or the keyboard appeared: keep the latest message visible.
                if newHeight < oldHeight && followsBottom {
                    scrollToBottom(proxy, animated: false)
                }
            }
            .onChange(of: store.items.count) { _, _ in
                if case .pending = store.items.last?.kind {
                    followsBottom = true
                }
                if followsBottom {
                    scrollToBottom(proxy, animated: true)
                } else if !store.items.isEmpty {
                    showJumpButton = true
                }
            }
            .onChange(of: store.working) { _, working in
                if working && followsBottom {
                    scrollToBottom(proxy, animated: true)
                }
            }
            .overlay {
                if store.isLoadingInitial && store.items.isEmpty {
                    ProgressView("Loading…")
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if showJumpButton {
                    jumpToBottomButton(proxy: proxy)
                }
            }
        }
    }

    private func jumpToBottomButton(proxy: ScrollViewProxy) -> some View {
        Button {
            followsBottom = true
            scrollToBottom(proxy, animated: true)
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 38, height: 38)
                .foregroundStyle(theme.primaryText)
                .background(theme.elevatedSurface, in: Circle())
                .overlay(Circle().stroke(theme.separator))
                .shadow(color: theme.palette.crust.opacity(0.25), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 14)
        .padding(.bottom, 10)
        .transition(.scale.combined(with: .opacity))
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
        } else {
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
    }

    private func loadOlderIfNeeded(proxy: ScrollViewProxy) {
        guard store.hasMore, !store.isLoadingOlder, !store.isLoadingInitial, !isPrepending else {
            return
        }
        isPrepending = true

        let anchor = topVisibleID == bottomID ? nil : topVisibleID
        let fallbackAnchor = anchor ?? store.items.first?.id

        Task {
            await store.loadOlder()
            defer { isPrepending = false }

            guard let fallbackAnchor else { return }
            // Let the newly inserted rows lay out before restoring the anchor.
            try? await Task.sleep(for: .milliseconds(60))
            withAnimation(nil) {
                proxy.scrollTo(fallbackAnchor, anchor: .top)
            }
        }
    }
}

private struct WorkingRow: View {
    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(theme.working)
            Text("Working…")
                .font(.footnote)
                .foregroundStyle(theme.working)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
