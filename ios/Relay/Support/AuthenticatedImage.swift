import SwiftUI

/// Loads a server image with the bearer token attached and caches the result.
struct AuthenticatedImage: View {
    let path: String
    let api: APIClient

    @Environment(\.appTheme) private var theme
    @State private var image: UIImage?
    @State private var didFail = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if didFail {
                Label("Image unavailable", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(theme.secondaryText)
                    .padding(12)
                    .frame(maxWidth: .infinity)
                    .background(
                        theme.elevatedSurface,
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
            } else {
                ProgressView()
                    .frame(minWidth: 120, minHeight: 80)
            }
        }
        .task(id: path) {
            await load()
        }
    }

    private func load() async {
        guard image == nil, !didFail, !path.isEmpty else { return }

        if let cached = ImageCache.shared.image(for: path) {
            image = cached
            return
        }

        do {
            let data = try await api.imageData(serverPath: path)
            guard let loaded = UIImage(data: data) else {
                didFail = true
                return
            }
            ImageCache.shared.store(loaded, for: path)
            image = loaded
        } catch {
            didFail = true
        }
    }
}

@MainActor
final class ImageCache {
    static let shared = ImageCache()

    private let cache = NSCache<NSString, UIImage>()

    func image(for key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        cache.setObject(image, forKey: key as NSString)
    }
}
