// Turns the iPhone app's square 1024px icon into a macOS .iconset: the artwork inset on the macOS
// icon grid (824px of 1024), clipped to its rounded square, with the system's soft drop shadow.
// Usage: swift make-icon.swift <icon.png> <AppIcon.iconset>
import AppKit
import SwiftUI

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: make-icon.swift <icon.png> <AppIcon.iconset>\n".utf8))
    exit(2)
}
guard let artwork = NSImage(contentsOfFile: arguments[1])?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write(Data("make-icon: can't read \(arguments[1])\n".utf8))
    exit(1)
}
let iconset = URL(filePath: arguments[2], directoryHint: .isDirectory)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

let canvas: CGFloat = 1024
let body = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = RoundedRectangle(cornerRadius: 185.4, style: .continuous).path(in: body).cgPath

let sizes: [(name: String, pixels: Int)] = [
    ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
    ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024),
]
for (name, pixels) in sizes {
    let scale = CGFloat(pixels) / canvas
    guard let context = CGContext(
        data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { exit(1) }
    context.interpolationQuality = .high
    context.scaleBy(x: scale, y: scale)

    // Shadows ignore the scale, so they're sized in pixels.
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -10 * scale), blur: 22 * scale, color: CGColor(gray: 0, alpha: 0.32))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: 0.16, alpha: 1))
    context.fillPath()
    context.restoreGState()

    context.saveGState()
    context.addPath(shape)
    context.clip()
    context.draw(artwork, in: body)
    context.restoreGState()

    // A faint edge keeps the dark icon from melting into a dark Dock.
    context.addPath(shape)
    context.setStrokeColor(CGColor(gray: 1, alpha: 0.14))
    context.setLineWidth(2.5)
    context.strokePath()

    guard let image = context.makeImage() else { exit(1) }
    let file = iconset.appending(path: "icon_\(name).png")
    guard let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil) else { exit(1) }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { exit(1) }
}
