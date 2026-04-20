import { PriestError } from '../errors/PriestError';
import { ProfileLoader } from '../profile/ProfileLoader';
import { ProviderAdapter } from '../providers/ProviderAdapter';
import { PriestErrorModel, PriestResponse } from '../schema/PriestResponse';
import { PriestRequest } from '../schema/PriestRequest';
import { SessionStore } from '../session/SessionStore';
import { Session } from '../session/SessionModel';
import { buildMessages } from './ContextBuilder';

/**
 * Orchestrates a single AI run.
 *
 * The engine is stateless per-run — it holds no mutable state between calls.
 *
 * Spec version this implementation targets: 1.0.0
 */
export class PriestEngine {
  /** Spec version this implementation targets. */
  static readonly specVersion = '2.0.0';

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
  async run(request: PriestRequest): Promise<PriestResponse> {
    const startMs = Date.now();
    const profile = request.profile ?? 'default';

    const adapter = this.adapters[request.config.provider];
    if (!adapter) throw PriestError.providerNotRegistered(request.config.provider);

    const loadedProfile = this.profileLoader.load(profile);
    const [session, isNewSession] = await this.resolveSession(request);

    const messages = buildMessages({
      profile: loadedProfile,
      session: session ?? undefined,
      prompt: request.prompt,
      context: request.context,
      memory: request.memory,
      userContext: request.userContext,
      outputSpec: request.output,
      maxSystemChars: request.config.maxSystemChars,
    });

    let text: string | undefined;
    let finishReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let errorModel: PriestErrorModel | undefined;

    try {
      const result = await adapter.complete(messages, request.config, request.output);
      text = result.text;
      finishReason = result.finishReason;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    } catch (err) {
      finishReason = 'error';
      if (err instanceof PriestError) {
        errorModel = { code: err.code, message: err.message, details: err.details };
      } else {
        errorModel = { code: 'INTERNAL_ERROR', message: String(err), details: {} };
      }
    }

    let sessionInfo = undefined;
    if (session && this.sessionStore && !errorModel) {
      session.appendTurn('user', request.prompt);
      if (text !== undefined) session.appendTurn('assistant', text);
      await this.sessionStore.save(session);
      sessionInfo = { id: session.id, isNew: isNewSession, turnCount: session.turns.length };
    }

    const latencyMs = Date.now() - startMs;
    const usage = (inputTokens !== undefined || outputTokens !== undefined)
      ? {
          inputTokens,
          outputTokens,
          totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) || undefined,
          estimatedCostUSD: undefined,
        }
      : undefined;

    return {
      text,
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
   * no usage stats, no latency info. Use run() if you need structured metadata.
   */
  async *stream(request: PriestRequest): AsyncGenerator<string, void, unknown> {
    const profile = request.profile ?? 'default';

    const adapter = this.adapters[request.config.provider];
    if (!adapter) throw PriestError.providerNotRegistered(request.config.provider);

    const loadedProfile = this.profileLoader.load(profile);
    const [session] = await this.resolveSession(request);

    const messages = buildMessages({
      profile: loadedProfile,
      session: session ?? undefined,
      prompt: request.prompt,
      context: request.context,
      memory: request.memory,
      userContext: request.userContext,
      outputSpec: request.output,
      maxSystemChars: request.config.maxSystemChars,
    });

    const parts: string[] = [];
    for await (const chunk of adapter.stream(messages, request.config, request.output)) {
      parts.push(chunk);
      yield chunk;
    }

    if (session && this.sessionStore && parts.length > 0) {
      session.appendTurn('user', request.prompt);
      session.appendTurn('assistant', parts.join(''));
      await this.sessionStore.save(session);
    }
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
