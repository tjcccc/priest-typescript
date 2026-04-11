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

const MEMORIES_HEADER = '## Loaded Memories\n\n';
const SECTION_SEPARATOR = '\n\n';
const MEMORY_SEPARATOR = '\n';

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
  systemContext?: string[];
  extraContext?: string[];
  outputSpec?: OutputSpec;
}): Message[] {
  const { profile, session, prompt, systemContext = [], extraContext = [], outputSpec } = opts;

  const systemParts: string[] = [];

  // System context (highest priority — injected by app layer)
  for (const ctx of systemContext) {
    if (ctx.trim()) systemParts.push(ctx);
  }

  // Profile rules
  if (profile.rules?.trim()) systemParts.push(profile.rules.trim());

  // Profile identity
  if (profile.identity?.trim()) systemParts.push(profile.identity.trim());

  // Profile custom
  if (profile.custom?.trim()) systemParts.push(profile.custom.trim());

  // Memories block
  if (profile.memories.length > 0) {
    const block = MEMORIES_HEADER + profile.memories.join(MEMORY_SEPARATOR);
    systemParts.push(block);
  }

  // Format instruction
  if (outputSpec?.promptFormat) {
    const instruction = FORMAT_INSTRUCTIONS[outputSpec.promptFormat];
    if (instruction) systemParts.push(instruction);
  }

  const messages: Message[] = [];

  // System message (only if non-empty)
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join(SECTION_SEPARATOR) });
  }

  // Historical turns
  if (session) {
    for (const turn of session.turns) {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  // User turn
  const userParts = [prompt, ...extraContext.filter(c => c.trim())];
  messages.push({ role: 'user', content: userParts.join(SECTION_SEPARATOR) });

  return messages;
}
