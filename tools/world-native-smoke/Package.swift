// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "WorldNativeSmoke",
    platforms: [.macOS(.v12)],
    dependencies: [.package(path: "../../apps/ios/Vendor/IDKit")],
    targets: [.executableTarget(name: "WorldNativeSmoke", dependencies: [.product(name: "IDKit", package: "IDKit")])]
)
