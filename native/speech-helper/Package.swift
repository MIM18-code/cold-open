// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "SpeechHelper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "speech-helper", targets: ["SpeechHelper"]),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.0"),
    ],
    targets: [
        .executableTarget(
            name: "SpeechHelper",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
