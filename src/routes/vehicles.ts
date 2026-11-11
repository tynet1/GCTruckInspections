import type { FastifyInstance } from "fastify";
import { requireRole, requireUser } from "../auth.ts";
import { one, q, tx } from "../db.ts";
import { defaultDiagram, diagramUrl, readDiagram } from "../diagrams.ts";
import { bad, conflict, HttpError, idParam, notFound, obj, reqStr, UUID_RE } from "../http.ts";

const VEHICLE_COLS = `
  vs.id, vs.truck_code, vs.unit, vs.vin, vs.plate, vs.year, vs.make, vs.model,
  vs.registration_expires, vs.registration_expired, vs.pulls_trailer,
  vs.last_inspection_id, vs.last_inspection_date, vs.last_status, vs.last_mileage, vs.open_repairs,
  d.id AS diagram_id, d.file_path AS diagram_path,
  td.id AS trailer_diagram_id, td.file_path AS trailer_path, td.name AS trailer_type`;

/**
 * Trucks as the app shows them. diagram_id / trailer_diagram_id are the pictures the form uses
 * (the truck's own, or the default when none is set); trailer_type is null when the truck has no trailer.
 */
export async function vehicleRows(where = "", params: unknown[] = []) {
  const truckDefault = await defaultDiagram("truck");
  const trailerDefault = await defaultDiagram("trailer");
  const rows = await q(
    `SELECT ${VEHICLE_COLS} FROM vehicle_status vs
       LEFT JOIN diagrams d ON d.id = vs.diagram_id
       LEFT JOIN diagrams td ON td.id = vs.trailer_diagram_id
     ${where}
     ORDER BY vs.truck_code`,
    params,
  );
  return rows.map(({ diagram_id, diagram_path, trailer_diagram_id, trailer_path, ...v }) => {
    const truck = diagram_id ? { id: diagram_id, file_path: diagram_path } : truckDefault;
    const trailer = trailer_diagram_id ? { id: trailer_diagram_id, file_path: trailer_path } : trailerDefault;
    return {
      ...v,
      diagram_id: truck?.id ?? null,
      diagram_url: diagramUrl(truck?.id ?? null, truck?.file_path ?? null),
      trailer_diagram_id: trailer?.id ?? null,
      trailer_diagram_url: diagramUrl(trailer?.id ?? null, trailer?.file_path ?? null),
    };
  });
}

export interface DamageMark {
  id: number;
  n: number;                 // 1, 2, 3… per picture (truck / trailer), oldest first; stays the same as more is added
  diagram: "truck" | "trailer";
  seq: number;               // its number on the inspection it was marked on
  x: number;
  y: number;
  note: string | null;
  inspection_id: string;
  inspection_date: string;
  trailer_number: string | null;
  on_current_diagram: boolean; // false if the truck's picture (or trailer type) changed since, so it can't be drawn
  photos: { id: string; caption: string | null }[];
  repair: DamageRepair | null; // set while it's marked repaired (it's then off the form's grey dots)
}

export interface DamageRepair {
  id: number;
  repaired_at: string;
  repaired_by_name: string;
  note: string | null;
  service_log_id: number | null; // fixed through this maintenance entry; null = marked repaired by a supervisor
  photos: { id: string; caption: string | null }[]; // the fixed area
}

/**
 * Every damage mark ever recorded on this truck, oldest first. Crews only mark new damage on each inspection,
 * so the truck's damage on file is all of these together, not just the last inspection's.
 */
export async function damageHistory(vehicleId: number, current: { diagram_id: number | null; trailer_diagram_id: number | null }) {
  const marks = await q(
    `SELECT dm.id, dm.diagram, dm.seq, dm.x, dm.y, dm.note, i.id AS inspection_id, i.inspection_date,
            i.trailer_number_text AS trailer_number,
            CASE WHEN dm.diagram = 'truck' THEN i.truck_diagram_id ELSE i.trailer_diagram_id END AS drawn_on
       FROM damage_marks dm JOIN live_inspections i ON i.id = dm.inspection_id
      WHERE i.vehicle_id = $1
      ORDER BY i.inspection_date, i.created_at, dm.seq`,
    [vehicleId],
  );
  const photos = await q(
    `SELECT p.id, p.caption, p.damage_mark_id
       FROM photos p JOIN damage_marks dm ON dm.id = p.damage_mark_id JOIN live_inspections i ON i.id = dm.inspection_id
      WHERE i.vehicle_id = $1 ORDER BY p.created_at, p.id`,
    [vehicleId],
  );
  const repairs = await q(
    `SELECT dr.id, dr.damage_mark_id, dr.repaired_at, dr.note, dr.service_log_id, u.name AS repaired_by_name
       FROM damage_repairs dr
       JOIN users u ON u.id = dr.repaired_by
       JOIN damage_marks dm ON dm.id = dr.damage_mark_id
       JOIN live_inspections i ON i.id = dm.inspection_id
      WHERE i.vehicle_id = $1 AND dr.active`,
    [vehicleId],
  );
  const repairPhotos = repairs.length
    ? await q(`SELECT id, caption, damage_repair_id FROM photos WHERE damage_repair_id = ANY($1::int[]) ORDER BY created_at, id`,
      [repairs.map((r) => r.id)])
    : [];
  const count = { truck: 0, trailer: 0 };
  return marks.map(({ drawn_on, ...m }): DamageMark => {
    const now = m.diagram === "truck" ? current.diagram_id : current.trailer_diagram_id;
    const r = repairs.find((x) => x.damage_mark_id === m.id);
    return {
      ...m,
      n: ++count[m.diagram as "truck" | "trailer"],
      on_current_diagram: !drawn_on || drawn_on === now,
      photos: photos.filter((p) => p.damage_mark_id === m.id).map(({ damage_mark_id: _d, ...p }) => p),
      repair: r
        ? {
          id: r.id, repaired_at: r.repaired_at, repaired_by_name: r.repaired_by_name, note: r.note, service_log_id: r.service_log_id,
          photos: repairPhotos.filter((p) => p.damage_repair_id === r.id).map(({ damage_repair_id: _d, ...p }) => p),
        }
        : null,
    };
  });
}

/**
 * A supervisor marks damage on file repaired: a note and at least one photo of the fixed area are required.
 * Idempotent on client_id. The shop does the same through the maintenance log (Log fix) instead.
 */
async function markRepaired(markId: number, userId: number, body: unknown) {
  const b = obj(body);
  const clientId = String(b.client_id ?? "").toLowerCase();
  if (!UUID_RE.test(clientId)) throw bad("client_id must be a uuid.");
  const note = reqStr(b.note, "What was done", 1000);
  if (!Array.isArray(b.photo_ids) || !b.photo_ids.length) throw bad("Add a photo of the fixed area.");
  if (b.photo_ids.length > 10) throw bad("Too many photos.");
  const photoIds = [...new Set(b.photo_ids.map((x) => String(x).toLowerCase()))];
  if (photoIds.some((id) => !UUID_RE.test(id))) throw bad("Each photo needs an id.");

  const dup = await one(`SELECT id FROM damage_repairs WHERE client_id = $1`, [clientId]);
  if (dup) return { id: dup.id, duplicate: true };
  const ready = await q(
    `SELECT id FROM photos WHERE id = ANY($1::uuid[]) AND uploaded_by = $2
        AND inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL`,
    [photoIds, userId],
  );
  const missing = photoIds.filter((id) => !ready.some((r) => r.id === id));
  if (missing.length) throw new HttpError(422, "The photo hasn't finished uploading yet.", { code: "photos_missing", photos: missing });

  return tx(async (c) => {
    const m = (await c.query(
      `SELECT dm.id, EXISTS (SELECT 1 FROM inspection_states s WHERE s.inspection_id = dm.inspection_id AND s.state <> 'active') AS hidden
         FROM damage_marks dm WHERE dm.id = $1 FOR UPDATE`,
      [markId],
    )).rows[0];
    if (!m || m.hidden) throw notFound("That damage isn't on file.");
    const ins = await c.query(
      `INSERT INTO damage_repairs (client_id, damage_mark_id, note, repaired_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING RETURNING id`,
      [clientId, markId, note, userId],
    );
    if (!ins.rows[0]) {
      const again = (await c.query(`SELECT id FROM damage_repairs WHERE client_id = $1`, [clientId])).rows[0];
      if (again) return { id: again.id, duplicate: true };
      throw conflict("That damage is already marked repaired.");
    }
    const id: number = ins.rows[0].id;
    for (const p of photoIds) {
      const r = await c.query(
        `UPDATE photos SET damage_repair_id = $2 WHERE id = $1 AND uploaded_by = $3
            AND inspection_id IS NULL AND service_log_id IS NULL AND damage_repair_id IS NULL`,
        [p, id, userId],
      );
      if (r.rowCount !== 1) throw conflict("A photo couldn't be attached. Add it again.");
    }
    return { id, duplicate: false };
  });
}

/** Undo a supervisor's "mark repaired" (a mistake). Nothing is erased: the repair is ended with a reason. */
async function undoRepair(repairId: number, userId: number, body: unknown) {
  const reason = reqStr(obj(body ?? {}).reason, "Reason", 500);
  const r = await one(`SELECT service_log_id, active FROM damage_repairs WHERE id = $1`, [repairId]);
  if (!r) throw notFound("Repair not found.");
  if (r.service_log_id) throw conflict("This was fixed through a maintenance entry. Void that entry to put the damage back on file.");
  const u = await one(
    `UPDATE damage_repairs SET active = false, ended_at = now(), ended_by = $2, end_reason = $3
      WHERE id = $1 AND active RETURNING id`,
    [repairId, userId, `Undone: ${reason}`],
  );
  if (!u) throw conflict("That repair was already undone.");
  return { ok: true };
}

export default async function vehicleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req) => {
    requireUser(req);
  });

  app.get("/vehicles", async () => vehicleRows());

  // Damage on file: mark repaired (supervisor+, photo required) and undo that.
  app.post("/damage-marks/:id/repair", { preHandler: requireRole("supervisor") }, async (req, reply) => {
    const out = await markRepaired(idParam(req.params), req.user!.id, req.body);
    return reply.code(out.duplicate ? 200 : 201).send(out);
  });
  app.post("/damage-repairs/:id/undo", { preHandler: requireRole("supervisor") }, async (req) =>
    undoRepair(idParam(req.params), req.user!.id, req.body));

  app.get("/vehicles/:id", async (req) => {
    const id = idParam(req.params);
    const [vehicle] = await vehicleRows("WHERE vs.id = $1", [id]);
    if (!vehicle) throw notFound("Truck not found.");
    const openRepairs = await q(
      `SELECT ii.id, ii.section, ii.label_snapshot AS label, ii.note, i.id AS inspection_id, i.inspection_date
         FROM inspection_items ii JOIN live_inspections i ON i.id = ii.inspection_id
        WHERE i.vehicle_id = $1 AND ii.result = 'repair' AND ii.resolved_at IS NULL
        ORDER BY i.inspection_date DESC, i.created_at DESC, ii.section, ii.id`,
      [id],
    );
    const history = await q(
      `SELECT i.id, i.inspection_date, i.inspector_name, i.mileage, i.status, i.mileage_flagged,
              (SELECT count(*) FROM inspection_items ii WHERE ii.inspection_id = i.id AND ii.result = 'repair') AS repair_count,
              (SELECT count(*) FROM inspection_items ii
                WHERE ii.inspection_id = i.id AND ii.result = 'repair' AND ii.resolved_at IS NULL) AS open_repair_count,
              (SELECT count(*) FROM damage_marks dm WHERE dm.inspection_id = i.id) AS damage_count
         FROM live_inspections i WHERE i.vehicle_id = $1
        ORDER BY i.inspection_date DESC, i.created_at DESC LIMIT 200`,
      [id],
    );
    const archived = await one<{ n: number }>(
      `SELECT count(*) AS n FROM inspection_states s JOIN inspections i ON i.id = s.inspection_id
        WHERE i.vehicle_id = $1 AND s.state = 'archived'`,
      [id],
    );
    const damage = await damageHistory(id, vehicle);
    return { vehicle, openRepairs, history, archived_count: archived?.n ?? 0, damage };
  });

  // Previous inspection prefills the notes; all damage on file shows as grey dots on the new form.
  // Archived and deleted inspections don't count for either.
  app.get("/vehicles/:id/last", async (req) => {
    const id = idParam(req.params);
    const last = await one(
      `SELECT id, inspection_date, existing_notes, new_observations, mileage,
              trailer_inspected, trailer_number_text, trailer_plate_text
         FROM live_inspections WHERE vehicle_id = $1
        ORDER BY inspection_date DESC, created_at DESC LIMIT 1`,
      [id],
    );
    if (!last) return { inspection: null, damage: [] };
    const [now] = await vehicleRows("WHERE vs.id = $1", [id]);
    if (!now) throw notFound("Truck not found.");
    // Old pins only make sense on the same picture: skip any drawn on a diagram the truck no longer uses,
    // and any marked repaired.
    const damage = (await damageHistory(id, now))
      .filter((m) => m.on_current_diagram && !m.repair)
      .map(({ photos: _p, on_current_diagram: _c, repair: _r, ...m }) => m);
    return { inspection: last, damage };
  });

  // Everything the inspection form needs that isn't truck-specific.
  app.get("/form-config", async () => {
    const checklist = await q(
      `SELECT id, section, label, sort_order FROM checklist_items WHERE active ORDER BY section, sort_order`,
    );
    const trailer = await defaultDiagram("trailer");
    return { checklist, trailer_diagram_url: diagramUrl(trailer?.id ?? null, trailer?.file_path ?? null) };
  });

  app.get("/diagrams", async () => {
    const rows = await q(`SELECT id, kind, name, file_path FROM diagrams ORDER BY kind, name`);
    return rows.map(({ file_path, ...d }) => ({ ...d, url: diagramUrl(d.id, file_path) }));
  });

  app.get("/diagrams/:id/image", async (req, reply) => {
    const d = await one(`SELECT file_path FROM diagrams WHERE id = $1`, [idParam(req.params)]);
    if (!d) throw notFound();
    const { data, mime } = await readDiagram(d.file_path);
    return reply.type(mime).header("cache-control", "private, max-age=86400").send(data);
  });
}
