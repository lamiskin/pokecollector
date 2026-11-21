### Features

- **Locally hosted scanners scan photos individually.** When the scanner is a keyless self-hosted endpoint such as Ollama, every staged photo now starts as its own individual scan, and grouping cards into one composite request is an explicit per-photo or per-batch choice. Gemini and hosted OpenAI-compatible endpoints keep automatic grouping.

### Fixes and changes

- None user-visible. The remaining commits in this release are release-pipeline and documentation updates.

### Limitations and notes

- Individual local scans serialize behind the single-slot endpoint gate, so a batch takes roughly one request per photo. Each photo now has its own request timeout, so a slow photo fails alone instead of taking a whole grid request with it.
- The scanner default is derived from configuration: an endpoint served with `OPENAI_API_KEY_REQUIRED=true` is treated as hosted and keeps composite grouping.
