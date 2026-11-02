# Voice helper notices

Cold Open is GPL-3.0-only. This directory is copied into the VoiceHelper resource bundle for packaging.

FluidAudio 0.18.0 is pinned at e15287985625dbf544a343df679436789ffb03fb. Its supplied top-level LICENSE is Apache-2.0; the bundled ThirdPartyLicenses are retained under FluidAudio/. Some optional FluidAudio TTS components have additional terms. GPL TTS components are compatible with Cold Open's GPL distribution; that does not establish a license for downloaded weights or voice recordings. The helper uses KokoroAne and Phonon, not the optional Inflect backend.

MLX Audio Swift is pinned at 87d0359538f8d7915ae77a41655dfcd891b6e614. Its MIT license is retained here. MLX Swift's MIT license is retained separately.

Downloaded model cards, weight licenses and notices are versioned files in the app-owned voice manifests. Their checksums and conversion provenance belong to each voice pack. Kokoro voice-asset permission and pronunciation frontend terms must be reviewed independently of the engine's code license. Phonon English 31m is the supported pack; noncommercial 40m packs are excluded. Qwen starter recipes contain no recordings; their generated reference assets require listening and rights review before redistribution.
