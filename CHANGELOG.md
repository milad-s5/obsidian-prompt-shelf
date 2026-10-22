# Changelog

## 1.1.0

- Messages passed to `api.chat()` can carry `images` (JPEG, PNG, WebP) and `audio` (MP3, WAV, OGG, WebM, M4A, AAC, FLAC) as base64. They are mapped to each provider's own format; messages without them send exactly the same request body as before.
- Each model has **Images** and **Audio** toggles in settings, on by default for names that suggest support. Requests with images or audio skip models that are not marked for them, along the whole fallback chain, and fail clearly when none is left.
- `json: true` asks for a JSON answer (Gemini `responseMimeType`, OpenAI-compatible `response_format`, retried once without it on a 400) and returns it with code fences stripped.
- Requests over 8 MB of images or 15 MB of audio are rejected before sending.
- Image and audio data is never logged, saved or cached; long base64 runs are removed from error details.
- `api.version` is now `3`, with a new `api.capabilities()`. Every version 2 method behaves as before.
- Unit tests (`npm test`) for the request bodies, model selection, JSON handling and streaming.

## 1.0.0

- First release: providers and keys in one place, reusable actions, streaming answers, thinking levels, Save as note, fallback models, clear errors, and a script API with a ready-made panel.
