import { GoogleGenAI, PartMediaResolutionLevel } from '@google/genai';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { filteredProviderFetch, type ReadbackMetrics } from './bounded-fetch';
import { safeProviderError } from './provider-error';
import { MAINTENANCE_GUIDANCE } from './maintenance';
import type { RequestAuthMetadata } from './request-auth-metadata';
import { consumeInteractionStream, InteractionStreamFailure, type StreamSnapshot } from './interaction-stream';
export type Env = {
    DB: D1Database;
    BUCKET: R2Bucket;
    GEMINI_API_KEY?: string;
    OWNER_EMAIL?: string;
    MAX_REQUESTS_PER_DAY?: string;
};
export const LIMITS = { inputBytes: 8 * 1024 * 1024, outputBytes: 20 * 1024 * 1024, requestBytes: 12 * 1024 * 1024, maxOutputTokens: 8192, videoMaxOutputTokens: 20000, videoPollResponseBytes: 32 * 1024 * 1024, timeoutMs: 110000, streamTimeoutMs: 105000, pollTimeoutMs: 60000, videoSyncTimeoutMs: 105000, pollResponseBytes: 4194304, pollReadBytes: 134217728, streamTextBytes: 262144, generationsPerMinute: 3, uploadsPerDay: 100 };
export const GUIDANCE = `${MAINTENANCE_GUIDANCE}

AI Studio Connector uses the official @google/genai SDK with the owner's server-side key. Use it for user-requested general multimodal work, especially speech, audio critique and music. User preference: do not use Gemini for coding tasks. Call connector_status before first use. Never request, return, log, or pass API keys in tool arguments; the owner enters GEMINI_API_KEY through Sites Settings. All generation sends the supplied content to Google and may be billed. Set cost_acknowledged only for a specific user-authorized generation; never run speculative tests. Use a fresh UUID request_id per new generation and reuse it to retrieve the original result after a timeout; do not blindly retry under a new ID. Default API is interactions. Verify available models with list_models; availability and input/output capabilities depend on Google's current account access. Suggested current examples are gemini-3.8-flash for understanding, gemini-3.8-flash-tts for TTS, lyria-3-clip-preview for 30-second music clips. Prefer a short clip before a full song. For TTS, put the exact transcript in text parts and delivery instructions in style. Set response_format type audio and speech_config. Video input supports private MP4/WebM files with static sampling at 1 FPS by default (0.1–8 FPS configurable). Higher sampling consumes more tokens. Set resolution high on a video input for the highest supported video detail (280 tokens/frame for Gemini 3); ultra_high is image-only. Omit resolution to preserve the provider default. Resolution and sampling FPS are independent. For Gemini 3.8 Flash on Interactions, processing agentic lets Google navigate video adaptively; omit fps in that mode. Static remains the default. Agentic processing usage is dynamic and may cost more or less; a fixed token estimate is not a spending cap. Token usage includes per-modality breakdowns when Google provides them; currency cost is an estimate from current pricing, not a billing receipt. Upload user-authorized input files using the MCP upload_file tool (maximum 8 MiB per file); generation accepts file IDs, never arbitrary URLs or local paths. Audio critique is a model assessment, not an objective listening test. Return authenticated file links for playback/download, or use read_file_chunk to retrieve binary chunks. Do not present a generated file as listened-to or quality-verified unless it actually was. Agentic video text/JSON defaults to105-second bounded foreground streaming with private partial checkpoints and store=false. For a user-approved long request, set background=true and google_storage_acknowledged=true ONLY after explicit approval to store that request/video/prompt/output at Google (default retention paid55days/free1day; project settings may differ). Background uses store=true and returns a local request ID promptly; poll get_request on that same ID. No generation retry is automatic, and no deletion is automatic. No general-purpose agents, code execution, remote tools, arbitrary network proxy, live audio sessions, Veo generation, unapproved background jobs, voice cloning or Google Files API are exposed in this version. Files are stored privately until the owner removes the Site or requests a separately reviewed cleanup. Interactions default to store=false; only explicitly acknowledged background requests use store=true. Local daily limits count attempted generations, including failures; they are request limits, not a dollar budget. A timeout may still incur charges at Google. Narrow Omni video generation is supported only for gemini-omni-1.1-flash, one 3-second 720p inline MP4, text plus at most two images, and 18000-20000 output tokens. Exactly two image inputs select generation_config.video_config.task=image_to_video so the first image defines the start and the second defines the end; zero/one-image requests retain automatic task selection. For distinct endpoint poses, supply images in order and preserve the prompt tags [# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]. Set response_format={type:video,delivery:inline,duration:3s,resolution:720p,aspect_ratio:16:9}, max_output_tokens=20000 and max_cost_usd to the authorized USD ceiling. Explicit background=true or background=false is required. Background=true additionally requires Google storage acknowledgment; background=false uses store=false and stream=false with a 105-second total synchronous deadline and no subsequent provider polling. A synchronous timeout may still be billed and cannot be reliably retrieved; never retry automatically. A non-generating countTokens check plus the output token bound must fit that ceiling at documented rates before submission. Only the same mapped job is polled; generated video bytes are privately saved and omitted from tool results. This is a conservative estimate guard, not a provider-enforced dollar budget or billing receipt.`;
export class ConnectorError extends Error {
    constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function ownerFromHeaders(headers: Headers, env: Env) { const uid = headers.get('oai-authenticated-user-id'); const email = headers.get('oai-authenticated-user-email'); if (!uid || !email)
    throw new ConnectorError('AUTH_REQUIRED', 'Sign in to the owner account.', 401); if (!env.OWNER_EMAIL || email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase())
    throw new ConnectorError('OWNER_ONLY', 'This connector is restricted to its owner.', 403); return uid; }
export function assertOrigin(req: Request) { const origin = req.headers.get('origin'); if (origin && origin !== new URL(req.url).origin)
    throw new ConnectorError('ORIGIN_REJECTED', 'Cross-origin requests are not accepted.', 403); }
export function errorMetadata(error: unknown) {
    const value = error && typeof error === 'object' ? error as { name?: unknown; status?: unknown; statusCode?: unknown } : {};
    const rawStatus = Number(value.status ?? value.statusCode);
    const httpStatus = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
    const allowedNames = ['APIConnectionTimeoutError', 'RequestTimeoutError', 'TimeoutError', 'APIConnectionError', 'ConnectionError', 'APIUserAbortError', 'RequestAbortedError', 'AbortError', 'ProviderResponseLimitError', 'SyntaxError'];
    const errorType = typeof value.name === 'string' && allowedNames.includes(value.name) ? value.name : undefined;
    return { ...(httpStatus ? { http_status: httpStatus } : {}), ...(errorType ? { error_type: errorType } : {}) };
}
export function safeError(error: unknown) {
    let cause: unknown = error;
    for (let depth=0;depth<5 && cause && typeof cause==='object';depth++) {
        if ('name' in cause && cause.name === 'ProviderResponseLimitError') return {code:'GOOGLE_POLL_RESPONSE_LIMIT',message:'Google returned more data than the safe readback limit. The existing background job is preserved; do not submit another generation.'};
        cause='cause' in cause ? cause.cause : undefined;
    }
    if (error instanceof ConnectorError) return { code: error.code, message: error.message };
    if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'Invalid input. Check required fields, supported options, and size limits.' };
    if (error instanceof InteractionStreamFailure) {
        const timeout = error.kind === 'timeout' || /Timeout/.test(errorMetadata(error.originalError).error_type ?? '');
        return { code: timeout ? 'GOOGLE_TIMEOUT' : error.kind === 'output_limit' ? 'GOOGLE_STREAM_LIMIT' : 'GOOGLE_STREAM_INTERRUPTED', message: timeout ? 'Google did not finish within the streaming time limit. Partial output may be available. Charges are possible; do not automatically generate again.' : 'The Google stream did not complete. Partial output may be available. Charges are possible; do not automatically generate again.' };
    }
    const metadata = errorMetadata(error), status = metadata.http_status;
    if (safeProviderError(error)?.message?.includes('Multiple authentication credentials received.')) return {code:'GOOGLE_AUTH_CONFLICT',message:'Google reported conflicting authentication credentials. This does not establish where the conflict originated; do not automatically generate again.'};
    const code = /Timeout/.test(metadata.error_type ?? '') || status === 408 || status === 504 ? 'GOOGLE_TIMEOUT' : status === 401 || status === 403 ? 'GOOGLE_ACCESS_DENIED' : status === 429 ? 'GOOGLE_QUOTA' : status === 400 ? 'GOOGLE_INVALID_REQUEST' : status === 404 ? 'GOOGLE_MODEL_UNAVAILABLE' : status && status >= 500 ? 'GOOGLE_SERVER_ERROR' : metadata.error_type === 'APIConnectionError' || metadata.error_type === 'ConnectionError' ? 'GOOGLE_CONNECTION_ERROR' : 'GOOGLE_REQUEST_FAILED';
    const messages: Record<string, string> = { GOOGLE_TIMEOUT: 'The Google request timed out. It may still have been charged; check this request ID and do not automatically resubmit.', GOOGLE_ACCESS_DENIED: 'Google rejected this key or model access. Check AI Studio permissions.', GOOGLE_QUOTA: 'Google quota or rate limit reached. Do not automatically resubmit generation.', GOOGLE_INVALID_REQUEST: 'Google rejected the request. Consult the safe provider diagnostic; HTTP 400 alone does not identify an input or model problem.', GOOGLE_MODEL_UNAVAILABLE: 'This model is unavailable to the configured key.', GOOGLE_SERVER_ERROR: 'Google returned a server error. Charges are possible; do not automatically resubmit.', GOOGLE_CONNECTION_ERROR: 'The connection to Google failed. Charges are possible; do not automatically resubmit.', GOOGLE_REQUEST_FAILED: 'The request did not complete reliably. Google may still have charged it. Check this request ID before trying again.' };
    return { code, message: messages[code] };
}
export const fileIdSchema = z.string().uuid();
const modelSchema = z.string().min(1).max(120).regex(/^(?:models\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const textPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(32000), speaker: z.string().max(80).optional(), style: z.string().max(2000).optional() }).strict();
const videoPart = z.object({
    type: z.literal('video'), file_id: fileIdSchema,
    fps: z.number().min(0.1).max(8).optional(),
    processing: z.enum(['static', 'agentic']).optional(),
    resolution: z.enum(['low', 'medium', 'high']).optional(),
}).strict().superRefine((part, ctx) => {
    if (part.processing === 'agentic' && part.fps !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fps'], message: 'FPS applies only to static video processing. Omit it for agentic processing.' });
    }
}).transform(part => part.processing === 'agentic' ? part : { ...part, fps: part.fps ?? 1 });
const mediaPart = z.object({ type: z.enum(['audio', 'image', 'document']), file_id: fileIdSchema }).strict();
const voice = z.object({ voice: z.string().min(1).max(100), speaker: z.string().max(80).optional(), language: z.string().max(30).optional() }).strict();
export const generationSchema = z.object({ background: z.boolean().optional(), google_storage_acknowledged: z.literal(true).optional(), request_id: z.string().uuid(), cost_acknowledged: z.literal(true), api: z.enum(['interactions', 'generate_content']).default('interactions'), model: modelSchema, input: z.union([z.string().min(1).max(32000), z.array(z.union([textPart, mediaPart, videoPart])).min(1).max(16)]), system_instruction: z.string().max(8000).optional(), max_output_tokens: z.number().int().min(1).max(20000).default(4096), max_cost_usd: z.number().positive().max(100).optional(), temperature: z.number().min(0).max(2).optional(), seed: z.number().int().min(0).max(2147483647).optional(), response_format: z.record(z.unknown()).optional(), speech_config: z.union([z.array(voice).min(1).max(1), z.object({ speakers: z.array(voice).min(1).max(2) }).strict()]).optional() }).strict().superRefine((a, ctx) => {
    if (a.background && (!a.google_storage_acknowledged || a.api !== 'interactions')) ctx.addIssue({code:z.ZodIssueCode.custom,path:['background'],message:'Background requires Interactions and explicit Google storage acknowledgment for this request.'});
    if (a.google_storage_acknowledged && !a.background) ctx.addIssue({code:z.ZodIssueCode.custom,path:['google_storage_acknowledged'],message:'Google storage acknowledgment applies only to an explicit background request.'});
    const video = a.response_format?.type === 'video';
    if (/^gemini-omni-/.test(a.model.replace(/^models\//,'')) && !video) ctx.addIssue({code:z.ZodIssueCode.custom,path:['response_format'],message:'Omni is a video-generation model; its explicit video format, budget and storage guards are required.'});
    if (!video && (a.max_output_tokens > 8192 || a.max_cost_usd !== undefined)) ctx.addIssue({code:z.ZodIssueCode.custom,path:['max_output_tokens'],message:'Extended token limit and cost guard apply only to the narrow Omni video request.'});
    if (video && (a.background === undefined || (a.background && !a.google_storage_acknowledged) || a.api !== 'interactions' || a.model.replace(/^models\//,'') !== 'gemini-omni-1.1-flash' || a.max_output_tokens < 18000 || a.max_cost_usd === undefined || a.system_instruction !== undefined || a.temperature !== undefined || a.seed !== undefined || a.speech_config !== undefined)) ctx.addIssue({code:z.ZodIssueCode.custom,path:['response_format'],message:'Omni video requires the supported model, an explicit background true/false choice, storage approval only for background true, 18000-20000 output tokens, and an authorized cost ceiling. Unsupported generation options are rejected.'});
});
const allowedMime = new Set(['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/aiff', 'audio/m4a', 'audio/mp4', 'audio/webm', 'audio/opus', 'image/png', 'image/jpeg', 'image/webp', 'application/pdf','video/mp4','video/webm']);
export const uploadSchema = z.object({ filename: z.string().min(1).max(120), mime_type: z.string().refine(v => allowedMime.has(v)), data_base64: z.string().min(4).max(Math.ceil(LIMITS.inputBytes / 3) * 4) }).strict();
export function decodeBase64(data: string, maxBytes: number) { if (data.length > Math.ceil(maxBytes / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new ConnectorError('INVALID_BASE64', 'Invalid or oversized base64 payload.'); const b = Buffer.from(data, 'base64'); if (b.length === 0 || b.length > maxBytes)
    throw new ConnectorError('FILE_TOO_LARGE', 'File exceeds the allowed size.'); return b; }
export function safeFilename(name: string) { return name.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'file'; }
function key(owner: string, id: string) { return `files/${encodeURIComponent(owner)}/${id}`; }
export async function quota(env: Env, owner: string, window: string, limit: number) { const r = await env.DB.prepare('INSERT INTO budget (owner, window, count) VALUES (?, ?, 1) ON CONFLICT(owner, window) DO UPDATE SET count=count+1 WHERE count < ?').bind(owner, window, limit).run(); if (r.meta.changes !== 1)
    throw new ConnectorError('LOCAL_LIMIT', 'Connector request limit reached. Wait for the next window or ask the owner to adjust settings.', 429); }
export function dailyLimit(env: Env) { const n = Number(env.MAX_REQUESTS_PER_DAY ?? 30); return Number.isFinite(n) ? Math.max(1, Math.min(300, Math.floor(n))) : 30; }
export async function putFile(env: Env, owner: string, bytes: Uint8Array, mime: string, filename: string, kind = 'output') { if (bytes.length > LIMITS.outputBytes)
    throw new ConnectorError('OUTPUT_TOO_LARGE', 'Generated file exceeds 20 MiB and was not saved.'); const id = crypto.randomUUID(); await env.BUCKET.put(key(owner, id), bytes, { httpMetadata: { contentType: mime, contentDisposition: `attachment; filename="${safeFilename(filename)}"` }, customMetadata: { filename: safeFilename(filename), kind, created_at: new Date().toISOString() } }); return { id, filename: safeFilename(filename), mime_type: mime, bytes: bytes.length, download_path: `/api/files/${id}` }; }
export async function uploadFile(env: Env, owner: string, args: unknown) { const a = uploadSchema.parse(args); const bytes = decodeBase64(a.data_base64, LIMITS.inputBytes); await quota(env, owner, `upload:${new Date().toISOString().slice(0, 10)}`, LIMITS.uploadsPerDay); return putFile(env, owner, bytes, a.mime_type, a.filename, 'input'); }
export async function getFile(env: Env, owner: string, id: string) { fileIdSchema.parse(id); const object = await env.BUCKET.get(key(owner, id)); if (!object)
    throw new ConnectorError('FILE_NOT_FOUND', 'File not found in your private storage.', 404); return object; }
export async function listFiles(env: Env, owner: string, cursor?: string) { const r = await env.BUCKET.list({ prefix: `files/${encodeURIComponent(owner)}/`, limit: 30, cursor, include: ['httpMetadata', 'customMetadata'] } as R2ListOptions & {
    include: string[];
}); return { files: r.objects.map(o => ({ id: o.key.split('/').pop(), filename: o.customMetadata?.filename, mime_type: o.httpMetadata?.contentType, bytes: o.size, created_at: o.customMetadata?.created_at, kind: o.customMetadata?.kind, download_path: `/api/files/${o.key.split('/').pop()}` })), next_cursor: r.truncated ? r.cursor : null }; }
export function client(env: Env, polling = false, onMetrics?: (metrics: ReadbackMetrics) => void, videoMedia = false, onRequestAuth?: (metadata: RequestAuthMetadata) => void) { if (!env.GEMINI_API_KEY)
    throw new ConnectorError('NOT_CONFIGURED', 'Add GEMINI_API_KEY as a secret in Sites Settings, then redeploy.', 409); return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, apiVersion: 'v1beta', httpOptions: { timeout: LIMITS.timeoutMs, retryOptions: { attempts: 1 }, ...(polling ? {fetch:filteredProviderFetch(videoMedia ? LIMITS.videoPollResponseBytes : LIMITS.pollResponseBytes,LIMITS.pollReadBytes,globalThis.fetch,onMetrics,videoMedia,onRequestAuth)} : {}) } }); }
export async function status(env: Env, owner: string) { const day = new Date().toISOString().slice(0, 10); const used = await env.DB.prepare('SELECT count FROM budget WHERE owner=? AND window=?').bind(owner, `generation:${day}`).first<{
    count: number;
}>(); return { name: 'AI Studio Connector', version: '1.6.5', sdk: '@google/genai 2.26.0', key_configured: Boolean(env.GEMINI_API_KEY), google_connection_verified: false, access: 'owner_only', limits: { ...LIMITS, generationsPerDay: dailyLimit(env), generationAttemptsToday: used?.count ?? 0 }, setup_url: 'https://chatgpt.com/sites', setup: 'AI Studio Connector → More actions → Settings → add GEMINI_API_KEY marked secret → redeploy', usage_guidance: GUIDANCE }; }
function checkJson(value: unknown, depth = 0) { if (depth > 12)
    throw new ConnectorError('INVALID_SCHEMA', 'Response schema is too deep.'); if (Array.isArray(value)) {
    for (const v of value)
        checkJson(v, depth + 1);
}
else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k))
            throw new ConnectorError('INVALID_SCHEMA', 'Reserved property in response schema.');
        if (k === '$ref' && typeof v === 'string' && !v.startsWith('#/'))
            throw new ConnectorError('INVALID_SCHEMA', 'External schema references are not supported.');
        checkJson(v, depth + 1);
    }
} }
export async function buildRequest(env: Env, owner: string, a: z.infer<typeof generationSchema>) {
    if (a.response_format) {
        if (JSON.stringify(a.response_format).length > 16000)
            throw new ConnectorError('INVALID_SCHEMA', 'Response format exceeds 16 KB.');
        checkJson(a.response_format);
        if (a.response_format.type === 'audio') {
            z.object({type:z.literal('audio'),delivery:z.literal('inline').optional(),mime_type:z.enum(['audio/wav','audio/mp3','audio/mpeg','audio/ogg','audio/ogg_opus','audio/opus','audio/l16']).optional(),sample_rate:z.number().int().min(8000).max(48000).optional(),bit_rate:z.number().int().min(16000).max(320000).optional()}).strict().parse(a.response_format);
            if (a.api === 'generate_content' && Object.keys(a.response_format).some(k=>k!=='type')) throw new ConnectorError('UNSUPPORTED_FORMAT','Legacy audio formatting options are not exposed. Use Interactions for explicit audio encoding.');
        }
        if (a.response_format.type === 'image') {
            z.object({type:z.literal('image'),delivery:z.literal('inline').optional(),mime_type:z.enum(['image/png','image/jpeg','image/webp']).optional(),aspect_ratio:z.string().regex(/^\d{1,2}:\d{1,2}$/).optional(),image_size:z.enum(['512','1K','2K']).optional()}).strict().parse(a.response_format);
        }
        if (a.response_format.type === 'video') {
            z.object({type:z.literal('video'),delivery:z.literal('inline'),duration:z.literal('3s'),resolution:z.literal('720p'),aspect_ratio:z.enum(['16:9','9:16'])}).strict().parse(a.response_format);
        }
    }
    const parts = typeof a.input === 'string' ? [{ type: 'text' as const, text: a.input }] : a.input;
    if (a.response_format?.type === 'video' && (parts.some(p => !['text','image'].includes(p.type) || (p.type === 'text' && (p.style || p.speaker))) || parts.filter(p=>p.type==='image').length>2 || parts.filter(p=>p.type==='text').reduce((n,p)=>n+(p.type==='text'?p.text.length:0),0)>4000)) throw new ConnectorError('UNSUPPORTED_VIDEO_INPUT','This video experiment accepts up to 4000 prompt characters and at most two private reference images only.');
    if (a.api !== 'interactions' && parts.some(p => p.type === 'video' && p.processing === 'agentic'))
        throw new ConnectorError('UNSUPPORTED_PROCESSING', 'Agentic video processing is exposed only through Interactions.');
    const content: any[] = [];
    let bytes = 0;
    for (const p of parts) {
        if (p.type === 'text') {
            bytes += Buffer.byteLength(p.text);
            const annotations = (p.style || p.speaker) ? [{ type: 'speech_metadata', ...(p.style ? { style: p.style } : {}), ...(p.speaker ? { speaker: p.speaker } : {}) }] : undefined;
            content.push({ type: 'text', text: p.text, ...(annotations ? { annotations } : {}) });
        }
        else {
            const f = await getFile(env, owner, p.file_id);
            bytes += f.size;
            if (bytes > LIMITS.inputBytes)
                throw new ConnectorError('INPUT_TOO_LARGE', 'Combined input exceeds 8 MiB.');
            const mime = f.httpMetadata?.contentType ?? '';
            if ((p.type === 'audio' && !mime.startsWith('audio/')) || (p.type === 'image' && !mime.startsWith('image/')) || (p.type === 'document' && mime !== 'application/pdf') || (p.type === 'video' && !['video/mp4','video/webm'].includes(mime)))
                throw new ConnectorError('MIME_MISMATCH', 'Input type does not match the stored file.');
            content.push({ type: p.type, mime_type: mime, data: Buffer.from(await f.arrayBuffer()).toString('base64'), ...(p.type === 'video' ? {processing:p.processing === 'agentic' ? 'agentic' : {type:'static',fps:p.fps}, ...(p.resolution ? {resolution:p.resolution} : {})} : {}) });
        }
    }
    if (bytes > LIMITS.inputBytes)
        throw new ConnectorError('INPUT_TOO_LARGE', 'Combined input exceeds 8 MiB.');
    if (a.api === 'interactions')
        return { model: a.model.replace(/^models\//, ''), input: [{ type: 'user_input', content }], store: a.background === true, stream: false, ...(a.background !== undefined ? {background:a.background} : {}), generation_config: { max_output_tokens: a.max_output_tokens, ...(a.response_format?.type === 'video' && content.filter(p => p.type === 'image').length === 2 ? { video_config: { task: 'image_to_video' } } : {}), ...(a.temperature !== undefined ? { temperature: a.temperature } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.speech_config ? { speech_config: a.speech_config } : {}) }, ...(a.system_instruction ? { system_instruction: a.system_instruction } : {}), ...(a.response_format ? { response_format: a.response_format } : {}) };
    const config: any = { maxOutputTokens: a.max_output_tokens, candidateCount: 1, ...(a.temperature !== undefined ? { temperature: a.temperature } : {}), ...(a.seed !== undefined ? { seed: a.seed } : {}), ...(a.system_instruction ? { systemInstruction: a.system_instruction } : {}) };
    if (a.response_format?.type === 'audio') {
        config.responseModalities = ['AUDIO'];
    }
    else if (a.response_format?.type === 'image') {
        config.responseModalities = ['TEXT','IMAGE'];
        config.imageConfig = {aspectRatio:a.response_format.aspect_ratio,imageSize:a.response_format.image_size,outputMimeType:a.response_format.mime_type};
    }
    else if (a.response_format) {
        config.responseMimeType = 'application/json';
        config.responseJsonSchema = a.response_format;
    }
    if (a.speech_config) {
        if (Array.isArray(a.speech_config))
            config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: a.speech_config[0].voice } }, ...(a.speech_config[0].language ? {languageCode:a.speech_config[0].language} : {}) };
        else {
            const languages=[...new Set(a.speech_config.speakers.map(v=>v.language).filter(Boolean))];
            if (languages.length>1) throw new ConnectorError('UNSUPPORTED_LANGUAGE','Legacy TTS needs one shared language across speakers.');
            config.speechConfig = { ...(languages.length?{languageCode:languages[0]}:{}), multiSpeakerVoiceConfig: { speakerVoiceConfigs: a.speech_config.speakers.map(v => ({ speaker: v.speaker, voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voice } } })) } };
        }
    }
    ;
    return { model: a.model, contents: [{ role: 'user', parts: content.map(p => p.type === 'text' ? { text: p.text, ...(p.annotations ? { speechMetadata: { style: p.annotations[0].style, speaker: p.annotations[0].speaker } } : {}) } : { inlineData: { mimeType: p.mime_type, data: p.data }, ...(p.type === 'video' ? {videoMetadata:{fps:p.processing.fps}, ...(p.resolution ? {mediaResolution:{level:PartMediaResolutionLevel[`MEDIA_RESOLUTION_${p.resolution.toUpperCase()}` as keyof typeof PartMediaResolutionLevel]}} : {})} : {}) }) }], config };
}
export function pcmToWav(bytes: Uint8Array, rate = 24000, channels = 1) { if (rate < 8000 || rate > 96000 || channels < 1 || channels > 2 || bytes.length % 2)
    throw new ConnectorError('UNSUPPORTED_AUDIO', 'Invalid PCM audio format.'); const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(bytes.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes.length, 40); return Buffer.concat([header, Buffer.from(bytes)]); }
export async function normalizeOutput(env: Env, owner: string, response: any, api: string) { const blocks: any[] = api === 'interactions' ? (response.steps ?? []).filter((s: any) => s.type === 'model_output').flatMap((s: any) => s.content ?? []) : (response.candidates ?? []).flatMap((c: any) => c.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.inlineData ? { type: p.inlineData.mimeType?.startsWith('audio/') ? 'audio' : 'image', mime_type: p.inlineData.mimeType, data: p.inlineData.data } : { type: 'text', text: p.text }); if (!blocks.length && response.output_audio)
    blocks.push({ type: 'audio', ...response.output_audio }); if (!blocks.some(b => b.type === 'video') && response.output_video) blocks.push({type:'video',...response.output_video}); if (!blocks.some(b => b.type === 'text') && response.output_text)
    blocks.push({ type: 'text', text: response.output_text }); let text = ''; let total = 0; const files = []; for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
        text += b.text + '\n';
        continue;
    }
    if (['audio','image','video'].includes(b.type) && typeof b.data !== 'string' && b.uri) throw new ConnectorError('UNSUPPORTED_DELIVERY','Google returned URI media instead of inline bytes. The request may have been charged; do not automatically repeat it.');
    if (!['audio', 'image', 'video'].includes(b.type) || typeof b.data !== 'string')
        continue;
    if (files.length >= 4)
        throw new ConnectorError('OUTPUT_TOO_LARGE', 'Too many generated files.');
    let bytes = decodeBase64(b.data, LIMITS.outputBytes);
    total += bytes.length;
    if (total > LIMITS.outputBytes)
        throw new ConnectorError('OUTPUT_TOO_LARGE', 'Combined generated media exceeds 20 MiB.');
    let mime = String(b.mime_type ?? (b.type === 'audio' ? 'audio/wav' : b.type === 'video' ? 'video/mp4' : 'image/png'));
    if (mime === 'audio/ogg_opus') mime = 'audio/ogg';
    if (mime.toLowerCase().startsWith('audio/l16') || mime.startsWith('audio/pcm')) {
        const rate = Number(b.sample_rate ?? mime.match(/rate=(\d+)/)?.[1] ?? 24000);
        bytes = pcmToWav(bytes, rate, Number(b.channels ?? 1));
        mime = 'audio/wav';
    }
    if (!/^(audio\/(wav|mpeg|mp3|ogg|aac|flac|opus)|image\/(png|jpeg|webp)|video\/mp4)$/.test(mime))
        throw new ConnectorError('UNSUPPORTED_OUTPUT', 'Google returned an unsupported media format.');
    const ext = ({ 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/opus': 'opus', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4':'mp4' } as Record<string, string>)[mime];
    files.push(await putFile(env, owner, bytes, mime, `generated-${files.length + 1}.${ext}`));
} let textFile = null; if (text.length > 24000) {
    textFile = await putFile(env, owner, Buffer.from(text), 'text/plain', 'response.txt');
    text = text.slice(0, 24000) + '\n[Full response saved in response.txt]';
} return { text: text.trim(), files: [...files, ...(textFile ? [textFile] : [])], provider_status: typeof response.status === 'string' ? response.status : undefined, usage: safeUsage(response.usage ?? response.usageMetadata), finish_reasons: response.candidates?.map((c: any) => c.finishReason).filter((s: any) => typeof s === 'string'), notice: !text.trim() && !files.length ? response.candidates?.some((c: {finishReason?: string}) => c.finishReason === 'MAX_TOKENS') ? 'The output token limit was reached before visible output. Thinking tokens can consume this limit. No refusal or unsupported-model conclusion follows; a new generation needs authorization.' : 'No usable output returned. Check finish_reasons and usage before deciding whether this was a safety response, token limit, or another provider outcome.' : undefined }; }
export function safeUsage(value: any) {
    if (!value || typeof value !== 'object') return null;
    const result: Record<string,unknown> = Object.fromEntries(Object.entries(value).filter(([k,v])=>/token|count/i.test(k)&&typeof v==='number'&&Number.isFinite(v)));
    for (const name of ['input_tokens_by_modality','output_tokens_by_modality','cached_tokens_by_modality','tool_use_tokens_by_modality','promptTokensDetails','candidatesTokensDetails','responseTokensDetails','cacheTokensDetails','toolUsePromptTokensDetails']) {
        if (Array.isArray(value[name])) result[name] = value[name].slice(0,16).filter((v:any)=>v&&typeof v.modality==='string'&&/^[A-Z_]+$/i.test(v.modality)).map((v:any)=>({modality:v.modality,...(Number.isFinite(v.tokens)?{tokens:v.tokens}:{}),...(Number.isFinite(v.tokenCount)?{tokenCount:v.tokenCount}:{})}));
    }
    return result;
}
function publicResult(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')));
}
function processingMarkers(response: Record<string, unknown>) {
    return Array.isArray(response.steps) ? response.steps.filter((step: unknown): step is {type: 'processing_call' | 'processing_result'} => Boolean(step && typeof step === 'object' && 'type' in step && (step.type === 'processing_call' || step.type === 'processing_result'))).slice(0, 1000).map(step => ({type:step.type})) : [];
}
function checkedInteractionId(id: unknown): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,512}$/.test(id)) throw new ConnectorError('GOOGLE_BACKGROUND_NO_ID','Google did not return a usable background identifier. Do not generate again automatically; charges are possible.');
    return id;
}
async function backgroundUpdate(env: Env, owner: string, previous: Record<string, unknown>, response: Record<string, unknown>) {
    if (checkedInteractionId(response.id) !== previous._provider_interaction_id) throw new ConnectorError('GOOGLE_BACKGROUND_ID_MISMATCH','Google returned a different background identifier. No result was accepted.');
    const providerStatus = response.status;
    if (!['queued','in_progress','completed','failed','cancelled','incomplete','requires_action','budget_exceeded'].includes(String(providerStatus))) throw new ConnectorError('GOOGLE_BACKGROUND_STATUS','Google returned an unrecognized background status. Inspect this request again; do not generate again.');
    const {_poll_started_at, poll_error, notice, ...base} = previous;
    void _poll_started_at; void poll_error; void notice;
    const result = { ...base, retrieval_status:'available', provider_status_verified:true, provider_status_as_of:Date.now(), provider_status: providerStatus, processing_steps: processingMarkers(response), usage: safeUsage(response.usage), last_checked_at: Date.now() };
    if (providerStatus === 'completed') return {state:'complete',result:{...result,...await normalizeOutput(env,owner,response,'interactions')}};
    if (providerStatus === 'queued' || providerStatus === 'in_progress') return {state:'running',result};
    return {state:'failed',result:{...result,error:{code:'GOOGLE_BACKGROUND_FAILED',message:`The Google background interaction ended with status ${providerStatus}. No new generation was submitted.`}}};
}
export async function pollBackgroundRequest(sdk: GoogleGenAI, id: string, timeoutMs = LIMITS.pollTimeoutMs) {
    const controller=new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline=new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{reject(new ConnectorError('GOOGLE_POLL_TIMEOUT','The status read reached its time limit. The existing Google job is preserved; check this same request ID later.'));controller.abort();},timeoutMs);
    });
    try {
        return await Promise.race([sdk.interactions.get(id,{include_input:false,stream:false},{timeout:timeoutMs,maxRetries:0,signal:controller.signal}) as unknown as Promise<Record<string,unknown>>,deadline]);
    } finally {clearTimeout(timer);controller.abort();}
}
export async function requestStatus(env: Env, owner: string, requestId: string, poller?: (id: string) => Promise<Record<string, unknown>>): Promise<any> {
    z.string().uuid().parse(requestId);
    const row = await env.DB.prepare('SELECT state,created_at,result FROM requests WHERE owner=? AND request_id=?').bind(owner,requestId).first<{state:string;created_at:number;result:string|null}>();
    if (!row) throw new ConnectorError('REQUEST_NOT_FOUND','Unknown request ID.',404);
    let stored: Record<string,unknown> = row.result ? JSON.parse(row.result) : {};
    let state = row.state;
    // A short DB lease prevents concurrent GETs from duplicating output storage.
    // It is recoverable if this Worker is interrupted while polling.
    const leaseExpired = state === 'polling' && Date.now() - Number(stored._poll_started_at ?? 0) > 90000;
    if (stored.background === true && stored._provider_interaction_id && (state === 'running' || leaseExpired)) {
        const providerId = checkedInteractionId(stored._provider_interaction_id);
        const claimed = {...stored,_poll_started_at:Date.now()};
        const claimedJson = JSON.stringify(claimed);
        const lock = await env.DB.prepare("UPDATE requests SET state='polling',result=? WHERE owner=? AND request_id=? AND state=? AND result=?").bind(claimedJson,owner,requestId,state,row.result).run();
        if (lock.meta.changes === 1) {
            const readbackMetrics:ReadbackMetrics[]=[];
            const requestAuth:RequestAuthMetadata[]=[];
            try {
                const pollStartedAt=Date.now();
                const response = poller ? await poller(providerId) : await pollBackgroundRequest(client(env,true,metrics=>readbackMetrics.push(metrics),stored.video_generation === true,metadata=>{if(requestAuth.length<4)requestAuth.push(metadata);}),providerId);
                const update = await backgroundUpdate(env,owner,claimed,response);
                state=update.state;stored={...update.result,poll_diagnostic:{elapsed_ms:Date.now()-pollStartedAt,response_projection:'incremental_filtered_json',response_limit_bytes:LIMITS.pollResponseBytes,readback:readbackMetrics,request_auth:requestAuth}};
            } catch (error) {
                const pollError=safeError(error);
                const diagnostic={...errorMetadata(error),timeout_ms:LIMITS.pollTimeoutMs,response_limit_bytes:LIMITS.pollResponseBytes,readback:readbackMetrics};
                console.warn(JSON.stringify({event:'background_poll_failed',request_id:requestId,code:pollError.code,...diagnostic}));
                const providerError=safeProviderError(error,[env.GEMINI_API_KEY,providerId]);
                state='running';stored={...stored,retrieval_status:'unavailable',provider_status_verified:false,poll_error:pollError,poll_diagnostic:{...diagnostic,request_auth:requestAuth,...(providerError ? {provider_error:providerError} : {})},last_checked_at:Date.now(),notice:'Retrieval failed. The displayed provider status is only the last known status, not a current confirmation that generation is running. Do not submit a new generation automatically.'};
            }
            await env.DB.prepare("UPDATE requests SET state=?,result=? WHERE owner=? AND request_id=? AND state='polling' AND result=?").bind(state,JSON.stringify(stored),owner,requestId,claimedJson).run();
        }
    }
    return {request_id:requestId,state:state === 'polling' ? 'running' : state,created_at:row.created_at,...publicResult(stored),...((state === 'running' || state === 'polling') && !stored.notice ? {notice:stored.background ? 'Google background generation is still running. Poll this same request ID; do not submit a new generation.' : 'Pending or interrupted. Do not resubmit under a new ID without checking possible charges.'} : {})};
}
export function usesAgenticTextStream(a: z.infer<typeof generationSchema>) { return !a.background && a.api === 'interactions' && Array.isArray(a.input) && a.input.some(p => p.type === 'video' && p.processing === 'agentic') && !['audio', 'image', 'video'].includes(String(a.response_format?.type)); }
export function videoCostGuard(inputTokens: unknown, outputTokenLimit: number, maxCostUsd: number) {
    if (typeof inputTokens !== 'number' || !Number.isInteger(inputTokens) || inputTokens < 0) throw new ConnectorError('COST_UNVERIFIED','Google did not return an input token count. No video generation was submitted.');
    // All output tokens use the higher video rate, conservatively covering text/thinking.
    const upperEstimate = (inputTokens * 1.5 + outputTokenLimit * 17.5) / 1000000;
    if (upperEstimate > maxCostUsd) throw new ConnectorError('COST_LIMIT','The conservative input/output token estimate exceeds the approved USD ceiling. No video generation was submitted.');
    return {currency:'USD',input_tokens:inputTokens,output_token_limit:outputTokenLimit,approved_ceiling:maxCostUsd,conservative_estimate:upperEstimate,pricing_source:'https://ai.google.dev/gemini-api/docs/pricing#gemini-omni-flash',notice:'Estimate from documented rates, not a billing receipt or provider-enforced dollar budget.'};
}
export async function runSynchronousVideo<T>(operation:(signal:AbortSignal)=>Promise<T>,timeoutMs=LIMITS.videoSyncTimeoutMs):Promise<T>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new ConnectorError('GOOGLE_SYNC_TIMEOUT','The synchronous video reached its time limit. Google may still charge the request. No automatic retry or background recovery is available; inspect this same local request ID.'));controller.abort();},timeoutMs);});
    try{return await Promise.race([operation(controller.signal),deadline]);}
    catch(error){
        let cause:unknown=error;
        for(let depth=0;depth<5&&cause&&typeof cause==='object';depth++){
            if('name' in cause&&cause.name==='ProviderResponseLimitError')throw new ConnectorError('GOOGLE_SYNC_RESPONSE_LIMIT','The synchronous response exceeded the safe readback limit. Google may have charged it; do not automatically generate again.');
            cause='cause' in cause?cause.cause:undefined;
        }
        throw error;
    }finally{clearTimeout(timer);controller.abort();}
}
export async function generate(env: Env, owner: string, args: unknown, provider?: (api: string, request: any) => Promise<any>) { const a = generationSchema.parse(args); if (!provider && !env.GEMINI_API_KEY)
    throw new ConnectorError('NOT_CONFIGURED', 'Add GEMINI_API_KEY as a secret in Sites Settings, then redeploy.', 409); const fingerprint = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(a)))).toString('hex');
    const params = await buildRequest(env, owner, a);
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO requests (owner,request_id,state,created_at,fingerprint) VALUES (?,?,'running',?,?)").bind(owner, a.request_id, Date.now(), fingerprint).run();
    if (inserted.meta.changes !== 1) {
        const previous = await env.DB.prepare('SELECT fingerprint FROM requests WHERE owner=? AND request_id=?').bind(owner, a.request_id).first<{fingerprint:string}>();
        if (previous?.fingerprint !== fingerprint) throw new ConnectorError('REQUEST_ID_CONFLICT','This request ID belongs to different input. Use the original request or explicitly authorize a new generation.',409);
        return requestStatus(env, owner, a.request_id);
    }
    const startedAt = Date.now();
    const syncVideo=a.response_format?.type === 'video' && a.background === false;
    const syncReadback:ReadbackMetrics[]=[];const syncAuth:RequestAuthMetadata[]=[];
    let streamProgress: StreamSnapshot | undefined;
    let backgroundRecord: Record<string, unknown> | undefined;
    const requestConfig:Record<string,any> = { model: a.model, api: a.api, ...(syncVideo ? {background:false,google_storage:'disabled_for_this_request',transport:'synchronous'} : {}), ...(a.response_format?.type === 'video' ? {video_generation:true,video_output_config:a.response_format} : {}), video_input_config: typeof a.input === 'string' ? [] : a.input.filter(p => p.type === 'video').map(p => ({ file_id: p.file_id, processing: p.processing ?? 'static', ...(p.processing !== 'agentic' ? { fps: p.fps } : {}), resolution: p.resolution ?? 'provider_default' })) };
    try {
    const date = new Date();
    await quota(env, owner, `generation:${date.toISOString().slice(0, 10)}`, dailyLimit(env));
    await quota(env, owner, `minute:${Math.floor(date.getTime() / 60000)}`, LIMITS.generationsPerMinute);
    const sdk = provider ? null : client(env,syncVideo,metrics=>syncReadback.push(metrics),syncVideo,metadata=>{if(syncAuth.length<4)syncAuth.push(metadata);});
    let costGuard;
    const prepareVideoCost=async(signal?:AbortSignal)=>{
    if (a.response_format?.type === 'video') {
        const countParams = {model:a.model.replace(/^models\//,''),contents:[{role:'user',parts:('input' in params ? params.input[0].content : []).map((p:any)=>p.type==='text'?{text:p.text}:{inlineData:{mimeType:p.mime_type,data:p.data}})}]};
        const counted = provider ? await provider('count_tokens',countParams) : await sdk!.models.countTokens({...countParams,...(signal?{config:{abortSignal:signal}}:{})});
        costGuard = videoCostGuard(counted.totalTokens,a.max_output_tokens,a.max_cost_usd!);
        Object.assign(requestConfig,{cost_guard:costGuard});
    }};
    let response;
    if(syncVideo){
        response=await runSynchronousVideo(async signal=>{
            await prepareVideoCost(signal);signal.throwIfAborted();
            return provider ? await provider(a.api,params) : await sdk!.interactions.create(params as any,{timeout:LIMITS.videoSyncTimeoutMs,maxRetries:0,signal});
        });
        const providerStatus=['completed','failed','cancelled','incomplete','in_progress','queued','requires_action'].includes(String(response.status))?response.status:'unrecognized';
        Object.assign(requestConfig,{provider_status:providerStatus,usage:safeUsage(response.usage)});
        if(providerStatus!=='completed')throw new ConnectorError('GOOGLE_SYNC_INCOMPLETE','Google did not return a completed synchronous video. Charges may apply; this local request ID cannot be automatically regenerated.');
    }else{
    await prepareVideoCost();
    if (!provider && usesAgenticTextStream(a)) {
        const streamed = await consumeInteractionStream(sdk!, params as Parameters<GoogleGenAI['interactions']['create']>[0], {
            timeoutMs: LIMITS.streamTimeoutMs, maxTextBytes: LIMITS.streamTextBytes, sanitizeUsage: safeUsage,
            onProgress: async snapshot => {
                streamProgress = snapshot;
                await env.DB.prepare("UPDATE requests SET result=? WHERE owner=? AND request_id=?").bind(JSON.stringify({ ...requestConfig, ...snapshot, partial: true }), owner, a.request_id).run();
            },
        });
        response = streamed.response; streamProgress = streamed.snapshot;
    } else response = provider ? await provider(a.api, params) : a.api === 'interactions' ? await sdk!.interactions.create(params as any, { timeout: LIMITS.timeoutMs, maxRetries: 0 }) : await sdk!.models.generateContent(params as any);
    }
    if (a.background) {
        const id = checkedInteractionId(response.id);
        backgroundRecord = {...requestConfig,background:true,google_storage:'enabled_for_this_request',_provider_interaction_id:id,provider_status:'in_progress'};
        // Save the server-only recovery mapping before inspecting/normalizing output.
        await env.DB.prepare("UPDATE requests SET result=? WHERE owner=? AND request_id=?").bind(JSON.stringify(backgroundRecord),owner,a.request_id).run();
        const update = await backgroundUpdate(env,owner,backgroundRecord,response);
        await env.DB.prepare('UPDATE requests SET state=?,result=? WHERE owner=? AND request_id=?').bind(update.state,JSON.stringify(update.result),owner,a.request_id).run();
        return {request_id:a.request_id,state:update.state,...publicResult(update.result),...(update.state === 'running' ? {notice:'Background request accepted by Google. Poll get_request using this same request ID; do not submit another generation.'} : {})};
    }
    const videoInputs = typeof a.input === 'string' ? [] : a.input.filter(p => p.type === 'video').map(p => ({
        file_id: p.file_id, processing: p.processing ?? 'static',
        ...(p.processing !== 'agentic' ? { fps: p.fps } : {}),
        resolution: p.resolution ?? 'provider_default',
    }));
    const processingSteps = a.api === 'interactions' && Array.isArray(response.steps) ? response.steps.filter((step: { type?: string }) => step.type === 'processing_call' || step.type === 'processing_result').slice(0, 1000).map((step: { type: string }) => ({ type: step.type })) : [];
    const normalized=await normalizeOutput(env,owner,response,a.api);
    if(syncVideo&&!normalized.files.some(file=>file.mime_type==='video/mp4'))throw new ConnectorError('GOOGLE_VIDEO_OUTPUT_MISSING','Google returned no usable MP4. Charges may apply; do not automatically generate again.');
    const result = {model:a.model,api:a.api,...(syncVideo?{...requestConfig,diagnostic:{elapsed_ms:Date.now()-startedAt,timeout_ms:LIMITS.videoSyncTimeoutMs,readback:syncReadback,request_auth:syncAuth}}:{}),...(streamProgress ? { transport: 'streaming', provider_interaction_id: streamProgress.provider_interaction_id, elapsed_ms: streamProgress.elapsed_ms } : {}),...(videoInputs.length ? { video_input_config: videoInputs, processing_steps: processingSteps } : {}),...normalized};
    await env.DB.prepare("UPDATE requests SET state='complete',result=? WHERE owner=? AND request_id=?").bind(JSON.stringify(result), owner, a.request_id).run();
    return { request_id: a.request_id, state: 'complete', ...result };
}
catch (error) {
    if (error instanceof InteractionStreamFailure) streamProgress = error.snapshot;
    const diagnostic = { ...errorMetadata(error instanceof InteractionStreamFailure ? error.originalError : error), elapsed_ms: Date.now() - startedAt, timeout_ms: syncVideo ? LIMITS.videoSyncTimeoutMs : usesAgenticTextStream(a) ? LIMITS.streamTimeoutMs : LIMITS.timeoutMs, ...(error instanceof InteractionStreamFailure ? { stream_failure: error.kind } : {}) };
    const result = { ...requestConfig, ...backgroundRecord, ...(streamProgress ? { ...streamProgress, partial: true } : {}), error: safeError(error), diagnostic:{...diagnostic,...(syncVideo?{readback:syncReadback,request_auth:syncAuth,provider_error:safeProviderError(error,[env.GEMINI_API_KEY])}:{})} };
    console.warn(JSON.stringify({ event: 'generation_failed', request_id: a.request_id, code: result.error.code, ...diagnostic }));
    await env.DB.prepare("UPDATE requests SET state='failed',result=? WHERE owner=? AND request_id=?").bind(JSON.stringify(result), owner, a.request_id).run();
    return { request_id: a.request_id, state: 'failed', ...publicResult(result) };
} }
export async function listModels(env: Env, args: unknown) { const a = z.object({ page_size: z.number().int().min(1).max(100).default(50), page_token: z.string().max(4000).optional() }).strict().parse(args ?? {}); const pager = await client(env).models.list({ config: { pageSize: a.page_size, pageToken: a.page_token } }); return { models: pager.page.map(m => ({ name: m.name, display_name: m.displayName, description: m.description, input_token_limit: m.inputTokenLimit, output_token_limit: m.outputTokenLimit, supported_actions: m.supportedActions })), next_page_token: (pager.params as any).config?.pageToken ?? null, notice: 'A listed model may still need account access or a different modality/API. Verify with its official documentation.' }; }
