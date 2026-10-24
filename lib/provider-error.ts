// Provider errors can echo prompts, media, identifiers, URLs or credentials.
// Expose only exact, known boilerplate; do not attempt to redact arbitrary prose.
const SAFE_MESSAGES = new Set([
    'API key not valid. Please pass a valid API key.',
    'Multiple authentication credentials received. Please pass only one.',
    'Failed to close Interaction stream: Multiple authentication credentials received. Please pass only one.',
    'Agent finished with error: Failed to close Interaction stream: Multiple authentication credentials received. Please pass only one.',
    'Request contains an invalid argument.',
    'Invalid API key.',
    'Permission denied.',
    'Permission denied',
    'Requested entity was not found.',
    'Precondition check failed.',
    'The service is currently unavailable.',
    'Internal error encountered.',
]);
const SAFE_CODES = new Set([
    'invalid_request', 'invalid_argument', 'unauthenticated', 'permission_denied',
    'not_found', 'resource_exhausted', 'failed_precondition', 'deadline_exceeded',
    'internal', 'unavailable', 'api_error', 'rate_limit_exceeded',
    'INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'NOT_FOUND',
    'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED', 'INTERNAL', 'UNAVAILABLE',
]);
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function safeProviderError(error: unknown, privateValues: Array<string | undefined> = []) {
    const outer = object(error);
    let payload = object(outer?.error);
    // Some SDK versions wrap the JSON error envelope in Error.message.
    // Bound parsing and accept JSON only, never an arbitrary exception string.
    if (!payload && typeof outer?.message === 'string' && outer.message.length <= 4096) {
        try { payload = object(JSON.parse(outer.message)); } catch { /* No safe structured error. */ }
    }
    payload = object(payload?.error) ?? payload;
    if (!payload) return undefined;
    const containsPrivate = (value: string) => privateValues.some(secret => Boolean(secret && value.includes(secret)));
    const rawCode = payload.code;
    const code = typeof rawCode === 'string' && SAFE_CODES.has(rawCode) && !containsPrivate(rawCode) ? rawCode
        : typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode >= 400 && rawCode <= 599 ? rawCode : undefined;
    const rawMessage = payload.message;
    const message = typeof rawMessage === 'string' && rawMessage.length <= 512 && SAFE_MESSAGES.has(rawMessage) && !containsPrivate(rawMessage) ? rawMessage : undefined;
    return {
        ...(code !== undefined ? { code } : {}),
        ...(message !== undefined ? { message } : {}),
        message_redacted: message === undefined,
    };
}
