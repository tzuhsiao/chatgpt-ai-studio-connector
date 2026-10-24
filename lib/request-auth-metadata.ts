// Observe only authentication-channel presence/counts at the fetch boundary.
// Never retain URL paths, query/header values, keys, tokens or request bodies.
export function requestAuthMetadata(input: RequestInfo | URL, init?: RequestInit) {
    try {
        const request = input instanceof Request ? input : undefined;
        const headers = new Headers(init?.headers ?? request?.headers);
        const url = new URL(request ? request.url : String(input));
        const credentialQueryNames = new Set(['key', 'api_key', 'apikey', 'access_token', 'oauth_token']);
        let queryCount = 0;
        for (const name of url.searchParams.keys()) if (credentialQueryNames.has(name.toLowerCase())) queryCount++;
        const keyPresent = headers.has('x-goog-api-key');
        const authorizationPresent = headers.has('authorization');
        const cookiePresent = headers.has('cookie');
        const cookieNonempty = Boolean(headers.get('cookie')?.trim());
        // Fetch Headers combines repeated header entries with commas. This is
        // an observed value count, not an interpretation of credential validity.
        const keyValues = keyPresent ? headers.get('x-goog-api-key')!.split(',').length : 0;
        return {
            available: true,
            api_key_header_present: keyPresent,
            api_key_header_value_count: Math.min(keyValues, 99),
            authorization_header_present: authorizationPresent,
            cookie_header_present: cookiePresent,
            cookie_header_nonempty: cookieNonempty,
            credential_query_parameter_count: Math.min(queryCount, 99),
            potential_credential_channel_count: Number(keyPresent) + Number(authorizationPresent) + Number(cookieNonempty) + Number(queryCount > 0),
        };
    } catch {
        // Diagnostics must never change the request or prevent its submission.
        return { available: false };
    }
}
export type RequestAuthMetadata = ReturnType<typeof requestAuthMetadata>;
