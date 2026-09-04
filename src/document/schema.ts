import { z } from "zod";

const id = z.string().regex(/^[A-Za-z_][\w-]*$/, "identifier: letters, digits, _ and -");

export const PeekSchema = z
  .object({
    file: z.string().min(1),
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    graph: z.enum(["head", "base"]).default("head"),
  })
  .strict()
  .refine((p) => p.to >= p.from, { message: "to must be >= from" });

export const AnchorSchema = z
  .object({
    title: z.string().min(1),
    detail: z.string().optional(),
    map: z.string().optional(),
    peek: PeekSchema.optional(),
  })
  .strict();

export const ActorSchema = z
  .object({ label: z.string().min(1), map: z.string().optional() })
  .strict();

const FieldSchema = z.object({ type: z.string().min(1), pk: z.boolean().optional() }).strict();
const CollectionSchema = z
  .object({
    label: z.string().optional(),
    key: z.string().optional(),
    schema: z.record(z.string(), FieldSchema),
  })
  .strict();

export const StoreSchema = z
  .object({
    kind: z.enum(["relational", "document"]),
    label: z.string().min(1),
    tables: z.record(z.string(), CollectionSchema).optional(),
    documents: z.record(z.string(), CollectionSchema).optional(),
  })
  .strict()
  .refine((s) => (s.kind === "relational" ? !!s.tables : !!s.documents), {
    message: "relational stores need tables, document stores need documents",
  });

export const DataSchema = z
  .object({
    actors: z.record(id, ActorSchema).default({}),
    anchors: z.record(id, AnchorSchema).default({}),
    stores: z.record(id, StoreSchema).default({}),
  })
  .strict();

export type Data = z.infer<typeof DataSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Peek = z.infer<typeof PeekSchema>;
export type Store = z.infer<typeof StoreSchema>;

// Fenced component blocks in review.md

const ActorRef = z.union([id, z.object({ label: z.string().min(1) }).strict()]);

export const SequenceSchema = z
  .object({
    label: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            from: ActorRef,
            to: ActorRef,
            label: z.string().min(1),
            anchor: id.optional(),
            code: z
              .union([
                z.string(),
                z.object({ language: z.string().optional(), text: z.string() }).strict(),
              ])
              .optional(),
          })
          .strict()
          .refine((m) => m.anchor || m.code, { message: "each message needs an anchor or code" }),
      )
      .min(1),
  })
  .strict();

const Frame = z.union([
  id,
  z.object({ calls: z.tuple([id, id]), reason: z.string().optional() }).strict(),
]);

export const CallstackSchema = z
  .object({
    title: z.string().optional(),
    base: z.array(Frame).default([]),
    head: z.array(Frame).default([]),
  })
  .strict();

export const DatabaseSchema = z
  .object({
    title: z.string().optional(),
    stores: z.array(id).min(1),
    usecases: z
      .array(
        z
          .object({
            id: id,
            label: z.string().min(1),
            summary: z.string().optional(),
            ops: z
              .array(
                z
                  .object({
                    op: z.enum(["read", "write"]),
                    store: z.string().min(1),
                    actor: id,
                    label: z.string().min(1),
                    anchor: id,
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const PeekBlockSchema = z.object({ anchor: id }).strict();

// map.yaml

export const MapNodeSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/, "dot path"),
    kind: z.enum(["person", "system", "container", "component", "code"]),
    label: z.string().min(1),
    description: z.string().optional(),
    files: z.array(z.string()).optional(),
    anchor: z.string().optional(),
  })
  .strict();

export const MapEdgeSchema = z
  .object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })
  .strict();

const MapGraph = z
  .object({ nodes: z.array(MapNodeSchema), edges: z.array(MapEdgeSchema).default([]) })
  .strict();

export const MapSchema = MapGraph.extend({ base: MapGraph.optional() }).strict();

export type MapFile = z.infer<typeof MapSchema>;
export type MapNode = z.infer<typeof MapNodeSchema>;
export type MapEdge = z.infer<typeof MapEdgeSchema>;
