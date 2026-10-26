// swift-tools-version: 6.0
import PackageDescription

// Standalone package for the paired Mac's local CUA helper. It is separate from the Dexter app and from
// the Health/iOS capabilities: the daemon spawns `dexter-cua-helper` and talks to it over stdio.
//
// The owned synthetic UI probe is a development fixture, not part of the package unless the build explicitly
// sets DEXTER_CUA_FIXTURES=1 (the lab reproduction does). A plain build, and anything shipped from it, has
// only the targets below.
var targets: [Target] = [
    // Protocol, session gates, the surface reader seam and the fixture backend. Foundation only: no AppKit, AX or screen APIs.
    .target(name: "MacCapabilitiesCore", swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]),
    // Accessibility, lock state, consent and indicator panels. Only used in native mode.
    .target(name: "MacCapabilitiesNative", dependencies: ["MacCapabilitiesCore"], swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]),
    .executableTarget(name: "DexterCuaHelper", dependencies: ["MacCapabilitiesCore", "MacCapabilitiesNative"], swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]),
    .testTarget(name: "MacCapabilitiesCoreTests", dependencies: ["MacCapabilitiesCore"]),
    .testTarget(name: "MacCapabilitiesNativeTests", dependencies: ["MacCapabilitiesNative", "MacCapabilitiesCore"]),
]
if Context.environment["DEXTER_CUA_FIXTURES"] == "1" {
    // Drives the production consent and indicator panels on its own surface only. No input monitor,
    // Accessibility, screen capture or other app is touched.
    targets.append(.executableTarget(name: "CuaPresentationProbe", dependencies: ["MacCapabilitiesNative"],
                                     path: "Fixtures/CuaPresentationProbe", swiftSettings: [.unsafeFlags(["-warnings-as-errors"])]))
}

let package = Package(
    name: "DexterMacCapabilities",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "MacCapabilitiesCore", targets: ["MacCapabilitiesCore"]),
        .library(name: "MacCapabilitiesNative", targets: ["MacCapabilitiesNative"]),
        .executable(name: "dexter-cua-helper", targets: ["DexterCuaHelper"]),
    ],
    targets: targets,
    swiftLanguageModes: [.v6]
)
