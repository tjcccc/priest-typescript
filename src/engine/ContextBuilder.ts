import { Profile } from '../profile/Profile';
import { Message } from '../providers/ProviderAdapter';
import { OutputSpec, PromptFormat } from '../schema/OutputSpec';
import { Session } from '../session/SessionModel';

// Spec-critical constants — must match spec/behavior/context-assembly.md exactly
const FORMAT_INSTRUCTIONS: Record<PromptFormat, string> = {
  json: 'Respond only with valid JSON. No prose, no markdown code fences.',
  xml:  'Respond only with valid XML. No prose, no markdown code fences.',
  code: 'Respond only with code. No prose, no markdown code fences around it.',
};

const MEMORIES_HEADER        = '## Loaded Memories\n\n';
const DYNAMIC_MEMORY_HEADER  = '## Memory\n\n';
const SECTION_SEPARATOR      = '\n\n';
const MEMORY_SEPARATOR       = '\n';

function assembleSystemContent(
  context: string[],
  rules: string,
  identity: string,
  custom: string | undefined,
  profileMems: string[],
  dynMems: string[],
  formatInstruction: string | undefined,
): string {
  const parts: string[] = [];
  for (const c of context) { if (c.trim()) parts.push(c); }
  if (rules.trim())    parts.push(rules.trim());
  if (identity.trim()) parts.push(identity.trim());
  if (custom?.trim())  parts.push(custom.trim());
  if (profileMems.length > 0) parts.push(MEMORIES_HEADER + profileMems.join(MEMORY_SEPARATOR));
  if (dynMems.length   > 0)   parts.push(DYNAMIC_MEMORY_HEADER + dynMems.join(MEMORY_SEPARATOR));
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

  // Step 3 — trim to budget (only when maxSystemChars is set)
  if (maxSystemChars != null) {
    const fmt = outputSpec?.promptFormat ? FORMAT_INSTRUCTIONS[outputSpec.promptFormat] : undefined;
    // Trim dynamic memory tail-first
    while (dynamicMemory.length > 0) {
      if (assembleSystemContent(context, profile.rules ?? '', profile.identity ?? '', profile.custom, profileMemories, dynamicMemory, fmt).length <= maxSystemChars) break;
      dynamicMemory.pop();
    }
    // Trim profile memories tail-first if still over budget
    while (profileMemories.length > 0) {
      if (assembleSystemContent(context, profile.rules ?? '', profile.identity ?? '', profile.custom, profileMemories, dynamicMemory, fmt).length <= maxSystemChars) break;
      profileMemories.pop();
    }
    // If still exceeded, continue — no further trimming (context/rules/identity/custom/format never trimmed)
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
    formatInstruction,
  );

  // Step 5 — build message list
  const messages: Message[] = [];

  if (systemContent.length > 0) {
    messages.push({ role: 'system', content: systemContent });
  }

  if (session) {
    for (const turn of session.turns) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  const userParts = [prompt, ...userContext.filter(c => c.trim())];
  messages.push({ role: 'user', content: userParts.join(SECTION_SEPARATOR) });

  return messages;
}
