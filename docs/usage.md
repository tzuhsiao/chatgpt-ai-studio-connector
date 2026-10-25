# Usage reference

This connector exposes Google GenAI through MCP tools and a Sites-hosted upload page.

## Tools

| Tool | Purpose |
| --- | --- |
| `connector_status` | Read configuration presence, limits, and local usage without contacting Google. |
| `list_models` | List one page of models available through the configured key. |
| `upload_file` | Store an audio, video, image, or PDF input. |
| `generate` | Submit a model request with explicit input, configuration, and billing acknowledgment. |
| `get_request` | Inspect an existing request and poll its mapped background job when applicable. |
| `list_files` | List uploaded and generated files with authenticated download links. |
| `read_file_chunk` | Export a stored file in chunks of up to 256 KiB. |

## Requests and files

The default API is Interactions. The optional `generate_content` path supports legacy generation. Model and modality availability depend on Google's account access.

Every generation requires a UUID `request_id` and `cost_acknowledged: true`. Reusing an ID with the same input returns the existing request; different input with that ID is rejected. After an uncertain result, inspect the original ID rather than automatically resubmitting.

Inputs can be text or references to files uploaded through the connector. File inputs use `file_id` UUIDs rather than arbitrary URLs or local paths. Accepted formats include supported audio and image MIME types, MP4, WebM, and PDF. Files are stored in the authenticated owner's namespace; selected input bytes are sent to Google when generation is requested. Files are not automatically deleted.

Generated text and media are saved with request results and authenticated download links. Raw PCM audio is wrapped as WAV. Provider output is not automatically quality-verified.

## Video analysis

Static video sampling is the default. Video input fields include:

| Field | Values and behavior |
| --- | --- |
| `processing` | `static` or `agentic`; agentic processing requires a supported Interactions model. |
| `fps` | Static sampling only, from 0.1 to 8; defaults to 1. Omit it with agentic processing. |
| `resolution` | `low`, `medium`, or `high`. Omit it for the provider default. |

Higher sampling or resolution can increase token usage. `ultra_high` is not supported for video. Agentic processing and static FPS cannot be combined.

Results may include token usage, submitted video settings, and safe processing markers. These help inspect a request; they do not prove which frames were examined.

## Background requests

Interactions default to `store: false`. To allow a specific request to run in the background with Google-side storage, add:

```json
{
  "background": true,
  "google_storage_acknowledged": true
}
```

These are additional fields on a complete `generate` request, not a standalone payload. Background execution requires explicit storage acknowledgment and is unavailable through `generate_content`. Provider retention follows the Google project's settings; the connector does not promise a per-request expiry or automatic deletion.

Use `get_request` with the original local request ID to check progress. Provider job IDs are mapped privately to that owner and request. Polling retrieves the mapped job without creating another generation. Interrupted foreground requests may retain incomplete `partial_text`; treat it as partial output.

## Omni video generation

The current implementation supports a narrow video-generation path:

- Model: `gemini-omni-1.1-flash`.
- Input: up to 4,000 prompt characters and at most two uploaded reference images.
- Output: one inline, 3-second, 720p MP4 at 16:9.
- `max_output_tokens`: 18,000–20,000; use 20,000 for the supported sample.
- `max_cost_usd`: an explicit approved ceiling checked against a conservative token estimate before submission.
- `background`: explicitly `true` or `false`. Only `true` also requires `google_storage_acknowledged: true`.

The required response format is:

```json
{
  "type": "video",
  "delivery": "inline",
  "duration": "3s",
  "resolution": "720p",
  "aspect_ratio": "16:9"
}
```

For two reference images, supply the start image first and end image second. The connector selects `image_to_video`; endpoint-role prompt tags can be preserved as `[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]`. Model adherence still requires evaluating the generated result.

Synchronous requests use `background: false`, `store: false`, and a 105-second overall deadline. A timed-out synchronous result cannot be reliably recovered. Approved background requests can be polled using their original local request ID.

The cost check is an estimate, not a provider-enforced spending limit. Other video models, durations, resolutions, and delivery modes are not exposed by this path.

## Default limits

| Limit | Default |
| --- | --- |
| Generation attempts | 30 per UTC day; 3 per minute |
| Daily configuration | `MAX_REQUESTS_PER_DAY`, clamped to 1–300 |
| Uploads | 100 per UTC day |
| Combined input | 8 MiB |
| Generated media | 20 MiB total, up to 4 files |
| Ordinary output tokens | Up to 8,192 |
| Omni output tokens | Up to 20,000 |
| Ordinary SDK timeout | 110 seconds |
| Foreground stream / synchronous Omni | 105 seconds |
| Background poll readback | 60 seconds |
| File export chunk | Up to 256 KiB |

Limits count attempts, including failures. They are not a currency budget. Google may charge a request even if the connection times out; paid generation is never automatically retried.

## Hosting and development

The current deployment uses Sites, Cloudflare Workers, D1, and R2 with the official `@google/genai` SDK pinned to 2.26.0. The server reads `GEMINI_API_KEY` from runtime secrets and requires an authenticated identity matching `OWNER_EMAIL`.

Authentication depends on the trusted Sites ingress. Moving to another host requires independently verified authentication and removal or replacement of caller-supplied identity headers. See [source and hosting notes](../SOURCE-EXPORT.md).

Tests use in-memory SQLite, mock object storage, and mock HTTP. They cover authorization, owner isolation, quotas, request deduplication, request serialization, streaming, and error handling without live Google generation.

## Maintenance

MCP initialization and `connector_status` include maintenance instructions for the assistant. With connected GitHub/development tools and the owner's authorization, it can investigate visible failures, search existing reports, file a sanitized issue, or open a tested draft PR in this repository. Paid generation is not retried for diagnosis; merging and deployment need separate authorization. This is assistant guidance, not a background monitoring service or guaranteed repair.

## References

- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Background execution](https://ai.google.dev/gemini-api/docs/background-execution)
- [Speech generation](https://ai.google.dev/gemini-api/docs/speech-generation)
- [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Omni video](https://ai.google.dev/gemini-api/docs/omni)
