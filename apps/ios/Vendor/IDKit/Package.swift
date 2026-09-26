// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "IDKit",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "IDKit", targets: ["IDKit"])],
    targets: [
        .binaryTarget(name: "idkitFFI", path: "IDKitFFI.xcframework"),
        .target(
            name: "IDKit",
            dependencies: ["idkitFFI"],
            path: "Sources/IDKit",
            exclude: ["Generated/idkit_coreFFI.h", "Generated/idkit_coreFFI.modulemap"]
        ),
    ]
)
