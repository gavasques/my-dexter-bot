// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DexterApple",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "DexterHostClient", targets: ["DexterHostClient"]),
        .library(name: "DexterAppCore", targets: ["DexterAppCore"]),
    ],
    dependencies: [.package(path: "ClientIdentity"), .package(path: "NativeActions"), .package(path:"KeychainRuntime"), .package(path: "AssistantRuntimeSetup")],
    targets: [
        .target(name: "DexterHostClient", dependencies: [.product(name: "DexterClientIdentity", package: "ClientIdentity")]),
        .target(name: "DexterAppCore", dependencies: [.product(name: "DexterNativeActions", package: "NativeActions"), "DexterHostClient", .product(name: "DexterClientIdentity", package: "ClientIdentity"), .product(name:"DexterKeychainRuntime",package:"KeychainRuntime",condition:.when(platforms:[.macOS])), .product(name: "DexterAssistantRuntimeSetup", package: "AssistantRuntimeSetup", condition: .when(platforms: [.macOS]))]),
        .testTarget(
            name: "DexterHostClientTests",
            dependencies: ["DexterHostClient", .product(name: "DexterClientIdentity", package: "ClientIdentity")],
            resources: [.process("Fixtures")]
        ),
        .testTarget(
            name: "DexterAppCoreTests",
            dependencies: [.product(name: "DexterNativeActions", package: "NativeActions"), "DexterAppCore", "DexterHostClient", .product(name: "DexterClientIdentity", package: "ClientIdentity")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
