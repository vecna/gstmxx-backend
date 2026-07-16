const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { processApprovedVideo } = require('../services/video');
const { STORAGE_INCOMING_DIR } = require('../paths');

// Configurazione credenziali di moderazione (sostituire o agganciare a process.env in produzione)
const ADMIN_USER = process.env.GSTMXX_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.GSTMXX_ADMIN_PASS || 'cambiami-subito-2026';

// Middleware di sicurezza: HTTP Basic Auth sincrono e leggero
function basicAuthMiddleware(req, res, next) {
   const authHeader = req.headers.authorization;
   if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
      return res.status(401).send('Autenticazione richiesta.');
   }

   const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
   const user = auth[0];
   const pass = auth[1];

   if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return next();
   }

   res.setHeader('WWW-Authenticate', 'Basic realm="Ghostmaxxing Moderation UI"');
   return res.status(401).send('Credenziali non valide.');
}

// Applichiamo la protezione Basic Auth a tutte le rotte di questo modulo
router.use(basicAuthMiddleware);

/**
 * @route   GET /api/admin/pending
 * @desc    Elenca gli upload in attesa di revisione umana
 */
router.get('/pending', (req, res) => {
   try {
      const rows = db.prepare(`
         SELECT id, consent_version, ghostyle_id, app_version, user_note, metrics_json, created_at 
         FROM uploads 
         WHERE status = 'pending' 
         ORDER BY created_at ASC
      `).all();
      return res.json({ ok: true, pending: rows });
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
      const record = db.prepare('SELECT filename FROM uploads WHERE id = ? AND status = ?').get(id, 'pending');
      if (!record) {
         return res.status(404).json({ ok: false, message: 'Upload in stato pending non trovato.' });
      }

      // Esecuzione della pipeline ffmpeg asincrona
      const processed = await processApprovedVideo(record.filename);

      // Aggiornamento dello stato sul DB transazionale
      db.prepare(`
         UPDATE uploads 
         SET status = 'approved', filename = ?, thumbnail_filename = ?, moderated_at = CURRENT_TIMESTAMP 
         WHERE id = ?
      `).run(processed.videoName, processed.thumbnailName, id);

      // Eliminazione del file grezzo originale in incoming per non sprecare spazio
      const originalPath = path.join(STORAGE_INCOMING_DIR, record.filename);
      if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);

      // TODO: Nella Fase 4 inseriremo qui il trigger per l'emissione dell'evento su ActivityPub/RSS

      return res.json({
         ok: true,
         message: 'Video normalizzato e pubblicato con successo.',
         video: processed.videoName,
         thumbnail: processed.thumbnailName
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
      const record = db.prepare('SELECT filename FROM uploads WHERE id = ? AND status = ?').get(id, 'pending');
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
