// swift-tools-version: 6.0
import PackageDescription
let package = Package(name:"DexterKeychainRuntime",platforms:[.macOS(.v14),.iOS(.v17)],products:[
    .library(name:"DexterKeychainRuntime",targets:["DexterKeychainRuntime"])
],targets:[.target(name:"DexterKeychainRuntime"),.testTarget(name:"DexterKeychainRuntimeTests",dependencies:["DexterKeychainRuntime"])],swiftLanguageModes:[.v6])
