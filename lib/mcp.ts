import { z } from 'zod';
import { GUIDANCE, LIMITS, ConnectorError, assertOrigin, ownerFromHeaders, safeError, status, uploadFile, listFiles, getFile, generate, requestStatus, listModels, type Env } from './connector';
import { Buffer } from 'node:buffer';
const obj = (properties: any = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, maxLength = 32000) => ({ type: 'string', description, maxLength });
const id = { type: 'string', format: 'uuid' };
const voice = obj({ voice: str('Prebuilt Google voice name', 100), speaker: str('Speaker label', 80), language: str('Language code', 30) }, ['voice']);
export const TOOLS = [
    { name: 'connector_status', description: 'Read private configuration presence, limits and usage guidance. Never returns the API key or contacts Google.', inputSchema: obj({ transport_probe_seconds: {type:'integer',minimum:0,maximum:130,default:0,description:'Optional nonbillable foreground transport test. Wait with SSE keepalives for this many seconds; never contacts Google.'} }), annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'list_models', description: 'List one page of models via the official Google GenAI SDK. Does not generate content; requires a configured key.', inputSchema: obj({ page_size: { type: 'integer', minimum: 1, maximum: 100 }, page_token: str('Continuation token from a previous response', 4000) }), annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'upload_file', description: 'Store an authorized input audio, video, image or PDF privately. Maximum 8 MiB. Sends no content to Google until generate is called. For larger tool payloads use the private website upload.', inputSchema: obj({ filename: str('Filename', 120), mime_type: str('Audio/image MIME type, video/mp4, video/webm or application/pdf', 100), data_base64: str('Standard base64, no data URL prefix', Math.ceil(LIMITS.inputBytes / 3) * 4) }, ['filename', 'mime_type', 'data_base64']), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: 'generate', description: 'Make one user-authorized, potentially billable Google GenAI request. General text/multimodal, structured JSON, TTS, music, video understanding, and a narrowly bounded 3-second 720p Omni video experiment. User preference: do not use Gemini for coding. No tools or arbitrary execution. Always reuse request_id after an uncertain result. Input files and prompt will be sent to Google. Audio/music output is stored privately and returned as authenticated links.', inputSchema: obj({ background:{type:'boolean',description:'Optional for ordinary Interactions; explicit true or false required for Omni video. True requires google_storage_acknowledged and returns promptly for polling. False selects one synchronous Omni request with store=false, stream=false, a 105-second total deadline, bounded output, and no automatic retry or provider polling.'},google_storage_acknowledged:{type:'boolean',enum:[true],description:'True only after explicit user approval for Google to store this request including video/input, prompt and output (default paid55days/free1day). Required only with background=true; no global preference or automatic deletion.'}, request_id: id, cost_acknowledged: { type: 'boolean', enum: [true], description: 'True only after the user authorizes this specific potentially billable generation.' }, api: { type: 'string', enum: ['interactions', 'generate_content'], default: 'interactions' }, model: str('Model ID from official docs/list_models. Examples: gemini-3.8-flash, gemini-3.8-flash-tts, lyria-3-clip-preview', 120), input: { oneOf: [str('Prompt'), { type: 'array', minItems: 1, maxItems: 16, items: { oneOf: [obj({ type: { const: 'text' }, text: str('Text or exact TTS transcript'), style: str('TTS delivery instructions', 2000), speaker: str('TTS speaker label', 80) }, ['type', 'text']), obj({ type: { enum: ['audio', 'image', 'document'] }, file_id: id }, ['type', 'file_id']), obj({type:{const:'video'},file_id:id,processing:{type:'string',enum:['static','agentic'],default:'static',description:'Static sampling by default. Agentic lets Gemini 3.8 Flash navigate video adaptively; Interactions only. Omit fps with agentic. Token usage is dynamic.'},fps:{type:'number',minimum:0.1,maximum:8,default:1,description:'Static processing only; defaults to 1 FPS. Omit with agentic processing. Higher FPS uses more input tokens.'},resolution:{type:'string',enum:['low','medium','high'],description:'Gemini 3 per-frame detail, independent of FPS. High is the maximum for video (280 tokens/frame); ultra_high is not supported. Omit for provider default.'}},['type','file_id'])] } }] }, system_instruction: str('Optional system instruction', 8000), max_output_tokens: { type: 'integer', minimum: 1, maximum: 20000, default: 4096, description:'Ordinary requests maximum 8192. Omni video only: 18000–20000; use 20000 for a 3-second sample.' }, max_cost_usd: {type:'number',exclusiveMinimum:0,maximum:100,description:'Required only for narrow Omni video generation: the user-approved USD ceiling. A conservative countTokens/output-token estimate must fit before submission; this is not a provider-enforced dollar budget.'}, temperature: { type: 'number', minimum: 0, maximum: 2 }, seed: { type: 'integer', minimum: 0, maximum: 2147483647 }, response_format: { type: 'object', description: 'Interactions response format or JSON schema, max 16 KB. For TTS use {"type":"audio"}. Legacy uses audio type or JSON schema. Omni video only: {type:video,delivery:inline,duration:3s,resolution:720p,aspect_ratio:16:9}, plus explicit background true/false, 20000 output tokens and max_cost_usd. Google storage consent is required only for background=true; omit it for synchronous background=false.' }, speech_config: { oneOf: [{ type: 'array', minItems: 1, maxItems: 1, items: voice }, obj({ speakers: { type: 'array', minItems: 1, maxItems: 2, items: voice } }, ['speakers'])] } }, ['request_id', 'cost_acknowledged', 'model', 'input']), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: 'get_request', description: 'Read a previous generation by local request ID. For an approved pending background request, performs one bounded Google GET with include_input=false for that owner-mapped job, never a new generation.', inputSchema: obj({ request_id: id }, ['request_id']), annotations: { readOnlyHint: true, openWorldHint: true } },
    { name: 'list_files', description: 'List private uploaded and generated files, up to 30 per page.', inputSchema: obj({ cursor: str('Continuation cursor', 4000) }), annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'read_file_chunk', description: 'Read a private file as bounded base64 chunks for attachment/export. Prefer its authenticated download URL for the user. Maximum 256 KiB per call.', inputSchema: obj({ file_id: id, offset: { type: 'integer', minimum: 0, default: 0 }, length: { type: 'integer', minimum: 1, maximum: 262144, default: 262144 } }, ['file_id']), annotations: { readOnlyHint: true, openWorldHint: false } }
];
function links(value: any, origin: string): any { if (Array.isArray(value))
    return value.map(v => links(v, origin)); if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k === 'download_path' ? 'download_url' : k, k === 'download_path' ? origin + v : links(v, origin)])); return value; }
export async function executeTool(name: string, args: unknown, env: Env, owner: string) { switch (name) {
    case 'connector_status': {
        const a = z.object({transport_probe_seconds:z.number().int().min(0).max(130).default(0)}).strict().parse(args ?? {});
        const started = Date.now();
        if (a.transport_probe_seconds) await new Promise(resolve => setTimeout(resolve, a.transport_probe_seconds * 1000));
        return { ...await status(env, owner), ...(a.transport_probe_seconds ? {transport_probe:{requested_seconds:a.transport_probe_seconds,elapsed_ms:Date.now()-started}} : {}) };
    }
    case 'list_models': return listModels(env, args);
    case 'upload_file': return uploadFile(env, owner, args);
    case 'generate': return generate(env, owner, args);
    case 'get_request': return requestStatus(env, owner, z.object({ request_id: z.string().uuid() }).strict().parse(args).request_id);
    case 'list_files': return listFiles(env, owner, z.object({ cursor: z.string().max(4000).optional() }).strict().parse(args ?? {}).cursor);
    case 'read_file_chunk': {
        const a = z.object({ file_id: z.string().uuid(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(262144).default(262144) }).strict().parse(args);
        const f = await getFile(env, owner, a.file_id);
        if (a.offset >= f.size)
            throw new ConnectorError('OFFSET_RANGE', 'Offset exceeds file length.');
        const all = await f.arrayBuffer();
        const data = Buffer.from(all.slice(a.offset, a.offset + a.length));
        return { file_id: a.file_id, mime_type: f.httpMetadata?.contentType, total_bytes: f.size, offset: a.offset, data_base64: data.toString('base64'), next_offset: a.offset + data.length < f.size ? a.offset + data.length : null };
    }
    default: throw new ConnectorError('UNKNOWN_TOOL', 'Unknown tool.');
} }
export async function readBounded(req: Request, max = LIMITS.requestBytes) { const declared = Number(req.headers.get('content-length') ?? 0); if (declared > max)
    throw new ConnectorError('REQUEST_TOO_LARGE', 'Request exceeds size limit.', 413); if (!req.body)
    return ''; const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; while (true) {
    const { done, value } = await reader.read();
    if (done)
        break;
    size += value.length;
    if (size > max) {
        await reader.cancel();
        throw new ConnectorError('REQUEST_TOO_LARGE', 'Request exceeds size limit.', 413);
    }
    chunks.push(value);
} return Buffer.concat(chunks).toString('utf8'); }
export async function handleMcp(req: Request, env: Env) { let rpc: any; try {
    assertOrigin(req);
    rpc = JSON.parse(await readBounded(req));
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string')
        return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, { status: 400 });
    let result: any;
    if (rpc.method === 'initialize') {
        result = { protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : '2025-03-26', serverInfo: { name: 'AI Studio Connector', version: '1.6.3' }, capabilities: { tools: {} }, instructions: GUIDANCE };
    }
    else if (rpc.method === 'tools/list') {
        result = { tools: TOOLS };
    }
    else if (rpc.method === 'ping') {
        result = {};
    }
    else if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
    }
    else if (rpc.method === 'tools/call') {
        const owner = ownerFromHeaders(req.headers, env);
        const invoke = async () => {
            try {
                const data = links(await executeTool(rpc.params?.name, rpc.params?.arguments ?? {}, env, owner), new URL(req.url).origin);
                return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, ...(data.error ? { isError: true } : {}) };
            } catch (e) {
                const error = safeError(e);
                return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
            }
        };
        if (req.headers.get('accept')?.includes('text/event-stream')) return streamMcpResult(rpc.id ?? null, invoke);
        result = await invoke();
    }
    else {
        return Response.json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: 'Method not found' } });
    }
    return Response.json({ jsonrpc: '2.0', id: rpc.id ?? null, result }, { headers: { 'Cache-Control': 'no-store' } });
}
catch (e) {
    const error = safeError(e);
    return Response.json({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: e instanceof ConnectorError && e.status === 401 ? -32001 : -32600, message: error.message } }, { status: e instanceof ConnectorError ? e.status : 400, headers: { 'Cache-Control': 'no-store' } });
} }

// Keep the same authenticated foreground request open while the provider works.
// No detached task, resumable Google storage, retries, or unbounded buffering.
export function streamMcpResult(id: unknown, invoke: () => Promise<unknown>, heartbeatMs = 15000) {
    const encoder = new TextEncoder();
    let closed = false, heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (text: string) => { if (!closed) controller.enqueue(encoder.encode(text)); };
            send(': connected\n\n');
            heartbeat = setInterval(() => send(': keepalive\n\n'), heartbeatMs);
            void invoke().then(result => {
                send(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id,result})}\n\n`);
            }, () => {
                send(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message:'Request interrupted. Check the original request ID before any retry.'}})}\n\n`);
            }).finally(() => {
                clearInterval(heartbeat);
                if (!closed) { closed = true; controller.close(); }
            });
        },
        cancel() { closed = true; clearInterval(heartbeat); },
    });
    return new Response(stream, {headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
}
