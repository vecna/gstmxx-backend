const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

/**
 * Pipeline di normalizzazione video pre-pubblicazione.
 * @param {string} inputFilename - Nome del file nella cartella storage/incoming/
 * @returns {Promise<{videoPath: string, thumbnailName: string}>} Paths dei file elaborati.
 */
function processApprovedVideo(inputFilename) {
   return new Promise((resolve, reject) => {
      const inputPath = path.resolve(__dirname, '../../storage/incoming/', inputFilename);
      const outputName = `pub-${path.parse(inputFilename).name}.mp4`;
      const outputPath = path.resolve(__dirname, '../../storage/approved/', outputName);
      const thumbnailDir = path.resolve(__dirname, '../../storage/thumbnails/');
      const thumbnailName = `thumb-${path.parse(inputFilename).name}.png`;

      if (!fs.existsSync(inputPath)) {
         return reject(new Error(`File sorgente non trovato: ${inputPath}`));
      }

      // 1. Pipeline di ottimizzazione e sanitizzazione con ffmpeg
      ffmpeg(inputPath)
         .output(outputPath)
         .videoCodec('libx264')     // Codec universale web-friendly
         .audioCodec('aac')         // Audio compresso standard
         .size('640x?')             // Riduzione risoluzione (larghezza fissa a 640px, altezza proporzionale)
         .outputOptions([
            '-crf 28',              // Compressione aggressiva ma dignitosa per risparmiare storage sul VPS
            '-map_metadata -1',     // TRAGUARDO PRIVACY: Strip completo di metadati, timestamp e geolocalizzazioni
            '-pix_fmt yuv420p'      // Massima compatibilità di riproduzione sui browser mobile
         ])
         .on('end', () => {
            // 2. Estrazione automatica del Poster Frame / Thumbnail dopo la conversione
            ffmpeg(outputPath)
               .screenshots({
                  timestamps: ['00:00:00.500'], // Cattura il frame a mezzo secondo per evitare dissolvenze iniziali nere
                  filename: thumbnailName,
                  folder: thumbnailDir,
                  size: '320x?'
               })
               .on('end', () => {
                  resolve({
                     videoName: outputName,
                     thumbnailName: thumbnailName
                  });
               })
               .on('error', (thumbErr) => {
                  console.error('[ffmpeg-thumb-error]:', thumbErr);
                  // Risolviamo comunque anche se fallisce il thumbnail per non bloccare la pubblicazione del video
                  resolve({ videoName: outputName, thumbnailName: null });
               });
         })
         .on('error', (err) => {
            console.error('[ffmpeg-conversion-error]:', err);
            reject(err);
         })
         .run();
   });
}

module.exports = {
   processApprovedVideo
};
