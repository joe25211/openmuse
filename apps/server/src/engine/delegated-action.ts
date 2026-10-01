import { z } from "zod";
import type { TaskDelegation } from "../../../../packages/domain/src/agent.ts";
import type { ProposalInput } from "../../../../packages/domain/src/index.ts";
import { textHash } from "../local-action.ts";

const botAction = z
  .object({
    kind: z.literal("file.replace_text"),
    target: z.literal("named-resource"),
    resourceId: z.string().regex(/^[a-f0-9]{16}$/),
    expectedText: z.string().refine((value) => new TextEncoder().encode(value).length <= 64 * 1024),
    replacementText: z
      .string()
      .refine((value) => new TextEncoder().encode(value).length <= 64 * 1024),
  })
  .strict();

/** Only a complete, final Bot response block can request an OpenMuse review. */
export function delegatedFileProposal(
  output: string,
  prompt: string,
  delegation: TaskDelegation,
): ProposalInput | null {
  if (
    delegation.readMode !== "direct" ||
    !delegation.resourcePath ||
    !delegation.sourcePath ||
    !/\b(replace|overwrite|update|edit|change)\b/i.test(prompt) ||
    /\b(draft|suggest|outline|example|hypothetical|dry[ -]?run)\b|\b(?:do not|don't|without)\s+(?:edit|replace|change|write|apply|overwrite|modify)\b|\bonly\s+copy\s+(?:the\s+)?text\b|\bno\s+changes\b|\bfor\s+review\s+only\b/i.test(
      prompt,
    )
  )
    return null;
  const blocks = [...output.matchAll(/```openmuse-action\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1 || !output.trimEnd().endsWith(blocks[0][0])) return null;
  try {
    const parsed = botAction.safeParse(JSON.parse(blocks[0][1]));
    if (
      !parsed.success ||
      parsed.data.resourceId !== textHash(delegation.resourcePath).slice(0, 16)
    )
      return null;
    return {
      kind: "file.replace_text",
      data: {
        path: delegation.resourcePath,
        expectedSha256: textHash(parsed.data.expectedText),
        replacementText: parsed.data.replacementText,
      },
    };
  } catch {
    return null;
  }
}
