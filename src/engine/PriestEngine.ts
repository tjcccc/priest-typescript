import { PriestError } from '../errors/PriestError';
import { Profile } from '../profile/Profile';
import { ProfileLoader } from '../profile/ProfileLoader';
import { AdapterCallOptions, AdapterStreamEvent, Message, ProviderAdapter } from '../providers/ProviderAdapter';
import { PriestErrorModel, PriestResponse, UsageInfo } from '../schema/PriestResponse';
import { PriestRequest } from '../schema/PriestRequest';
import { ToolCall } from '../schema/ToolTypes';
import { SessionStore } from '../session/SessionStore';
import { Session } from '../session/SessionModel';
import { buildMessages } from './ContextBuilder';
import { PriestStreamEvent, RunOptions } from './StreamEvents';

/**
 * Orchestrates a single AI run.
 *
 * The engine is stateless per-run — it holds no mutable state between calls.
 */
export class PriestEngine {
  /** Spec version this implementation targets. */
  static readonly specVersion = '2.4.0';

  constructor(
    private readonly profileLoader: ProfileLoader,
    private readonly sessionStore?: SessionStore,
    private readonly adapters: Record<string, ProviderAdapter> = {},
  ) {}

  /**
   * Execute a single request and return a structured response.
   *
   * Throws PriestError for PROVIDER_NOT_REGISTERED and SESSION_NOT_FOUND.
   * All other provider errors are caught and placed into response.error.
   */
  async run(request: PriestRequest, options?: RunOptions): Promise<PriestResponse> {
    const startMs = Date.now();
    const profile = request.profile ?? 'default';

    const adapter = this.adapter(request);
    const loadedProfile = this.profileLoader.load(profile);
    const [session, isNewSession] = await this.resolveSession(request);
    const messages = this.messagesFor(request, loadedProfile, session);

    let text: string | undefined;
    let toolCalls: ToolCall[] | undefined;
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let errorModel: PriestErrorModel | undefined;

    try {
      const result = await adapter.complete(messages, request.config, request.output, this.callOptions(request, options));
      text = result.text;
      toolCalls = result.toolCalls && result.toolCalls.length > 0 ? result.toolCalls : undefined;
      finishReason = result.finishReason;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    } catch (err) {
      finishReason = 'error';
      errorModel = toErrorModel(err);
    }

    if (toolCalls && finishReason !== 'tool_calls') finishReason = 'tool_calls';

    let sessionInfo = undefined;
    if (session && this.sessionStore && !errorModel) {
      // Tool-call iterations are turn-local: persist only when the model
      // produced a final answer (no pending tool calls).
      if (!toolCalls) {
        session.appendTurn('user', request.prompt);
        if (text !== undefined) session.appendTurn('assistant', text);
        await this.sessionStore.save(session);
      }
      sessionInfo = { id: session.id, isNew: isNewSession, turnCount: session.turns.length };
    }

    const latencyMs = Date.now() - startMs;
    const usage = buildUsage(inputTokens, outputTokens);

    return {
      text,
      toolCalls,
      execution: {
        provider: request.config.provider,
        model: request.config.model,
        latencyMs,
        profile,
        finishedReason: (finishReason as PriestResponse['execution']['finishedReason']) ?? undefined,
      },
      usage,
      session: sessionInfo,
      error: errorModel,
      metadata: request.metadata ?? {},
      ok: errorModel === undefined,
    };
  }

  /**
   * Yield text chunks as they arrive from the provider.
   *
   * Session is saved automatically after the stream completes.
   * Unlike run(), stream() yields only raw text chunks — no final PriestResponse,
   * no usage stats, no latency info. Use streamEvents() if you need tool calls
   * or structured metadata while streaming.
   */
  async *stream(request: PriestRequest, options?: RunOptions): AsyncGenerator<string, void, unknown> {
    for await (const event of this.streamEvents(request, options)) {
      if (event.type === 'text_delta') yield event.text;
      else if (event.type === 'done' && event.response.error) {
        const e = event.response.error;
        throw new PriestError(e.code as PriestError['code'], e.message, e.details);
      }
    }
  }

  /**
   * Yield structured streaming events: text deltas, tool-call progress, usage,
   * and a terminal 'done' event carrying the full PriestResponse.
   *
   * Adapters without native event streaming are wrapped: text chunks become
   * text_delta events. Provider errors surface in done.response.error rather
   * than being thrown, matching run() semantics.
   */
  async *streamEvents(request: PriestRequest, options?: RunOptions): AsyncGenerator<PriestStreamEvent, void, unknown> {
    const startMs = Date.now();
    const profile = request.profile ?? 'default';

    const adapter = this.adapter(request);
    const loadedProfile = this.profileLoader.load(profile);
    const [session, isNewSession] = await this.resolveSession(request);
    const messages = this.messagesFor(request, loadedProfile, session);
    const callOptions = this.callOptions(request, options);

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let errorModel: PriestErrorModel | undefined;

    try {
      const source: AsyncGenerator<AdapterStreamEvent, void, unknown> = adapter.streamEvents
        ? adapter.streamEvents(messages, request.config, request.output, callOptions)
        : wrapTextStream(adapter.stream(messages, request.config, request.output, callOptions));

      for await (const event of source) {
        switch (event.type) {
          case 'text_delta':
            textParts.push(event.text);
            yield event;
            break;
          case 'tool_call_start':
          case 'tool_call_delta':
            yield event;
            break;
          case 'tool_call_end':
            toolCalls.push(event.toolCall);
            yield event;
            break;
          case 'usage':
            inputTokens = event.inputTokens ?? inputTokens;
            outputTokens = event.outputTokens ?? outputTokens;
            yield { type: 'usage', usage: buildUsage(inputTokens, outputTokens) as UsageInfo };
            break;
          case 'finish':
            finishReason = event.finishReason ?? finishReason;
            break;
        }
      }
    } catch (err) {
      finishReason = 'error';
      errorModel = toErrorModel(err);
    }

    const text = textParts.length > 0 ? textParts.join('') : undefined;
    const hasToolCalls = toolCalls.length > 0;
    if (hasToolCalls && finishReason !== 'error') finishReason = 'tool_calls';

    let sessionInfo = undefined;
    if (session && this.sessionStore && !errorModel) {
      if (!hasToolCalls && text !== undefined) {
        session.appendTurn('user', request.prompt);
        session.appendTurn('assistant', text);
        await this.sessionStore.save(session);
      }
      sessionInfo = { id: session.id, isNew: isNewSession, turnCount: session.turns.length };
    }

    const response: PriestResponse = {
      text,
      toolCalls: hasToolCalls ? toolCalls : undefined,
      execution: {
        provider: request.config.provider,
        model: request.config.model,
        latencyMs: Date.now() - startMs,
        profile,
        finishedReason: (finishReason as PriestResponse['execution']['finishedReason']) ?? undefined,
      },
      usage: buildUsage(inputTokens, outputTokens),
      session: sessionInfo,
      error: errorModel,
      metadata: request.metadata ?? {},
      ok: errorModel === undefined,
    };

    yield { type: 'done', response };
  }

  private adapter(request: PriestRequest): ProviderAdapter {
    const adapter = this.adapters[request.config.provider];
    if (!adapter) throw PriestError.providerNotRegistered(request.config.provider);
    return adapter;
  }

  private messagesFor(request: PriestRequest, loadedProfile: Profile, session: Session | null): Message[] {
    return buildMessages({
      profile: loadedProfile,
      session: session ?? undefined,
      prompt: request.prompt,
      context: request.context,
      memory: request.memory,
      userContext: request.userContext,
      outputSpec: request.output,
      maxSystemChars: request.config.maxSystemChars,
      images: request.images,
      toolExchange: request.toolExchange,
    });
  }

  private callOptions(request: PriestRequest, options?: RunOptions): AdapterCallOptions | undefined {
    if (!options?.signal && !request.tools) return undefined;
    return {
      signal: options?.signal,
      tools: request.tools,
      toolChoice: request.toolChoice,
    };
  }

  private async resolveSession(request: PriestRequest): Promise<[Session | null, boolean]> {
    const { session: ref } = request;
    if (!ref || !this.sessionStore) return [null, false];

    const continueExisting = ref.continueExisting ?? true;
    const createIfMissing = ref.createIfMissing ?? true;

    if (continueExisting) {
      const existing = await this.sessionStore.get(ref.id);
      if (existing) return [existing, false];
      if (createIfMissing) {
        const s = await this.sessionStore.create(request.profile ?? 'default', ref.id);
        return [s, true];
      }
      throw PriestError.sessionNotFound(ref.id);
    } else {
      const s = await this.sessionStore.create(request.profile ?? 'default');
      return [s, true];
    }
  }
}

function buildUsage(inputTokens?: number, outputTokens?: number): UsageInfo | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) || undefined,
    estimatedCostUSD: undefined,
  };
}

function toErrorModel(err: unknown): PriestErrorModel {
  if (err instanceof PriestError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  return { code: 'INTERNAL_ERROR', message: String(err), details: {} };
}

async function* wrapTextStream(
  source: AsyncGenerator<string, void, unknown>,
): AsyncGenerator<AdapterStreamEvent, void, unknown> {
  for await (const chunk of source) {
    yield { type: 'text_delta', text: chunk };
  }
  yield { type: 'finish', finishReason: 'stop' };
}
