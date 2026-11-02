# Optional downloads

The Cold Open release contains no voice, speech or language model weights. Each of the following is downloaded
only when the writer asks for it, and none is licensed by Cold Open.

- **Voice packs** (Settings > Local Features): Phonon, Kokoro, Ming and Qwen3-TTS weights from Hugging Face. Each
  pack is pinned to exact repository revisions and file hashes in `apps/desktop/src/main/models/voice-manifest.ts`.
  After download, Cold Open writes the pack's license, provenance, sources and any required attribution (for
  example CC BY 4.0) into a notice file beside the weights.
- **Dictation**: the speech helper downloads Parakeet models through FluidAudio from Hugging Face on first use, under
  their own licenses. Apple's on-device speech recognition is part of macOS.
- **Local AI**: Cold Open talks to an Ollama server the writer installs and runs. Ollama and the models pulled into
  it are separate software under their own licenses.
- **Cloud AI**: ChatGPT (through OpenAI's Sign in with ChatGPT for open-source apps) and the writer's own Anthropic,
  OpenAI or Google API keys are services under their providers' terms. Cold Open sends script text to them only when
  the writer has set one up, and asks once before casting or sentence completion first use one.
