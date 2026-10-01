import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, rename, unlink } from "node:fs/promises";
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
function backupPath(scoped: Scoped, actionId: string) {
  if (!/^[a-f0-9-]{36,64}$/.test(actionId)) throw new AppError("Invalid action reference", 422);
  return `/proc/self/fd/${scoped.directory.fd}/.openmuse-review-${actionId}.before`;
}
async function backupHash(scoped: Scoped, actionId: string): Promise<string | null> {
  const path = backupPath(scoped, actionId);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("Invalid file evidence");
    const bytes = await handle.readFile();
    if (bytes.length > 64 * 1024) throw new Error("Invalid file evidence");
    return textHash(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await handle.close();
  }
}
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
  actionId: string,
  beforeFinalCheck?: () => Promise<void>,
  beforeRename?: () => Promise<void>,
) {
  const { text, scoped, info } = await readScoped(root, input.data.path);
  const temporary = `/proc/self/fd/${scoped.directory.fd}/.openmuse-${randomUUID()}`;
  let backup = "";
  let attempted = false;
  let linked = false;
  try {
    backup = backupPath(scoped, actionId);
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
    // A hard link keeps the displaced inode available if another process edits it during commit.
    await link(scoped.path, backup);
    linked = true;
    const original = await open(backup, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const held = await original.stat();
      if (
        held.ino !== info.ino ||
        held.dev !== info.dev ||
        (await backupHash(scoped, actionId)) !== input.data.expectedSha256
      )
        throw new AppError("The named file changed. No replacement was made.", 409);
    } finally {
      await original.close();
    }
    await beforeFinalCheck?.();
    const current = await readCurrent(scoped);
    if (
      current.info.ino !== info.ino ||
      current.info.dev !== info.dev ||
      textHash(current.text) !== input.data.expectedSha256
    )
      throw new AppError("The named file changed. No replacement was made.", 409);
    await beforeRename?.();
    attempted = true;
    await rename(temporary, scoped.path);
    await scoped.directory.sync();
    if ((await backupHash(scoped, actionId)) !== input.data.expectedSha256)
      throw new Error("The displaced file changed during replacement");
    return `Replaced the reviewed text in ${input.data.path}`;
  } catch (error) {
    if (attempted)
      throw Object.assign(
        new Error(
          `The file write needs exact content reconciliation. Displaced content is preserved as .openmuse-review-${actionId}.before beside the named file.`,
        ),
        {
          outcomeUnknown: true,
          cause: error,
        },
      );
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
    if (linked && !attempted) await unlink(backup).catch(() => undefined);
    await scoped.directory.close();
  }
}

export async function localActionEvidence(
  root: string | undefined,
  input: LocalAction,
  actionId: string,
) {
  try {
    const { text, scoped } = await readScoped(root, input.data.path);
    let displaced: string | null;
    try {
      displaced = await backupHash(scoped, actionId);
    } finally {
      await scoped.directory.close();
    }
    const current = textHash(text);
    if (displaced !== null && displaced !== input.data.expectedSha256) return "unknown" as const;
    if (current === textHash(input.data.replacementText) && displaced === input.data.expectedSha256)
      return "completed" as const;
    if (current === input.data.expectedSha256) return "not_completed" as const;
  } catch {
    /* Missing or unsafe target leaves the outcome unknown. */
  }
  return "unknown" as const;
}

export async function clearLocalActionBackup(
  root: string | undefined,
  input: LocalAction,
  actionId: string,
) {
  const scoped = await scopedFile(root, input.data.path);
  try {
    if ((await backupHash(scoped, actionId)) === input.data.expectedSha256)
      await unlink(backupPath(scoped, actionId));
  } finally {
    await scoped.directory.close();
  }
}
