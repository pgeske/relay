// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "RelayBoard",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(name: "RelayBoard", path: "Sources/RelayBoard"),
    ]
)
