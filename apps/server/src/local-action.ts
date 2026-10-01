import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, realpath, rm, statfs, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
      leaf: parts.at(-1) ?? "",
      canonical: resolve(base, path),
      parent: expectedParent,
    };
  } catch {
    await directory?.close();
    throw new AppError("The named file is outside the scoped resource", 422);
  }
}

type Scoped = Awaited<ReturnType<typeof scopedFile>>;
function evidenceName(actionId: string) {
  if (!/^[a-f0-9-]{36,64}$/.test(actionId)) throw new AppError("Invalid action reference", 422);
  return `.openmuse-review-${actionId}.swap`;
}
function evidencePath(scoped: Scoped, actionId: string) {
  return `/proc/self/fd/${scoped.directory.fd}/${evidenceName(actionId)}`;
}
async function evidenceHash(scoped: Scoped, actionId: string): Promise<string | null> {
  const path = evidencePath(scoped, actionId);
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

async function exchange(directory: Awaited<ReturnType<typeof open>>, from: string, to: string) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/mv",
      ["--exchange", "--no-copy", "--", `/proc/self/fd/3/${from}`, `/proc/self/fd/3/${to}`],
      {
        env: { LC_ALL: "C" },
        stdio: ["ignore", "ignore", "ignore", directory.fd],
      },
    );
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? -1));
  });
  if (code !== 0) throw new Error("Atomic file exchange was not confirmed");
}

let exchangeProbe: Promise<boolean> | undefined;
export function atomicExchangeAvailable() {
  exchangeProbe ??= (async () => {
    if (process.platform !== "linux") return false;
    let folder: string;
    try {
      folder = await mkdtemp(join(tmpdir(), "openmuse-exchange-"));
    } catch {
      return false;
    }
    try {
      await writeFile(join(folder, "a"), "A");
      await writeFile(join(folder, "b"), "B");
      const directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await exchange(directory, "a", "b");
      } finally {
        await directory.close();
      }
      return (
        (await readFile(join(folder, "a"), "utf8")) === "B" &&
        (await readFile(join(folder, "b"), "utf8")) === "A"
      );
    } catch {
      return false;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  })();
  return exchangeProbe;
}

async function supportedExchangeFilesystem(path: string) {
  // Fail closed on filesystems where renameat2(RENAME_EXCHANGE) support is not established.
  const type = (await statfs(path)).type;
  return new Set([0x9123683e, 0xef53, 0x58465342, 0x01021994, 0x794c7630]).has(type);
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
  try {
    if (!(await atomicExchangeAvailable()) || !(await supportedExchangeFilesystem(scoped.parent)))
      throw new AppError(
        "Atomic local replacement is unavailable. Keep the Bot result as text.",
        503,
      );
  } finally {
    await scoped.directory.close();
  }
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
  beforeExchange?: () => Promise<void>,
) {
  const { text, scoped, info } = await readScoped(root, input.data.path);
  let evidence = "";
  let attempted = false;
  let prepared = false;
  try {
    if (!(await atomicExchangeAvailable()) || !(await supportedExchangeFilesystem(scoped.parent)))
      throw new AppError("Atomic local replacement is unavailable", 503);
    evidence = evidencePath(scoped, actionId);
    if (textHash(text) !== input.data.expectedSha256)
      throw new AppError("The named file changed. No replacement was made.", 409);
    const replacement = await open(
      evidence,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      info.mode & 0o777,
    );
    prepared = true;
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
    await beforeExchange?.();
    attempted = true;
    await exchange(scoped.directory, evidenceName(actionId), scoped.leaf);
    await scoped.directory.sync();
    if (
      (await evidenceHash(scoped, actionId)) !== input.data.expectedSha256 ||
      textHash((await readCurrent(scoped)).text) !== textHash(input.data.replacementText)
    )
      throw new Error("Exact before and after file evidence was not confirmed");
    return `Replaced the reviewed text in ${input.data.path}`;
  } catch (error) {
    if (attempted)
      throw Object.assign(
        new Error(
          `The file write needs exact content reconciliation. Displaced content is preserved as ${evidenceName(actionId)} beside the named file.`,
        ),
        {
          outcomeUnknown: true,
          cause: error,
        },
      );
    throw error;
  } finally {
    if (prepared && !attempted) await unlink(evidence).catch(() => undefined);
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
      displaced = await evidenceHash(scoped, actionId);
    } finally {
      await scoped.directory.close();
    }
    const current = textHash(text);
    const after = textHash(input.data.replacementText);
    if (current === after && displaced === input.data.expectedSha256) return "completed" as const;
    // The original bytes on the named path cannot prove the exchange never ran:
    // a later writer could have restored them from the displaced .swap inode.
  } catch {
    /* Missing or unsafe target leaves the outcome unknown. */
  }
  return "unknown" as const;
}

export async function clearLocalActionEvidence(
  root: string | undefined,
  input: LocalAction,
  actionId: string,
) {
  const scoped = await scopedFile(root, input.data.path);
  try {
    const evidence = await evidenceHash(scoped, actionId);
    if (evidence === input.data.expectedSha256 || evidence === textHash(input.data.replacementText))
      await unlink(evidencePath(scoped, actionId));
  } finally {
    await scoped.directory.close();
  }
}
