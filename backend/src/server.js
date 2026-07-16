const { bootstrapRuntime } = require('./bootstrap');

bootstrapRuntime();

const express = require('express');
const rateLimit = require('express-rate-limit');
const uploadsRouter = require('./routes/uploads');
const adminRouter = require('./routes/admin');
const publicRouter = require('./routes/public'); // Importazione del nuovo router dei feed RSS
const { startStaleUploadCleanup } = require('./services/cleanup');

const PORT = process.env.PORT || 3000;
const AP_ENABLED = /^(1|true|yes|on)$/i.test(process.env.GSTMXX_ENABLE_AP || '');

function uploadRateLimitMax() {
   const parsed = Number.parseInt(process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX || '5', 10);
   return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function isolateMiddleware(label, middleware) {
   return (req, res, next) => {
      try {
         const result = middleware(req, res, (err) => {
            if (err) {
               console.error(`[Ghostmaxxing Backend] ${label} route error:`, err);
            }
            next(err);
         });

         if (result && typeof result.catch === 'function') {
            result.catch((err) => {
               console.error(`[Ghostmaxxing Backend] ${label} async route error:`, err);
               next(err);
            });
         }
      } catch (err) {
         console.error(`[Ghostmaxxing Backend] ${label} sync route error:`, err);
         next(err);
      }
   };
}

function createApp() {
   const app = express();

   app.use(express.json());
   app.use(express.urlencoded({ extended: true }));

   // Rate limit per rotte ad alto impatto prestazionale (Threat mitigation)
   const uploadLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: uploadRateLimitMax(),
      message: { ok: false, message: 'Troppi tentativi. Riprova più tardi.' },
      standardHeaders: true,
      legacyHeaders: false,
   });

   // 1. Infrastruttura ActivityPub. Disattivata di default finche B7 non riscrive Fedify correttamente.
   if (AP_ENABLED) {
      const { activityPubMiddleware } = require('./services/activitypub');
      app.use(isolateMiddleware('ActivityPub', activityPubMiddleware));
      console.log('[Ghostmaxxing Backend] ActivityPub enabled via GSTMXX_ENABLE_AP.');
   } else {
      console.log('[Ghostmaxxing Backend] ActivityPub disabled. Set GSTMXX_ENABLE_AP=1 to enable it.');
   }

   // 2. Rotte dei Feed RSS pubblici e a bassa frizione
   app.use('/feed', isolateMiddleware('feed', publicRouter));

   // 3. Rotta pubblica per l'invio degli asset dai workshop
   app.use('/api/uploads', uploadLimiter, isolateMiddleware('uploads', uploadsRouter));

   // 4. Rotta privata di amministrazione e moderazione umana
   app.use('/api/admin', isolateMiddleware('admin', adminRouter));

   app.use((req, res) => {
      return res.status(404).json({ ok: false, message: 'Risorsa non trovata.' });
   });

   app.use((err, req, res, next) => {
      if (res.headersSent) {
         return next(err);
      }

      console.error('[Ghostmaxxing Backend] Request isolated:', err);

      if (err instanceof Error) {
         return res.status(err.status || err.statusCode || 400).json({ ok: false, message: err.message });
      }
      return res.status(500).json({ ok: false, message: 'Errore generico non gestito nel backend.' });
   });

   return app;
}

function startServer() {
   const app = createApp();
   if (process.env.NODE_ENV !== 'test') {
      startStaleUploadCleanup();
   }
   return app.listen(PORT, () => {
      console.log(`[Ghostmaxxing Backend] Server avviato sulla porta ${PORT}`);
   });
}

if (require.main === module) {
   startServer();
}

module.exports = {
   createApp,
   startServer,
   isolateMiddleware,
   uploadRateLimitMax
};
