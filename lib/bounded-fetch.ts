import { requestAuthMetadata, type RequestAuthMetadata } from './request-auth-metadata';

export class ProviderResponseLimitError extends Error {
    constructor() { super('The provider response exceeded the safe readback bound.'); this.name='ProviderResponseLimitError'; }
}

// Enforce the cap before SDK JSON parsing or response cloning can buffer a large
// provider payload. No response bytes are logged or retained by this wrapper.
export function boundedProviderFetch(maxBytes: number, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
    return async (input, init) => {
        const response = await fetcher(input, init);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel();
            throw new ProviderResponseLimitError();
        }
        if (!response.body) return response;
        const reader = response.body.getReader();
        let size = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const {value,done}=await reader.read();
                    if (done) {controller.close();return;}
                    size+=value.byteLength;
                    if (size>maxBytes) {
                        await reader.cancel();
                        controller.error(new ProviderResponseLimitError());
                        return;
                    }
                    controller.enqueue(value);
                } catch(error) {controller.error(error);}
            },
            async cancel(reason) {await reader.cancel(reason);},
        });
        const headers=new Headers(response.headers);
        headers.delete('content-length');
        return new Response(body,{status:response.status,statusText:response.statusText,headers});
    };
}

type JsonFrame = {kind:'object'|'array';state:'key'|'colon'|'value'|'comma';key?:string};
// Incremental JSON redaction: discard entire sensitive/heavy values without ever
// assembling their strings or objects. The SDK only receives the small result.
export class JsonReadbackFilter {
    removedValues=0;
    private stack:JsonFrame[]=[];
    private mode:'normal'|'string'|'primitive'='normal';
    private keyString=false;
    private keyToken='';
    private escaped=false;
    private skip:'none'|'string'|'container'|'primitive'='none';
    private skipDepth=0;
    private skipString=false;
    private skipEscaped=false;
    private removed=new Set(['signature','summary','input','data','thought_signature']);
    constructor(retainInlineMedia = false) { if (retainInlineMedia) this.removed.delete('data'); }
    private complete(){const parent=this.stack.at(-1);if(parent)parent.state='comma';}
    transform(chunk:string){
        let out='';
        for(let i=0;i<chunk.length;i++){
            const c=chunk[i];
            if(this.skip!=='none'){
                if(this.skip==='primitive'){
                    if(!/[\s,}\]]/.test(c))continue;
                    this.skip='none';this.complete();i--;continue;
                }
                if(this.skipString){
                    if(this.skipEscaped)this.skipEscaped=false;
                    else if(c==='\\')this.skipEscaped=true;
                    else if(c==='"'){
                        this.skipString=false;
                        if(this.skip==='string'){this.skip='none';this.complete();}
                    }
                    continue;
                }
                if(c==='"'){this.skipString=true;continue;}
                if(c==='{'||c==='[')this.skipDepth++;
                else if(c==='}'||c===']'){
                    this.skipDepth--;
                    if(this.skipDepth===0){this.skip='none';this.complete();}
                }
                continue;
            }
            if(this.mode==='string'){
                out+=c;
                if(this.keyString){this.keyToken+=c;if(this.keyToken.length>512)throw new ProviderResponseLimitError();}
                if(this.escaped)this.escaped=false;
                else if(c==='\\')this.escaped=true;
                else if(c==='"'){
                    this.mode='normal';
                    if(this.keyString){const parent=this.stack.at(-1)!;parent.key=JSON.parse(this.keyToken);parent.state='colon';this.keyToken='';}
                    else this.complete();
                }
                continue;
            }
            if(this.mode==='primitive'){
                if(!/[\s,}\]]/.test(c)){out+=c;continue;}
                this.mode='normal';this.complete();i--;continue;
            }
            if(/\s/.test(c)){out+=c;continue;}
            const parent=this.stack.at(-1);
            if(parent?.kind==='object'&&parent.state==='value'&&parent.key&&this.removed.has(parent.key)){
                this.removedValues++;out+='null';
                if(c==='"'){this.skip='string';this.skipString=true;this.skipEscaped=false;}
                else if(c==='{'||c==='['){this.skip='container';this.skipDepth=1;this.skipString=false;}
                else this.skip='primitive';
                continue;
            }
            if(c==='"'){
                this.mode='string';this.keyString=parent?.kind==='object'&&parent.state==='key';this.keyToken=this.keyString?'"':'';this.escaped=false;out+=c;continue;
            }
            if(c==='{'||c==='['){
                if(this.stack.length>=128)throw new ProviderResponseLimitError();
                this.stack.push({kind:c==='{'?'object':'array',state:c==='{'?'key':'value'});out+=c;continue;
            }
            if(c==='}'||c===']'){this.stack.pop();this.complete();out+=c;continue;}
            if(c===':'){if(parent)parent.state='value';out+=c;continue;}
            if(c===','){if(parent){parent.state=parent.kind==='object'?'key':'value';parent.key=undefined;}out+=c;continue;}
            this.mode='primitive';out+=c;
        }
        return out;
    }
    finish(){if(this.skip!=='none'||this.mode==='string'||this.stack.length)throw new Error('Incomplete JSON readback.');}
}

export type ReadbackMetrics={received_bytes:number;retained_bytes:number;discarded_values:number;declared_content_length?:number};
export function filteredProviderFetch(maxOutputBytes:number,maxReadBytes:number,fetcher:typeof fetch=globalThis.fetch,onMetrics?:(metrics:ReadbackMetrics)=>void,retainInlineMedia=false,onRequestAuth?:(metadata:RequestAuthMetadata)=>void):typeof fetch{
    return async(input,init)=>{
        onRequestAuth?.(requestAuthMetadata(input,init));
        const response=await fetcher(input,init);
        if(!response.body)return response;
        const reader=response.body.getReader(),decoder=new TextDecoder(),encoder=new TextEncoder(),filter=new JsonReadbackFilter(retainInlineMedia);
        let readBytes=0,outputBytes=0;
        const declared=response.headers.get('content-length');
        const report=()=>onMetrics?.({received_bytes:readBytes,retained_bytes:outputBytes,discarded_values:filter.removedValues,...(declared!==null&&Number.isFinite(Number(declared))?{declared_content_length:Number(declared)}:{})});
        const body=new ReadableStream<Uint8Array>({
            async pull(controller){
                try{
                    while(true){
                        const {value,done}=await reader.read();
                        if(done){const tail=filter.transform(decoder.decode());filter.finish();if(tail){const bytes=encoder.encode(tail);outputBytes+=bytes.byteLength;if(outputBytes>maxOutputBytes)throw new ProviderResponseLimitError();controller.enqueue(bytes);}report();controller.close();return;}
                        readBytes+=value.byteLength;
                        if(readBytes>maxReadBytes){await reader.cancel();throw new ProviderResponseLimitError();}
                        const safe=filter.transform(decoder.decode(value,{stream:true}));
                        if(!safe)continue;
                        const bytes=encoder.encode(safe);outputBytes+=bytes.byteLength;
                        if(outputBytes>maxOutputBytes){await reader.cancel();throw new ProviderResponseLimitError();}
                        controller.enqueue(bytes);return;
                    }
                }catch(error){report();controller.error(error);}
            },
            async cancel(reason){await reader.cancel(reason);},
        });
        const headers=new Headers(response.headers);headers.delete('content-length');
        return new Response(body,{status:response.status,statusText:response.statusText,headers});
    };
}
