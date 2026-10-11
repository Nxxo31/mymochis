import { Router } from '../router.js';
import { authMiddleware, requireRole } from '../auth.js';

const router = new Router();

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf',
]);

function safeFilename(originalname) {
  const ext = (originalname.includes('.') ? originalname.slice(originalname.lastIndexOf('.')) : '').toLowerCase().slice(0, 8).replace(/[^a-z0-9.]/g, '');
  const hash = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
  const ts = Date.now().toString(36);
  return `${ts}-${hash}${ext}`;
}

router.post('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const form = await req.raw.formData();
  const files = form.getAll('files').filter(f => f && typeof f.arrayBuffer === 'function');
  if (files.length === 0) {
    return res.status(400).json({ error: 'no_files', message: 'No se recibieron archivos' });
  }
  if (files.length > 8) {
    return res.status(400).json({ error: 'too_many_files', message: 'Maximo 8 archivos por subida' });
  }
  const category = String(form.get('category') || 'general').slice(0, 64);

  const prepared = [];
  for (const f of files) {
    if (!ALLOWED_MIME.has(f.type)) {
      return res.status(400).json({ error: 'bad_mime', message: `Tipo de archivo no permitido: ${f.type}` });
    }
    if (f.size > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'too_large', message: `Archivo excede 25MB: ${f.name}` });
    }
    prepared.push({ f, filename: safeFilename(f.name || 'file') });
  }

  const out = [];
  for (const { f, filename } of prepared) {
    await req.env.UPLOADS.put(filename, f.stream(), {
      httpMetadata: { contentType: f.type },
      customMetadata: { originalname: f.name || '', uploaded_by: String(req.user.sub), category },
    });
    await req.db.prepare(
      `INSERT INTO uploads (filename, originalname, mimetype, size, uploaded_by, category)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(filename, f.name || '', f.type, f.size, req.user.sub, category);
    out.push({
      filename,
      originalname: f.name,
      mimetype: f.type,
      size: f.size,
      url: `/uploads/${filename}`,
      category,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user.sub,
    });
  }
  res.status(201).json({ ok: true, files: out });
});

router.get('/', [authMiddleware, requireRole('admin')], async (req, res) => {
  const category = req.query.category;
  const rows = category
    ? await req.db.prepare(
        `SELECT filename, originalname, mimetype, size, uploaded_at, uploaded_by, category, alt_text
         FROM uploads WHERE category = ? ORDER BY uploaded_at DESC LIMIT 200`
      ).all(category)
    : await req.db.prepare(
        `SELECT filename, originalname, mimetype, size, uploaded_at, uploaded_by, category, alt_text
         FROM uploads ORDER BY uploaded_at DESC LIMIT 200`
      ).all();
  res.json({ files: rows.map((r) => ({ ...r, url: `/uploads/${r.filename}` })) });
});

router.delete('/:filename', [authMiddleware, requireRole('admin')], async (req, res) => {
  const name = req.params.filename;
  if (name.includes('/') || name.includes('..') || name.includes('\\')) {
    return res.status(400).json({ error: 'bad_filename' });
  }
  const existing = await req.db.prepare('SELECT filename, size FROM uploads WHERE filename = ?').get(name);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  try {
    await req.env.UPLOADS.delete(name);
    await req.db.prepare('DELETE FROM uploads WHERE filename = ?').run(name);
    res.json({ ok: true, freed_bytes: existing.size });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', detail: String(err) });
  }
});

export default router;
