import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.ts";
import { config } from "../config.ts";
import { one, q } from "../db.ts";
import { bad, conflict, notFound, UUID_RE, uuidParam } from "../http.ts";
import { files, imageType, newKey } from "../storage.ts";

export default async function photoRoutes(app: FastifyInstance) {
  /**
   * Upload one photo before the inspection is submitted. The phone picks the photo's uuid,
   * so a retried upload of the same photo is a no-op instead of a duplicate.
   * multipart fields: id (uuid) first, then file.
   */
  app.post("/photos", async (req, reply) => {
    const user = requireUser(req);
    const part = await req.file({ limits: { fileSize: config.photo.maxBytes, files: 1 } });
    if (!part) throw bad("No photo was sent.");
    const idField = part.fields.id as { value?: unknown } | undefined;
    const id = typeof idField?.value === "string" ? idField.value.toLowerCase() : "";
    if (!UUID_RE.test(id)) throw bad("Photo id must be a uuid.");

    const data = await part.toBuffer();
    if (part.file.truncated) throw bad("Photo is too large.");
    const type = imageType(data);
    if (!type) throw bad("That file isn't a JPEG or PNG photo.");

    const existing = await one(`SELECT id, uploaded_by FROM photos WHERE id = $1`, [id]);
    if (existing) {
      if (existing.uploaded_by !== user.id) throw conflict("Photo id already used.");
      return reply.code(200).send({ id });
    }
    const key = newKey(type.ext, id);
    await files.put(key, data);
    await q(
      `INSERT INTO photos (id, file_path, content_type, bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [id, key, type.mime, data.length, user.id],
    );
    return reply.code(201).send({ id });
  });

  app.get("/photos/:id", async (req, reply) => {
    requireUser(req);
    const p = await one(`SELECT file_path, content_type FROM photos WHERE id = $1`, [uuidParam(req.params)]);
    if (!p) throw notFound("Photo not found.");
    return reply
      .type(p.content_type)
      .header("cache-control", "private, max-age=31536000, immutable")
      .send(files.stream(p.file_path));
  });
}

/**
 * Delete photos that were uploaded but never attached to an inspection or a maintenance entry.
 * (A phone that was offline longer than this still has the photo and uploads it again.)
 */
export async function cleanupOrphanPhotos(log: (m: string) => void): Promise<void> {
  const rows = await q(
    `DELETE FROM photos
      WHERE inspection_id IS NULL AND service_log_id IS NULL AND created_at < now() - make_interval(days => $1)
     RETURNING file_path`,
    [config.photo.orphanDays],
  );
  for (const r of rows) await files.remove(r.file_path).catch(() => {});
  if (rows.length) log(`removed ${rows.length} orphan photo(s)`);
}
