import { env } from 'cloudflare:workers';
import { ownerFromHeaders, assertOrigin, ConnectorError, safeError, type Env } from './connector';
export async function protectedRoute(req: Request, fn: (e: Env, owner: string) => Promise<Response>) { try {
    assertOrigin(req);
    const e = env as unknown as Env;
    return await fn(e, ownerFromHeaders(req.headers, e));
}
catch (error) {
    return Response.json({ error: safeError(error) }, { status: error instanceof ConnectorError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } });
} }
