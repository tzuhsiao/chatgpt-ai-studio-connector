import { protectedRoute } from '@/lib/routes';
import { listFiles } from '@/lib/connector';
export const dynamic='force-dynamic';
export async function GET(req:Request){return protectedRoute(req,async(e,o)=>Response.json(await listFiles(e,o,new URL(req.url).searchParams.get('cursor')??undefined),{headers:{'Cache-Control':'no-store'}}));}
