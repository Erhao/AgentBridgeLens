// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AgentBridgeMac",
    platforms: [.macOS("14.2")],
    products: [.executable(name: "AgentBridgeMac", targets: ["AgentBridgeMac"])],
    targets: [
        .target(name: "BridgeCore"),
        .executableTarget(name: "AgentBridgeMac", dependencies: ["BridgeCore"]),
        .executableTarget(name: "BridgeCoreChecks", dependencies: ["BridgeCore"])
    ]
)
