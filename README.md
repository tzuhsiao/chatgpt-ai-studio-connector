# chatgpt-ai-studio-connector

Connect ChatGPT to Google AI Studio for access to Gemini, Nano Banana, Omni, and more.

## Features

- Text and structured JSON output.
- Image, speech, and music generation.
- Audio, video, image, and PDF analysis.
- Bounded Omni video generation, file uploads, and request tracking.

Model availability depends on your Google API access.

## Setup

1. In the Site's Settings, add `GEMINI_API_KEY` as a secret and set `OWNER_EMAIL`.
2. Keep Site access restricted to the owner, then redeploy.
3. Install the Site's plugin in ChatGPT.
4. Check `connector_status` and `list_models`, then use the plugin in chat.

Google may charge for generation. After a timeout, check the original request ID before submitting again.

## Development

Requires Node.js 22.13 or later.

```sh
npm run install:ci
npm test
npx tsc --noEmit
npm run build
```

## Documentation

- [Tools, media options, and limits](docs/usage.md)
- [Source provenance and hosting requirements](SOURCE-EXPORT.md)
