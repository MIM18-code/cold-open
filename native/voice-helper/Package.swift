// swift-tools-version:6.2
import PackageDescription
let package = Package(
    name: "VoiceHelper",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "voice-helper", targets: ["VoiceHelper"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.0"),
        .package(url: "https://github.com/Blaizzy/mlx-audio-swift.git", revision: "87d0359538f8d7915ae77a41655dfcd891b6e614"),
        .package(url: "https://github.com/ml-explore/mlx-swift.git", from: "0.33.0")
    ],
    targets: [.executableTarget(name: "VoiceHelper", dependencies: [
        .product(name: "FluidAudio", package: "FluidAudio"),
        .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
        .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
        .product(name: "MLX", package: "mlx-swift")
    ], resources: [.copy("Notices")])]
)
