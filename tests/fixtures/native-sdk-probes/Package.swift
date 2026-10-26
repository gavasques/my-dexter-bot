// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DexterSyntheticSDKProbes", platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../../apps/apple")],
    targets: [
        .executableTarget(name: "GroupsSDKProbe", dependencies: [.product(name: "DexterHostClient", package: "apple"), .product(name: "DexterAppCore", package: "apple")]),
        .executableTarget(name: "NativeVoiceSDKProbe", dependencies: [.product(name: "DexterHostClient", package: "apple")])
    ], swiftLanguageModes: [.v6])
