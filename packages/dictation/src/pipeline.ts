// Transcript to checked screenplay take: the same steps Writers Block's format_take runs.

import type { Diagnostic, Proposal } from "./models.ts";
import type { Formatter } from "./formatter.ts";
import { audit, capitalizeIntroductions, normalizeProposal } from "./validation.ts";

export interface FormattedTake {
  proposal: Proposal;
  diagnostics: Diagnostic[];
}

export async function formatTake(
  formatter: Formatter, transcript: string, context: Record<string, unknown>,
  { cast = [], introduced = [], signal }: { cast?: string[]; introduced?: string[]; signal?: AbortSignal } = {},
): Promise<FormattedTake> {
  signal?.throwIfAborted();
  let proposal = await formatter.format(transcript, context, signal);
  signal?.throwIfAborted();
  proposal = normalizeProposal(proposal, transcript);
  proposal = capitalizeIntroductions(proposal, cast, introduced);
  return { proposal, diagnostics: audit(proposal, transcript) };
}
