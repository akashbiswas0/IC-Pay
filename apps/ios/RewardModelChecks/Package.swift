// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "SuicaRewardModels",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "RewardModels", path: "Sources"),
        .testTarget(name: "RewardModelsTests", dependencies: ["RewardModels"], path: "Tests")
    ]
)
