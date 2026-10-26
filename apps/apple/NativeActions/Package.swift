// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DexterNativeActions",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "DexterNativeActions", targets: ["DexterNativeActions"]),
    ],
    targets: [
        .target(
            name: "DexterNativeActions",
            resources: [.process("Resources")]
        ),
        .testTarget(name: "DexterNativeActionsTests", dependencies: ["DexterNativeActions"]),
    ],
    swiftLanguageModes: [.v6]
)
