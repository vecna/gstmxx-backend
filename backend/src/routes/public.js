const express = require('express');
const router = express.Router();
const db = require('../db');

// Configurazione dominio di riferimento per i link assoluti dei feed
const BASE_URL = process.env.GSTMXX_BASE_URL || 'https://ghostyles.vecna.eu';

/**
 * Funzione helper per l'escaping dei caratteri speciali all'interno dei nodi XML.
 */
function escapeXml(unsafe) {
   if (!unsafe) return '';
   return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
         case '<': return '&lt;';
         case '>': return '&gt;';
         case '&': return '&amp;';
         case '\'': return '&apos;';
         case '"': return '&quot;';
         default: return c;
      }
   });
}

/**
 * Generatore generico di strutture XML RSS 2.0.
 */
function buildRssFeed(title, description, items) {
   const now = new Date().toUTCString();
   let xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
   <title>${escapeXml(title)}</title>
   <link>${BASE_URL}</link>
   <description>${escapeXml(description)}</description>
   <language>it-it</language>
   <lastBuildDate>${now}</lastBuildDate>
`;

   items.forEach(item => {
      xml += `   <item>
      <title>${escapeXml(item.title)}</title>
      <link>${item.link}</link>
      <description>${escapeXml(item.description)}</description>
      <pubDate>${new Date(item.created_at).toUTCString()}</pubDate>
      <guid isPermaLink="true">${item.link}</guid>
   </item>\n`;
   });

   xml += `</channel>\n</rss>`;
   return xml;
}

/**
 * @route   GET /feed/videos.xml
 * @desc    Feed RSS dei video approvati e normalizzati originati dai workshop
 */
router.get('/videos.xml', (req, res) => {
   try {
      const rows = db.prepare(`
         SELECT id, user_note, ghostyle_id, created_at 
         FROM uploads 
         WHERE status = 'approved' 
         ORDER BY created_at DESC LIMIT 50
      `).all();

      const items = rows.map(r => ({
         title: `Video Camouflage Workshop ID ${r.id}`,
         link: `${BASE_URL}/videos/${r.id}`,
         description: `Note utente: ${r.user_note || 'Nessuna nota'}. Plugin utilizzato: ${r.ghostyle_id || 'Nessuno'}.`,
         created_at: r.created_at
      }));

      res.header('Content-Type', 'application/xml');
      return res.send(buildRssFeed('Ghostmaxxing — Ultimi Video Camouflage', 'Archivio pubblico dei tentativi di elusione biometrica riusciti.', items));
   } catch (err) {
      return res.status(500).send('Errore durante la generazione del feed.');
   }
});

/**
 * @route   GET /feed/ghostyles.xml
 * @desc    Placeholder Feed per la pubblicazione di nuovi plugin immessi nell'archivio
 */
router.get('/ghostyles.xml', (req, res) => {
   // In attesa della Fase 2 dell'archivio, restituiamo un feed vuoto valido
   res.header('Content-Type', 'application/xml');
   return res.send(buildRssFeed('Ghostmaxxing — Nuovi Ghostyles', 'Nuovi pattern e filtri avversariali rilasciati dalla community.', []));
});

/**
 * @route   GET /feed/news.xml
 * @desc    Placeholder Feed per i comunicati politici ed editoriali del progetto
 */
router.get('/news.xml', (req, res) => {
   res.header('Content-Type', 'application/xml');
   return res.send(buildRssFeed('Ghostmaxxing — Aggiornamenti del Progetto', 'Comunicati ed aggiornamenti dal Sindacato Universale Digitale NINA.', []));
});

/**
 * @route   GET /feed/all.xml
 * @desc    Aggregatore globale omnicomprensivo
 */
router.get('/all.xml', (req, res) => {
   try {
      const rows = db.prepare(`
         SELECT id, user_note, created_at FROM uploads WHERE status = 'approved' ORDER BY created_at DESC LIMIT 25
      `).all();
      const items = rows.map(r => ({
         title: `Aggiornamento Workshop: Video Camouflage ${r.id}`,
         link: `${BASE_URL}/videos/${r.id}`,
         description: r.user_note || 'Nuovo asset normalizzato disponibile per l\'analisi visiva.',
         created_at: r.created_at
      }));
      res.header('Content-Type', 'application/xml');
      return res.send(buildRssFeed('Ghostmaxxing — Feed Globale', 'Tutti i flussi di informazione unificati.', items));
   } catch (err) {
      return res.status(500).send('Errore interno.');
   }
});

module.exports = router;
