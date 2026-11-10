import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { one } from "./db.ts";
import { files, isKey } from "./storage.ts";

/**
 * diagrams.file_path is either a bundled image under public/ ("diagrams/az018-truck.jpg")
 * or a storage key for an image an admin uploaded ("2026/11/<uuid>.jpg").
 */
export function diagramUrl(id: number | null, filePath: string | null): string | null {
  if (!id || !filePath) return null;
  if (filePath.startsWith("diagrams/")) return "/" + filePath;
  return `/api/diagrams/${id}/image`;
}

export async function readDiagram(filePath: string): Promise<{ data: Buffer; mime: string }> {
  const mime = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
  if (filePath.startsWith("diagrams/") && /^diagrams\/[\w.-]+\.(jpg|png)$/.test(filePath)) {
    return { data: await readFile(join(config.publicDir, filePath)), mime };
  }
  if (isKey(filePath)) return { data: await files.read(filePath), mime };
  throw new Error(`Bad diagram path ${filePath}`);
}

/** The diagram used when a truck has none set, and the trailer diagram. */
export async function defaultDiagram(kind: "truck" | "trailer"): Promise<{ id: number; file_path: string } | undefined> {
  return one(`SELECT id, file_path FROM diagrams WHERE kind = $1 ORDER BY id LIMIT 1`, [kind]);
}
