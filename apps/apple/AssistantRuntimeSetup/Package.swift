// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DexterAssistantRuntimeSetup", platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "DexterAssistantRuntimeSetup", targets: ["DexterAssistantRuntimeSetup"])],
    targets: [.target(name: "DexterAssistantRuntimeSetup"),
              .testTarget(name: "DexterAssistantRuntimeSetupTests", dependencies: ["DexterAssistantRuntimeSetup"])])
