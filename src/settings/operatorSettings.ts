import { mkdir, readFile, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { logger } from "../logging/logger.js";

export const defaultHandoffMessage =
  "Voy a pasar tu conversación a una persona del equipo. La respuesta puede tardar un poco, pero tu mensaje quedó registrado y no lo vamos a perder.";

export const operatorSettingsSchema = z.object({
  handoffMessage: z.string().trim().min(1).max(1600)
});

export type OperatorSettings = z.infer<typeof operatorSettingsSchema>;

export class OperatorSettingsManager {
  private settings: OperatorSettings = { handoffMessage: defaultHandoffMessage };
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly filePath: string,
    private readonly onEvent?: (event: { type: "loaded" | "invalid"; message?: string }) => void
  ) {}

  async start() {
    const absolutePath = resolve(this.filePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await readFile(absolutePath, "utf8");
    } catch {
      await writeFile(absolutePath, `${JSON.stringify(this.settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx"
      }).catch(() => undefined);
    }
    await this.reload();
    this.watcher = watch(dirname(absolutePath), (_event, filename) => {
      if (filename?.toString() !== absolutePath.split(/[\\/]/).at(-1)) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reload(), 75);
    });
  }

  stop() {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.watcher?.close();
  }

  get current(): OperatorSettings {
    return { ...this.settings };
  }

  async reload() {
    try {
      const raw = await readFile(resolve(this.filePath), "utf8");
      const parsed = operatorSettingsSchema.parse(JSON.parse(raw));
      this.settings = parsed;
      logger.info("Operator settings loaded", { path: resolve(this.filePath) });
      this.onEvent?.({ type: "loaded" });
      return { ok: true as const, settings: this.current };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Operator settings are invalid; retaining last valid configuration", {
        path: resolve(this.filePath),
        error: message
      });
      this.onEvent?.({ type: "invalid", message });
      return { ok: false as const, error: message, settings: this.current };
    }
  }
}
