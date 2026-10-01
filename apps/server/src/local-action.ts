import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProposalInput } from "../../../packages/domain/src/index.ts";
import { AppError } from "./errors.ts";

export type LocalAction = Extract<ProposalInput, { kind: "file.replace_text" }>;
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex");

async function scopedFile(root: string | undefined, path: string) {
  const parts = path.split(/[\\/]/);
  if (!root || isAbsolute(path) || parts.some((part) => !part || part === "." || part === ".."))
    throw new AppError("The named file is outside the scoped resource", 422);
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const base = await realpath(root);
    directory = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const part of parts.slice(0, -1)) {
      const child = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await directory.close();
      directory = child;
    }
    const parent = await realpath(`/proc/self/fd/${directory.fd}`);
    const expectedParent = await realpath(resolve(base, ...parts.slice(0, -1)));
    const within = relative(base, parent);
    if (
      parent !== expectedParent ||
      within === ".." ||
      within.startsWith("../") ||
      isAbsolute(within)
    )
      throw new Error();
    return {
      directory,
      path: `/proc/self/fd/${directory.fd}/${parts.at(-1)}`,
      canonical: resolve(base, path),
      parent: expectedParent,
    };
  } catch {
    await directory?.close();
    throw new AppError("The named file is outside the scoped resource", 422);
  }
}

type Scoped = Awaited<ReturnType<typeof scopedFile>>;
async function readCurrent(scoped: Scoped) {
  const handle = await open(scoped.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 64 * 1024 ||
      (await realpath(`/proc/self/fd/${handle.fd}`)) !== scoped.canonical ||
      (await realpath(`/proc/self/fd/${scoped.directory.fd}`)) !== scoped.parent
    )
      throw new Error();
    const bytes = await handle.readFile();
    if (bytes.length > 64 * 1024) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
    return { text, info };
  } finally {
    await handle.close();
  }
}

async function readScoped(root: string | undefined, path: string) {
  const scoped = await scopedFile(root, path);
  try {
    return { ...(await readCurrent(scoped)), scoped };
  } catch {
    await scoped.directory.close();
    throw new AppError("The named file cannot be read safely", 422);
  }
}

export async function prepareLocalAction(root: string | undefined, input: LocalAction) {
  const { text, scoped } = await readScoped(root, input.data.path);
  await scoped.directory.close();
  if (textHash(text) !== input.data.expectedSha256)
    throw new AppError("The named file changed. Ask for a fresh proposal.", 409);
  if (text === input.data.replacementText)
    throw new AppError("The proposed replacement is identical to the current file", 422);
}

export async function executeLocalAction(
  root: string | undefined,
  input: LocalAction,
  beforeFinalCheck?: () => Promise<void>,
) {
  const { text, scoped, info } = await readScoped(root, input.data.path);
  const temporary = `/proc/self/fd/${scoped.directory.fd}/.openmuse-${randomUUID()}`;
  let attempted = false;
  try {
    if (textHash(text) !== input.data.expectedSha256)
      throw new AppError("The named file changed. No replacement was made.", 409);
    const replacement = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      info.mode & 0o777,
    );
    try {
      await replacement.writeFile(input.data.replacementText, "utf8");
      await replacement.sync();
    } finally {
      await replacement.close();
    }
    await beforeFinalCheck?.();
    const current = await readCurrent(scoped);
    if (
      current.info.ino !== info.ino ||
      current.info.dev !== info.dev ||
      textHash(current.text) !== input.data.expectedSha256
    )
      throw new AppError("The named file changed. No replacement was made.", 409);
    attempted = true;
    await rename(temporary, scoped.path);
    await scoped.directory.sync();
    return `Replaced the reviewed text in ${input.data.path}`;
  } catch (error) {
    if (attempted)
      throw Object.assign(new Error("The file write needs exact content reconciliation"), {
        outcomeUnknown: true,
        cause: error,
      });
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
    await scoped.directory.close();
  }
}

export async function localActionEvidence(root: string | undefined, input: LocalAction) {
  try {
    const { text, scoped } = await readScoped(root, input.data.path);
    await scoped.directory.close();
    const current = textHash(text);
    if (current === textHash(input.data.replacementText)) return "completed" as const;
    if (current === input.data.expectedSha256) return "not_completed" as const;
  } catch {
    /* Missing or unsafe target leaves the outcome unknown. */
  }
  return "unknown" as const;
}
