/**
 * @file server/src/routes/notes.ts
 * @description
 *   Notes routes — the template's first PROTECTED endpoints. The data store
 *   is INJECTED (createApp options.db) so tests run the full chain
 *   (signature verify → handler → store → response) without a database;
 *   production wires the Prisma-backed store (the platform DB standard).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal data port the handler consumes (Prisma-backed in production). */
export interface NotesStore {
  list(): Promise<NoteRow[]>;
  create(input: { title: string; body: string }): Promise<NoteRow>;
}

/** Lazy Prisma-backed store — importing @prisma/client only on first use
 * keeps unit tests (which inject their own store) free of a generated client. */
export function createPrismaNotesStore(): NotesStore {
  return {
    async list() {
      const { getPrisma } = await import('../db.js');
      const prisma = await getPrisma();
      return prisma.note.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    },
    async create(input) {
      const { getPrisma } = await import('../db.js');
      const prisma = await getPrisma();
      return prisma.note.create({ data: { title: input.title, body: input.body } });
    },
  };
}

function toNote(row: NoteRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** GET /api/notes — permission: app-template.notes:read (ADR-007; enforced
 * app-side once the membership source is wired, see README). */
export function listNotesHandler(store: NotesStore): RequestHandler {
  return async (_req: Request, res: Response, _next: NextFunction) => {
    const rows = await store.list();
    res.json({ notes: rows.map(toNote) });
  };
}

/** POST /api/notes — permission: app-template.notes:write. */
export function createNoteHandler(store: NotesStore): RequestHandler {
  return async (req: Request, res: Response, _next: NextFunction) => {
    const { title, body } = (req.body ?? {}) as { title?: unknown; body?: unknown };
    if (typeof title !== 'string' || title.trim() === '' || typeof body !== 'string') {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION_FAILED', message: 'title and body are required', status: 422 } });
      return;
    }
    const row = await store.create({ title: title.trim(), body });
    res.status(201).json({ note: toNote(row) });
  };
}
