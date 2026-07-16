const express = require('express');
const rateLimit = require('express-rate-limit');
const uploadsRouter = require('./routes/uploads');
const adminRouter = require('./routes/admin');
const publicRouter = require('./routes/public'); // Importazione del nuovo router dei feed RSS
const { activityPubMiddleware } = require('./services/activitypub'); // Importazione del middleware Fedify

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit per rotte ad alto impatto prestazionale (Threat mitigation)
const uploadLimiter = rateLimit({
   windowMs: 15 * 60 * 1000,
   max: 5,
   message: { ok: false, message: 'Troppi tentativi. Riprova più tardi.' },
   standardHeaders: true,
   legacyHeaders: false,
 });

// 1. Iniezione dell'infrastruttura di federazione ActivityPub (Intercetta le chiamate degli attori e WebFinger)
app.use(activityPubMiddleware);

// 2. Rotte dei Feed RSS pubblici e a bassa frizione
app.use('/feed', publicRouter);

// 3. Rotta pubblica per l'invio degli asset dai workshop
app.use('/api/uploads', uploadLimiter, uploadsRouter);

// 4. Rotta privata di amministrazione e moderazione umana
app.use('/api/admin', adminRouter);

app.use((err, req, res, next) => {
   if (err instanceof Error) {
      return res.status(400).json({ ok: false, message: err.message });
   }
   return res.status(500).json({ ok: false, message: 'Errore generico non gestito nel backend.' });
});

app.listen(PORT, () => {
   console.log(`[Ghostmaxxing Backend] Server avviato ed aperto al Fediverso sulla porta ${PORT}`);
});
