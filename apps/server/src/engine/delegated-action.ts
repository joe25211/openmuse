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
  delegation: TaskDelegation,
): ProposalInput | null {
  if (
    delegation.replacementIntent !== "reviewed_replace_text" ||
    delegation.readMode !== "direct" ||
    !delegation.resourcePath ||
    !delegation.sourcePath
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
