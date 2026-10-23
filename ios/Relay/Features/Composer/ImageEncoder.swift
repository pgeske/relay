import UIKit

struct ComposerAttachment: Identifiable {
    let id = UUID()
    let image: UIImage
}

enum ImageEncoder {
    /// Downsizes and JPEG-encodes a photo for POST /input.
    static func encode(
        _ image: UIImage,
        maxDimension: CGFloat = 2048,
        quality: CGFloat = 0.8
    ) -> InputImage? {
        let resized = downscaled(image, maxDimension: maxDimension)
        guard let data = resized.jpegData(compressionQuality: quality) else {
            return nil
        }
        return InputImage(base64: data.base64EncodedString(), mimeType: "image/jpeg")
    }

    static func downscaled(_ image: UIImage, maxDimension: CGFloat) -> UIImage {
        let pixelSize = CGSize(
            width: image.size.width * image.scale,
            height: image.size.height * image.scale
        )
        let longestSide = max(pixelSize.width, pixelSize.height)
        guard longestSide > maxDimension, longestSide > 0 else { return image }

        let factor = maxDimension / longestSide
        let target = CGSize(
            width: max(1, (pixelSize.width * factor).rounded()),
            height: max(1, (pixelSize.height * factor).rounded())
        )

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
