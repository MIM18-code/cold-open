# Third-party notices

Cold Open's application code is licensed under GPL-3.0-only. The screenplay engine, relay and dictation packages
are MIT. Third-party components keep their own copyrights and licenses.

The release includes a `licenses/` directory with the full upstream license and notice files.
`licenses/components.json` records each bundled package's name, version, license and upstream repository:

- JavaScript packages bundled into the app (React, ProseMirror, Yjs, y-protocols, lib0, ws, pdf-lib, saxes,
  qrcode.react, Atlassian's pragmatic drag-and-drop and their dependencies).
- Swift packages compiled into the voice and speech helpers (FluidAudio, MLX Swift, mlx-audio-swift,
  swift-transformers, swift-huggingface, swift-jinja, swift-crypto, swift-asn1, swift-collections,
  swift-numerics, EventSource, yyjson, zstd), including the components they compile in themselves, such as MLX,
  metal-cpp, fmt and nlohmann/json inside MLX Swift, and FluidAudio's third-party model notices.

Electron 44.2.0's MIT license is in `licenses/electron-LICENSE`. Its complete Chromium component notices are in
`licenses/electron-LICENSES.chromium.html`. Native runtime source and modification information is in
[docs/NATIVE_SOURCE.md](docs/NATIVE_SOURCE.md). The corresponding source archives accompany every binary release;
keep them, and these notices, when redistributing a release.

`apps/desktop/src/renderer/features/assistant/brand/chatgpt-logo-black.svg` and `chatgpt-logo-white.svg` are
OpenAI's ChatGPT logo, unchanged from developers.openai.com/assets/siwc/sign-in-buttons/, for the "Continue with
ChatGPT" button that OpenAI's Sign in with ChatGPT guidelines call for. The logo is OpenAI's trademark and is not
covered by Cold Open's license.

Cold Open includes the default Parakeet dictation weights by NVIDIA, converted to Core ML by FluidInference.
The model, vocabulary and attribution ship in `Contents/Resources/parakeet-tdt-0.6b-v3`. [Original model](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Core ML conversion](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml/tree/7dd20fe6b1797d35f5e3307e8b1732d9a178edfe), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Additional voice packs and local writing models are separate downloads. Cold Open downloads them only when
the writer asks, from pinned revisions, and keeps each one's license and attribution beside it; see
[docs/OPTIONAL_DOWNLOADS.md](docs/OPTIONAL_DOWNLOADS.md).

Cold Open uses the Mac's installed fonts and bundles no font files.
