import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { authMiddleware, requireRole } from '../auth.js';
import { db } from '../db.js';

const router = Router();

const UPLOAD_DIR = process.env.NEXOMOCHIS_UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
]);

if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (extname(file.originalname) || '').toLowerCase().slice(0, 8);
    const hash = randomBytes(8).toString('hex');
    const ts = Date.now().toString(36);
    cb(null, `${ts}-${hash}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

router.post('/', [authMiddleware, requireRole('admin')], upload.array('files', 8), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'no_files', message: 'No se recibieron archivos' });
  }
  const category = (req.body.category || 'general').toString().slice(0, 64);
  const insert = db.prepare(
    `INSERT INTO uploads (filename, originalname, mimetype, size, uploaded_by, category)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const files = [];
  for (const f of req.files) {
    insert.run(f.filename, f.originalname, f.mimetype, f.size, req.user.sub, category);
    files.push({
      filename: f.filename,
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      url: `/uploads/${f.filename}`,
      category,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user.sub,
    });
  }
  res.status(201).json({ ok: true, files });
});

router.get('/', [authMiddleware, requireRole('admin')], (req, res) => {
  const category = req.query.category;
  const rows = category
    ? db.prepare(
        `SELECT filename, originalname, mimetype, size, uploaded_at, uploaded_by, category, alt_text
         FROM uploads WHERE category = ? ORDER BY uploaded_at DESC LIMIT 200`
      ).all(category)
    : db.prepare(
        `SELECT filename, originalname, mimetype, size, uploaded_at, uploaded_by, category, alt_text
         FROM uploads ORDER BY uploaded_at DESC LIMIT 200`
      ).all();
  res.json({ files: rows.map((r) => ({ ...r, url: `/uploads/${r.filename}` })) });
});

router.delete('/:filename', [authMiddleware, requireRole('admin')], (req, res) => {
  const safe = basename(req.params.filename);
  if (safe !== req.params.filename) {
    return res.status(400).json({ error: 'bad_filename' });
  }
  const full = join(UPLOAD_DIR, safe);
  if (!existsSync(full)) return res.status(404).json({ error: 'not_found' });
  try {
    const size = statSync(full).size;
    unlinkSync(full);
    db.prepare('DELETE FROM uploads WHERE filename = ?').run(safe);
    res.json({ ok: true, freed_bytes: size });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', detail: String(err) });
  }
});

export default router;

