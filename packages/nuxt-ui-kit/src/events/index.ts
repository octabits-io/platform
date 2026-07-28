/**
 * @octabits-io/nuxt-ui-kit/events — the browser side of
 * `@octabits-io/framework/events`: a fetch-based SSE reader (header auth,
 * `Last-Event-ID` replay, full-jitter backoff, durable-only watermark,
 * bounded dedupe) and its Vue composable.
 *
 * The invalidation registry (which composable refetches on which resource
 * key) is deliberately NOT here yet — it stays app-local until the
 * resource-key convention has proven itself; see the events design record.
 */
export { createSseFrameParser, type SseFrame, type SseFrameParser } from './sseParser.ts';
export {
  createEventStreamClient,
  type EventStreamClient,
  type EventStreamClientOptions,
  type EventStreamRequest,
  type EventStreamState,
  type StreamedEvent,
} from './client.ts';
export { useEventStream, type UseEventStreamReturn } from './useEventStream.ts';
