import type { GoogleGenAI } from '@google/genai';

export type StreamSnapshot = {
    transport: 'streaming';
    phase: 'awaiting_response' | 'streaming';
    provider_interaction_id?: string;
    provider_status?: string;
    elapsed_ms: number;
    received_events: number;
    processing_steps: Array<{ type: 'processing_call' | 'processing_result' }>;
    partial_text: string;
    usage: unknown;
};
export class InteractionStreamFailure extends Error {
    constructor(public kind: 'timeout' | 'connection' | 'incomplete' | 'output_limit' | 'provider_error', public snapshot: StreamSnapshot, public originalError?: unknown) {
        super('The provider stream did not complete.');
        this.name = 'InteractionStreamFailure';
    }
}

// Only final-answer text and bounded operational metadata are retained. Thoughts,
// signatures, input bytes, provider error bodies and arbitrary events are never copied.
export async function consumeInteractionStream(
    sdk: GoogleGenAI,
    request: Parameters<typeof sdk.interactions.create>[0],
    options: {
        timeoutMs: number;
        maxTextBytes: number;
        sanitizeUsage: (usage: unknown) => unknown;
        onProgress: (snapshot: StreamSnapshot) => Promise<void>;
    },
) {
    const start = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
    const output = new Map<number, string>();
    const stepTypes = new Map<number, string>();
    let bytes = 0, events = 0, lastSaved = 0, completed = false;
    let id: string | undefined, status: string | undefined, usage: unknown = null;
    const processing: StreamSnapshot['processing_steps'] = [];
    const text = () => [...output.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join('\n');
    const snapshot = (): StreamSnapshot => ({ transport: 'streaming', phase: events ? 'streaming' : 'awaiting_response', ...(id ? { provider_interaction_id: id } : {}), ...(status ? { provider_status: status } : {}), elapsed_ms: Date.now() - start, received_events: events, processing_steps: [...processing], partial_text: text().slice(0, 24000), usage });
    function append(index: number, value: string) {
        bytes += new TextEncoder().encode(value).length;
        if (bytes > options.maxTextBytes) throw new InteractionStreamFailure('output_limit', snapshot());
        output.set(index, (output.get(index) ?? '') + value);
    }
    try {
        const stream = await sdk.interactions.create({ ...request, stream: true, store: false }, { timeout: options.timeoutMs, maxRetries: 0, signal: controller.signal });
        for await (const event of stream) {
            events++;
            if (events > 50000) throw new InteractionStreamFailure('output_limit', snapshot());
            if (event.event_type === 'interaction.created' || event.event_type === 'interaction.completed') {
                const interaction = event.interaction;
                if (/^[a-zA-Z0-9._:-]{1,512}$/.test(interaction.id)) id = interaction.id;
                if (['in_progress', 'completed', 'failed', 'cancelled', 'incomplete', 'requires_action'].includes(interaction.status)) status = interaction.status;
                if (interaction.usage) usage = options.sanitizeUsage(interaction.usage);
                if (event.event_type === 'interaction.completed') {
                    completed = interaction.status === 'completed';
                    if (!completed) throw new InteractionStreamFailure('provider_error', snapshot());
                }
            } else if (event.event_type === 'step.start') {
                if (!Number.isInteger(event.index) || event.index < 0 || stepTypes.size >= 1024) throw new InteractionStreamFailure('output_limit', snapshot());
                stepTypes.set(event.index, event.step.type);
                if (event.step.type === 'model_output') {
                    for (const part of event.step.content ?? []) if (part.type === 'text') append(event.index, part.text);
                } else if ((event.step.type === 'processing_call' || event.step.type === 'processing_result') && processing.length < 1000) {
                    processing.push({ type: event.step.type });
                }
            } else if (event.event_type === 'step.delta') {
                if (stepTypes.get(event.index) === 'model_output' && event.delta.type === 'text') append(event.index, event.delta.text);
                if (event.metadata?.total_usage) usage = options.sanitizeUsage(event.metadata.total_usage);
            } else if (event.event_type === 'step.stop') {
                if (event.usage) usage = options.sanitizeUsage(event.usage);
            } else if (event.event_type === 'error') {
                throw new InteractionStreamFailure('provider_error', snapshot());
            }
            // At most one checkpoint per two seconds, plus creation/completion.
            if (event.event_type === 'interaction.created' || completed || Date.now() - lastSaved >= 2000) {
                await options.onProgress(snapshot()); lastSaved = Date.now();
            }
            if (completed) break;
        }
        if (!completed) throw new InteractionStreamFailure('incomplete', snapshot());
        return { response: { status, usage, steps: [...processing, { type: 'model_output', content: [{ type: 'text', text: text() }] }] }, snapshot: snapshot() };
    } catch (error) {
        if (error instanceof InteractionStreamFailure) throw error;
        throw new InteractionStreamFailure(timedOut ? 'timeout' : 'connection', snapshot(), error);
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}
