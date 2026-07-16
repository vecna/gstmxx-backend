const express = require('express');
const fs = require('fs');
const router = express.Router();
const db = require('../db');
const { GHOSTYLES_JSON_PATH } = require('../paths');

const BASE_URL = process.env.GSTMXX_BASE_URL || 'https://ghostmaxxing.vecna.eu';

function escapeXml(unsafe) {
   if (!unsafe) return '';
   return String(unsafe).replace(/[<>&'"]/g, (c) => {
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

function buildRssFeed(title, description, items) {
   const now = new Date().toUTCString();
   let xml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
   <title>${escapeXml(title)}</title>
   <link>${escapeXml(BASE_URL)}</link>
   <description>${escapeXml(description)}</description>
   <language>en</language>
   <lastBuildDate>${now}</lastBuildDate>
`;

   items.forEach(item => {
      const pubDate = new Date(item.created_at || Date.now()).toUTCString();
      xml += `   <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <description>${escapeXml(item.description)}</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
   </item>\n`;
   });

   xml += `</channel>\n</rss>`;
   return xml;
}

function readGhostyles() {
   try {
      const raw = fs.readFileSync(GHOSTYLES_JSON_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
   } catch (err) {
      console.error('[Ghostyles Feed Error]:', err.message);
      return [];
   }
}

function uploadItem(row) {
   const isClipboard = row.kind === 'clipboard';
   const section = isClipboard ? 'clipboard' : 'videos';
   return {
      title: isClipboard ? `Clipboard image ${row.id}` : `Workshop video ${row.id}`,
      link: `${BASE_URL}/${section}/${row.id}`,
      description: `${row.user_note || 'No note provided.'} Ghostyle: ${row.ghostyle_id || 'none'}.`,
      created_at: row.created_at
   };
}

router.get('/videos.xml', (req, res) => {
   try {
      const rows = db.prepare(`
         SELECT id, kind, user_note, ghostyle_id, created_at
         FROM uploads
         WHERE status = 'approved' AND kind = 'video'
         ORDER BY created_at DESC LIMIT 50
      `).all();

      res.header('Content-Type', 'application/xml');
      return res.send(buildRssFeed(
         'Ghostmaxxing - Workshop Videos',
         'Moderated workshop videos published by Ghostmaxxing.',
         rows.map(uploadItem)
      ));
   } catch (err) {
      return res.status(500).send('Feed generation failed.');
   }
});

router.get('/ghostyles.xml', (req, res) => {
   const items = readGhostyles().map((ghostyle) => ({
      title: `Ghostyle: ${ghostyle.id}`,
      link: `${BASE_URL}/${ghostyle.url}`,
      description: `Adversarial appearance pattern ${ghostyle.id}.`,
      created_at: '2026-07-01T00:00:00.000Z'
   }));

   res.header('Content-Type', 'application/xml');
   return res.send(buildRssFeed(
      'Ghostmaxxing - Ghostyles',
      'Ghostyle patterns available for the Ghostmaxxing lab.',
      items
   ));
});

router.get('/news.xml', (req, res) => {
   try {
      const rows = db.prepare(`
         SELECT id, title, body, link, created_at
         FROM news
         ORDER BY created_at DESC LIMIT 50
      `).all();

      const items = rows.map((row) => ({
         title: row.title,
         link: row.link || `${BASE_URL}/news/${row.id}`,
         description: row.body,
         created_at: row.created_at
      }));

      res.header('Content-Type', 'application/xml');
      return res.send(buildRssFeed(
         'Ghostmaxxing - News',
         'Project updates from Ghostmaxxing.',
         items
      ));
   } catch (err) {
      return res.status(500).send('Feed generation failed.');
   }
});

router.get('/all.xml', (req, res) => {
   try {
      const uploads = db.prepare(`
         SELECT id, kind, user_note, ghostyle_id, created_at
         FROM uploads
         WHERE status = 'approved'
         ORDER BY created_at DESC LIMIT 25
      `).all().map(uploadItem);

      const news = db.prepare(`
         SELECT id, title, body, link, created_at
         FROM news
         ORDER BY created_at DESC LIMIT 25
      `).all().map((row) => ({
         title: row.title,
         link: row.link || `${BASE_URL}/news/${row.id}`,
         description: row.body,
         created_at: row.created_at
      }));

      const items = uploads.concat(news)
         .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
         .slice(0, 50);

      res.header('Content-Type', 'application/xml');
      return res.send(buildRssFeed(
         'Ghostmaxxing - All Updates',
         'All public Ghostmaxxing feeds in one stream.',
         items
      ));
   } catch (err) {
      return res.status(500).send('Feed generation failed.');
   }
});

module.exports = router;
