import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { consumeInteractionStream, InteractionStreamFailure, type StreamSnapshot } from '../lib/interaction-stream';
import { safeError, errorMetadata, safeUsage } from '../lib/connector';
import { streamMcpResult } from '../lib/mcp';

const request = { model: 'gemini-3.8-flash', input: 'mock-only', store: false as const, stream: true as const };
function sdkFor(events: unknown[], delayMs = 0) {
    let calls = 0;
    const sdk = new GoogleGenAI({ apiKey: 'test-only-not-a-secret', httpOptions: { fetch: async (input, init) => {
        calls++;
        const req = input instanceof Request ? input : new Request(input, init);
        const body = await req.json() as {store: boolean; stream: boolean};
        assert.equal(body.store, false); assert.equal(body.stream, true);
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                const abort = () => { clearTimeout(timer); controller.error(req.signal.reason); };
                const timer = setTimeout(() => {
                    if (req.signal.aborted) return;
                    for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                    controller.close(); req.signal.removeEventListener('abort', abort);
                }, delayMs);
                req.signal.addEventListener('abort', abort, {once:true});
            },
        }), { headers: {'Content-Type':'text/event-stream'} });
    } } });
    return { sdk, calls: () => calls };
}
const start = {event_type:'interaction.created',interaction:{id:'mock-id',status:'in_progress'}};
const finish = {event_type:'interaction.completed',interaction:{id:'mock-id',status:'completed',usage:{total_input_tokens:100,total_output_tokens:10,total_thought_tokens:5}}};
const textSteps = [
    {event_type:'step.start',index:3,step:{type:'model_output',content:[]}},
    {event_type:'step.delta',index:3,delta:{type:'text',text:'Hello '}},
    {event_type:'step.delta',index:3,delta:{type:'text',text:'world'}},
];

test('SDK SSE reducer reconstructs final text, safe markers and terminal usage without thoughts',async()=>{
    const fixture=sdkFor([start,
        {event_type:'step.start',index:0,step:{type:'thought',summary:[{type:'text',text:'secret-thought'}],signature:'secret-signature'}},
        {event_type:'step.delta',index:0,delta:{type:'thought_summary',text:'secret-summary'}},
        {event_type:'step.start',index:1,step:{type:'processing_call',id:'a',signature:'secret-signature'}},
        {event_type:'step.start',index:2,step:{type:'processing_result',call_id:'a',signature:'secret-signature'}},
        ...textSteps,finish]);
    const saved:StreamSnapshot[]=[];
    const result=await consumeInteractionStream(fixture.sdk,request,{timeoutMs:1000,maxTextBytes:10000,sanitizeUsage:safeUsage,onProgress:async value=>{saved.push(value);}});
    assert.equal(fixture.calls(),1);
    assert.equal(result.snapshot.partial_text,'Hello world');
    assert.equal(result.snapshot.phase,'streaming');
    assert.deepEqual(result.snapshot.processing_steps,[{type:'processing_call'},{type:'processing_result'}]);
    assert.deepEqual(result.snapshot.usage,{total_input_tokens:100,total_output_tokens:10,total_thought_tokens:5});
    assert.doesNotMatch(JSON.stringify({result,saved}),/secret-thought|secret-signature|secret-summary/);
});

test('stream ending without interaction.completed retains partial text and does not retry',async()=>{
    const fixture=sdkFor([start,...textSteps]);
    await assert.rejects(consumeInteractionStream(fixture.sdk,request,{timeoutMs:1000,maxTextBytes:1000,sanitizeUsage:safeUsage,onProgress:async()=>{}}),(error:unknown)=>{
        assert.ok(error instanceof InteractionStreamFailure); assert.equal(error.kind,'incomplete');
        assert.equal(error.snapshot.partial_text,'Hello world'); return true;
    });
    assert.equal(fixture.calls(),1);
});

test('foreground stream total deadline aborts an open body and retains operational snapshot',async()=>{
    const fixture=sdkFor([start,finish],100);
    await assert.rejects(consumeInteractionStream(fixture.sdk,request,{timeoutMs:25,maxTextBytes:1000,sanitizeUsage:safeUsage,onProgress:async()=>{}}),(error:unknown)=>{
        assert.ok(error instanceof InteractionStreamFailure); assert.equal(error.kind,'timeout');
        assert.equal(safeError(error).code,'GOOGLE_TIMEOUT'); return true;
    });
    assert.equal(fixture.calls(),1);
});

test('stream text and event bounds prevent unbounded buffering',async()=>{
    const fixture=sdkFor([start,...textSteps,finish]);
    await assert.rejects(consumeInteractionStream(fixture.sdk,request,{timeoutMs:1000,maxTextBytes:5,sanitizeUsage:safeUsage,onProgress:async()=>{}}),(error:unknown)=>{
        assert.ok(error instanceof InteractionStreamFailure);assert.equal(error.kind,'output_limit');return true;
    });
});

test('SDK timeout applies before headers and after SSE headers, with distinct safe metadata',async()=>{
    // AbortSignal.timeout timers are unref'ed in Node; keep the isolated mock alive.
    const keepAlive=setInterval(()=>{},1000);
    try {
        const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:async(input,init)=>{
            const req=input instanceof Request?input:new Request(input,init);
            return await new Promise<Response>((_,reject)=>req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true}));
        }}});
        await assert.rejects(sdk.interactions.create(request,{timeout:25,maxRetries:0}),(error:unknown)=>{
            assert.equal(errorMetadata(error).error_type,'APIConnectionTimeoutError');return true;
        });
        const fixture=sdkFor([finish],100);
        const stream=await fixture.sdk.interactions.create(request,{timeout:25,maxRetries:0});
        await assert.rejects(async()=>{for await(const event of stream) void event;},(error:unknown)=>{
            assert.equal(errorMetadata(error).error_type,'TimeoutError');return true;
        });
    } finally {clearInterval(keepAlive);}
});

test('MCP SSE sends headers/keepalive before result and exactly one final JSON-RPC response',async()=>{
    let done=false;
    const response=streamMcpResult(7,async()=>{await new Promise(resolve=>setTimeout(resolve,35));done=true;return {value:'ok'};},5);
    assert.equal(done,false);assert.equal(response.headers.get('Content-Type'),'text/event-stream');
    const text=await response.text();
    assert.match(text,/: connected/);assert.match(text,/: keepalive/);
    assert.equal(text.match(/event: message/g)?.length,1);
    assert.match(text,/"id":7,"result":\{"value":"ok"\}/);
});

test('error diagnostics only retain allowlisted type and bounded HTTP status',()=>{
    const error=Object.assign(new Error('secret prompt APIKEY and URL'),{name:'APIConnectionTimeoutError',status:504,headers:{Authorization:'secret'},body:'private-video'});
    assert.equal(safeError(error).code,'GOOGLE_TIMEOUT');
    assert.deepEqual(errorMetadata(error),{http_status:504,error_type:'APIConnectionTimeoutError'});
    assert.doesNotMatch(JSON.stringify({safe:safeError(error),metadata:errorMetadata(error)}),/APIKEY|private-video|secret prompt|Authorization/);
    assert.deepEqual(errorMetadata({name:'secret-value',status:123456}),{});
});

test('bounded provider response rejects large bodies before SDK buffering and redacts error',async()=>{
    const {boundedProviderFetch}=await import('../lib/bounded-fetch');
    let canceled=false;
    const fetcher:typeof fetch=async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2048));},cancel(){canceled=true;}}),{headers:{'Content-Type':'application/json'}});
    const response=await boundedProviderFetch(1024,fetcher)('https://mock.invalid');
    await assert.rejects(response.text(),(error:unknown)=>{assert.equal(safeError(error).code,'GOOGLE_POLL_RESPONSE_LIMIT');return true;});
    assert.equal(canceled,true);
});

test('bounded provider response rejects oversized declared content without reading it',async()=>{
    const {boundedProviderFetch}=await import('../lib/bounded-fetch');
    const fetcher:typeof fetch=async()=>new Response('mock',{headers:{'Content-Length':'999999'}});
    await assert.rejects(boundedProviderFetch(1024,fetcher)('https://mock.invalid'),(error:unknown)=>{assert.equal(safeError(error).code,'GOOGLE_POLL_RESPONSE_LIMIT');return true;});
});

test('incremental readback drops huge nested fields across arbitrary chunk boundaries',async()=>{
    const {JsonReadbackFilter}=await import('../lib/bounded-fetch');
    const original={id:'same-job',status:'completed',input:[{data:'private-input'}],steps:[{type:'thought',summary:[{text:'private-thought'}],signature:'S'.repeat(10000)},{type:'processing_result',signature:'P'.repeat(10000)},{type:'model_output',content:[{type:'text',text:'Text with escaped " quote, emoji🙂 and newline\nend'}]}],usage:{total_tokens:123}};
    const encoded=JSON.stringify(original);
    for(const chunkSize of [1,3,127,4096]){
        const filter=new JsonReadbackFilter();let output='';for(let i=0;i<encoded.length;i+=chunkSize)output+=filter.transform(encoded.slice(i,i+chunkSize));filter.finish();
        const safe=JSON.parse(output);assert.equal(safe.id,'same-job');assert.equal(safe.status,'completed');assert.equal(safe.input,null);assert.equal(safe.steps[0].signature,null);assert.equal(safe.steps[0].summary,null);
        assert.equal(safe.steps[2].content[0].text,original.steps[2].content?.[0].text);assert.equal(safe.usage.total_tokens,123);assert.ok(output.length<500);
    }
});

test('real SDK receives only compact filtered JSON while original signature exceeds readback cap',async()=>{
    const {filteredProviderFetch}=await import('../lib/bounded-fetch');
    const {pollBackgroundRequest}=await import('../lib/connector');
    const source=JSON.stringify({id:'mock-filtered',status:'completed',steps:[{type:'processing_result',signature:'x'.repeat(20000)},{type:'model_output',content:[{type:'text',text:'Recovered text'}]}],usage:{total_tokens:12}});
    const bytes=new TextEncoder().encode(source);let offset=0;
    const fetcher:typeof fetch=async()=>new Response(new ReadableStream({pull(c){if(offset===bytes.length){c.close();return;}const end=Math.min(offset+97,bytes.length);c.enqueue(bytes.slice(offset,end));offset=end;}}),{headers:{'Content-Type':'application/json'}});
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:filteredProviderFetch(1024,30000,fetcher)}});
    const result=await pollBackgroundRequest(sdk,'mock-filtered');assert.equal(result.status,'completed');assert.doesNotMatch(JSON.stringify(result),/xxxx/);assert.match(JSON.stringify(result),/Recovered text/);
});

test('video-only readback retains inline MP4 but still discards signatures and input without changing normal polling',async()=>{
    const {JsonReadbackFilter,filteredProviderFetch}=await import('../lib/bounded-fetch');
    const source={id:'mock-omni',status:'completed',input:[{data:'private-source'}],steps:[{type:'thought',signature:'secret-signature',summary:'private-thinking'},{type:'model_output',content:[{type:'video',mime_type:'video/mp4',data:Buffer.from('mock-mp4').toString('base64')}]}]};
    for(const keepData of [false,true]){const filter=new JsonReadbackFilter(keepData);const text=JSON.stringify(source);let result='';for(let i=0;i<text.length;i+=3)result+=filter.transform(text.slice(i,i+3));filter.finish();const parsed=JSON.parse(result);assert.equal(parsed.input,null);assert.equal(parsed.steps[0].signature,null);assert.equal(parsed.steps[0].summary,null);assert.equal(parsed.steps[1].content[0].data,keepData?source.steps[1].content?.[0].data:null);}
    const fetcher:typeof fetch=async()=>Response.json(source);
    const sdk=new GoogleGenAI({apiKey:'test-only-not-a-secret',httpOptions:{fetch:filteredProviderFetch(4096,8192,fetcher,undefined,true)}});
    const result=await sdk.interactions.get('mock-omni',{include_input:false,stream:false},{maxRetries:0});assert.equal(result.output_video?.data,source.steps[1].content?.[0].data);
});
