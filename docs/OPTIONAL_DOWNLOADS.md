# Optional downloads

Cold Open includes its default Parakeet dictation model. Additional voices and local writing models are optional downloads.

- **Voice packs** (Settings > Local Features): Phonon, Kokoro, Ming and Qwen3-TTS weights from Hugging Face. Each
  pack is pinned to exact repository revisions and file hashes in `apps/desktop/src/main/models/voice-manifest.ts`.
  After download, Cold Open writes the pack's license, provenance, sources and any required attribution (for
  example CC BY 4.0) into a notice file beside the weights.
- **Dictation**: the Mac app includes NVIDIA’s Parakeet TDT 0.6B v3 in FluidInference’s Core ML format, including the int8-v2 encoder. The helper loads it from the app bundle on first use. Dictation works offline without a model download. Apple's on-device speech recognition is part of macOS.
- **Local AI**: Tools > Set up AI can start an existing Ollama installation or download a checksum-verified Mac runtime into Cold Open’s application data. After the writer chooses local setup, Cold Open starts the server on loopback and downloads a writing model if needed. Ollama and the models pulled into
  it are separate software under their own licenses.
- **Cloud AI**: ChatGPT (through OpenAI's Sign in with ChatGPT for open-source apps) and the writer's own Anthropic,
  OpenAI or Google API keys are services under their providers' terms. Cold Open sends script text to them only when
  the writer has set one up, and asks once before casting or sentence completion first use one.
