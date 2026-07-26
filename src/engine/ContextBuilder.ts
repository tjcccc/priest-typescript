import { readFileSync } from 'node:fs';

import { PriestError } from '../errors/PriestError';
import { Profile } from '../profile/Profile';
import { ContentBlock, Message } from '../providers/ProviderAdapter';
import { DEFAULT_IMAGE_MEDIA_TYPE, ImageInput, validateImageInput } from '../schema/ImageInput';
import { OutputSpec, PromptFormat } from '../schema/OutputSpec';
import { ToolExchangeTurn } from '../schema/ToolTypes';
import { Session } from '../session/SessionModel';

// Spec-critical constants — must match spec/behavior/context-assembly.md exactly
const FORMAT_INSTRUCTIONS: Record<PromptFormat, string> = {
  json: 'Respond only with valid JSON. No prose, no markdown code fences.',
  xml:  'Respond only with valid XML. No prose, no markdown code fences.',
  code: 'Respond only with code. No prose, no markdown code fences around it.',
};

const MEMORIES_HEADER        = '## Loaded Memories\n\n';
const DYNAMIC_MEMORY_HEADER  = '## Memory\n\n';
const SUMMARY_HEADER         = '## Conversation so far (summary)\n\n';
const SECTION_SEPARATOR      = '\n\n';
const MEMORY_SEPARATOR       = '\n';

function assembleSystemContent(
  context: string[],
  rules: string,
  identity: string,
  custom: string | undefined,
  profileMems: string[],
  dynMems: string[],
  conversationSummary: string | undefined,
  formatInstruction: string | undefined,
): string {
  const parts: string[] = [];
  for (const c of context) { if (c.trim()) parts.push(c); }
  if (rules.trim())    parts.push(rules.trim());
  if (identity.trim()) parts.push(identity.trim());
  if (custom?.trim())  parts.push(custom.trim());
  if (profileMems.length > 0) parts.push(MEMORIES_HEADER + profileMems.join(MEMORY_SEPARATOR));
  if (dynMems.length   > 0)   parts.push(DYNAMIC_MEMORY_HEADER + dynMems.join(MEMORY_SEPARATOR));
  // Compaction summary stands in for the folded-away history. Placed after
  // memory (more volatile than profile/rules) and before format instruction.
  if (conversationSummary?.trim()) parts.push(SUMMARY_HEADER + conversationSummary.trim());
  if (formatInstruction)       parts.push(formatInstruction);
  return parts.join(SECTION_SEPARATOR);
}

/**
 * Assemble the messages array for a provider call.
 *
 * Mirrors context_builder.py exactly. The algorithm is documented in
 * spec/behavior/context-assembly.md.
 */
export function buildMessages(opts: {
  profile: Profile;
  session: Session | undefined;
  prompt: string;
  context?: string[];
  memory?: string[];
  userContext?: string[];
  outputSpec?: OutputSpec;
  maxSystemChars?: number;
  images?: ImageInput[];
  toolExchange?: ToolExchangeTurn[];
  sessionContextTurns?: number;
}): Message[] {
  const {
    profile,
    session,
    prompt,
    context = [],
    memory = [],
    userContext = [],
    outputSpec,
    maxSystemChars,
    images = [],
    toolExchange = [],
    sessionContextTurns,
  } = opts;

  // Step 1 — normalize profile memories
  const profileMemories = profile.memories
    .map(m => m.trim())
    .filter(m => m.length > 0);

  // Step 2 — deduplicate dynamic memory
  const seen = new Set<string>(profileMemories);
  const dynamicMemory: string[] = [];
  for (const entry of memory) {
    const stripped = entry.trim();
    if (!stripped) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    dynamicMemory.push(stripped);
  }

  // Compaction summary (when the session has been compacted): stands in for the
  // folded-away leading turns, which are then skipped in Step 5.
  const compaction = session?.getCompaction();
  const conversationSummary = compaction?.summary;
  const summarizedThrough = compaction?.summarizedThrough ?? 0;

  // Step 3 — trim to budget (only when maxSystemChars is set)
  if (maxSystemChars != null) {
    const fmt = outputSpec?.promptFormat ? FORMAT_INSTRUCTIONS[outputSpec.promptFormat] : undefined;
    // Trim dynamic memory tail-first
    while (dynamicMemory.length > 0) {
      if (assembleSystemContent(context, profile.rules ?? '', profile.identity ?? '', profile.custom, profileMemories, dynamicMemory, conversationSummary, fmt).length <= maxSystemChars) break;
      dynamicMemory.pop();
    }
    // Trim profile memories tail-first if still over budget
    while (profileMemories.length > 0) {
      if (assembleSystemContent(context, profile.rules ?? '', profile.identity ?? '', profile.custom, profileMemories, dynamicMemory, conversationSummary, fmt).length <= maxSystemChars) break;
      profileMemories.pop();
    }
    // If still exceeded, continue — no further trimming (context/rules/identity/custom/summary/format never trimmed)
  }

  // Step 4 — assemble system content
  const formatInstruction = outputSpec?.promptFormat ? FORMAT_INSTRUCTIONS[outputSpec.promptFormat] : undefined;
  const systemContent = assembleSystemContent(
    context,
    profile.rules ?? '',
    profile.identity ?? '',
    profile.custom,
    profileMemories,
    dynamicMemory,
    conversationSummary,
    formatInstruction,
  );

  // Step 5 — build message list
  const messages: Message[] = [];

  if (systemContent.length > 0) {
    messages.push({ role: 'system', content: systemContent });
  }

  if (session) {
    // Skip turns folded into the summary; replay only the recent tail.
    let windowStart = summarizedThrough;
    if (sessionContextTurns != null) {
      // Cap to the last N turns — never un-hiding turns already folded into the
      // summary (max with summarizedThrough).
      windowStart = Math.max(summarizedThrough, session.turns.length - Math.max(0, sessionContextTurns));
      // Snap down to a user turn so an odd-sized window never opens the replay on
      // an orphan assistant reply (strict OpenAI-compatible backends, e.g.
      // DashScope, reject a leading assistant message). Floored by
      // summarizedThrough, since the summary already stands in for earlier turns.
      while (
        windowStart > summarizedThrough
        && windowStart < session.turns.length
        && session.turns[windowStart].role !== 'user'
      ) {
        windowStart -= 1;
      }
    }
    for (const turn of session.turns.slice(windowStart)) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  const userParts = [prompt, ...userContext.filter(c => c.trim())];
  const userText = userParts.join(SECTION_SEPARATOR);

  if (images.length > 0) {
    // Multimodal user message: image blocks first, text last (mirrors Python).
    const blocks: ContentBlock[] = images.map(imageToBlock);
    blocks.push({ type: 'text', text: userText });
    messages.push({ role: 'user', content: blocks });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  // Tool loop history for the current turn. Appended after the user message,
  // never persisted in sessions.
  for (const turn of toolExchange) {
    if (turn.kind === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text ?? '',
        toolCalls: turn.toolCalls,
        ...(turn.reasoning ? { reasoning: turn.reasoning } : {}),
      });
    } else {
      messages.push({ role: 'tool', content: turn.content, toolCallId: turn.toolCallId, name: turn.name });
    }
  }

  return messages;
}

/** Convert an ImageInput to an OpenAI-format image_url content block. */
function imageToBlock(image: ImageInput): ContentBlock {
  validateImageInput(image);
  const mediaType = image.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE;
  if (image.url) {
    return { type: 'image_url', image_url: { url: image.url } };
  }
  if (image.path) {
    let b64: string;
    try {
      b64 = readFileSync(image.path).toString('base64');
    } catch (err) {
      throw PriestError.imageLoadError(image.path, String(err));
    }
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } };
  }
  // image.data is guaranteed non-null here by validateImageInput
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image.data}` } };
}
