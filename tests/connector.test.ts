import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { ownerFromHeaders, safeError, generate, generationSchema, buildRequest, uploadFile, getFile, status, pcmToWav, decodeBase64, requestStatus, pollBackgroundRequest, runSynchronousVideo, usesAgenticTextStream, type Env } from '../lib/connector';
import { handleMcp, TOOLS } from '../lib/mcp';
function env(): Env { const db = new DatabaseSync(':memory:'); for (const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync('drizzle/'+f, 'utf8')); const store = new Map<string, any>(); return { OWNER_EMAIL: 'owner@example.com', DB: { prepare(sql: string) { const statement = db.prepare(sql); let args: any[] = []; const q = { bind(...v: any[]) { args = v; return q; }, async run() { const r = statement.run(...args); return { meta: { changes: Number(r.changes) } }; }, async first() { return statement.get(...args) ?? null; } }; return q; } } as any, BUCKET: { async put(k: string, b: Uint8Array, opts: any) { store.set(k, { bytes: Buffer.from(b), ...opts }); }, async get(k: string) { const o = store.get(k); return o ? { size: o.bytes.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, arrayBuffer: async () => Uint8Array.from(o.bytes).buffer } : null; }, async list() { return { objects: [], truncated: false }; } } as any }; }
const args = () => ({ request_id: crypto.randomUUID(), cost_acknowledged: true as const, model: 'gemini-3.8-flash', input: 'Test content' });
test('owner identity required and isolated', () => { const e = env(); assert.throws(() => ownerFromHeaders(new Headers(), e)); assert.throws(() => ownerFromHeaders(new Headers({ 'oai-authenticated-user-id': 'x', 'oai-authenticated-user-email': 'other@example.com' }), e)); assert.equal(ownerFromHeaders(new Headers({ 'oai-authenticated-user-id': 'u1', 'oai-authenticated-user-email': 'owner@example.com' }), e), 'u1'); });
test('discovery public but data-bearing MCP calls protected', async () => { const e = env(); const req = (method: string, params = {}) => new Request('https://unit.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); assert.equal((await handleMcp(req('tools/list'), e)).status, 200); assert.equal((await handleMcp(req('tools/call', { name: 'connector_status' }), e)).status, 401); assert.equal((await handleMcp(new Request('https://unit.test/mcp', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }), e)).status, 403); });
test('missing key never calls provider', async () => { const e = env(); await assert.rejects(generate(e, 'u1', args()), /GEMINI_API_KEY/); assert.equal((await status(e, 'u1')).key_configured, false); });
test('invalid fields, tool execution, model URL and oversized token limits rejected', () => { for (const patch of [{ cost_acknowledged: false }, { max_output_tokens: 9000 }, { model: 'https://evil.test' }, { tools: [{ codeExecution: {} }] }, { httpOptions: { baseUrl: 'https://evil.test' } }, { input: [{ type: 'audio', uri: 'https://evil.test/audio' }] }])
    assert.throws(() => generationSchema.parse({ ...args(), ...patch })); });
test('binary input private to owner and exact bytes roundtrip', async () => { const e = env(); const b = Buffer.from([1, 2, 3, 4]); const f = await uploadFile(e, 'u1', { filename: 'sample.wav', mime_type: 'audio/wav', data_base64: b.toString('base64') }); assert.deepEqual(Buffer.from(await (await getFile(e, 'u1', f.id)).arrayBuffer()), b); await assert.rejects(getFile(e, 'u2', f.id)); const request: any = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), input: [{ type: 'text', text: 'Critique this audio' }, { type: 'audio', file_id: f.id }] })); assert.equal(request.input[0].content[1].data, b.toString('base64')); assert.equal(request.store, false); });
test('TTS speech style maps to explicit metadata and speaker settings', async () => { const e = env(); const request: any = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), model: 'gemini-3.8-flash-tts', input: [{ type: 'text', text: 'Hello.', style: 'warm', speaker: 'A' }], response_format: { type: 'audio' }, speech_config: { speakers: [{ speaker: 'A', voice: 'Kore' }] } })); assert.deepEqual(request.input[0].content[0].annotations, [{ type: 'speech_metadata', style: 'warm', speaker: 'A' }]); assert.equal(request.generation_config.speech_config.speakers[0].voice, 'Kore'); });
test('music output saved; idempotent request avoids second provider call', async () => { const e = env(); const a = { ...args(), model: 'lyria-3-clip-preview' }; let calls = 0; const mock = async () => { calls++; return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Instrumental' }, { type: 'audio', mime_type: 'audio/mp3', data: Buffer.from('mock audio').toString('base64') }] }], usage: { total_tokens: 3, private: 'never return' } }; }; const first = await generate(e, 'u1', a, mock); const second = await generate(e, 'u1', a, mock); assert.equal(first.state, 'complete'); assert.equal(first.files[0].mime_type, 'audio/mp3'); assert.equal(second.files[0].id, first.files[0].id); assert.equal(calls, 1); assert.deepEqual(first.usage, { total_tokens: 3 }); });
test('daily cap and per-minute cap apply before billable provider request', async () => { const e = env(); e.MAX_REQUESTS_PER_DAY = '2'; let calls = 0; const mock = async () => { calls++; return { output_text: 'ok' }; }; await generate(e, 'u1', args(), mock); await generate(e, 'u1', args(), mock); const blocked = await generate(e, 'u1', args(), mock); assert.equal(blocked.error.code, 'LOCAL_LIMIT'); assert.equal(calls, 2); });
test('raw SDK errors never return key, URL or prompt', async () => { const e = env(); const r = await generate(e, 'u1', args(), async () => { throw Object.assign(new Error('fake-secret-key & private prompt https://private.test'), { status: 403 }); }); assert.equal(r.error.code, 'GOOGLE_ACCESS_DENIED'); assert.doesNotMatch(JSON.stringify(r), /fake-secret|private prompt|private.test/); assert.doesNotMatch(JSON.stringify(safeError(new Error('secret'))), /secret/); });
test('base64 validated and PCM wrapped as WAV', () => { assert.throws(() => decodeBase64('not-base64!', 100)); const wav = pcmToWav(Buffer.from([0, 0, 1, 0]), 24000, 1); assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000); assert.equal(wav.length, 48); });
test('legacy generateContent maps structured schema without extra SDK capabilities', async () => { const e = env(); const r: any = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), api: 'generate_content', response_format: { type: 'object', properties: { answer: { type: 'string' } } } })); assert.equal(r.config.responseMimeType, 'application/json'); assert.equal(r.config.candidateCount, 1); assert.equal(r.contents[0].parts[0].text, 'Test content'); assert.equal(r.config.tools, undefined); });
test('real SDK serializes Interactions request against mock fetch only', async () => { const e = env(); const request: any = await buildRequest(e, 'u1', generationSchema.parse(args())); let calls = 0; const fakeFetch = async (input: any, init?: any) => { calls++; const url = typeof input === 'string' ? input : input.url; assert.match(url, /generativelanguage.googleapis.com\/v1beta\/interactions/); const body = typeof input === 'string' ? JSON.parse(init.body) : await input.json(); assert.equal(body.store, false); assert.equal(body.model, 'gemini-3.8-flash'); return new Response(JSON.stringify({ id: 'mock', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Mock answer' }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }; const sdk = new GoogleGenAI({ apiKey: 'test-only-not-a-secret', httpOptions: { fetch: fakeFetch, retryOptions: { attempts: 1 } } }); const result = await sdk.interactions.create(request as any, { maxRetries: 0 }); assert.equal(calls, 1); assert.equal(result.steps[0].type, 'model_output'); });

test('request ID collision with different input is rejected',async()=>{const e=env();const a=args();const mock=async()=>({output_text:'ok'});await generate(e,'u1',a,mock);await assert.rejects(generate(e,'u1',{...a,input:'different'},mock),/different input/);});

test('valid multi-MiB media does not overflow decoder stack',()=>{for(const n of [8*1024*1024,20*1024*1024]){const bytes=Buffer.alloc(n,1);assert.equal(decodeBase64(bytes.toString('base64'),n).length,n);}});
test('minute cap limits requests even with daily quota available',async()=>{const e=env();let calls=0;const mock=async()=>{calls++;return{output_text:'ok'};};for(let i=0;i<4;i++)await generate(e,'u1',args(),mock);assert.equal(calls,3);});
test('unsupported URI and audio format rejected before billing',async()=>{for(const response_format of [{type:'audio',delivery:'uri'},{type:'audio',mime_type:'audio/mulaw'},{type:'image',delivery:'uri'}]){await assert.rejects(buildRequest(env(),'u1',generationSchema.parse({...args(),response_format})));}});
test('legacy single speaker language maps to languageCode',async()=>{const r:any=await buildRequest(env(),'u1',generationSchema.parse({...args(),api:'generate_content',speech_config:[{voice:'Kore',language:'es'}]}));assert.equal(r.config.speechConfig.languageCode,'es');});
test('MP4 video accepted and FPS maps to both SDK request paths',async()=>{const e=env();const f=await uploadFile(e,'u1',{filename:'gameplay.mp4',mime_type:'video/mp4',data_base64:Buffer.from('mock video bytes').toString('base64')});const input=[{type:'text',text:'Review the battle presentation.'},{type:'video',file_id:f.id,fps:3}];const current:any=await buildRequest(e,'u1',generationSchema.parse({...args(),input}));assert.equal(current.input[0].content[1].type,'video');assert.equal(current.input[0].content[1].processing.fps,3);assert.equal(current.input[0].content[1].mime_type,'video/mp4');const legacy:any=await buildRequest(e,'u1',generationSchema.parse({...args(),api:'generate_content',input}));assert.equal(legacy.contents[0].parts[1].videoMetadata.fps,3);assert.equal(legacy.contents[0].parts[1].inlineData.mimeType,'video/mp4');});
test('video MIME mismatch and excessive FPS rejected',async()=>{const e=env();const f=await uploadFile(e,'u1',{filename:'sound.mp3',mime_type:'audio/mp3',data_base64:Buffer.from('audio').toString('base64')});await assert.rejects(buildRequest(e,'u1',generationSchema.parse({...args(),input:[{type:'video',file_id:f.id,fps:3}]})),/does not match/);assert.throws(()=>generationSchema.parse({...args(),input:[{type:'video',file_id:f.id,fps:30}]}));});
test('usage keeps bounded modality counts and model for cost estimation',async()=>{const e=env();const r=await generate(e,'u1',args(),async()=>({output_text:'review',usage:{total_input_tokens:100,total_output_tokens:20,input_tokens_by_modality:[{modality:'VIDEO',tokens:80,private:'do not expose'},{modality:'AUDIO',tokens:20}],output_tokens_by_modality:[{modality:'TEXT',tokens:20}]}}));assert.equal(r.model,'gemini-3.8-flash');assert.deepEqual(r.usage.input_tokens_by_modality,[{modality:'VIDEO',tokens:80},{modality:'AUDIO',tokens:20}]);assert.doesNotMatch(JSON.stringify(r.usage),/private|do not expose/);});

type SerializedVideoPart = {
    resolution?: string; processing?: { type: string; fps: number } | string; fps?: number;
    data?: string; mediaResolution?: { level: string }; videoMetadata?: { fps: number }; inlineData?: { data: string };
};
type SerializedVideoRequest = {
    store?: boolean; input: Array<{ content: SerializedVideoPart[] }>; contents: Array<{ parts: SerializedVideoPart[] }>;
};

test('video resolution is optional, bounded, and advertised in MCP discovery', async () => {
    const input = [{ type: 'video', file_id: crypto.randomUUID() }];
    const defaults = generationSchema.parse({ ...args(), input });
    assert.deepEqual(defaults.input, [{ ...input[0], fps: 1 }]);
    for (const resolution of ['low', 'medium', 'high']) {
        assert.doesNotThrow(() => generationSchema.parse({ ...args(), input: [{ ...input[0], resolution }] }));
    }
    for (const resolution of ['ultra_high', '4K', '', 280, null]) {
        assert.throws(() => generationSchema.parse({ ...args(), input: [{ ...input[0], resolution }] }));
    }
    const response = await handleMcp(new Request('https://unit.test/mcp', {
        method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), env());
    const discovery = await response.json() as { result: { tools: typeof TOOLS } };
    const schema = discovery.result.tools.find((tool: { name: string }) => tool.name === 'generate')!.inputSchema;
    const video = schema.properties.input.oneOf[1].items.oneOf.find((part: { properties: { type: { const?: string } } }) => part.properties.type.const === 'video');
    assert.deepEqual(video.properties.resolution.enum, ['low', 'medium', 'high']);
    assert.equal(video.properties.fps.default, 1);
    assert.equal(video.properties.fps.maximum, 8);
    assert.equal(video.required.includes('resolution'), false);
});

test('high video resolution survives real SDK serialization for both APIs without provider calls', async () => {
    const e = env();
    const bytes = Buffer.from('mock high-resolution video');
    const file = await uploadFile(e, 'u1', { filename: 'review.mp4', mime_type: 'video/mp4', data_base64: bytes.toString('base64') });
    for (const api of ['interactions', 'generate_content'] as const) {
        let calls = 0;
        const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            calls++;
            const request = input instanceof Request ? input : new Request(input, init);
            const body = await request.json() as SerializedVideoRequest;
            if (api === 'interactions') {
                assert.match(request.url, /\/v1beta\/interactions/);
                const part = body.input[0].content[1];
                assert.equal(part.resolution, 'high');
                assert.deepEqual(part.processing, { type: 'static', fps: 1 });
                assert.equal(part.data, bytes.toString('base64'));
                assert.equal(body.store, false);
                return Response.json({ id: 'mock-video', status: 'completed', steps: [] });
            }
            assert.match(request.url, /\/models\/gemini-3.8-flash:generateContent/);
            const part = body.contents[0].parts[1];
            assert.deepEqual(part.mediaResolution, { level: 'MEDIA_RESOLUTION_HIGH' });
            assert.deepEqual(part.videoMetadata, { fps: 1 });
            assert.equal(part.inlineData?.data, bytes.toString('base64'));
            return Response.json({ candidates: [] });
        };
        const request = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), api, input: [
            { type: 'text', text: 'Review small visual details.' },
            { type: 'video', file_id: file.id, fps: 1, resolution: 'high' },
        ] }));
        const sdk = new GoogleGenAI({ apiKey: 'test-only-not-a-secret', httpOptions: { fetch: fakeFetch, retryOptions: { attempts: 1 } } });
        if (api === 'interactions') await sdk.interactions.create(request as Parameters<typeof sdk.interactions.create>[0], { maxRetries: 0 });
        else await sdk.models.generateContent(request as Parameters<typeof sdk.models.generateContent>[0]);
        assert.equal(calls, 1);
    }
});

test('omitting video resolution preserves both provider defaults', async () => {
    const e = env();
    const file = await uploadFile(e, 'u1', { filename: 'review.webm', mime_type: 'video/webm', data_base64: Buffer.from('video').toString('base64') });
    for (const api of ['interactions', 'generate_content'] as const) {
        const request = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), api, input: [{ type: 'video', file_id: file.id }] })) as unknown as SerializedVideoRequest;
        if (api === 'interactions') {
            assert.equal(request.input?.[0].content[0].resolution, undefined);
            assert.deepEqual(request.input[0].content[0].processing, { type: 'static', fps: 1 });
        } else {
            assert.equal(request.contents?.[0].parts[0].mediaResolution, undefined);
            assert.equal(request.contents[0].parts[0].videoMetadata?.fps, 1);
        }
    }
});

test('agentic video is an explicit Interactions mode and cannot silently apply FPS', async () => {
    const e = env();
    const file = await uploadFile(e, 'u1', { filename: 'adaptive.mp4', mime_type: 'video/mp4', data_base64: Buffer.from('mock adaptive video').toString('base64') });
    const input = [{ type: 'video', file_id: file.id, processing: 'agentic', resolution: 'high' }];
    const parsed = generationSchema.parse({ ...args(), input });
    assert.deepEqual(parsed.input, input);
    assert.throws(() => generationSchema.parse({ ...args(), input: [{ ...input[0], fps: 1 }] }));
    assert.throws(() => generationSchema.parse({ ...args(), input: [{ ...input[0], processing: 'auto' }] }));
    await assert.rejects(buildRequest(e, 'u1', generationSchema.parse({ ...args(), input, api: 'generate_content' })), /only through Interactions/);
    let calls = 0;
    const request = await buildRequest(e, 'u1', parsed);
    const sdk = new GoogleGenAI({ apiKey: 'test-only-not-a-secret', httpOptions: {
        fetch: async (input, init) => {
            calls++;
            const body = await (input instanceof Request ? input : new Request(input, init)).json() as SerializedVideoRequest;
            assert.equal(body.input[0].content[0].processing, 'agentic');
            assert.equal(body.input[0].content[0].resolution, 'high');
            assert.equal(body.input[0].content[0].fps, undefined);
            assert.equal(body.store, false);
            return Response.json({ id: 'mock-agentic', status: 'completed', steps: [] });
        }, retryOptions: { attempts: 1 },
    } });
    await sdk.interactions.create(request as Parameters<typeof sdk.interactions.create>[0], { maxRetries: 0 });
    assert.equal(calls, 1);
});

test('video receipt retains settings and safe processing markers without raw thoughts', async () => {
    const e = env();
    const file = await uploadFile(e, 'u1', { filename: 'adaptive.mp4', mime_type: 'video/mp4', data_base64: Buffer.from('mock adaptive video').toString('base64') });
    const a = { ...args(), input: [{ type: 'video', file_id: file.id, processing: 'agentic', resolution: 'high' }] };
    const result = await generate(e, 'u1', a, async () => ({ output_text: 'Review', steps: [
        { type: 'thought', text: 'private-thought' },
        { type: 'processing_call', id: 'step-a', signature: 'private-signature' },
        { type: 'processing_result', call_id: 'step-a', signature: 'private-signature' },
    ], usage: { total_input_tokens: 100, total_output_tokens: 10 } }));
    assert.deepEqual(result.video_input_config, [{ file_id: file.id, processing: 'agentic', resolution: 'high' }]);
    assert.deepEqual(result.processing_steps, [{ type: 'processing_call' }, { type: 'processing_result' }]);
    assert.doesNotMatch(JSON.stringify(result), /private-thought|private-signature|step-a/);
    const again = await generate(e, 'u1', a, async () => { throw new Error('must not generate twice'); });
    assert.deepEqual(again.video_input_config, result.video_input_config);
    assert.deepEqual(again.processing_steps, result.processing_steps);
});

test('MAX_TOKENS without visible output is reported as token cap, not refusal',async()=>{
    const result=await generate(env(),'u1',{...args(),api:'generate_content'},async()=>({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[]}}],usageMetadata:{thoughtsTokenCount:28,promptTokenCount:6,totalTokenCount:34}}));
    assert.match(result.notice,/output token limit/);
    assert.match(result.notice,/Thinking tokens/);
    assert.deepEqual(result.finish_reasons,['MAX_TOKENS']);
});

test('stream failures persist safe partial state and same request ID cannot regenerate',async()=>{
    const {InteractionStreamFailure}=await import('../lib/interaction-stream');
    const e=env(),a=args(); let calls=0;
    const partial={transport:'streaming' as const,phase:'streaming' as const,provider_interaction_id:'mock-id',elapsed_ms:12,received_events:3,processing_steps:[],partial_text:'Incomplete answer',usage:{total_input_tokens:100}};
    const result=await generate(e,'u1',a,async()=>{calls++;throw new InteractionStreamFailure('timeout',partial);});
    assert.equal(result.state,'failed');assert.equal(result.error.code,'GOOGLE_TIMEOUT');assert.equal(result.partial_text,'Incomplete answer');assert.equal(result.partial,true);
    const duplicate=await generate(e,'u1',a,async()=>{calls++;return {output_text:'should not run'};});
    assert.equal(calls,1);assert.equal(duplicate.partial_text,'Incomplete answer');assert.equal(duplicate.state,'failed');
});

test('background storage requires explicit per-request consent and Interactions',async()=>{
    for(const patch of [{background:true},{google_storage_acknowledged:true},{background:true,google_storage_acknowledged:false},{background:true,google_storage_acknowledged:true,api:'generate_content'},{store:true}]) assert.throws(()=>generationSchema.parse({...args(),...patch}));
    const ordinary=await buildRequest(env(),'u1',generationSchema.parse(args()));
    assert.ok('store' in ordinary);
    assert.equal(ordinary.store,false);assert.equal(ordinary.background,undefined);
    const approved=generationSchema.parse({...args(),background:true,google_storage_acknowledged:true});
    const built=await buildRequest(env(),'u1',approved);
    assert.ok('store' in built);
    assert.equal(built.background,true);assert.equal(built.store,true);assert.equal(built.stream,false);
    assert.equal(usesAgenticTextStream(approved),false);
    let calls=0;
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async(input,init)=>{
        calls++;const req=input instanceof Request?input:new Request(input,init);const body=await req.json() as {store:boolean;background:boolean;stream:boolean};
        assert.deepEqual({store:body.store,background:body.background,stream:body.stream},{store:true,background:true,stream:false});
        return Response.json({id:'private-bg-sdk',status:'in_progress',steps:[]});
    }}});
    await sdk.interactions.create(built as Parameters<typeof sdk.interactions.create>[0],{maxRetries:0});assert.equal(calls,1);
});

test('background create is single-shot; owner-mapped poll completes and keeps provider ID private',async()=>{
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};let creates=0,polls=0;
    const pending=await generate(e,'u1',a,async()=>{creates++;return{id:'private-bg-1',status:'in_progress',steps:[]};});
    assert.equal(pending.state,'running');assert.equal(pending.background,true);assert.doesNotMatch(JSON.stringify(pending),/private-bg-1|_provider/);
    await assert.rejects(requestStatus(e,'u2',a.request_id,async()=>{polls++;return{};}),/Unknown request/);assert.equal(polls,0);
    const complete=await requestStatus(e,'u1',a.request_id,async id=>{polls++;assert.equal(id,'private-bg-1');return{id,status:'completed',steps:[{type:'user_input',content:[{type:'text',text:'do-not-expose-input'}]},{type:'thought',summary:[{type:'text',text:'do-not-expose-thought'}]},{type:'processing_call',id:'a',signature:'secret-sig'},{type:'processing_result',call_id:'a',signature:'secret-sig'},{type:'model_output',content:[{type:'text',text:'Completed review'}]}],usage:{total_tokens:42}};});
    assert.equal(complete.state,'complete');assert.equal(complete.text,'Completed review');
    assert.deepEqual(complete.processing_steps,[{type:'processing_call'},{type:'processing_result'}]);
    assert.doesNotMatch(JSON.stringify(complete),/private-bg-1|do-not-expose|secret-sig|_provider|_poll/);
    const duplicate=await generate(e,'u1',a,async()=>{creates++;return{};});
    assert.equal(duplicate.state,'complete');assert.equal(creates,1);assert.equal(polls,1);
});

test('background GET uses include_input=false, no create call, and no retries',async()=>{
    let calls=0;
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async(input,init)=>{
        calls++;const req=input instanceof Request?input:new Request(input,init);const url=new URL(req.url);
        assert.equal(req.method,'GET');assert.match(url.pathname,/interactions\/private-bg-sdk$/);assert.equal(url.searchParams.get('include_input'),'false');
        return Response.json({id:'private-bg-sdk',status:'in_progress',steps:[]});
    }}});
    await pollBackgroundRequest(sdk,'private-bg-sdk');assert.equal(calls,1);
});

test('SDK HTTP 400 poll returns safe provider diagnostic for the same owner-mapped job only',async()=>{
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};let creates=0,gets=0;
    await generate(e,'u1',a,async()=>{creates++;return{id:'private-diagnostic-job',status:'in_progress'};});
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async(input,init)=>{
        gets++;const req=input instanceof Request?input:new Request(input,init);const url=new URL(req.url);
        assert.equal(req.method,'GET');assert.equal(url.pathname,'/v1beta/interactions/private-diagnostic-job');
        assert.equal(url.searchParams.get('include_input'),'false');assert.equal(url.searchParams.has('fields'),false);
        return Response.json({error:{code:'invalid_request',message:'API key not valid. Please pass a valid API key.',details:[{prompt:'private prompt',key:'secret-key'}]}},{status:400});
    },retryOptions:{attempts:1}}});
    const result=await requestStatus(e,'u1',a.request_id,id=>pollBackgroundRequest(sdk,id));
    assert.equal(result.state,'running');assert.equal(result.poll_diagnostic.http_status,400);
    assert.deepEqual(result.poll_diagnostic.provider_error,{code:'invalid_request',message:'API key not valid. Please pass a valid API key.',message_redacted:false});
    assert.doesNotMatch(JSON.stringify(result),/private-diagnostic-job|private prompt|secret-key|_provider/);
    await assert.rejects(requestStatus(e,'u2',a.request_id,id=>pollBackgroundRequest(sdk,id)),/Unknown request/);
    assert.equal(creates,1);assert.equal(gets,1);
});

test('real polling path records safe auth channel counts and known provider error without secrets or new generation',async(t)=>{
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};e.GEMINI_API_KEY='test-only-not-a-secret';
    await generate(e,'u1',a,async()=>({id:'private-auth-job',status:'in_progress'}));
    let gets=0;const logs:unknown[]=[];
    t.mock.method(console,'warn',(...values:unknown[])=>logs.push(values));
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
        gets++;const req=input instanceof Request?input:new Request(input,init);
        assert.equal(req.method,'GET');assert.equal(req.headers.get('x-goog-api-key'),'test-only-not-a-secret');assert.equal(req.headers.has('authorization'),false);
        return Response.json({error:{code:'invalid_request',message:'Multiple authentication credentials received. Please pass only one.'}},{status:400});
    });
    const result=await requestStatus(e,'u1',a.request_id);
    assert.equal(gets,1);assert.equal(result.state,'running');
    assert.deepEqual(result.poll_diagnostic.request_auth,[{available:true,api_key_header_present:true,api_key_header_value_count:1,authorization_header_present:false,cookie_header_present:true,cookie_header_nonempty:false,credential_query_parameter_count:0,potential_credential_channel_count:1}]);
    assert.equal(result.poll_diagnostic.provider_error.message,'Multiple authentication credentials received. Please pass only one.');
    assert.equal(result.poll_diagnostic.provider_error.message_redacted,false);
    assert.doesNotMatch(JSON.stringify(result),/test-only-not-a-secret|private-auth-job/);
    assert.doesNotMatch(JSON.stringify(logs),/test-only-not-a-secret|private-auth-job|Multiple authentication/);
});

test('transient background polling error preserves running job and can recover on same ID',async()=>{
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};
    await generate(e,'u1',a,async()=>({id:'private-bg-2',status:'queued',steps:[]}));
    const failedPoll=await requestStatus(e,'u1',a.request_id,async()=>{throw Object.assign(new Error('private provider error'),{status:503});});
    assert.equal(failedPoll.state,'running');assert.ok(failedPoll.poll_error);assert.doesNotMatch(JSON.stringify(failedPoll),/private provider error|private-bg-2/);
    const recovered=await requestStatus(e,'u1',a.request_id,async id=>({id,status:'completed',output_text:'Recovered',steps:[]}));
    assert.equal(recovered.state,'complete');assert.equal(recovered.text,'Recovered');assert.equal(recovered.poll_error,undefined);
});

test('concurrent background polls use one provider GET and expose no private lease fields',async()=>{
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};
    await generate(e,'u1',a,async()=>({id:'private-bg-3',status:'in_progress',steps:[]}));
    let release:()=>void=()=>{},calls=0;
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const first=requestStatus(e,'u1',a.request_id,async id=>{calls++;await waiting;return{id,status:'completed',output_text:'One result',steps:[]};});
    await new Promise(resolve=>setTimeout(resolve,10));
    const second=await requestStatus(e,'u1',a.request_id,async()=>{calls++;return{};});
    assert.equal(second.state,'running');assert.doesNotMatch(JSON.stringify(second),/_poll|_provider|private-bg-3/);
    release();assert.equal((await first).state,'complete');assert.equal(calls,1);
});

test('background poll has hard overall deadline even if fetch ignores abort',async()=>{
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async()=>new Promise<Response>(()=>{})}});
    const started=Date.now();await assert.rejects(pollBackgroundRequest(sdk,'mock-bg',25),(error:unknown)=>{assert.equal(safeError(error).code,'GOOGLE_POLL_TIMEOUT');return true;});
    assert.ok(Date.now()-started<500);
});

const omniArgs = () => ({...args(),model:'gemini-omni-1.1-flash',background:true,google_storage_acknowledged:true,max_output_tokens:20000,max_cost_usd:0.4,response_format:{type:'video',delivery:'inline',duration:'3s',resolution:'720p',aspect_ratio:'16:9'}});
test('Omni video requires explicit bounded format, budget and Google storage approval before provider access',async()=>{
    const e=env();for(const patch of [{background:undefined},{google_storage_acknowledged:undefined},{model:'veo-3.1-fast-generate-preview'},{max_output_tokens:4096},{max_cost_usd:undefined},{system_instruction:'not supported'},{api:'generate_content'}]) assert.throws(()=>generationSchema.parse({...omniArgs(),...patch}));
    for(const format of [{duration:'10s'},{resolution:'1080p'},{delivery:'uri'},{extra:'no'}]) await assert.rejects(buildRequest(e,'u1',generationSchema.parse({...omniArgs(),response_format:{...omniArgs().response_format,...format}})));
    const r:any=await buildRequest(e,'u1',generationSchema.parse(omniArgs()));assert.equal(r.store,true);assert.equal(r.background,true);assert.equal(r.generation_config.max_output_tokens,20000);assert.equal(r.response_format.duration,'3s');
});
test('Omni counts tokens before one paid submission, persists cost guard, and retrieves only its own MP4',async()=>{
    const e=env();const a=omniArgs();const calls:string[]=[];const bytes=Buffer.from('small mock MP4');
    const mock=async(api:string)=>{calls.push(api);return api==='count_tokens'?{totalTokens:600}:{id:'omni-background',status:'in_progress'};};
    const created=await generate(e,'u1',a,mock);assert.equal(created.state,'running');assert.deepEqual(calls,['count_tokens','interactions']);assert.equal(created.cost_guard.approved_ceiling,0.4);assert.ok(created.cost_guard.conservative_estimate<0.4);assert.equal(created.video_generation,true);assert.doesNotMatch(JSON.stringify(created),/omni-background/);
    await assert.rejects(requestStatus(e,'u2',a.request_id));
    const completed=await requestStatus(e,'u1',a.request_id,async id=>{assert.equal(id,'omni-background');return{id,status:'completed',steps:[{type:'model_output',content:[{type:'video',mime_type:'video/mp4',data:bytes.toString('base64')}]}],usage:{total_input_tokens:600,total_output_tokens:17376}};});
    assert.equal(completed.state,'complete');assert.equal(completed.files[0].mime_type,'video/mp4');assert.deepEqual(Buffer.from(await (await getFile(e,'u1',completed.files[0].id)).arrayBuffer()),bytes);assert.doesNotMatch(JSON.stringify(completed),/small mock|bW9jayBNUDQ/);
    await generate(e,'u1',a,mock);assert.equal(calls.length,2);
});
test('Omni cost check fails closed before any paid submission',async()=>{
    for(const counted of [{totalTokens:40000},{}, {totalTokens:-1}]){const calls:string[]=[];const result=await generate(env(),'u1',omniArgs(),async api=>{calls.push(api);return counted;});assert.equal(result.state,'failed');assert.match(result.error.code,/COST_LIMIT|COST_UNVERIFIED/);assert.deepEqual(calls,['count_tokens']);}
});
test('Omni typed request survives official SDK serialization against mock HTTP only',async()=>{
    const e=env(),request=await buildRequest(e,'u1',generationSchema.parse(omniArgs()));let calls=0;
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async(input,init)=>{calls++;const req=input instanceof Request?input:new Request(input,init);const body=await req.json() as any;assert.equal(body.background,true);assert.equal(body.store,true);assert.equal(body.generation_config.max_output_tokens,20000);assert.deepEqual(body.response_format,omniArgs().response_format);return Response.json({id:'mock-omni',status:'in_progress',steps:[]});},retryOptions:{attempts:1}}});
    await sdk.interactions.create(request as any,{maxRetries:0});assert.equal(calls,1);
});

test('Omni cannot implicitly generate video without explicit format and budget guards',()=>{assert.throws(()=>generationSchema.parse({...args(),model:'gemini-omni-1.1-flash'}));});

const syncOmniArgs=()=>({...omniArgs(),background:false,google_storage_acknowledged:undefined,max_cost_usd:0.5});
test('synchronous Omni requires explicit false and keeps storage, budget and format guards',async()=>{
    const a=generationSchema.parse(syncOmniArgs());const built:any=await buildRequest(env(),'u1',a);
    assert.equal(built.background,false);assert.equal(built.store,false);assert.equal(built.stream,false);
    assert.throws(()=>generationSchema.parse({...syncOmniArgs(),background:undefined}));
    assert.throws(()=>generationSchema.parse({...syncOmniArgs(),google_storage_acknowledged:true}));
    assert.throws(()=>generationSchema.parse({...syncOmniArgs(),max_cost_usd:undefined}));
    assert.throws(()=>generationSchema.parse({...syncOmniArgs(),max_output_tokens:8192}));
    assert.equal(TOOLS.find(t=>t.name==='generate')!.inputSchema.properties.background.type,'boolean');
});
test('synchronous Omni counts once, creates once, stores one private MP4 and never polls or retries',async(t)=>{
    const e=env();e.GEMINI_API_KEY='test-only-not-a-secret';const a=syncOmniArgs();const calls:string[]=[];const bytes=Buffer.from('mock synchronous MP4');
    t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
        const req=input instanceof Request?input:new Request(input,init);const url=new URL(req.url);calls.push(url.pathname);
        assert.equal(req.method,'POST');assert.equal(req.headers.get('x-goog-api-key'),'test-only-not-a-secret');assert.equal(req.headers.has('authorization'),false);
        if(url.pathname.endsWith(':countTokens'))return Response.json({totalTokens:600});
        assert.equal(url.pathname,'/v1beta/interactions');const body:any=await req.json();
        assert.equal(body.background,false);assert.equal(body.store,false);assert.equal(body.stream,false);assert.equal(body.generation_config.max_output_tokens,20000);
        return Response.json({id:'private-sync-id',status:'completed',steps:[{type:'model_output',content:[{type:'video',mime_type:'video/mp4',data:bytes.toString('base64')}]}],usage:{total_input_tokens:600,total_output_tokens:17376}});
    });
    const result=await generate(e,'u1',a);assert.equal(result.state,'complete');assert.equal(result.transport,'synchronous');assert.equal(result.cost_guard.approved_ceiling,0.5);
    assert.equal(result.files.length,1);assert.equal(result.files[0].mime_type,'video/mp4');assert.equal(result.google_storage,'disabled_for_this_request');
    assert.deepEqual(Buffer.from(await(await getFile(e,'u1',result.files[0].id)).arrayBuffer()),bytes);
    assert.doesNotMatch(JSON.stringify(result),/private-sync-id|test-only-not-a-secret|bW9jayBzeW5j/);
    assert.equal((await generate(e,'u1',a)).state,'complete');assert.equal((await requestStatus(e,'u1',a.request_id)).state,'complete');assert.equal(calls.length,2);
});
test('synchronous Omni cost failures prevent paid submission, and failures never resubmit the same ID',async()=>{
    const a=syncOmniArgs(),e=env();const calls:string[]=[];
    const cost=await generate(e,'u1',a,async api=>{calls.push(api);return{totalTokens:1000000};});
    assert.equal(cost.state,'failed');assert.equal(cost.error.code,'COST_LIMIT');assert.deepEqual(calls,['count_tokens']);
    const failureArgs=syncOmniArgs();let submits=0;
    const failure=await generate(e,'u1',failureArgs,async api=>{if(api==='count_tokens')return{totalTokens:600};submits++;throw Object.assign(new Error('untrusted private error'),{status:503});});
    assert.equal(failure.state,'failed');assert.equal(failure.background,false);assert.doesNotMatch(JSON.stringify(failure),/untrusted private error/);
    await generate(e,'u1',failureArgs,async()=>{submits++;return{};});assert.equal(submits,1);
});
test('synchronous deadline aborts stalled work and prevents a late cost response from starting generation',async()=>{
    let submits=0;await assert.rejects(runSynchronousVideo(async signal=>{await new Promise(r=>setTimeout(r,30));signal.throwIfAborted();submits++;return{};},10),(error:any)=>error.code==='GOOGLE_SYNC_TIMEOUT');
    await new Promise(r=>setTimeout(r,40));assert.equal(submits,0);
    await assert.rejects(runSynchronousVideo(async()=>new Promise(()=>{}),10),(error:any)=>error.code==='GOOGLE_SYNC_TIMEOUT');
});
test('synchronous incomplete/no-video responses are not falsely marked complete',async()=>{
    for(const response of [{status:'failed',usage:{total_tokens:1}},{status:'completed',steps:[]}]){
        const result=await generate(env(),'u1',syncOmniArgs(),async api=>api==='count_tokens'?{totalTokens:600}:response);
        assert.equal(result.state,'failed');assert.match(result.error.code,/GOOGLE_SYNC_INCOMPLETE|GOOGLE_VIDEO_OUTPUT_MISSING/);
    }
});
test('authentication conflicts and failed retrievals no longer imply invalid user content or active generation',async()=>{
    const error=Object.assign(new Error('provider'),{status:400,error:{code:'invalid_request',message:'Multiple authentication credentials received. Please pass only one.'}});
    assert.equal(safeError(error).code,'GOOGLE_AUTH_CONFLICT');
    const e=env(),a={...args(),background:true,google_storage_acknowledged:true};
    await generate(e,'u1',a,async()=>({id:'private-stale-job',status:'in_progress'}));
    const result=await requestStatus(e,'u1',a.request_id,async()=>{throw error;});
    assert.equal(result.retrieval_status,'unavailable');assert.equal(result.provider_status_verified,false);assert.match(result.notice,/last known/);
});

test('daily upload quota permits 100 private uploads and rejects upload 101 without affecting generation quota',async()=>{
    const e=env();const upload={filename:'quota.png',mime_type:'image/png',data_base64:Buffer.from('tiny local test image').toString('base64')};
    for(let i=0;i<100;i++)await uploadFile(e,'u1',upload);
    await assert.rejects(uploadFile(e,'u1',upload),(error:any)=>error.code==='LOCAL_LIMIT');
    const current=await status(e,'u1');
    assert.equal(current.limits.uploadsPerDay,100);
    assert.equal(current.limits.generationAttemptsToday,0);
    assert.equal(current.limits.generationsPerDay,30);
    assert.equal(current.limits.generationsPerMinute,3);
    assert.equal(current.limits.inputBytes,8*1024*1024);
    await assert.doesNotReject(uploadFile(e,'u2',upload));
});

test('Omni two endpoint images preserve order, exact bytes and role tags through real SDK serialization', async () => {
    const e = env();
    const images = [Buffer.from([0, 1, 2, 255]), Buffer.from([255, 3, 2, 0])];
    const files = await Promise.all(images.map((bytes, i) => uploadFile(e, 'u1', { filename: `endpoint${i}.png`, mime_type: 'image/png', data_base64: bytes.toString('base64') })));
    const text = '[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] Move smoothly between these poses.';
    for (const background of [false, true]) {
        const request: any = await buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), background, google_storage_acknowledged: background || undefined, input: [{ type: 'text', text }, ...files.map(file => ({ type: 'image', file_id: file.id }))] }));
        const sdk = new GoogleGenAI({ apiKey: 'test-only-not-a-secret', httpOptions: { fetch: async (input, init) => {
            const req = input instanceof Request ? input : new Request(input, init);
            const body: any = await req.json();
            assert.deepEqual(body.generation_config.video_config, { task: 'image_to_video' });
            assert.equal(body.input[0].content[0].text, text);
            assert.deepEqual(body.input[0].content.slice(1).map((part: any) => ({ type: part.type, mime: part.mime_type, bytes: Buffer.from(part.data, 'base64') })), images.map(bytes => ({ type: 'image', mime: 'image/png', bytes })));
            assert.equal(body.store, background); assert.equal(body.background, background); assert.equal(body.stream, false);
            return Response.json({ id: 'mock-endpoints', status: 'completed', steps: [] });
        }, retryOptions: { attempts: 1 } } });
        await sdk.interactions.create(request, { maxRetries: 0 });
    }
});

test('Omni endpoint change retains zero/one references and rejects excess or unsupported inputs before provider access', async () => {
    const e = env();
    const file = await uploadFile(e, 'u1', { filename: 'pose.png', mime_type: 'image/png', data_base64: Buffer.from('pose').toString('base64') });
    const image = { type: 'image', file_id: file.id };
    for (const input of ['text only', [image]]) await buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input }));
    for (const input of [[image, image, image], [{ type: 'audio', file_id: file.id }], [{ type: 'video', file_id: file.id }], [{ type: 'text', text: 'pose', style: 'warm' }], [{ type: 'text', text: 'pose', speaker: 'A' }], 'x'.repeat(4001)]) {
        let calls = 0;
        await assert.rejects(generate(e, 'u1', { ...omniArgs(), input }, async () => { calls++; return {}; }), (error: any) => error.code === 'UNSUPPORTED_VIDEO_INPUT');
        assert.equal(calls, 0);
    }
    const general: any = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), input: [image, image, image] }));
    assert.equal(general.input[0].content.length, 3);
});

test('Omni two references retain combined byte cap, MIME checks and private owner isolation', async () => {
    const e = env();
    const first = await uploadFile(e, 'u1', { filename: 'first.png', mime_type: 'image/png', data_base64: Buffer.alloc(4 * 1024 * 1024).toString('base64') });
    const last = await uploadFile(e, 'u1', { filename: 'last.png', mime_type: 'image/png', data_base64: Buffer.alloc(4 * 1024 * 1024).toString('base64') });
    const images = [first, last].map(file => ({ type: 'image', file_id: file.id }));
    await buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input: images }));
    for (const input of [[{ type: 'text', text: 'x' }, ...images], [...images, { type: 'text', text: 'x' }]])
        await assert.rejects(buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input })), (error: any) => error.code === 'INPUT_TOO_LARGE');
    await assert.rejects(buildRequest(e, 'u2', generationSchema.parse({ ...omniArgs(), input: images })));
    const foreign = await uploadFile(e, 'u2', { filename: 'foreign.png', mime_type: 'image/png', data_base64: Buffer.from('private pose').toString('base64') });
    await assert.rejects(buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input: [images[0], { type: 'image', file_id: foreign.id }] })));
    const audio = await uploadFile(e, 'u1', { filename: 'audio.wav', mime_type: 'audio/wav', data_base64: Buffer.from('audio').toString('base64') });
    await assert.rejects(buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input: [images[0], { type: 'image', file_id: audio.id }] })), (error: any) => error.code === 'MIME_MISMATCH');
});

test('Omni preflight counts both endpoint images and preserves the authorized cost ceiling', async () => {
    for (const totalTokens of [600, 40000]) {
        const e = env();
        const encoded = ['first pose', 'last pose'].map(text => Buffer.from(text).toString('base64'));
        const files = await Promise.all(encoded.map((data_base64, i) => uploadFile(e, 'u1', { filename: `pose${i}.png`, mime_type: 'image/png', data_base64 })));
        const calls: string[] = [];
        const result = await generate(e, 'u1', { ...omniArgs(), input: files.map(file => ({ type: 'image', file_id: file.id })) }, async (api, params: any) => {
            calls.push(api);
            if (api === 'count_tokens') { assert.deepEqual(params.contents[0].parts.map((part: any) => part.inlineData.data), encoded); return { totalTokens }; }
            assert.deepEqual(params.input[0].content.map((part: any) => part.data), encoded);
            return { id: 'mock-two-images', status: 'in_progress' };
        });
        if (totalTokens === 600) { assert.equal(result.state, 'running'); assert.equal(result.cost_guard.approved_ceiling, 0.4); assert.deepEqual(calls, ['count_tokens', 'interactions']); }
        else { assert.equal(result.error.code, 'COST_LIMIT'); assert.deepEqual(calls, ['count_tokens']); }
    }
});

test('connector status and MCP initialize advertise the same release and guidance', async () => {
    const e = env(); const current = await status(e, 'u1');
    assert.equal(current.version, '1.6.5'); assert.match(current.usage_guidance, /video_config.task=image_to_video/); assert.match(current.usage_guidance, /at most two images/); assert.match(current.usage_guidance, /<LAST_FRAME>@Image2/);
    const response = await handleMcp(new Request('https://unit.test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }), e);
    const body: any = await response.json(); assert.equal(body.result.serverInfo.version, current.version); assert.equal(body.result.instructions, current.usage_guidance);
});


test('explicit endpoint mode applies only to two-image Omni video, leaving other paths unchanged', async () => {
    const e = env();
    const file = await uploadFile(e, 'u1', { filename: 'pose.png', mime_type: 'image/png', data_base64: Buffer.from('pose').toString('base64') });
    const image = { type: 'image', file_id: file.id };
    for (const input of ['text only', [image]]) {
        const request: any = await buildRequest(e, 'u1', generationSchema.parse({ ...omniArgs(), input }));
        assert.equal(request.generation_config.video_config, undefined);
    }
    for (const api of ['interactions', 'generate_content']) {
        const request: any = await buildRequest(e, 'u1', generationSchema.parse({ ...args(), api, input: [image, image] }));
        assert.equal(request.generation_config?.video_config, undefined);
        assert.equal(request.config?.videoConfig, undefined);
    }
});
