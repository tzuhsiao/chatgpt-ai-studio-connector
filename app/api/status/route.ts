import { protectedRoute } from '@/lib/routes';
import { status } from '@/lib/connector';
export const dynamic='force-dynamic';
export async function GET(req:Request){return protectedRoute(req,async(e,o)=>Response.json(await status(e,o),{headers:{'Cache-Control':'no-store'}}));}
