import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const idsSchema = z.array(z.string().regex(/^om_[a-f0-9]{32}$/)).max(10000);
const writes = new Map<string, Promise<void>>();
/** Owned-session registry: IDs are recorded only after this bridge creates a session.
 * Never auto-enroll upstream list results. Messages and state stay authoritative in Hermes.
 * One bridge process owns a data directory. Writes within it are serialized and atomic.
 */
export class ConversationIndex {
  private readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  async ids(): Promise<string[]> {
    await writes.get(this.directory);
    return this.read();
  }
  private async read(): Promise<string[]> {
    try {
      return idsSchema.parse(
        JSON.parse(await readFile(join(this.directory, "conversation-ids.json"), "utf8")),
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return [];
      throw new Error("Conversation index is unavailable");
    }
  }
  async remember(ids: string[]): Promise<void> {
    const operation = (writes.get(this.directory) || Promise.resolve()).then(async () => {
      const before = await this.read();
      const merged = idsSchema.parse([...new Set([...before, ...ids])].sort());
      if (JSON.stringify(before) === JSON.stringify(merged)) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, "conversation-ids.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(merged), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    });
    const settled = operation.catch(() => {});
    writes.set(this.directory, settled);
    void settled.then(() => {
      if (writes.get(this.directory) === settled) writes.delete(this.directory);
    });
    await operation;
  }
}
