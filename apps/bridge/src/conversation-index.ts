import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const idsSchema = z.array(z.string().regex(/^om_[a-f0-9]{32}$/)).max(10000);
/** Discovery index only: messages, titles and archive state remain authoritative in Hermes.
 * Hermes's list endpoint omits archived rows; retaining IDs makes them discoverable.
 * One bridge process owns a data directory. Writes within it are serialized and atomic.
 */
export class ConversationIndex {
  private pending = Promise.resolve();
  constructor(private readonly directory: string) {}
  async ids(): Promise<string[]> {
    await this.pending;
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
    const operation = this.pending.then(async () => {
      const before = await this.read();
      const merged = idsSchema.parse([...new Set([...before, ...ids])].sort());
      if (JSON.stringify(before) === JSON.stringify(merged)) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = join(this.directory, "conversation-ids.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(merged), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    });
    this.pending = operation.catch(() => {});
    await operation;
  }
}
