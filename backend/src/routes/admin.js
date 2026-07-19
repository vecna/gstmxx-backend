const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { processApprovedClipboard, processApprovedVideo } = require('../services/video');
const { emitCreateForUpload } = require('../services/activitypub');
const { STORAGE_INCOMING_DIR } = require('../paths');
const { publicUrlForUpload } = require('../services/publicUrls');

// Configurazione credenziali di moderazione (sostituire o agganciare a process.env in produzione)
const ADMIN_USER = process.env.GSTMXX_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.GSTMXX_ADMIN_PASS || 'cambiami-subito-2026';

// Middleware di sicurezza: HTTP Basic Auth sincrono e leggero
function basicAuthMiddleware(req, res, next) {
   const authHeader = req.headers.authorization;
   if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
      return res.status(401).send('Autenticazione richiesta.');
   }

   let decoded;
   try {
      decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf8');
   } catch (err) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
      return res.status(401).send('Credenziali non valide.');
   }

   const separator = decoded.indexOf(':');
   if (separator < 0) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
      return res.status(401).send('Credenziali non valide.');
   }

   const user = decoded.slice(0, separator);
   const pass = decoded.slice(separator + 1);

   if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return next();
   }

   res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
   return res.status(401).send('Credenziali non valide.');
}

// Applichiamo la protezione Basic Auth a tutte le rotte di questo modulo
router.use(basicAuthMiddleware);

router.get('/', (req, res) => {
   return res.sendFile(path.resolve(__dirname, '../admin/index.html'));
});

/**
 * @route   GET /api/admin/pending
 * @desc    Elenca gli upload in attesa di revisione umana
 */
router.get('/pending', (req, res) => {
   try {
      const kind = ['video', 'clipboard'].includes(req.query.kind) ? req.query.kind : null;
      const rows = db.prepare(`
         SELECT id, kind, consent_version, ghostyle_id, app_version, user_note, metrics_json, created_at
         FROM uploads 
         WHERE status = 'pending'
           AND (? IS NULL OR kind = ?)
         ORDER BY created_at ASC
      `).all(kind, kind);
      return res.json({
         ok: true,
         pending: rows.map((row) => ({
            ...row,
            mediaUrl: `/api/admin/media/${row.id}`,
            publicUrl: publicUrlForUpload(row)
         }))
      });
   } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
   }
});

router.get('/media/:id', (req, res) => {
   try {
      const record = db.prepare('SELECT filename, kind FROM uploads WHERE id = ? AND status = ?').get(req.params.id, 'pending');
      if (!record) {
         return res.status(404).json({ ok: false, message: 'Pending upload not found.' });
      }

      const mediaPath = path.join(STORAGE_INCOMING_DIR, record.filename);
      if (!fs.existsSync(mediaPath)) {
         return res.status(404).json({ ok: false, message: 'Pending media file not found.' });
      }

      if (record.kind === 'clipboard') {
         res.type('image/png');
      }
      return res.sendFile(mediaPath);
   } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
   }
});

router.post('/news', (req, res) => {
   try {
      const { title, body, link } = req.body || {};
      if (!title || !body) {
         return res.status(400).json({ ok: false, message: 'title and body are required.' });
      }

      const id = crypto.randomUUID();
      db.prepare(`
         INSERT INTO news (id, title, body, link)
         VALUES (?, ?, ?, ?)
      `).run(id, title, body, link || null);

      return res.status(201).json({ ok: true, id });
   } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
   }
});

/**
 * @route   POST /api/admin/approve/:id
 * @desc    Approva un video, innesca ffmpeg e lo sposta nell'archivio pubblico
 */
router.post('/approve/:id', async (req, res) => {
   const { id } = req.params;
   try {
      const record = db.prepare(`
         SELECT id, filename, kind, ghostyle_id, user_note
         FROM uploads
         WHERE id = ? AND status = ?
      `).get(id, 'pending');
      if (!record) {
         return res.status(404).json({ ok: false, message: 'Upload in stato pending non trovato.' });
      }

      // Esecuzione della pipeline ffmpeg asincrona
      const processed = record.kind === 'clipboard'
         ? await processApprovedClipboard(record.filename, id)
         : await processApprovedVideo(record.filename, id);

      // Aggiornamento dello stato sul DB transazionale
      db.prepare(`
         UPDATE uploads 
         SET status = 'approved', filename = ?, thumbnail_filename = ?, moderated_at = CURRENT_TIMESTAMP 
         WHERE id = ?
      `).run(processed.videoName, processed.thumbnailName, id);

      // Eliminazione del file grezzo originale in incoming per non sprecare spazio
      const originalPath = path.join(STORAGE_INCOMING_DIR, record.filename);
      if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);

      const published = {
         ...record,
         filename: processed.videoName,
         thumbnail_filename: processed.thumbnailName
      };
      const federation = await emitCreateForUpload(published);

      return res.json({
         ok: true,
         message: 'Upload published successfully.',
         kind: record.kind,
         video: processed.videoName,
         thumbnail: processed.thumbnailName,
         publicUrl: publicUrlForUpload(published),
         federation
      });

   } catch (err) {
      console.error('[Admin Approve Error]:', err);
      return res.status(500).json({ ok: false, message: `Errore durante l'approvazione: ${err.message}` });
   }
});

/**
 * @route   POST /api/admin/reject/:id
 * @desc    Rifiuta un video ed elimina fisicamente l'asset dal server
 */
router.post('/reject/:id', (req, res) => {
   const { id } = req.params;
   try {
      const record = db.prepare('SELECT filename, kind FROM uploads WHERE id = ? AND status = ?').get(id, 'pending');
      if (!record) {
         return res.status(404).json({ ok: false, message: 'Upload in stato pending non trovato.' });
      }

      // Aggiornamento di stato sul DB
      db.prepare("UPDATE uploads SET status = 'rejected', moderated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);

      // Eliminazione fisica definitiva dell'asset video non approvato
      const fileToClean = path.join(STORAGE_INCOMING_DIR, record.filename);
      if (fs.existsSync(fileToClean)) {
         fs.unlinkSync(fileToClean);
      }

      return res.json({ ok: true, message: 'Upload scartato ed eliminato definitivamente dal filesystem.' });
   } catch (err) {
      return res.status(500).json({ ok: false, message: err.message });
   }
});

module.exports = router;
