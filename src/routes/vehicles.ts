import type { FastifyInstance } from "fastify";
import { requireUser } from "../auth.ts";
import { one, q } from "../db.ts";
import { defaultDiagram, diagramUrl, readDiagram } from "../diagrams.ts";
import { idParam, notFound } from "../http.ts";

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

export default async function vehicleRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req) => {
    requireUser(req);
  });

  app.get("/vehicles", async () => vehicleRows());

  app.get("/vehicles/:id", async (req) => {
    const id = idParam(req.params);
    const [vehicle] = await vehicleRows("WHERE vs.id = $1", [id]);
    if (!vehicle) throw notFound("Truck not found.");
    const openRepairs = await q(
      `SELECT ii.id, ii.section, ii.label_snapshot AS label, ii.note, i.id AS inspection_id, i.inspection_date
         FROM inspection_items ii JOIN inspections i ON i.id = ii.inspection_id
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
         FROM inspections i WHERE i.vehicle_id = $1
        ORDER BY i.inspection_date DESC, i.created_at DESC LIMIT 200`,
      [id],
    );
    return { vehicle, openRepairs, history };
  });

  // Previous inspection: prefills notes and shows its pins as grey dots on the new form.
  app.get("/vehicles/:id/last", async (req) => {
    const id = idParam(req.params);
    const last = await one(
      `SELECT id, inspection_date, existing_notes, new_observations, mileage,
              trailer_inspected, trailer_number_text, trailer_plate_text, truck_diagram_id, trailer_diagram_id
         FROM inspections WHERE vehicle_id = $1
        ORDER BY inspection_date DESC, created_at DESC LIMIT 1`,
      [id],
    );
    if (!last) return { inspection: null, damage: [] };
    // Old pins only make sense on the same picture: skip them if the truck's diagram or trailer type changed.
    const [now] = await vehicleRows("WHERE vs.id = $1", [id]);
    const same = (kind: string) => kind === "truck"
      ? !last.truck_diagram_id || last.truck_diagram_id === now?.diagram_id
      : !last.trailer_diagram_id || last.trailer_diagram_id === now?.trailer_diagram_id;
    const marks = await q(`SELECT diagram, seq, x, y, note FROM damage_marks WHERE inspection_id = $1 ORDER BY diagram, seq`, [last.id]);
    const { truck_diagram_id: _t, trailer_diagram_id: _r, ...inspection } = last;
    return { inspection, damage: marks.filter((m) => same(m.diagram)) };
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
