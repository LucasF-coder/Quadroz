const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const defaultDbPath = path.join(__dirname, '..', 'mangahub.db');
const legacyDbPath = path.join(__dirname, '..', 'quadroz.db');
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : fs.existsSync(defaultDbPath)
    ? defaultDbPath
    : fs.existsSync(legacyDbPath)
      ? legacyDbPath
      : defaultDbPath;
const db = new Database(dbPath, { busyTimeout: 5000 });

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = memory');
db.pragma('foreign_keys = ON');

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(tableName, columnName, sqlTypeAndOptions) {
  if (hasColumn(tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeAndOptions}`);
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      last_ip TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_owner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS mangas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      normalized_title TEXT,
      description TEXT NOT NULL,
      author TEXT NOT NULL,
      cover_url TEXT,
      publication_status TEXT NOT NULL DEFAULT 'unknown',
      source_lang TEXT,
      chapters_consistent INTEGER NOT NULL DEFAULT 1,
      sync_frozen INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      total_chapters INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS manga_categories (
      manga_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (manga_id, category_id),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS manga_languages (
      manga_id INTEGER NOT NULL,
      language TEXT NOT NULL,
      PRIMARY KEY (manga_id, language),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_manga_categories (
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      category_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, manga_id, category_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES user_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS library_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reading',
      current_chapter INTEGER NOT NULL DEFAULT 1,
      last_page INTEGER NOT NULL DEFAULT 1,
      source_id TEXT,
      source_name TEXT,
      source_language TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, manga_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, manga_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

CREATE TABLE IF NOT EXISTS extension_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_nsfw INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS banned_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL UNIQUE,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS extension_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_url TEXT NOT NULL,
      source_name TEXT NOT NULL,
      lang TEXT NOT NULL,
      source_id TEXT NOT NULL,
      base_url TEXT NOT NULL,
      extension_pkg TEXT NOT NULL,
      extension_name TEXT NOT NULL,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_nsfw INTEGER NOT NULL DEFAULT 0,
      UNIQUE(repo_url, source_id, lang)
    );

    CREATE TABLE IF NOT EXISTS manga_origins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id INTEGER NOT NULL,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      external_id TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_url, external_id),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS suwayomi_chapter_refs (
      manga_external_id TEXT NOT NULL,
      chapter_ref TEXT NOT NULL,
      chapter_route_index INTEGER NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (manga_external_id, chapter_ref)
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY,
      preferred_language TEXT NOT NULL DEFAULT 'pt-br',
      nsfw_protection INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS page_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      chapter_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'pt-br',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chapter_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      chapter_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'pt-br',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS page_bookmarks (
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      chapter_id TEXT NOT NULL,
      page_index INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, manga_id, chapter_id, page_index),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reading_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manga_id INTEGER NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_number REAL NOT NULL DEFAULT 1,
      page_index INTEGER NOT NULL DEFAULT 1,
      source_id TEXT,
      source_name TEXT,
      source_language TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, manga_id, chapter_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS manga_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(manga_id, normalized_alias),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS manga_source_cache (
      manga_id INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'suwayomi',
      source_id TEXT NOT NULL DEFAULT '',
      source_name TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      external_id TEXT NOT NULL DEFAULT '',
      source_lang TEXT NOT NULL DEFAULT '',
      chapter_count INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (manga_id, source_key),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_health (
      source_url TEXT PRIMARY KEY,
      source_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'unknown',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enabled_sources (
      source_id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      lang TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'suwayomi',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_sync_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_user_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      admin_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_by INTEGER,
      context TEXT,
      FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS banned_mangas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      manga_id INTEGER NOT NULL UNIQUE,
      reason TEXT NOT NULL DEFAULT '',
      banned_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (manga_id) REFERENCES mangas(id) ON DELETE CASCADE,
      FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS banned_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      reason TEXT NOT NULL DEFAULT '',
      banned_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (banned_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS manga_chapters_cache (
      source_key TEXT NOT NULL,
      external_id TEXT NOT NULL,
      chapters_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_key, external_id)
    );

    CREATE TABLE IF NOT EXISTS feedback_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      admin_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_by INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'last_ip', 'TEXT');
  ensureColumn('users', 'banned_at', 'TEXT');
  ensureColumn('mangas', 'normalized_title', 'TEXT');
  ensureColumn('mangas', 'publication_status', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn('mangas', 'source_lang', 'TEXT');
  ensureColumn('mangas', 'chapters_consistent', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('mangas', 'sync_frozen', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('mangas', 'last_synced_at', 'TEXT');
  ensureColumn('mangas', 'is_nsfw', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('library_entries', 'source_id', 'TEXT');
  ensureColumn('library_entries', 'source_name', 'TEXT');
  ensureColumn('library_entries', 'source_language', 'TEXT');
  ensureColumn('reading_history', 'source_id', 'TEXT');
  ensureColumn('reading_history', 'source_name', 'TEXT');
  ensureColumn('reading_history', 'source_language', 'TEXT');
  ensureColumn('content_reports', 'context', 'TEXT');
  ensureColumn('user_preferences', 'nsfw_protection', 'INTEGER NOT NULL DEFAULT 1');

  db.exec('CREATE INDEX IF NOT EXISTS idx_mangas_normalized_title ON mangas(normalized_title)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_categories_manga ON manga_categories(manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_languages_manga ON manga_languages(manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_languages_language ON manga_languages(language)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_categories_user ON user_categories(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_manga_categories_user_manga ON user_manga_categories(user_id, manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_user_manga_categories_category ON user_manga_categories(category_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_banned_ips_ip ON banned_ips(ip)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_page_comments_lookup ON page_comments(chapter_id, page_index, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_page_comments_manga ON page_comments(manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chapter_comments_lookup ON chapter_comments(chapter_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chapter_comments_user_time ON chapter_comments(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_suwayomi_chapter_refs_updated ON suwayomi_chapter_refs(updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reading_history_user_time ON reading_history(user_id, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_reading_history_source ON reading_history(user_id, source_id, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_library_entries_source ON library_entries(user_id, source_id, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_aliases_manga ON manga_aliases(manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_aliases_normalized ON manga_aliases(normalized_alias)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_source_cache_manga ON manga_source_cache(manga_id, last_checked_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_source_cache_lang ON manga_source_cache(source_lang, chapter_count DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_manga_chapters_cache_updated ON manga_chapters_cache(updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_source_health_status_time ON source_health(status, last_checked_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_content_reports_status_time ON content_reports(status, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_content_reports_target ON content_reports(target_type, target_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON content_reports(reporter_user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_status_time ON feedback_messages(status, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_user_time ON feedback_messages(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_banned_mangas_manga ON banned_mangas(manga_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_banned_users_user ON banned_users(user_id)');

  ensureColumn('users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (count === 0) {
    const { hashPassword } = require('./auth.js');
    const pswd = hashPassword('admin123');
    db.prepare(`INSERT INTO users (username, email, password_hash) VALUES ('admin', 'admin@local', ?)`).run(pswd);
  }
}

module.exports = {
  db,
  initDb,
  seedIfEmpty
};
