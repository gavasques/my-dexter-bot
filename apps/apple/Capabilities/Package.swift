// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DexterIOSCapabilities",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "DexterIOSCapabilities", targets: ["DexterIOSCapabilities"])],
    dependencies: [.package(name: "NativeActions", path: "../NativeActions")],
    targets: [
        .target(name: "DexterIOSCapabilities", dependencies: [.product(name: "DexterNativeActions", package: "NativeActions")], resources: [.process("Resources")]),
        .testTarget(name: "DexterIOSCapabilitiesTests", dependencies: ["DexterIOSCapabilities", .product(name: "DexterNativeActions", package: "NativeActions")]),
        .testTarget(name: "DexterIOSForegroundCapabilitiesTests", dependencies: ["DexterIOSCapabilities", .product(name: "DexterNativeActions", package: "NativeActions")]),
    ],
    swiftLanguageModes: [.v6]
)
