const Database = require('better-sqlite3');
const path = require('path');

// Connessione al file di persistenza SQLite dedicato
const dbPath = path.resolve(__dirname, '../data/ghostmaxxing.sqlite');
const db = new Database(dbPath);

// Abilitazione del Write-Ahead Logging (WAL) per gestire letture/scritture concorrenti senza blocchi
db.pragma('journal_mode = WAL');

// Inizializzazione della tabella per la coda di moderazione degli uploads
db.prepare(`
  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
    consent_version TEXT NOT NULL,
    ghostyle_id TEXT,
    app_version TEXT,
    user_note TEXT,
    metrics_json TEXT,
    delete_token TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    moderated_at TEXT
  )
`).run();

// Inizializzazione della tabella per la federazione ActivityPub (Fase 6)
db.prepare(`
  CREATE TABLE IF NOT EXISTS ap_followers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT UNIQUE NOT NULL,
    inbox_url TEXT NOT NULL,
    followed_actor TEXT CHECK(followed_actor IN ('video', 'ghostyles', 'news')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

module.exports = db;
