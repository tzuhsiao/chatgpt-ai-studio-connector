import { env } from 'cloudflare:workers';
import { handleMcp } from '@/lib/mcp';
import type { Env } from '@/lib/connector';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleMcp(request,env as unknown as Env);}
export function GET(){return new Response('Use MCP Streamable HTTP POST.',{status:405,headers:{Allow:'POST'}});}
