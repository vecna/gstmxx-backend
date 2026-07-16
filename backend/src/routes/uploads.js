const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

// Configurazione dello storage temporaneo (cartella storage/incoming/)
const storage = multer.diskStorage({
   destination: (req, file, cb) => {
      cb(null, path.resolve(__dirname, '../../storage/incoming/'));
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

/**
 * @route   POST /api/uploads
 * @desc    Ricezione video brevi dai workshop con annesso consenso biometrico.
 * @access  Pubblico (con limitazione di frequenza/rate limit)
 */
router.post('/', upload.single('video'), (req, res) => {
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
         return res.status(400).json({ ok: false, message: 'Il parametro consent_version è obbligatorio.' });
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

module.exports = router;
