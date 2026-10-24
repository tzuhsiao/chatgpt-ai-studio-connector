import { protectedRoute } from '@/lib/routes';
import { getFile } from '@/lib/connector';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){const {id}=await params;return protectedRoute(req,async(e,o)=>{const f=await getFile(e,o,id);const headers=new Headers();f.writeHttpMetadata(headers);headers.set('Cache-Control','private, no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Content-Security-Policy',"default-src 'none'; sandbox");return new Response(f.body,{headers});});}
