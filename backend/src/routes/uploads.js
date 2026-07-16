const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { STORAGE_INCOMING_DIR } = require('../paths');
const { removeIfExists, removeUploadFiles } = require('../services/uploadFiles');
const { validateUploadedVideo } = require('../services/videoValidation');
const { emitDeleteForUpload } = require('../services/activitypub');

// Configurazione dello storage temporaneo (cartella storage/incoming/)
const storage = multer.diskStorage({
   destination: (req, file, cb) => {
      cb(null, STORAGE_INCOMING_DIR);
   },
   filename: (req, file, cb) => {
      // Generiamo un nome file casuale e sicuro per evitare directory traversal o sovrascritture
      const randomName = crypto.randomBytes(16).toString('hex');
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomName}${ext}`);
   }
});

// Filtro di sicurezza preventivo sui MIME-type accettati dal browser
const fileFilter = (req, file, cb) => {
   const allowedTypes = ['video/mp4', 'video/webm', 'video/ogg'];
   if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
   } else {
      cb(new Error('Formato file non valido. Sono ammessi solo video (MP4, WebM, OGG).'), false);
   }
};

// Istanza Multer con limite di peso stringente impostato a 15MB
const upload = multer({
   storage: storage,
   fileFilter: fileFilter,
   limits: { fileSize: 15 * 1024 * 1024 } // 15 Megabytes
});

function tokenMatches(issuedToken, providedToken) {
   if (!issuedToken || !providedToken) return false;

   const issuedDigest = crypto.createHash('sha256').update(String(issuedToken)).digest();
   const providedDigest = crypto.createHash('sha256').update(String(providedToken)).digest();
   return crypto.timingSafeEqual(issuedDigest, providedDigest);
}

/**
 * @route   POST /api/uploads
 * @desc    Ricezione video brevi dai workshop con annesso consenso biometrico.
 * @access  Pubblico (con limitazione di frequenza/rate limit)
 */
router.post('/', upload.single('video'), async (req, res) => {
   try {
      if (!req.file) {
         return res.status(400).json({ ok: false, message: 'Nessun file video ricevuto.' });
      }

      // Estrazione e validazione dei campi del contratto di payload v1.0
      const {
         consent_version,
         ghostyle_id,
         app_version,
         user_note,
         metrics_json
      } = req.body;

      // Il consenso esplicito è un blocco vincolante per l'archiviazione e la successiva moderazione
      if (!consent_version) {
         removeIfExists(req.file.path);
         return res.status(400).json({ ok: false, message: 'Il parametro consent_version è obbligatorio.' });
      }

      const isVideo = await validateUploadedVideo(req.file.path);
      if (!isVideo) {
         removeIfExists(req.file.path);
         return res.status(400).json({ ok: false, message: 'Il file caricato non contiene un video valido.' });
      }

      // Generazione identificativi univoci e token di cancellazione autonomo (Opzione 2 + 4)
      const uploadId = crypto.randomUUID();
      const deleteToken = crypto.randomBytes(32).toString('hex');

      // Inserimento transazionale nel database SQLite dello stato 'pending'
      const insertStmt = db.prepare(`
         INSERT INTO uploads (id, filename, consent_version, ghostyle_id, app_version, user_note, metrics_json, delete_token, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `);

      insertStmt.run(
         uploadId,
         req.file.filename,
         consent_version,
         ghostyle_id || null,
         app_version || null,
         user_note || null,
         metrics_json || null,
         deleteToken
      );

      // Risposta conforme alle specifiche del contratto della Roadmap MVP
      return res.status(201).json({
         ok: true,
         uploadId: uploadId,
         deleteToken: deleteToken, // Permette l'autenticazione per l'eliminazione autonoma senza account
         message: 'Upload ricevuto ed inserito nella coda di moderazione umana.'
      });

   } catch (err) {
      console.error('[Upload Route Error]:', err);
      return res.status(500).json({ ok: false, message: 'Errore interno durante l\'elaborazione dell\'upload.' });
   }
});

/**
 * @route   DELETE /api/uploads/:id
 * @desc    Cancellazione autonoma autenticata dal delete token emesso all'upload.
 * @access  Pubblico con token opaco
 */
router.delete('/:id', async (req, res) => {
   const { id } = req.params;
   const providedToken = req.get('X-Delete-Token');

   try {
      const record = db.prepare(`
         SELECT id, filename, thumbnail_filename, status, delete_token, created_at
         FROM uploads
         WHERE id = ?
      `).get(id);

      if (!record) {
         return res.status(404).json({ ok: false, message: 'Upload non trovato.' });
      }

      if (record.status === 'deleted' || record.status === 'rejected') {
         return res.status(410).json({ ok: false, message: 'Upload già rimosso.' });
      }

      if (!tokenMatches(record.delete_token, providedToken)) {
         return res.status(403).json({ ok: false, message: 'Delete token non valido.' });
      }

      const wasApproved = record.status === 'approved';
      const update = db.prepare(`
         UPDATE uploads
         SET status = 'deleted', moderated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status IN ('pending', 'approved')
      `).run(id);

      if (update.changes < 1) {
         return res.status(410).json({ ok: false, message: 'Upload già rimosso.' });
      }

      const removedFiles = removeUploadFiles(record);

      let federation = { skipped: true };
      if (wasApproved) {
         federation = await emitDeleteForUpload(record);
      }

      return res.json({
         ok: true,
         message: 'Upload cancellato.',
         removedFiles: removedFiles.length,
         federation
      });
   } catch (err) {
      console.error('[Upload Delete Route Error]:', err);
      return res.status(500).json({ ok: false, message: 'Errore interno durante la cancellazione dell\'upload.' });
   }
});

module.exports = router;
