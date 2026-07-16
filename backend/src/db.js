const Database = require('better-sqlite3');
const { ensureRuntimeDirectories } = require('./bootstrap');
const { DB_PATH } = require('./paths');

ensureRuntimeDirectories();

// Connessione al file di persistenza SQLite dedicato
const db = new Database(DB_PATH);

// Abilitazione del Write-Ahead Logging (WAL) per gestire letture/scritture concorrenti senza blocchi
db.pragma('journal_mode = WAL');

/**
 * Retrieves the raw SQL schema definition for a given table from sqlite_master.
 * 
 * @param {string} tableName - The name of the table.
 * @returns {string|null} The SQL schema string, or null if the table does not exist.
 */
function getTableSql(tableName) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return row ? row.sql : null;
}

/**
 * Retrieves the column names for a given table.
 * 
 * @param {string} tableName - The name of the table.
 * @returns {string[]} An array of column names.
 */
function getColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name);
}

/**
 * Creates the uploads table if it does not already exist.
 * 
 * @param {string} [tableName='uploads'] - The name of the table to create.
 * @returns {void}
 */
function createUploadsTable(tableName = 'uploads') {
  db.prepare(`
  CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    thumbnail_filename TEXT,
    kind TEXT CHECK(kind IN ('video', 'clipboard')) DEFAULT 'video',
    status TEXT CHECK(status IN ('pending', 'approved', 'rejected', 'deleted')) DEFAULT 'pending',
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
}

/**
 * Creates the followers table if it does not already exist.
 * 
 * @param {string} [tableName='ap_followers'] - The name of the table to create.
 * @returns {void}
 */
function createFollowersTable(tableName = 'ap_followers') {
  db.prepare(`
  CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT UNIQUE NOT NULL,
    inbox_url TEXT NOT NULL,
    followed_actor TEXT CHECK(followed_actor IN ('video', 'ghostyles', 'news', 'clipboard')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
  `).run();
}

/**
 * Performs database migration schema upgrades on the uploads table.
 * 
 * @returns {void}
 */
function migrateUploadsTable() {
  const sql = getTableSql('uploads');
  if (!sql) {
    createUploadsTable();
    return;
  }

  const columns = getColumns('uploads');
  const needsDeletedStatus = !sql.includes("'deleted'");
  const needsThumbnail = !columns.includes('thumbnail_filename');
  const needsKind = !columns.includes('kind');
  if (!needsDeletedStatus && !needsThumbnail && !needsKind) return;

  const hasModeratedAt = columns.includes('moderated_at');
  const hasKind = columns.includes('kind');
  const hasThumbnail = columns.includes('thumbnail_filename');
  db.transaction(() => {
    db.prepare('ALTER TABLE uploads RENAME TO uploads_old').run();
    createUploadsTable();
    db.prepare(`
      INSERT INTO uploads (
        id, filename, thumbnail_filename, kind, status, consent_version, ghostyle_id,
        app_version, user_note, metrics_json, delete_token, created_at, moderated_at
      )
      SELECT
        id, filename,
        ${hasThumbnail ? 'thumbnail_filename' : 'NULL'},
        ${hasKind ? 'kind' : "'video'"},
        status, consent_version, ghostyle_id,
        app_version, user_note, metrics_json, delete_token, created_at,
        ${hasModeratedAt ? 'moderated_at' : 'NULL'}
      FROM uploads_old
    `).run();
    db.prepare('DROP TABLE uploads_old').run();
  })();
}

/**
 * Performs database migration schema upgrades on the followers table.
 * 
 * @returns {void}
 */
function migrateFollowersTable() {
  const sql = getTableSql('ap_followers');
  if (!sql) {
    createFollowersTable();
    return;
  }

  if (sql.includes("'clipboard'")) return;

  db.transaction(() => {
    db.prepare('ALTER TABLE ap_followers RENAME TO ap_followers_old').run();
    createFollowersTable();
    db.prepare(`
      INSERT OR IGNORE INTO ap_followers (id, actor_id, inbox_url, followed_actor, created_at)
      SELECT id, actor_id, inbox_url, followed_actor, created_at
      FROM ap_followers_old
    `).run();
    db.prepare('DROP TABLE ap_followers_old').run();
  })();
}

migrateUploadsTable();
migrateFollowersTable();

db.prepare(`
  CREATE TABLE IF NOT EXISTS keys (
    actor TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    public_jwk TEXT NOT NULL,
    private_jwk TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (actor, algorithm)
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

module.exports = db;
