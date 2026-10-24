# chatgpt-ai-studio-connector
Connect ChatGPT to Google AI Studio for access to Gemini, Nano Banana, Omni, and more.

Private MCP connector using the official `@google/genai` JavaScript SDK, pinned to **2.26.0**. This is an extensible, schema-guided Google GenAI client, not an audio-only wrapper.

## Setup

1. Open https://chatgpt.com/sites and find **AI Studio Connector**.
2. Select **More actions → Settings** and add `GEMINI_API_KEY` as a **secret**. Enter the key directly there; do not paste it into chat, source, tool arguments, or this website.
3. Ensure `OWNER_EMAIL` is configured to the owner account email, retain owner-only Site access, and redeploy the latest saved version to apply the settings. Missing `OWNER_EMAIL` fails closed. Never put the API key in Git.
4. Install the Site's canonical private plugin from **Plugins → Personal → Created by you**.
5. Use `connector_status`, then `list_models` for a read-only connection check. Generation only follows a specific authorized request.

The Site's owner is enforced twice: Sites private access, and a server-side comparison of the platform-verified email against `OWNER_EMAIL`. A service token without user identity is insufficient for data-bearing tools. Do not broaden Site access or expose the key.

## Tools

- `connector_status`: key presence, local usage, limits, guidance; no Google request
- `list_models`: one SDK model-list page
- `upload_file`: private audio/video/image/PDF input, base64 up to 8 MiB; website multipart upload is easier for larger files
- `generate`: explicit model, text/media input (including MP4/WebM video), optional system instruction, output JSON schema, audio response format, single/two-speaker configuration, token limit, temperature and seed; Interactions API by default or legacy `generateContent`
- `get_request`: look up a previously submitted request without generating again
- `list_files`: private uploaded/generated file metadata and download URLs
- `read_file_chunk`: bounded 256 KiB chunks for file export into an authorized attachment workflow

Input files are stored in R2 under the authenticated user's namespace. A generation request sends only supplied prompt, configuration and selected input bytes to Google. Interactions default to `store=false`; explicitly approved background requests use `store=true`. Generated text/audio/images are persisted privately, with playable or downloadable links. Raw PCM is wrapped into WAV. Model output is not automatically listened to or quality-verified. Google content safety or account limitations may reject a request.

The plugin's MCP initialization guidance explicitly preserves the owner's preference: **do not use Gemini for coding**. This is workflow guidance; the connector remains general-purpose.

## Video review

MP4/WebM input uses inline bytes through the official SDK. Static sampling defaults to 1 FPS and can be set between 0.1 and 8 FPS per video input. Higher sampling uses more tokens. Original video frame rate is not the analysis sampling rate.

Set `resolution: "high"` on a video input for the highest supported Gemini 3 video detail, independently of FPS. `low` and `medium` are also supported. Omit `resolution` to preserve the provider default. High uses approximately 280 tokens per frame, compared with 70 at low/medium/default; `ultra_high` is image-only and is rejected for video. For example: `{ "type": "video", "file_id": "<uploaded UUID>", "fps": 1, "resolution": "high" }`.

Interactions receives `resolution: "high"` on the video content item. The legacy `generate_content` path receives `mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" }` on the video part. Per-item resolution is a Gemini 3 capability; other model eligibility depends on Google.

Results include model, API, total token usage and modality breakdowns when returned by Google. These support a cost estimate using current model pricing; the API response is not a billing receipt.

For adaptive video understanding with Gemini 3.8 Flash on Interactions, set `processing: "agentic"` and omit `fps`: `{ "type": "video", "file_id": "<uploaded UUID>", "processing": "agentic", "resolution": "high" }`. The connector passes the string `"agentic"` directly to the video content item; no static FPS is added. The combination of agentic processing and FPS is rejected, as is agentic processing through the legacy API. Static processing remains the default for existing requests.

Video results include `video_input_config` as a receipt of the submitted settings and `processing_steps` containing only the returned `processing_call`/`processing_result` type markers. These markers can confirm provider processing steps when returned, without exposing signatures, raw model thoughts, or media content. An empty marker list does not prove which frames were inspected. Actual input usage can vary in agentic mode and may be higher or lower than static sampling.

## Defaults and limits

- 30 generation attempts per UTC day, configurable via non-secret `MAX_REQUESTS_PER_DAY` (1–300); 3 per minute
- Up to 8,192 output tokens, 8 MiB combined input, 20 MiB combined output media, 4 generated media files
- 100 uploads per UTC day, up to 8 MiB each
- 110-second SDK timeout for ordinary requests; agentic video text/JSON uses bounded foreground streaming up to 105 seconds, with MCP SSE keepalives every 15 seconds; no automatic paid retries
- UUID idempotency with input fingerprint; duplicates return the original result, mismatched input fails
- Limits count attempts, including failures. These are operational request limits, **not a currency spending cap**. Set appropriate Google project billing/quota controls separately. A timeout does not prove that Google canceled or did not charge the request.
- Files remain private; no automatic deletion is performed

No arbitrary SDK method execution, code execution, tools, remote URLs, general-purpose agents, live audio sessions, Google Files API or voice-cloning endpoints are exposed. Per-request acknowledged background execution and narrowly bounded Omni video generation are supported as described below. New capabilities require explicit schemas and authorization handling.

## Long-running request reliability

Agentic video text/JSON requests stream from Google with `store=false`; generated audio/image response paths retain their existing non-streaming behavior. MCP clients that accept `text/event-stream` receive an immediate SSE response, 15-second keepalives and the final JSON-RPC result. This is one bounded foreground request, not a detached job or automatic retry. The connected MCP host canceled a nonbillable 120-second probe despite keepalives, so foreground streaming is deliberately bounded to 105 seconds. Longer jobs require the separately acknowledged background path below.

The stream reducer retains only model-output text, safe processing markers, bounded usage metadata and an interaction ID. It ignores thought content and signatures. Private progress snapshots are saved locally at most once per two seconds plus lifecycle boundaries; interrupted requests expose bounded `partial_text`, `partial: true`, phase and timing through `get_request`. Partial text is incomplete and must not be presented as a finished answer. An interaction ID with `store=false` is diagnostic metadata, not a recovery guarantee. Disconnection or worker shutdown can stop foreground work; use the same request ID to inspect saved state, never silently retry generation.

Failure diagnostics expose only allowlisted error categories, numeric HTTP status, elapsed time and configured timeout. Raw provider errors, headers, stack traces, prompts, media and credentials are neither logged nor returned. Since 1.5.2, an owner-only failed background poll also returns an allowlisted provider error code and exact known boilerplate message in poll_diagnostic.provider_error. Unrecognized text is suppressed with message_redacted=true; the configured credential and mapped provider ID are explicitly excluded. This diagnostic is not written to Worker logs and does not change GET parameters, retries, limits, job mapping or generation behavior. Version 1.5.3 additionally records only presence/counts of potential outgoing authentication channels at the polling fetch boundary, without changing or retaining header/query values. It recognizes the user-observed multiple-authentication-credentials boilerplate. Older failed records remain unchanged and may lack these details.

For a nonbillable transport check, `connector_status` accepts optional `transport_probe_seconds` (0–130). This waits in the same foreground request, emits SSE keepalives when supported, then reads status without contacting Google or changing generation quotas.

## Optional background execution

Default requests remain `store=false`. For a specific request whose Google storage the user explicitly approved, add both `background: true` and `google_storage_acknowledged: true` to `generate` with `api: "interactions"`. Missing acknowledgment, acknowledgment without background, and legacy-API background requests are rejected before generation. The resulting Google request is `background:true`, `store:true`, `stream:false`. This is per-request consent, not a global preference.

Google's default retention is 55 days on paid tier and 1 day on free tier, subject to project settings. There is no per-request TTL/expiry field; do not promise an exact one-day deletion. No automatic deletion is performed. See the official Interactions data-retention and background-execution guides.

The connector immediately stores the returned provider interaction ID privately under the authenticated owner's local request ID. It never accepts arbitrary provider IDs or returns the mapped background provider ID. `get_request` polls only that mapped interaction with `include_input:false`, a hard 60-second total readback deadline and no automatic retries. Google rejected standard field-mask projection on this endpoint. Readback therefore incrementally discards signature, summary, input and binary data values before SDK JSON parsing. It retains final text/JSON and usage without assembling discarded values. Raw streaming reads are bounded to 128 MiB; retained JSON is bounded to 4 MiB. This background readback path is for text/JSON output; large media output uses the existing foreground path. Failed bounded reads preserve the job mapping. Generation is never re-created when polling or reusing an existing request ID. Concurrent polls use a short recoverable local lease. Pending results retain safe operational metadata; completed text/media is saved through the existing private output pipeline. Transient GET failures preserve the job as running so the same ID can be checked later. If a creation response fails before an ID is received, the connector cannot recover the handle and will not submit a second paid request automatically.

## Verification

`node --import tsx --test tests/*.test.ts`

`npx tsc --noEmit`

`node <Sites plugin directory>/scripts/build-site.mjs`

Tests use in-memory SQLite, mock object storage and mock HTTP. They cover authorization, per-user isolation, MCP discovery, quotas, idempotency, error redaction, large base64 media, TTS mapping, music output, legacy generation and real-SDK Interactions serialization. **No real API key or live Google generation was used for the initial build.** Actual model eligibility remains unverified until the owner configures the key and authorizes a request.

## Official references

- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://ai.google.dev/gemini-api/docs/background-execution
- https://ai.google.dev/gemini-api/docs/speech-generation
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://ai.google.dev/gemini-api/docs/media-resolution
- https://ai.google.dev/gemini-api/docs/audio
- https://ai.google.dev/gemini-api/docs/music-generation
- https://googleapis.github.io/js-genai/release_docs/
- https://learn.chatgpt.com/docs/sites


## Narrow Omni video experiment (introduced in 1.5.1; limits updated in 1.6.2)

Only `gemini-omni-1.1-flash` supports generated video in this version. Choose `background:true` with explicit Google storage acknowledgment for asynchronous execution, or the synchronous option below. It accepts at most two private reference images and 4000 prompt characters. Set `response_format` to `{ "type": "video", "delivery": "inline", "duration": "3s", "resolution": "720p", "aspect_ratio": "16:9" }`, `max_output_tokens` to 20000, and `max_cost_usd` to the user-approved USD ceiling. Ordinary modalities retain their existing 8192-token maximum. Unspecified execution mode, Veo, URI outputs, arbitrary resolutions, longer durations, editing chains and unsupported settings are rejected before generation.

Before one paid submission, the SDK makes a non-generating countTokens request. The cost guard uses $1.50 per million input tokens and the higher $17.50 rate for every output token, including text/thinking, and refuses if this conservative estimate exceeds the approved ceiling. A 3-second 720p video normally represents 17,376 output video tokens ($0.30408), with additional input/text usage. The estimate is not a provider-enforced dollar budget or billing receipt. Provider access/parameter support remains live-test dependent.

Video retrieval reuses the same owner-mapped background interaction. It retains bounded inline media while stripping signatures, summaries and input before SDK parsing. This special path has a 32 MiB retained-JSON cap and the existing 128 MiB raw-read cap; saved MP4 remains capped at 20 MiB. Normal text/JSON polls retain the existing 4 MiB cap and strip binary data. Tool responses contain private file metadata, never MP4 base64. Export uses the existing 256 KiB chunk reader. No API key handling, Site audience, persistent account access, external URL fetching, retries or deletion behavior changed.

Official references: https://ai.google.dev/gemini-api/docs/omni , https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash , https://ai.google.dev/api/interactions-api , https://ai.google.dev/gemini-api/docs/pricing#gemini-omni-flash

## Controlled synchronous Omni option (1.6.0)

For an explicitly authorized synchronous trial, use `background:false` and omit `google_storage_acknowledged`. The same narrow 3-second 720p Omni format, at most two images, 18,000–20,000 output-token bound, explicit billable approval and conservative `max_cost_usd` guard remain required. An omitted background choice is rejected for Omni. The provider request is `background:false, store:false, stream:false`.

The complete cost-check plus synchronous submission/readback is bounded to 105 seconds. Cost failure or deadline expiry before submission prevents a later POST. SDK retries remain disabled. Media readback reuses the 128 MiB raw/32 MiB filtered response bounds and 20 MiB decoded-output cap. A completed inline MP4 is saved in existing owner-private storage. A timeout, interrupted response, missing MP4 or provider failure stays under the original local request ID and never triggers a second generation or provider GET. A timeout may still be billed and `store:false` does not provide background recovery. Existing approved background jobs retain their original retrieval path.

HTTP 400 is no longer described as proof of invalid model/input. The known multiple-credentials error is classified separately. Failed background retrieval explicitly marks the displayed provider status unverified/last-known, without inventing a terminal provider result.

## Distinct Omni endpoint references (1.6.2)

Omni accepts zero, one, or two private reference images; three or more are rejected before provider access. To constrain distinct endpoint poses, supply the start image first and end image second, with prompt tags `[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]`. Image order, original bytes and prompt tags are forwarded unchanged. The combined 8 MiB input limit (including text), 4000-character prompt limit, model/format restrictions, token and cost guards, private owner-only storage, and synchronous/background behavior are unchanged. Both images are included in the preflight token count. Provider compliance with endpoint poses still requires an explicitly authorized live generation to evaluate.

## Explicit endpoint interpolation (1.6.3)

Exactly two-image Omni video requests now set `generation_config.video_config.task` to `image_to_video`. Google's [Interactions API schema](https://ai.google.dev/api/interactions-api) defines this mode as first-image start frame and optional second-image end frame; omitting it lets the model choose a task automatically. Zero/one-image requests retain automatic task selection, and non-video requests are unchanged. This applies to both existing synchronous and background modes without changing the input wrapper, reference order, bytes, cost preflight, or other guards. SDK serialization is tested without provider calls; model adherence and pixel fidelity still need separately authorized generation to evaluate.

## Source export and hosting boundary

See [SOURCE-EXPORT.md](SOURCE-EXPORT.md) for the reviewed source revision, export changes, and deployment prerequisites. The current application relies on Sites to authenticate visitors and strip or overwrite client-supplied `oai-authenticated-user-*` headers. Do not expose the application directly on another host while trusting those headers; add independently verified authentication first. The local preview mock identity is for loopback development only.
