// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "DexterDeviceIdentity", platforms: [.macOS(.v14)], products: [
    .library(name: "DexterDeviceIdentity", targets: ["DexterDeviceIdentity"]),
    .executable(name: "dexter-device-identity", targets: ["DexterDeviceIdentityCLI"]),
], dependencies: [.package(path:"../KeychainRuntime")], targets: [
    .target(name: "DexterDeviceIdentity",dependencies:[.product(name:"DexterKeychainRuntime",package:"KeychainRuntime")]),
    .executableTarget(name: "DexterDeviceIdentityCLI", dependencies: ["DexterDeviceIdentity"]),
    .testTarget(name: "DexterDeviceIdentityTests", dependencies: ["DexterDeviceIdentity"]),
], swiftLanguageModes: [.v6])
