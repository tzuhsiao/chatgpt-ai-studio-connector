import { protectedRoute } from '@/lib/routes';
import { uploadFile, ConnectorError, LIMITS } from '@/lib/connector';
import { Buffer } from 'node:buffer';
export const dynamic='force-dynamic';
export async function POST(req:Request){return protectedRoute(req,async(e,o)=>{if(!req.headers.get('content-type')?.startsWith('multipart/form-data'))throw new ConnectorError('INVALID_INPUT','Use multipart/form-data with a file field.');const size=Number(req.headers.get('content-length')??0);if(!size||size>LIMITS.inputBytes+16000)throw new ConnectorError('FILE_TOO_LARGE','Upload requires a known size of at most 8 MiB.',413);const form=await req.formData();const f=form.get('file');if(!(f instanceof File)||f.size>LIMITS.inputBytes)throw new ConnectorError('INVALID_FILE','Choose an audio, video, image or PDF file up to 8 MiB.');return Response.json(await uploadFile(e,o,{filename:f.name,mime_type:f.type,data_base64:Buffer.from(await f.arrayBuffer()).toString('base64')}));});}
