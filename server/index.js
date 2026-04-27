require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const globalLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  message: { error: 'Muitas requisições. Tente novamente em 1 minuto.' }
});

const { db, initDb } = require('./db');
const { signToken } = require('./auth');
const { requireAuth, attachOptionalUser } = require('./middleware');
const { startDailySyncScheduler, runSync, getSyncStatus, stopSync } = require('./scheduler');
const { createTtlCache } = require('./services/cache');
const { health } = require('./controllers/health-controller');

const app = express();
const PORT = process.env.PORT || 3000;
const PROFILE_LANGUAGES = new Set(['pt-br', 'en', 'es']);
const REPORT_STATUSES = new Set(['open', 'in_review', 'resolved', 'dismissed']);
const FEEDBACK_STATUSES = new Set(['new', 'reviewing', 'resolved', 'archived']);
const SUWAYOMI_BASE = String(process.env.SUWAYOMI_BASE || 'http://127.0.0.1:4567').replace(/\/+$/, '');
const SUWAYOMI_API_BASE = `${SUWAYOMI_BASE}/api/v1`;
const SUWAYOMI_PT_LANGS = new Set(['pt', 'pt-br', 'pt_br']);
const SUPPORTED_DETAIL_LANGUAGES = new Set(['pt-br', 'en', 'es']);
const SUWAYOMI_SEARCH_MAX_SOURCES = Math.max(4, Number(process.env.SUWAYOMI_SEARCH_MAX_SOURCES) || 20);
const SUWAYOMI_SEARCH_CONCURRENCY = Math.max(2, Number(process.env.SUWAYOMI_SEARCH_CONCURRENCY) || 6);
const SUWAYOMI_DETAIL_SEARCH_DEFAULT_CANDIDATES = Math.max(2, Number(process.env.SUWAYOMI_DETAIL_SEARCH_DEFAULT_CANDIDATES) || 4);
const SUWAYOMI_DETAIL_SEARCH_EXPANDED_CANDIDATES = Math.max(
  SUWAYOMI_DETAIL_SEARCH_DEFAULT_CANDIDATES,
  Number(process.env.SUWAYOMI_DETAIL_SEARCH_EXPANDED_CANDIDATES) || 8
);
const SUWAYOMI_NSFW_SOURCE_KEYWORDS = ['3hentai', 'hentai', 'doujin', 'nsfw', 'adult', 'porn', 'r18', 'luscious'];
const ENABLE_MANGADEX_FALLBACK = String(process.env.ENABLE_MANGADEX_FALLBACK || '0').trim() === '1';
const CHAPTER_PAGES_CACHE_TTL_MS = Math.max(2 * 60 * 1000, Number(process.env.CHAPTER_PAGES_CACHE_TTL_MS) || 15 * 60 * 1000);
const MANGA_CHAPTERS_RESPONSE_CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.MANGA_CHAPTERS_RESPONSE_CACHE_TTL_MS) || 8 * 60 * 1000
);
const AUTH_ATTEMPT_WINDOW_MS = Math.max(60_000, Number(process.env.AUTH_ATTEMPT_WINDOW_MS) || 15 * 60 * 1000);
const AUTH_ATTEMPT_MAX_FAILURES = Math.max(3, Number(process.env.AUTH_ATTEMPT_MAX_FAILURES) || 6);
const AUTH_ATTEMPT_LOCK_MS = Math.max(60_000, Number(process.env.AUTH_ATTEMPT_LOCK_MS) || 20 * 60 * 1000);
const SOURCE_DOWN_BLOCK_HOURS = Math.max(1, Number(process.env.SOURCE_DOWN_BLOCK_HOURS) || 6);
const SOURCE_HEALTH_REFRESH_TTL_MS = Math.max(60_000, Number(process.env.SOURCE_HEALTH_REFRESH_TTL_MS) || 5 * 60 * 1000);
const SOURCE_HEALTH_DOWN_LIST_LIMIT = Math.max(5, Number(process.env.SOURCE_HEALTH_DOWN_LIST_LIMIT) || 80);
const authAttemptStore = new Map();
const defaultStaticRoot = path.join(__dirname, '..', 'public');
const configuredStaticRoot = process.env.STATIC_DIR
  ? path.resolve(__dirname, '..', process.env.STATIC_DIR, 'public')
  : defaultStaticRoot;
const STATIC_ROOT = fs.existsSync(configuredStaticRoot) ? configuredStaticRoot : defaultStaticRoot;
const externalJsonCache = createTtlCache({
  ttlMs: 2 * 60 * 1000,
  maxEntries: 700
});
const chapterPagesCache = createTtlCache({
  ttlMs: CHAPTER_PAGES_CACHE_TTL_MS,
  maxEntries: 1500
});
const suwayomiSourcesCache = createTtlCache({
  ttlMs: 5 * 60 * 1000,
  maxEntries: 20
});
const mangaChaptersResponseCache = createTtlCache({
  ttlMs: MANGA_CHAPTERS_RESPONSE_CACHE_TTL_MS,
  maxEntries: 900
});
let sourceHealthLastRefreshAt = 0;

function getExtensionSourceNsfwFlag(sourceId, lang = 'all') {
  const rows = db.prepare(`
    SELECT is_nsfw FROM extension_sources
    WHERE source_id = ? AND lang = ?
    LIMIT 1
  `).all(String(sourceId), String(lang));
  return rows[0]?.is_nsfw === 1;
}

initDb();

app.use(globalLimiter);
app.use(express.json());
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.path.startsWith('/api/image-proxy') || req.path.startsWith('/api/suwayomi-image')) return false;
      return compression.filter(req, res);
    }
  })
);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use('/api', enforceIpBan);
app.use(
  express.static(STATIC_ROOT, {
    etag: true,
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }

      if (filePath.endsWith('.js')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }

      if (filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }

      if (/\.(js|svg|png|jpe?g|webp|avif|woff2?)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      }
    }
  })
);

async function fetchJson(url, options = {}) {
  const cacheKey = String(options.cacheKey || '').trim();
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 120000);

  const runFetch = async () => {
    const timeoutMs = Math.max(2000, Number(options.timeoutMs) || 15000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Quadroz/1.0',
          ...(options.headers && typeof options.headers === 'object' ? options.headers : {})
        }
      });

      if (!response.ok) {
        throw new Error(`Falha ao buscar recurso externo (${response.status}).`);
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  };

  if (!cacheKey) {
    return runFetch();
  }

  return externalJsonCache.wrap(cacheKey, runFetch, ttlMs);
}

function normalizeLanguageCode(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (/^[a-z]{2}(-[a-z]{2})?$/.test(normalized)) {
    return normalized;
  }
  return fallback;
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;

  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return Boolean(fallback);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

function normalizeProfileLanguage(value, fallback = 'pt-br') {
  const normalized = normalizeLanguageCode(value, '');
  if (normalized === 'es' || normalized === 'es-la' || normalized === 'es-419') return 'es';
  if (normalized === 'en') return 'en';
  if (normalized === 'pt' || normalized === 'pt-br') return 'pt-br';
  return fallback;
}

function normalizeDetailLanguage(value, fallback = 'pt-br') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'preferred') return 'preferred';
  if (raw === 'all') return 'all';
  const normalized = normalizeProfileLanguage(raw, '');
  if (SUPPORTED_DETAIL_LANGUAGES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeIpAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const first = raw.split(',')[0].trim();
  if (!first) return '';
  if (first.startsWith('::ffff:')) {
    return first.slice(7);
  }
  if (first === '::1') return '127.0.0.1';
  return first;
}

function getRequestIp(req) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return normalizeIpAddress(xForwardedFor[0]);
  }
  if (typeof xForwardedFor === 'string' && xForwardedFor.trim()) {
    return normalizeIpAddress(xForwardedFor);
  }

  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return normalizeIpAddress(xRealIp);
  }

  return normalizeIpAddress(req.ip || req.socket?.remoteAddress || '');
}

function pruneAuthAttempts(now = Date.now()) {
  for (const [key, value] of authAttemptStore.entries()) {
    if (!value || typeof value !== 'object') {
      authAttemptStore.delete(key);
      continue;
    }

    const failedAt = Array.isArray(value.failedAt) ? value.failedAt : [];
    const active = failedAt.filter((timestamp) => now - Number(timestamp || 0) <= AUTH_ATTEMPT_WINDOW_MS);
    const lockedUntil = Number(value.lockedUntil || 0);
    if (active.length === 0 && lockedUntil <= now) {
      authAttemptStore.delete(key);
      continue;
    }

    value.failedAt = active;
    authAttemptStore.set(key, value);
  }
}

function getAuthAttemptKey(ip, email = '') {
  const normalizedIp = normalizeIpAddress(ip) || 'unknown-ip';
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return `ip:${normalizedIp}`;
  return `ip:${normalizedIp}|email:${normalizedEmail}`;
}

function getAuthAttemptState(key, now = Date.now()) {
  pruneAuthAttempts(now);
  const existing = authAttemptStore.get(key);
  if (!existing) {
    return {
      failedAt: [],
      lockedUntil: 0
    };
  }

  const filtered = Array.isArray(existing.failedAt)
    ? existing.failedAt.filter((timestamp) => now - Number(timestamp || 0) <= AUTH_ATTEMPT_WINDOW_MS)
    : [];

  return {
    failedAt: filtered,
    lockedUntil: Number(existing.lockedUntil || 0)
  };
}

function registerAuthFailure(key, now = Date.now()) {
  const state = getAuthAttemptState(key, now);
  state.failedAt.push(now);
  if (state.failedAt.length >= AUTH_ATTEMPT_MAX_FAILURES) {
    state.lockedUntil = now + AUTH_ATTEMPT_LOCK_MS;
    state.failedAt = [];
  }
  authAttemptStore.set(key, state);
  return state;
}

function clearAuthFailures(key) {
  authAttemptStore.delete(key);
}

function touchUserLastIp(userId, ip) {
  const normalized = normalizeIpAddress(ip);
  if (!Number.isInteger(Number(userId)) || !normalized) return;
  db.prepare('UPDATE users SET last_ip = ? WHERE id = ?').run(normalized, userId);
}

function enforceIpBan(req, res, next) {
  const clientIp = getRequestIp(req);
  req.clientIp = clientIp;

  if (!clientIp) {
    return next();
  }

  const banned = db.prepare('SELECT id FROM banned_ips WHERE ip = ?').get(clientIp);
  if (banned) {
    return res.status(403).json({ error: 'Seu IP foi bloqueado por um administrador.' });
  }

  return next();
}

function parseCategoriesString(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeStatusLabel(value) {
  if (!value) return 'unknown';
  const normalized = String(value).trim().toLowerCase();
  const map = {
    ongoing: 'ongoing',
    completed: 'completed',
    hiatus: 'hiatus',
    cancelled: 'cancelled',
    canceled: 'cancelled'
  };
  return map[normalized] || 'unknown';
}

function normalizeMangaTitleKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeGenreToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeGenreList(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((item) => normalizeGenreToken(item))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function hasTitleInDescription(mangaA, mangaB) {
  const titleA = normalizeMangaTitleKey(mangaA?.title);
  const titleB = normalizeMangaTitleKey(mangaB?.title);
  const descriptionA = normalizeMangaTitleKey(mangaA?.description);
  const descriptionB = normalizeMangaTitleKey(mangaB?.description);

  if (titleA && descriptionB.includes(titleA)) return true;
  if (titleB && descriptionA.includes(titleB)) return true;
  return false;
}

function areEquivalentByGenreAndDescription(mangaA, mangaB) {
  const genresA = normalizeGenreList(mangaA?.genres || []);
  const genresB = normalizeGenreList(mangaB?.genres || []);
  if (genresA.length === 0 || genresB.length === 0) return false;
  if (genresA.length !== genresB.length) return false;
  if (!genresA.every((genre, index) => genre === genresB[index])) return false;
  return hasTitleInDescription(mangaA, mangaB);
}

function dedupeMangaItems(list) {
  const output = [];
  const seenTitles = new Set();

  for (const item of Array.isArray(list) ? list : []) {
    const titleKey = normalizeMangaTitleKey(item?.title);
    if (titleKey && seenTitles.has(titleKey)) {
      // Já temos o mesmo título, elimina repetição.
      // eslint-disable-next-line no-continue
      continue;
    }

    const repeatedByContent = output.some((existing) => areEquivalentByGenreAndDescription(existing, item));
    if (repeatedByContent) {
      // Mesmo mangá com título alternativo, evita duplicata na lista.
      // eslint-disable-next-line no-continue
      continue;
    }

    if (titleKey) seenTitles.add(titleKey);
    output.push(item);
  }

  return output;
}

function mapProfileLanguageToTesteLanguage(language, fallback = 'pt') {
  const normalized = normalizeProfileLanguage(language, 'pt-br');
  if (normalized === 'es') return 'es';
  if (normalized === 'en') return 'en';
  if (normalized === 'pt-br') return 'pt';
  return fallback;
}

function normalizeTesteSourceLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  const normalized = normalizeLanguageCode(raw, raw);
  if (normalized === 'pt' || normalized === 'pt-br') return 'pt-br';
  if (normalized === 'es' || normalized === 'es-la' || normalized === 'es-419') return 'es';
  if (normalized === 'en') return 'en';
  return normalized || '';
}

function buildSuwayomiUrl(pathName, query = null) {
  const safePath = String(pathName || '').startsWith('/') ? String(pathName || '') : `/${String(pathName || '')}`;
  const url = new URL(`${SUWAYOMI_API_BASE}${safePath}`);
  if (query && typeof query === 'object') {
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === undefined || rawValue === null || rawValue === '') continue;
      url.searchParams.set(key, String(rawValue));
    }
  }
  return url.toString();
}

async function fetchSuwayomiJson(pathName, query = null, options = {}) {
  const url = buildSuwayomiUrl(pathName, query);
  const cacheTtl = Math.max(1000, Number(options.ttlMs) || 90_000);
  const skipCache = options.skipCache === true;
  const cacheKey = skipCache ? '' : `suwayomi:${url}`;

  return fetchJson(url, {
    cacheKey,
    ttlMs: cacheTtl,
    timeoutMs: Math.max(2000, Number(options.timeoutMs) || 20_000),
    headers: {
      Accept: 'application/json'
    }
  });
}

function shouldIncludeSuwayomiSourceByLanguage(sourceLang, requestedLanguage) {
  const normalizedRequested = String(requestedLanguage || 'pt').trim().toLowerCase();
  if (normalizedRequested === 'all') return true;

  const normalizedSource = String(sourceLang || '').trim().toLowerCase();
  if (normalizedRequested === 'pt' || normalizedRequested === 'pt-br' || normalizedRequested === 'pt_br') {
    return SUWAYOMI_PT_LANGS.has(normalizedSource);
  }

  return normalizedSource === normalizedRequested;
}

function normalizeSuwayomiSource(rawSource) {
  const sourceId = String(rawSource?.id || '').trim();
  const sourceLang = normalizeTesteSourceLanguage(rawSource?.lang || '');
  const iconPath = String(rawSource?.iconUrl || '').trim();
  return {
    id: sourceId,
    name: String(rawSource?.name || `Fonte ${sourceId || 'Suwayomi'}`).trim(),
    lang: sourceLang,
    icon: iconPath ? `${SUWAYOMI_BASE}${iconPath}` : '',
    supportsLatest: parseBooleanLike(rawSource?.supportsLatest, false)
  };
}

async function fetchSuwayomiSources(language = 'all') {
  const normalizedLanguage = String(language || 'all').trim().toLowerCase() || 'all';
  const allSources = await suwayomiSourcesCache.wrap(
    'all',
    async () => {
      const payload = await fetchSuwayomiJson('/source/list', null, {
        ttlMs: 5 * 60 * 1000,
        timeoutMs: 8000
      });
      return Array.isArray(payload) ? payload : [];
    },
    5 * 60 * 1000
  );

  const mapped = allSources
    .map(normalizeSuwayomiSource)
    .filter((item) => item.id);
  const filtered = mapped.filter((item) => shouldIncludeSuwayomiSourceByLanguage(item.lang, normalizedLanguage));

  return {
    total: filtered.length,
    sources: filtered
  };
}

function normalizeSourceUrl(value) {
  return String(value || '').trim().slice(0, 400);
}

function extractSuwayomiSourceIdFromUrl(sourceUrl) {
  const match = /^suwayomi:\/\/source\/(.+)$/i.exec(String(sourceUrl || '').trim());
  return match ? String(match[1] || '').trim() : '';
}

function normalizeSqlAlias(value) {
  const alias = String(value || 'm').trim();
  if (/^[a-z_][a-z0-9_]*$/i.test(alias)) return alias;
  return 'm';
}

function buildHealthySourceExistsClause(alias = 'm') {
  const safeAlias = normalizeSqlAlias(alias);
  const safeDownHours = Math.max(1, Math.floor(SOURCE_DOWN_BLOCK_HOURS));
  return `EXISTS (
    SELECT 1
    FROM manga_origins mo
    LEFT JOIN source_health sh
      ON sh.source_url = mo.source_url
      AND sh.status = 'down'
      AND sh.last_checked_at >= datetime('now', '-${safeDownHours} hours')
    WHERE mo.manga_id = ${safeAlias}.id
      AND TRIM(mo.source_url) <> ''
      AND TRIM(mo.external_id) <> ''
      AND sh.source_url IS NULL
  )`;
}

function buildDiscoverCatalogWhereParts(alias = 'm') {
  const safeAlias = normalizeSqlAlias(alias);
  return [
    `${safeAlias}.cover_url IS NOT NULL AND TRIM(${safeAlias}.cover_url) <> ''`,
    `EXISTS (SELECT 1 FROM manga_categories mg2 WHERE mg2.manga_id = ${safeAlias}.id)`,
    buildChapterReadySourceExistsClause(safeAlias)
  ];
}

function buildSavedCatalogWhereParts(alias = 'm') {
  const safeAlias = normalizeSqlAlias(alias);
  return buildDiscoverCatalogWhereParts(safeAlias).concat([
    `${safeAlias}.total_chapters > 0`
  ]);
}

// Cache de mangás banidos (refresh a cada 5 minutos)
let bannedMangasCache = { ids: new Set(), updatedAt: 0 };

function invalidateBannedMangasCache() {
  bannedMangasCache.updatedAt = 0;
}

function getBannedMangaIds() {
  const now = Date.now();
  if (now - bannedMangasCache.updatedAt > 5 * 60 * 1000) {
    const rows = db.prepare('SELECT manga_id FROM banned_mangas').all();
    bannedMangasCache = { ids: new Set(rows.map(r => r.manga_id)), updatedAt: now };
  }
  return bannedMangasCache.ids;
}

function isMangaBanned(mangaId) {
  return getBannedMangaIds().has(Number(mangaId));
}

function buildExcludedBannedMangasClause(alias = 'm') {
  const bannedIds = Array.from(getBannedMangaIds());
  const safeAlias = normalizeSqlAlias(alias);
  if (bannedIds.length === 0) return '1=1';
  
  // Usamos uma subquery para garantir consistência total com o banco de dados
  return `${safeAlias}.id NOT IN (SELECT manga_id FROM banned_mangas)`;
}

function buildChapterReadySourceExistsClause(alias = 'm') {
  const safeAlias = normalizeSqlAlias(alias);
  
  // Verifica se existe no cache de fontes OU se existe uma origem salva (manga_origins)
  // Se o mangá for novo (sem cache nem origem), deixamos ele aparecer se tiver cover_url (Discovery)
  return `(
    EXISTS (
      SELECT 1 FROM manga_source_cache sc
      WHERE sc.manga_id = ${safeAlias}.id AND sc.chapter_count > 0
    )
    OR EXISTS (
      SELECT 1 FROM manga_origins mo
      WHERE mo.manga_id = ${safeAlias}.id
    )
    OR (${safeAlias}.cover_url IS NOT NULL AND TRIM(${safeAlias}.cover_url) <> '')
  )`;
}

function upsertSourceHealthStatus(sourceUrl, status, sourceName = '', errorMessage = '') {
  const normalizedUrl = normalizeSourceUrl(sourceUrl);
  if (!normalizedUrl) return;

  const normalizedStatus = status === 'up' || status === 'down' ? status : 'unknown';
  const safeName = String(sourceName || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  const safeError = String(errorMessage || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const initialFailureCount = normalizedStatus === 'down' ? 1 : 0;

  db.prepare(`
    INSERT INTO source_health (
      source_url,
      source_name,
      status,
      failure_count,
      last_error,
      last_checked_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(source_url) DO UPDATE SET
      source_name = CASE
        WHEN excluded.source_name <> '' THEN excluded.source_name
        ELSE source_health.source_name
      END,
      status = excluded.status,
      failure_count = CASE
        WHEN excluded.status = 'down' THEN source_health.failure_count + 1
        ELSE 0
      END,
      last_error = CASE
        WHEN excluded.status = 'down' THEN excluded.last_error
        ELSE ''
      END,
      last_checked_at = excluded.last_checked_at,
      updated_at = excluded.updated_at
  `).run(
    normalizedUrl,
    safeName,
    normalizedStatus,
    initialFailureCount,
    normalizedStatus === 'down' ? safeError : ''
  );
}

function markSourceAsUp(sourceUrl, sourceName = '') {
  upsertSourceHealthStatus(sourceUrl, 'up', sourceName, '');
}

function markSourceAsDown(sourceUrl, sourceName = '', errorMessage = '') {
  upsertSourceHealthStatus(sourceUrl, 'down', sourceName, errorMessage || 'Fonte indisponível.');
}

function getBlockedSourceUrlSet(maxAgeHours = SOURCE_DOWN_BLOCK_HOURS) {
  const safeHours = Math.max(1, Math.floor(Number(maxAgeHours) || SOURCE_DOWN_BLOCK_HOURS));
  const rows = db.prepare(`
    SELECT source_url
    FROM source_health
    WHERE status = 'down'
      AND last_checked_at >= datetime('now', '-${safeHours} hours')
  `).all();

  return new Set(
    rows
      .map((row) => normalizeSourceUrl(row?.source_url))
      .filter(Boolean)
  );
}

function getSourceHealthSummary(limit = SOURCE_HEALTH_DOWN_LIST_LIMIT) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || SOURCE_HEALTH_DOWN_LIST_LIMIT));
  const safeHours = Math.max(1, Math.floor(SOURCE_DOWN_BLOCK_HOURS));

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS checked_count,
      SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up_count,
      SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down_count,
      SUM(CASE
        WHEN status = 'down' AND last_checked_at >= datetime('now', '-${safeHours} hours')
          THEN 1
        ELSE 0
      END) AS blocked_count
    FROM source_health
  `).get();

  const downRows = db.prepare(`
    SELECT
      source_url,
      source_name,
      failure_count,
      last_error,
      last_checked_at,
      updated_at
    FROM source_health
    WHERE status = 'down'
    ORDER BY last_checked_at DESC
    LIMIT ?
  `).all(safeLimit);

  return {
    checkedCount: Math.max(0, Number(totals?.checked_count) || 0),
    upCount: Math.max(0, Number(totals?.up_count) || 0),
    downCount: Math.max(0, Number(totals?.down_count) || 0),
    blockedCount: Math.max(0, Number(totals?.blocked_count) || 0),
    downSources: downRows.map((row) => ({
      sourceUrl: normalizeSourceUrl(row?.source_url),
      sourceName: String(row?.source_name || '').trim(),
      failureCount: Math.max(0, Number(row?.failure_count) || 0),
      lastError: String(row?.last_error || '').trim(),
      lastCheckedAt: row?.last_checked_at || null,
      updatedAt: row?.updated_at || null
    }))
  };
}

async function refreshSuwayomiSourceHealthSnapshot(options = {}) {
  const force = options.force === true;
  const now = Date.now();
  if (!force && now - sourceHealthLastRefreshAt < SOURCE_HEALTH_REFRESH_TTL_MS) {
    return;
  }

  let sourceMap;
  try {
    sourceMap = await fetchTesteSourcesMap('all');
  } catch {
    return;
  }

  const suwayomiSources = db.prepare(`
    SELECT
      source_url,
      MAX(CASE WHEN TRIM(source_name) <> '' THEN source_name ELSE '' END) AS source_name
    FROM manga_origins
    WHERE source_url LIKE 'suwayomi://source/%'
    GROUP BY source_url
  `).all();

  suwayomiSources.forEach((row) => {
    const sourceUrl = normalizeSourceUrl(row?.source_url);
    const sourceId = extractSuwayomiSourceIdFromUrl(sourceUrl);
    if (!sourceUrl || !sourceId) return;

    const sourceInfo = sourceMap.get(sourceId);
    const fallbackName = String(row?.source_name || `Fonte ${sourceId}`).trim() || `Fonte ${sourceId}`;
    if (sourceInfo) {
      markSourceAsUp(sourceUrl, sourceInfo.name || fallbackName);
    } else {
      markSourceAsDown(sourceUrl, fallbackName, 'Fonte não encontrada no Suwayomi.');
    }
  });

  const knownHttpSources = db.prepare(`
    SELECT
      source_url,
      MAX(CASE WHEN TRIM(source_name) <> '' THEN source_name ELSE '' END) AS source_name
    FROM manga_origins
    WHERE source_url LIKE 'http://%' OR source_url LIKE 'https://%'
    GROUP BY source_url
  `).all();

  knownHttpSources.forEach((row) => {
    const sourceUrl = normalizeSourceUrl(row?.source_url);
    if (!sourceUrl) return;
    if (sourceUrl.includes('mangadex.org')) {
      markSourceAsUp(sourceUrl, row?.source_name || 'MangaDex');
    }
  });

  sourceHealthLastRefreshAt = now;
}

function runTasksWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Math.min(items.length || 1, Number(concurrency) || 1));
  const output = new Array(items.length);
  let cursor = 0;

  const launch = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      // eslint-disable-next-line no-await-in-loop
      output[index] = await worker(items[index], index);
    }
  };

  return Promise.all(Array.from({ length: safeConcurrency }, () => launch())).then(() => output);
}

function normalizeSuwayomiCoverUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  const direct = normalizeExternalImageUrl(raw);
  if (direct) return direct;
  const normalizedPath = raw.startsWith('/') ? raw : `/${raw}`;
  return normalizeExternalImageUrl(`${SUWAYOMI_BASE}${normalizedPath}`);
}

function normalizeSuwayomiGenres(rawValue) {
  if (Array.isArray(rawValue)) return rawValue.map((item) => String(item || '').trim()).filter(Boolean);
  const raw = String(rawValue || '').trim();
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

function formatSuwayomiManga(rawManga, sourceMeta = null) {
  const sourceId = String(rawManga?.sourceId || rawManga?.source_id || sourceMeta?.id || '').trim();
  const genres = normalizeSuwayomiGenres(rawManga?.genre);
  const nsfwGenres = ['hentai', 'ecchi', 'doujin', 'adult', '18+', '+18', 'uncensored', 'loli', 'shota', 'sexual violence', 'incest', 'rape', 'netorare', 'ntr', 'yaoi', 'yuri', 'smut'];
  const isNsfw = genres.some(g => nsfwGenres.includes(g.toLowerCase()));
  return {
    id: String(rawManga?.id || '').trim(),
    title: String(rawManga?.title || '').trim(),
    description: String(rawManga?.description || '').trim(),
    cover: normalizeSuwayomiCoverUrl(rawManga?.thumbnailUrl || rawManga?.cover),
    status: rawManga?.status || 'unknown',
    author: String(rawManga?.author || '').trim(),
    genre: genres,
    source_id: sourceId,
    source_name: sourceMeta?.name || '',
    lang: sourceMeta?.lang || normalizeTesteSourceLanguage(rawManga?.lang || ''),
    url: String(rawManga?.url || '').trim(),
    in_library: Boolean(rawManga?.inLibrary || rawManga?.in_library),
    nsfw: isNsfw
  };
}

function formatSuwayomiChapter(rawChapter) {
  const chapterId = String(rawChapter?.id || '').trim();
  const chapterRouteIndex = Number(rawChapter?.index);
  const chapterNumber = Number(rawChapter?.chapterNumber);
  const pageCount = Number(rawChapter?.pageCount);
  const uploadDate = Number(rawChapter?.uploadDate);

  return {
    id: chapterId,
    chapter_id: chapterId,
    chapter_index: Number.isFinite(chapterRouteIndex) ? Math.round(chapterRouteIndex) : null,
    index: Number.isFinite(chapterNumber) ? chapterNumber : null,
    name: String(rawChapter?.name || '').trim(),
    date_upload: Number.isFinite(uploadDate) ? uploadDate : 0,
    scanlator: String(rawChapter?.scanlator || '').trim(),
    read: Boolean(rawChapter?.read),
    pages: Number.isFinite(pageCount) && pageCount > 0 ? Math.round(pageCount) : 0
  };
}

function cacheSuwayomiChapterRef(mangaExternalId, chapterRef, chapterRouteIndex, pageCount = 0) {
  const mangaId = String(mangaExternalId || '').trim();
  const ref = String(chapterRef || '').trim();
  const routeIndex = Number(chapterRouteIndex);
  const pages = Number(pageCount);
  if (!mangaId || !ref || !Number.isInteger(routeIndex) || routeIndex < 0) return;

  db.prepare(`
    INSERT INTO suwayomi_chapter_refs (
      manga_external_id,
      chapter_ref,
      chapter_route_index,
      page_count,
      updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(manga_external_id, chapter_ref) DO UPDATE SET
      chapter_route_index = excluded.chapter_route_index,
      page_count = CASE
        WHEN excluded.page_count > 0 THEN excluded.page_count
        ELSE suwayomi_chapter_refs.page_count
      END,
      updated_at = excluded.updated_at
  `).run(mangaId, ref, routeIndex, Number.isFinite(pages) && pages > 0 ? Math.round(pages) : 0);
}

function readCachedSuwayomiChapterRef(mangaExternalId, chapterRef) {
  const mangaId = String(mangaExternalId || '').trim();
  const ref = String(chapterRef || '').trim();
  if (!mangaId || !ref) return null;

  return db.prepare(`
    SELECT chapter_route_index, page_count
    FROM suwayomi_chapter_refs
    WHERE manga_external_id = ? AND chapter_ref = ?
    LIMIT 1
  `).get(mangaId, ref);
}

async function searchSuwayomiCatalog(query, options = {}) {
  const searchTerm = String(query || '').trim();
  if (!searchTerm) {
    return {
      query: '',
      page: 1,
      total: 0,
      results: [],
      errors: []
    };
  }

  const page = Math.max(1, Number(options.page) || 1);
  const requestedSourceId = String(options.sourceId || '').trim();
  const requestedLanguage = String(options.lang || 'pt').trim().toLowerCase() || 'pt';
  const sourcePayload = await fetchSuwayomiSources('all');
  const sourceMap = new Map(sourcePayload.sources.map((source) => [source.id, source]));

  let selectedSources;
  if (requestedSourceId) {
    const source = sourceMap.get(requestedSourceId) || {
      id: requestedSourceId,
      name: `Fonte ${requestedSourceId}`,
      lang: '',
      supportsLatest: false
    };
    selectedSources = [source];
  } else {
    selectedSources = sourcePayload.sources
      .filter((source) => shouldIncludeSuwayomiSourceByLanguage(source.lang, requestedLanguage))
      .sort((a, b) => {
        const latestDiff = Number(b.supportsLatest) - Number(a.supportsLatest);
        if (latestDiff !== 0) return latestDiff;
        return String(a.name).localeCompare(String(b.name), 'pt-BR');
      })
      .slice(0, SUWAYOMI_SEARCH_MAX_SOURCES);
  }

  const results = [];
  const errors = [];

  await runTasksWithConcurrency(selectedSources, SUWAYOMI_SEARCH_CONCURRENCY, async (source) => {
    try {
      const payload = await fetchSuwayomiJson(`/source/${encodeURIComponent(source.id)}/search`, {
        searchTerm,
        page
      }, {
        ttlMs: 60_000,
        timeoutMs: 12_000
      });

      const mangas = Array.isArray(payload?.mangaList) ? payload.mangaList : [];
      mangas.forEach((rawManga) => {
        const formatted = formatSuwayomiManga(rawManga, source);
        if (!formatted.id || !formatted.source_id) return;
        results.push(formatted);
      });
    } catch (error) {
      errors.push({
        source_id: source.id,
        error: String(error?.message || error)
      });
    }
    return null;
  });

  return {
    query: searchTerm,
    page,
    total: results.length,
    results,
    errors
  };
}

async function fetchSuwayomiPopularBySource(sourceId, page = 1) {
  const normalizedSourceId = String(sourceId || '').trim();
  if (!normalizedSourceId) {
    return {
      source_id: '',
      page: 1,
      has_next: false,
      total: 0,
      results: []
    };
  }

  const sourcePayload = await fetchSuwayomiSources('all');
  const source = sourcePayload.sources.find((item) => item.id === normalizedSourceId) || {
    id: normalizedSourceId,
    name: `Fonte ${normalizedSourceId}`,
    lang: '',
    supportsLatest: false
  };

  const safePage = Math.max(1, Number(page) || 1);
  const payload = await fetchSuwayomiJson(`/source/${encodeURIComponent(normalizedSourceId)}/popular/${safePage}`, null, {
    ttlMs: 90_000,
    timeoutMs: 12_000
  });
  const mangaList = Array.isArray(payload?.mangaList) ? payload.mangaList : [];
  const results = mangaList
    .map((rawManga) => formatSuwayomiManga(rawManga, source))
    .filter((item) => item.id && item.source_id);

  return {
    source_id: normalizedSourceId,
    page: safePage,
    has_next: Boolean(payload?.hasNextPage),
    total: results.length,
    results
  };
}

async function fetchSuwayomiLatestBySource(sourceId, page = 1) {
  const normalizedSourceId = String(sourceId || '').trim();
  if (!normalizedSourceId) {
    return {
      source_id: '',
      page: 1,
      has_next: false,
      total: 0,
      results: []
    };
  }

  const sourcePayload = await fetchSuwayomiSources('all');
  const source = sourcePayload.sources.find((item) => item.id === normalizedSourceId) || {
    id: normalizedSourceId,
    name: `Fonte ${normalizedSourceId}`,
    lang: '',
    supportsLatest: false
  };

  const safePage = Math.max(1, Number(page) || 1);
  const payload = await fetchSuwayomiJson(`/source/${encodeURIComponent(normalizedSourceId)}/latest/${safePage}`, null, {
    ttlMs: 90_000,
    timeoutMs: 12_000
  });
  const mangaList = Array.isArray(payload?.mangaList) ? payload.mangaList : [];
  const results = mangaList
    .map((rawManga) => formatSuwayomiManga(rawManga, source))
    .filter((item) => item.id && item.source_id);

  return {
    source_id: normalizedSourceId,
    page: safePage,
    has_next: Boolean(payload?.hasNextPage),
    total: results.length,
    results
  };
}

async function fetchSuwayomiMangaChapters(mangaExternalId, order = 'desc', options = {}) {
  const mangaId = String(mangaExternalId || '').trim();
  const normalizedOrder = String(order || 'desc').trim().toLowerCase();
  if (!mangaId) {
    return {
      manga_id: '',
      total: 0,
      chapters: []
    };
  }

  const payload = await fetchSuwayomiJson(`/manga/${encodeURIComponent(mangaId)}/chapters`, null, {
    ttlMs: 5 * 60 * 1000,
    skipCache: options.skipCache
  });
  const chapters = (Array.isArray(payload) ? payload : [])
    .map(formatSuwayomiChapter)
    .filter((chapter) => chapter.chapter_id);

  const tx = db.transaction(() => {
    chapters.forEach((chapter) => {
      if (!Number.isInteger(chapter.chapter_index)) return;
      cacheSuwayomiChapterRef(mangaId, chapter.chapter_id, chapter.chapter_index, chapter.pages);
    });
  });
  tx();

  chapters.sort((a, b) => {
    const aNumber = Number(a.index);
    const bNumber = Number(b.index);
    const aSortable = Number.isFinite(aNumber) ? aNumber : 0;
    const bSortable = Number.isFinite(bNumber) ? bNumber : 0;
    return normalizedOrder === 'asc' ? aSortable - bSortable : bSortable - aSortable;
  });

  return {
    manga_id: mangaId,
    total: chapters.length,
    chapters
  };
}

async function resolveSuwayomiChapterRouteIndex(mangaExternalId, chapterRef, explicitRouteIndex = null, skipCache = false) {
  const mangaId = String(mangaExternalId || '').trim();
  const ref = String(chapterRef || '').trim();
  
  if (explicitRouteIndex !== null && explicitRouteIndex !== undefined && explicitRouteIndex !== '') {
    const routeIndexCandidate = Number(explicitRouteIndex);
    if (Number.isInteger(routeIndexCandidate) && routeIndexCandidate >= 0) {
      return routeIndexCandidate;
    }
  }

  if (!skipCache) {
    const cached = readCachedSuwayomiChapterRef(mangaId, ref);
    if (Number.isInteger(Number(cached?.chapter_route_index)) && Number(cached.chapter_route_index) >= 0) {
      return Number(cached.chapter_route_index);
    }
  }

  const chapterPayload = await fetchSuwayomiMangaChapters(mangaId, 'desc', { skipCache });
  const chapters = Array.isArray(chapterPayload?.chapters) ? chapterPayload.chapters : [];
  
  let chapter = chapters.find((item) => String(item.chapter_id || '').trim() === ref);

  if (!chapter) {
    const refNumeric = Number(ref);
    if (Number.isFinite(refNumeric)) {
      chapter = chapters.find((item) => Number(item.index) === refNumeric) || null;
    }
  }

  if (!chapter || !Number.isInteger(chapter.chapter_index) || chapter.chapter_index < 0) {
    throw new Error('Capítulo não encontrado');
  }

  cacheSuwayomiChapterRef(mangaId, ref, chapter.chapter_index, chapter.pages);
  return chapter.chapter_index;
}

async function fetchSuwayomiChapterPages(mangaExternalId, chapterRef, options = {}) {
  const mangaId = String(mangaExternalId || '').trim();
  const ref = String(chapterRef || '').trim();
  if (!mangaId || !ref) {
    throw new Error('Parâmetros de capítulo inválidos.');
  }

  let routeIndex = await resolveSuwayomiChapterRouteIndex(mangaId, ref, options.routeIndex);
  let chapterDetails;
  let lastError;
  
  const tryFetch = async (idx) => {
    return fetchSuwayomiJson(`/manga/${encodeURIComponent(mangaId)}/chapter/${idx}`, null, {
      ttlMs: 0,
      skipCache: true,
      timeoutMs: 15_000
    });
  };

  try {
    chapterDetails = await tryFetch(routeIndex);
  } catch (err) {
    lastError = err;
    // Se falhar (404 ou 500), tentamos re-sincronizar os capítulos e buscar pelo ref ou número
    try {
      console.log(`[fetchPages] Falha no índice ${routeIndex} (${err.message}). Tentando re-resolver...`);
      routeIndex = await resolveSuwayomiChapterRouteIndex(mangaId, ref, null, true);
      chapterDetails = await tryFetch(routeIndex);
    } catch (err2) {
      // Se ainda falhar, tentamos uma última vez buscando o capítulo pelo número (caso o ID tenha mudado)
      try {
        const list = await fetchSuwayomiMangaChapters(mangaId, 'desc', { skipCache: true });
        const found = list.chapters.find(c => String(c.chapter_id) === ref || String(c.id) === ref);
        if (found && Number.isInteger(found.chapter_index) && found.chapter_index !== routeIndex) {
          routeIndex = found.chapter_index;
          chapterDetails = await tryFetch(routeIndex);
        } else {
          throw err2;
        }
      } catch (err3) {
        throw new Error(`O Suwayomi retornou um erro ao carregar este capítulo (Fonte: ${mangaId}, Cap: ${ref}). Detalhes: ${err.message}`);
      }
    }
  }

  if (!chapterDetails) {
    throw new Error(`O Suwayomi retornou um erro ao carregar este capítulo (Fonte: ${mangaId}, Cap: ${ref}). Detalhes: ${lastError?.message || 'Erro desconhecido'}`);
  }

  let pageCount = Number(chapterDetails?.pageCount);
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const probe = await fetch(`${SUWAYOMI_API_BASE}/manga/${encodeURIComponent(mangaId)}/chapter/${routeIndex}/page/0`, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Quadroz/1.0',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
          }
        });
        if (probe.ok) {
          const updatedDetails = await fetchSuwayomiJson(`/manga/${encodeURIComponent(mangaId)}/chapter/${routeIndex}`, null, {
            ttlMs: 60_000,
            timeoutMs: 12_000,
            skipCache: true
          });
          if (updatedDetails) {
            chapterDetails = updatedDetails;
            pageCount = Number(chapterDetails?.pageCount);
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Ignorar erro do probe
    }
  }

  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    throw new Error('Páginas não disponíveis para este capítulo');
  }

  const safePageCount = Math.max(1, Math.round(pageCount));
  const pages = Array.from({ length: safePageCount }, (_item, index) => ({
    index: index + 1,
    url: `${SUWAYOMI_API_BASE}/manga/${encodeURIComponent(mangaId)}/chapter/${routeIndex}/page/${index}`
  }));

  cacheSuwayomiChapterRef(mangaId, ref, routeIndex, safePageCount);
  const chapterDetailsId = String(chapterDetails?.id || '').trim();
  if (chapterDetailsId && chapterDetailsId !== ref) {
    cacheSuwayomiChapterRef(mangaId, chapterDetailsId, routeIndex, safePageCount);
  }

  return {
    manga_id: mangaId,
    chapter_ref: ref,
    chapter_index: chapterDetails?.chapterNumber ?? null,
    chapter_id: chapterDetailsId || ref,
    chapter_route_index: routeIndex,
    chapter_name: String(chapterDetails?.name || '').trim(),
    total_pages: pages.length,
    pages
  };
}

async function fetchTesteJson(pathName, query = null, options = {}) {
  const safePath = String(pathName || '').startsWith('/') ? String(pathName || '') : `/${String(pathName || '')}`;

  if (safePath === '/sources') {
    return fetchSuwayomiSources(query?.lang || 'all');
  }

  if (safePath === '/search') {
    return searchSuwayomiCatalog(query?.q || '', {
      sourceId: query?.source_id,
      page: query?.page,
      lang: query?.lang || 'all'
    });
  }

  if (safePath === '/popular') {
    return fetchSuwayomiPopularBySource(query?.source_id, query?.page);
  }

  if (safePath === '/latest') {
    return fetchSuwayomiLatestBySource(query?.source_id, query?.page);
  }

  const chaptersMatch = /^\/manga\/([^/]+)\/chapters$/i.exec(safePath);
  if (chaptersMatch) {
    return fetchSuwayomiMangaChapters(decodeURIComponent(chaptersMatch[1]), query?.order || 'desc');
  }

  const chapterPagesMatch = /^\/manga\/([^/]+)\/chapter\/([^/]+)$/i.exec(safePath);
  if (chapterPagesMatch) {
    return fetchSuwayomiChapterPages(
      decodeURIComponent(chapterPagesMatch[1]),
      decodeURIComponent(chapterPagesMatch[2]),
      {
        routeIndex: query?.routeIndex ?? query?.chapter_route_index ?? options.routeIndex
      }
    );
  }

  throw new Error(`Endpoint Suwayomi não suportado: ${safePath}`);
}

function serializeMangaRow(row) {
  const genres = parseCategoriesString(row.genres ?? row.categories);
  const categories = parseCategoriesString(row.user_categories);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    author: row.author,
    coverUrl: buildImageProxyUrl(row.cover_url) || row.cover_url,
    totalChapters: row.total_chapters,
    favoriteCount: row.favorite_count || 0,
    isFavorited: Boolean(row.is_favorited),
    inLibrary: Boolean(row.in_library),
    publicationStatus: row.publication_status || 'unknown',
    sourceLang: row.source_lang || '',
    chaptersConsistent: row.chapters_consistent === 1,
    genres,
    categories,
    isNsfw: row.is_nsfw === 1
  };
}

function getMangaOrigins(mangaId) {
  return db
    .prepare(`
      SELECT source_name, source_url, external_id
      FROM manga_origins
      WHERE manga_id = ?
      ORDER BY CASE WHEN source_url LIKE '%mangadex.org%' THEN 0 ELSE 1 END, imported_at DESC
    `)
    .all(mangaId);
}

function findMangaByNormalizedTitle(normalizedTitle) {
  if (!normalizedTitle) return null;
  return db
    .prepare('SELECT id FROM mangas WHERE normalized_title = ? ORDER BY id ASC LIMIT 1')
    .get(normalizedTitle);
}

function buildUniqueMangaTitle(baseTitle, externalId) {
  const fallback = `Mangá ${externalId || Date.now()}`;
  const normalized = String(baseTitle || '').trim();
  const safeBase = normalized || fallback;
  let candidate = safeBase.slice(0, 200);
  let suffix = 2;

  while (db.prepare('SELECT id FROM mangas WHERE title = ?').get(candidate)) {
    const nextSuffix = ` (${suffix})`;
    const maxBaseLength = Math.max(1, 200 - nextSuffix.length);
    candidate = `${safeBase.slice(0, maxBaseLength)}${nextSuffix}`;
    suffix += 1;
  }

  return candidate;
}

function upsertSuwayomiManga(rawManga, sourceLang = '') {
  const externalId = String(rawManga?.id || '').trim();
  const sourceId = String(rawManga?.source_id || '').trim();
  if (!externalId || !sourceId) return null;

  const sourceUrl = `suwayomi://source/${sourceId}`;
  const sourceName = String(rawManga?.source_name || `Suwayomi ${sourceId}`).trim();
  const normalizedTitle = normalizeMangaTitleKey(rawManga?.title);
  const title = String(rawManga?.title || '').trim();
  const description = String(rawManga?.description || '').trim() || 'Sem descrição disponível.';
  const author = String(rawManga?.author || '').trim() || 'Autor desconhecido';
  const coverUrl = normalizeExternalImageUrl(rawManga?.cover || '');
  const publicationStatus = normalizeStatusLabel(rawManga?.status);
  const normalizedSourceLang = normalizeTesteSourceLanguage(sourceLang || rawManga?.lang || '');

  const existingOrigin = db
    .prepare('SELECT manga_id FROM manga_origins WHERE source_url = ? AND external_id = ?')
    .get(sourceUrl, externalId);

  let mangaId = Number(existingOrigin?.manga_id || 0);
  if (!Number.isInteger(mangaId) || mangaId < 1) {
    const byNormalizedTitle = findMangaByNormalizedTitle(normalizedTitle);
    mangaId = Number(byNormalizedTitle?.id || 0);
  }

  if (!Number.isInteger(mangaId) || mangaId < 1) {
    const uniqueTitle = buildUniqueMangaTitle(title, externalId);
    const insert = db.prepare(`
      INSERT INTO mangas (
        title,
        normalized_title,
        description,
        author,
        cover_url,
        publication_status,
        source_lang,
        total_chapters,
        chapters_consistent,
        last_synced_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, datetime('now'))
    `).run(
      uniqueTitle,
      normalizedTitle || normalizeMangaTitleKey(uniqueTitle),
      description,
      author,
      coverUrl || null,
      publicationStatus,
      normalizedSourceLang || null
    );
    mangaId = Number(insert.lastInsertRowid);
  }

  if (!Number.isInteger(mangaId) || mangaId < 1) return null;

  const allGenres = [
    ...(rawManga?.genre || rawManga?.genres || []),
    ...(rawManga?.tags || [])
  ];
  const genreHasNsfw = Array.isArray(allGenres) && allGenres.some(g => isNsfwCategoryName(g));

  db.prepare(`
    UPDATE mangas
    SET
      title = COALESCE(NULLIF(?, ''), title),
      normalized_title = COALESCE(NULLIF(?, ''), normalized_title),
      description = COALESCE(NULLIF(?, ''), description),
      author = COALESCE(NULLIF(?, ''), author),
      cover_url = COALESCE(NULLIF(?, ''), cover_url),
      publication_status = COALESCE(NULLIF(?, ''), publication_status),
      source_lang = COALESCE(NULLIF(?, ''), source_lang),
      is_nsfw = CASE WHEN ? = 1 OR is_nsfw = 1 THEN 1 ELSE 0 END,
      last_synced_at = datetime('now')
    WHERE id = ?
  `).run(
    title,
    normalizedTitle,
    description,
    author,
    coverUrl,
    publicationStatus,
    normalizedSourceLang,
    genreHasNsfw ? 1 : 0,
    mangaId
  );

  if (normalizedSourceLang) {
    db.prepare('INSERT OR IGNORE INTO manga_languages (manga_id, language) VALUES (?, ?)')
      .run(mangaId, normalizedSourceLang);
  }

  upsertMangaOrigin(mangaId, sourceName, sourceUrl, externalId);
  const runtimeAliases = extractAlternativeTitlesFromRawPayload(rawManga, 24);
  if (runtimeAliases.length > 0) {
    saveMangaAliases(mangaId, runtimeAliases, 'suwayomi-runtime');
  }
  return mangaId;
}

function fetchSerializedMangasByIds(mangaIds, userId) {
  const uniqueIds = Array.from(new Set(mangaIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0)));
  if (uniqueIds.length === 0) return [];

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.manga_id = m.id) AS is_favorited,
        EXISTS(SELECT 1 FROM library_entries le WHERE le.user_id = ? AND le.manga_id = m.id) AS in_library,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.manga_id = m.id AND umc.user_id = ?
        ) AS user_categories
      FROM mangas m
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE m.id IN (${placeholders})
      GROUP BY m.id
    `)
    .all(userId, userId, userId, ...uniqueIds);

  const byId = new Map(rows.map((row) => [Number(row.id), serializeMangaRow(row)]));
  return uniqueIds.map((id) => byId.get(id)).filter(Boolean);
}

function buildUserGenreAffinity(userId) {
  const targetUserId = Number(userId);
  if (!Number.isInteger(targetUserId) || targetUserId < 1) return new Map();

  const rows = db.prepare(`
    SELECT
      c.name AS genre_name,
      SUM(src.weight) AS affinity
    FROM (
      SELECT f.manga_id, 5 AS weight
      FROM favorites f
      WHERE f.user_id = ?
      UNION ALL
      SELECT le.manga_id, 3 AS weight
      FROM library_entries le
      WHERE le.user_id = ?
      UNION ALL
      SELECT DISTINCT rh.manga_id, 2 AS weight
      FROM reading_history rh
      WHERE rh.user_id = ?
      UNION ALL
      SELECT DISTINCT umc.manga_id, 2 AS weight
      FROM user_manga_categories umc
      WHERE umc.user_id = ?
    ) src
    JOIN manga_categories mc ON mc.manga_id = src.manga_id
    JOIN categories c ON c.id = mc.category_id
    GROUP BY c.name
  `).all(targetUserId, targetUserId, targetUserId, targetUserId);

  const affinity = new Map();
  rows.forEach((row) => {
    const key = normalizeGenreToken(row?.genre_name || '');
    const score = Math.max(0, Number(row?.affinity) || 0);
    if (!key || score <= 0) return;
    affinity.set(key, score);
  });
  return affinity;
}

function weightedRandomPick(items, limit) {
  const source = Array.isArray(items) ? items.slice() : [];
  const targetLimit = Math.max(1, Number(limit) || 1);
  const picked = [];

  while (source.length > 0 && picked.length < targetLimit) {
    const totalWeight = source.reduce((acc, item) => acc + Math.max(0.01, Number(item?.weight) || 0.01), 0);
    let cursor = Math.random() * totalWeight;
    let selectedIndex = 0;

    for (let index = 0; index < source.length; index += 1) {
      cursor -= Math.max(0.01, Number(source[index]?.weight) || 0.01);
      if (cursor <= 0) {
        selectedIndex = index;
        break;
      }
    }

    const [selected] = source.splice(selectedIndex, 1);
    if (selected) {
      picked.push(selected);
    }
  }

  return picked;
}

function buildRecommendedMangas(userId, limit = 16, random = false) {
  const targetLimit = Math.max(1, Math.min(40, Number(limit) || 16));
  const targetUserId = Number(userId);
  const isLoggedIn = targetUserId > 0;
  
  const baseWhereParts = buildSavedCatalogWhereParts('m').concat([
    buildChapterReadySourceExistsClause('m'),
    buildExcludedBannedMangasClause('m')
  ]);
  const baseWhereParams = [];

  const rows = db.prepare(`
    SELECT
      m.id,
      m.title,
      m.description,
      m.author,
      m.cover_url,
      m.total_chapters,
      m.publication_status,
      m.source_lang,
      m.chapters_consistent,
      COALESCE(fc.favorite_count, 0) AS favorite_count,
      EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.manga_id = m.id) AS is_favorited,
      EXISTS(SELECT 1 FROM library_entries le WHERE le.user_id = ? AND le.manga_id = m.id) AS in_library,
      GROUP_CONCAT(DISTINCT g.name) AS genres,
      COALESCE(m.last_synced_at, m.created_at) AS synced_at
    FROM mangas m
    LEFT JOIN (
      SELECT manga_id, COUNT(*) AS favorite_count
      FROM favorites
      GROUP BY manga_id
    ) fc ON fc.manga_id = m.id
    LEFT JOIN manga_categories mg ON mg.manga_id = m.id
    LEFT JOIN categories g ON g.id = mg.category_id
    WHERE ${baseWhereParts.join(' AND ')}
    GROUP BY m.id
    ORDER BY ${random ? 'random()' : 'm.id DESC'}
    LIMIT ${random ? targetLimit : 100}
  `).all(targetUserId || -1, targetUserId || -1, ...baseWhereParams);

  const serialized = rows.map((row) => serializeMangaRow(row));
  const deduped = dedupeMangaItems(serialized);

  return deduped.slice(0, targetLimit);
}

function normalizeChapterNumber(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function ensureUserPreference(userId) {
  db.prepare(`
    INSERT INTO user_preferences (user_id, preferred_language, nsfw_protection, updated_at)
    VALUES (?, 'pt-br', 1, datetime('now'))
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId);
}

function getUserPreferredLanguage(userId) {
  if (!userId) return 'pt-br';
  ensureUserPreference(userId);
  const row = db.prepare('SELECT preferred_language FROM user_preferences WHERE user_id = ?').get(userId);
  return normalizeProfileLanguage(row?.preferred_language, 'pt-br');
}

const NSFW_CATEGORIES = [
  // Gêneros H/NSFW principais
  'Hentai', 'Ecchi', 'Doujin', 'Adult', '18+', '+18', 'Uncensored', 'Mature',
  'Smut', 'Erotic', 'Lewd', 'Porn', 'Pornographic', 'Sex', 'Sexual', 'Sexo Explicito',
  // Conteúdo explícito
  'Anal', 'Anal Sex', 'Analingus', 'Blowjob', 'Blowjobs', 'Cum', 'Cumshot', 'Cumshots',
  'Creampie', 'Deepthroat', 'Double Penetration', 'Fisting', 'Gangbang', 'Group Sex',
  'Masturbation', 'Oral Sex', 'Vaginal', 'Penis', 'Pussy', 'Cock', 'Bukkake',
  'Footjob', 'Paizuri', 'Tentacles', 'Lactation',
  // Conteúdo adulto/tema
  'Bdsm', 'Bondage', 'Domination', 'Submission', 'Futanari', 'Futa',
  'Milf', 'Gyaru', 'Monster Girl', 'Monster Girls',
  'Transformation', 'Hypnosis', 'Mind Control', 'Hypno',
  'Pregnant', 'Pregnancy', 'Exhibitionism', 'Voyeurism',
  'Slut', 'Whore', 'Netorare', 'NTR', 'Cuckold',
  'Ugly Bastard', 'Adults Only', 'Suggestive',
  // Conteúdo extremo/proibido
  'Incest', 'Rape', 'Sexual Violence', 'Bestiality', 'Necrophilia',
  'Loli', 'Lolicon', 'Shota', 'Shotacon', 'Toddler', 'Preteen', 'Preteen Girls',
  'Grooming',
  // Boys Love / Girls Love
  'Yaoi', 'Yuri', 'BL', 'GL', 'Girls Love', 'Boys Love',
  // Outros
  'Trap', 'Femboy', 'Crossdressing',
  // Novos termos detectados
  'Small Tits', 'Big Tits', 'Boobs', 'Tits', 'Amateur', 'Straight Sex', 'Hot'
];

function isNsfwCategoryName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return NSFW_CATEGORIES.some(nsfw => lower.includes(nsfw.toLowerCase()));
}

function getUserNsfwProtection(userId) {
  if (!userId) return 1;
  ensureUserPreference(userId);
  const row = db.prepare('SELECT nsfw_protection FROM user_preferences WHERE user_id = ?').get(userId);
  return row?.nsfw_protection ?? 1;
}

function setUserNsfwProtection(userId, value) {
  if (!userId) return;
  ensureUserPreference(userId);
  db.prepare(`
    UPDATE user_preferences SET nsfw_protection = ?, updated_at = datetime('now') WHERE user_id = ?
  `).run(value ? 1 : 0, userId);
}

function buildLanguagePreference(primary) {
  const normalizedPrimary = normalizeProfileLanguage(primary, 'pt-br');
  let candidates;
  if (normalizedPrimary === 'en') {
    candidates = ['en', 'es', 'pt-br', 'pt'];
  } else if (normalizedPrimary === 'es') {
    candidates = ['es', 'en', 'pt-br', 'pt'];
  } else {
    candidates = ['pt-br', 'pt', 'en', 'es'];
  }
  const unique = [];
  for (const lang of candidates) {
    if (!lang) continue;
    if (!unique.includes(lang)) unique.push(lang);
  }
  return unique;
}

function buildLanguagePriority(languages) {
  const map = new Map();
  languages.forEach((lang, index) => map.set(lang, index));
  return (lang) => {
    if (map.has(lang)) return map.get(lang);
    return 999;
  };
}

function appendCategoryFilter(whereParts, params, category, alias = 'm') {
  const value = String(category || '').trim();
  if (!value) return;

  if (/^\d+$/.test(value)) {
    whereParts.push(`EXISTS (SELECT 1 FROM manga_categories mc2 WHERE mc2.manga_id = ${alias}.id AND mc2.category_id = ?)`);
    params.push(Number(value));
    return;
  }

  whereParts.push(`EXISTS (
    SELECT 1
    FROM manga_categories mc2
    JOIN categories c2 ON c2.id = mc2.category_id
    WHERE mc2.manga_id = ${alias}.id AND c2.name = ?
  )`);
  params.push(value);
}

function getGenreFilterValue(query) {
  return String(query.genre || query.category || '').trim();
}

function appendStatusFilter(whereParts, params, status, alias = 'm') {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return;

  if (normalized === 'completed') {
    whereParts.push(`${alias}.publication_status = 'completed'`);
    return;
  }

  if (normalized === 'ongoing') {
    whereParts.push(`${alias}.publication_status IN ('ongoing', 'hiatus')`);
    return;
  }

  whereParts.push(`${alias}.publication_status = ?`);
  params.push(normalized);
}

function appendLanguageFilter(whereParts, params, language, alias = 'm') {
  const normalized = normalizeLanguageCode(language, '');
  if (!normalized || normalized === 'all') return;

  const target = normalizeProfileLanguage(normalized, '');
  if (!target) return;

  if (target === 'pt-br') {
    whereParts.push(`(
      EXISTS (
        SELECT 1
        FROM manga_languages ml
        WHERE ml.manga_id = ${alias}.id AND ml.language = 'pt-br'
      )
      OR ${alias}.source_lang IN ('pt-br', 'pt')
      OR EXISTS (
        SELECT 1
        FROM manga_source_cache sc_lang
        WHERE sc_lang.manga_id = ${alias}.id AND sc_lang.source_lang IN ('pt-br', 'pt') AND sc_lang.chapter_count > 0
      )
    )`);
    return;
  }

  whereParts.push(`(
    EXISTS (
      SELECT 1
      FROM manga_languages ml
      WHERE ml.manga_id = ${alias}.id AND ml.language = ?
    )
    OR ${alias}.source_lang = ?
    OR EXISTS (
      SELECT 1
      FROM manga_source_cache sc_lang
      WHERE sc_lang.manga_id = ${alias}.id AND sc_lang.source_lang = ? AND sc_lang.chapter_count > 0
    )
  )`);
  params.push(target, target, target);
}

function normalizeExternalImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }

  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function buildImageProxyUrl(value) {
  const normalized = normalizeExternalImageUrl(value);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    const base = new URL(SUWAYOMI_BASE);
    const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const basePort = base.port || (base.protocol === 'https:' ? '443' : '80');
    const sameOrigin = parsed.protocol === base.protocol && parsed.hostname === base.hostname && parsedPort === basePort;
    const localhostPair =
      (base.hostname === 'localhost' || base.hostname === '127.0.0.1' || base.hostname === '::1')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1')
      && parsed.protocol === base.protocol
      && parsedPort === basePort;
    if (sameOrigin || localhostPair) {
      return `/api/suwayomi-image?url=${encodeURIComponent(normalized)}`;
    }
  } catch {
    return '';
  }
  return `/api/image-proxy?url=${encodeURIComponent(normalized)}`;
}

function isLocalOrPrivateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return true;
    if (parts[0] === 10 || parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
  }

  return false;
}

function normalizeSuwayomiImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const configuredBase = new URL(SUWAYOMI_BASE);
    const host = String(parsed.hostname || '').toLowerCase();
    const port = String(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'));
    const configuredPort = String(configuredBase.port || (configuredBase.protocol === 'https:' ? '443' : '80'));
    const sameOrigin = parsed.protocol === configuredBase.protocol && parsed.hostname === configuredBase.hostname && port === configuredPort;
    const isConfiguredLocalhost =
      (configuredBase.hostname === 'localhost' || configuredBase.hostname === '127.0.0.1' || configuredBase.hostname === '::1')
      && (host === 'localhost' || host === '127.0.0.1' || host === '::1')
      && port === configuredPort
      && parsed.protocol === configuredBase.protocol;

    if (!sameOrigin && !isConfiguredLocalhost) return '';
    const pathName = String(parsed.pathname || '');
    const isChapterPage = /\/api\/v1\/manga\/[^/]+\/chapter\/\d+\/page\/\d+$/i.test(pathName);
    const isThumbnail = /\/api\/v1\/manga\/[^/]+\/thumbnail$/i.test(pathName);
    const isSourceIcon = /\/api\/v1\/source\/[^/]+\/icon$/i.test(pathName);
    if (!isChapterPage && !isThumbnail && !isSourceIcon) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

async function fetchMangadexChapters(externalId, options = {}) {
  const preferredLanguages = Array.isArray(options.preferredLanguages) ? options.preferredLanguages : [];
  const languageModeInput = String(options.languageMode || 'preferred').trim().toLowerCase();
  const explicitLanguage = normalizeLanguageCode(languageModeInput, '');
  const languageMode = languageModeInput === 'all' ? 'all' : explicitLanguage || 'preferred';

  let offset = 0;
  const limit = 100;
  const maxChapters = 1200;
  const allRows = [];

  while (offset < maxChapters) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('order[chapter]', 'asc');

    if (languageMode === 'preferred') {
      const fallbackLanguagePreference = preferredLanguages.length > 0 ? preferredLanguages : ['pt-br', 'pt', 'en', 'es'];
      fallbackLanguagePreference.forEach((lang, index) => {
        if (index === 0) {
          params.set('translatedLanguage[]', lang);
        } else {
          params.append('translatedLanguage[]', lang);
        }
      });
    } else if (languageMode === 'pt-br') {
      params.set('translatedLanguage[]', 'pt-br');
      params.append('translatedLanguage[]', 'pt');
    } else if (languageMode !== 'all') {
      params.set('translatedLanguage[]', languageMode);
    }

    params.set('includeExternalUrl', '0');

    const feedUrl = `https://api.mangadex.org/manga/${externalId}/feed?${params.toString()}`;
    const feed = await fetchJson(feedUrl, {
      cacheKey: `mangadex:feed:${feedUrl}`,
      ttlMs: 2 * 60 * 1000
    });
    const data = Array.isArray(feed?.data) ? feed.data : [];
    if (data.length === 0) break;

    allRows.push(...data);

    const total = Number(feed?.total || allRows.length);
    offset += Number(feed?.limit || limit);
    if (offset >= total) break;
  }

  const deduped = new Map();
  const availableLanguages = new Set();
  const langPriority = buildLanguagePriority(preferredLanguages.length > 0 ? preferredLanguages : ['pt-br', 'pt', 'en', 'es']);

  allRows.forEach((item, index) => {
    const attrs = item.attributes || {};
    const chapterRaw = String(attrs.chapter || '').trim();
    const language = normalizeTesteSourceLanguage(attrs.translatedLanguage || 'unknown') || 'unknown';
    if (SUPPORTED_DETAIL_LANGUAGES.has(language)) {
      availableLanguages.add(language);
    }

    const baseKey = chapterRaw || `item-${index}`;
    const key = languageMode === 'all' ? `${baseKey}::${language}` : baseKey;
    const candidate = {
      id: item.id,
      number: chapterRaw || String(index + 1),
      chapterNumber: normalizeChapterNumber(chapterRaw, index + 1),
      title: attrs.title || '',
      pages: attrs.pages || 0,
      language,
      publishedAt: attrs.publishAt || null
    };

    const current = deduped.get(key);
    if (!current) {
      deduped.set(key, candidate);
      return;
    }

    if (languageMode === 'preferred' && langPriority(candidate.language) < langPriority(current.language)) {
      deduped.set(key, candidate);
      return;
    }

    const currentPublishAt = current.publishedAt ? Date.parse(current.publishedAt) : 0;
    const candidatePublishAt = candidate.publishedAt ? Date.parse(candidate.publishedAt) : 0;
    if (candidatePublishAt > currentPublishAt) {
      deduped.set(key, candidate);
    }
  });

  const chapters = Array.from(deduped.values()).sort((a, b) => {
    if (a.chapterNumber !== b.chapterNumber) return a.chapterNumber - b.chapterNumber;
    const byNumber = String(a.number).localeCompare(String(b.number), 'pt-BR');
    if (byNumber !== 0) return byNumber;
    return String(a.language).localeCompare(String(b.language), 'pt-BR');
  });

  return {
    chapters,
    availableLanguages: Array.from(availableLanguages).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  };
}

function addMangaToLibrary(userId, mangaId, sourceMeta = {}) {
  const normalizedMeta = normalizeSourceMetadata(sourceMeta);
  db.prepare(`
    INSERT OR IGNORE INTO library_entries (user_id, manga_id, status, current_chapter, last_page)
    VALUES (?, ?, 'reading', 1, 1)
  `).run(userId, mangaId);

  db.prepare(`
    UPDATE library_entries
    SET
      source_id = CASE WHEN ? <> '' THEN ? ELSE source_id END,
      source_name = CASE WHEN ? <> '' THEN ? ELSE source_name END,
      source_language = CASE WHEN ? <> '' THEN ? ELSE source_language END,
      updated_at = datetime('now')
    WHERE user_id = ? AND manga_id = ?
  `).run(
    normalizedMeta.sourceId,
    normalizedMeta.sourceId,
    normalizedMeta.sourceName,
    normalizedMeta.sourceName,
    normalizedMeta.sourceLanguage,
    normalizedMeta.sourceLanguage,
    userId,
    mangaId
  );
}

function normalizeLanguageForTranslation(value, fallback = 'pt') {
  const normalized = normalizeLanguageCode(value, '');
  if (!normalized) return fallback;
  const [base] = normalized.split('-');
  return base || fallback;
}

function normalizeCommentBody(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
}

function serializeChapterCommentRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    mangaId: row.manga_id,
    chapterId: row.chapter_id,
    language: row.language,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function saveReadingHistory(userId, mangaId, chapterId, chapterNumber, pageIndex, sourceMeta = {}) {
  const normalizedMeta = normalizeSourceMetadata(sourceMeta);
  db.transaction(() => {
    db.prepare('DELETE FROM reading_history WHERE user_id = ? AND manga_id = ? AND chapter_id <> ?')
      .run(userId, mangaId, chapterId);

    db.prepare(`
      INSERT INTO reading_history (
        user_id,
        manga_id,
        chapter_id,
        chapter_number,
        page_index,
        source_id,
        source_name,
        source_language,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, manga_id, chapter_id) DO UPDATE SET
        chapter_number = excluded.chapter_number,
        page_index = excluded.page_index,
        source_id = CASE WHEN excluded.source_id <> '' THEN excluded.source_id ELSE reading_history.source_id END,
        source_name = CASE WHEN excluded.source_name <> '' THEN excluded.source_name ELSE reading_history.source_name END,
        source_language = CASE
          WHEN excluded.source_language <> '' THEN excluded.source_language
          ELSE reading_history.source_language
        END,
        updated_at = excluded.updated_at
    `).run(
      userId,
      mangaId,
      chapterId,
      chapterNumber,
      pageIndex,
      normalizedMeta.sourceId,
      normalizedMeta.sourceName,
      normalizedMeta.sourceLanguage
    );
  })();
}

function serializeUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    createdAt: row.created_at,
    isAdmin: (row.is_admin === 1 || row.is_owner === 1),
    isOwner: row.is_owner === 1
  };
}

function getUserById(userId) {
  return db
    .prepare('SELECT id, username, email, created_at, is_admin, is_owner FROM users WHERE id = ?')
    .get(userId);
}

function isUserAdmin(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(userId);
  return row?.is_admin === 1 || row?.is_owner === 1;
}

function isUserOwner(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT is_owner FROM users WHERE id = ?').get(userId);
  return row?.is_owner === 1;
}

function requireAdmin(req, res, next) {
  if (!req.user?.userId) {
    return res.status(401).json({ error: 'Token ausente.' });
  }

  // Se o token já tem isAdmin, podemos usar. Se não, consultamos o banco.
  // Como atualizamos o signToken, tokens novos terão isAdmin.
  // Para segurança total, verificamos no banco.
  if (!isUserAdmin(req.user.userId)) {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  }

  return next();
}

function requireOwner(req, res, next) {
  if (!req.user?.userId) {
    return res.status(401).json({ error: 'Token ausente.' });
  }

  if (!isUserOwner(req.user.userId)) {
    return res.status(403).json({ error: 'Acesso restrito ao DONO.' });
  }

  return next();
}

function normalizeLongText(value, maxLength = 2400) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeUserIdList(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  const ids = [];

  value.forEach((item) => {
    const id = Number(item);
    if (!Number.isInteger(id) || id < 1 || unique.has(id)) return;
    unique.add(id);
    ids.push(id);
  });

  return ids;
}

function normalizeReportReason(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = {
    criminal: 'criminal_content',
    criminal_content: 'criminal_content',
    crime: 'criminal_content',
    missing: 'missing_chapters',
    missing_chapters: 'missing_chapters',
    'missing-chapters': 'missing_chapters',
    source_mismatch: 'source_mismatch',
    source: 'source_mismatch',
    source_incorrect: 'source_mismatch',
    wrong_source: 'source_mismatch',
    fonte_errada: 'source_mismatch',
    fonte_incorreta: 'source_mismatch',
    bug: 'bug',
    broken: 'bug',
    other: 'other',
    outro: 'other'
  };
  return map[normalized] || '';
}

function normalizeReportTargetType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = {
    manga: 'manga',
    comment: 'comment',
    chapter: 'chapter',
    app: 'app'
  };
  return map[normalized] || '';
}

function normalizeFeedbackCategory(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = {
    bug: 'bug',
    content: 'content',
    suggestion: 'suggestion',
    sugestao: 'suggestion',
    general: 'general',
    geral: 'general'
  };
  return map[normalized] || 'general';
}

function serializeReportRow(row) {
  return {
    id: row.id,
    reporterUserId: row.reporter_user_id,
    reporterUsername: row.reporter_username,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    details: row.details,
    status: row.status,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedBy: row.resolved_by,
    resolvedByUsername: row.resolved_by_username || null
  };
}

function serializeFeedbackRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    username: row.username,
    category: row.category,
    message: row.message,
    status: row.status,
    adminNotes: row.admin_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedBy: row.reviewed_by,
    reviewedByUsername: row.reviewed_by_username || null
  };
}

function getCatalogHealthStats() {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM mangas) AS total_mangas,
      (
        SELECT COUNT(*)
        FROM mangas
        WHERE cover_url IS NULL OR TRIM(cover_url) = ''
      ) AS missing_cover,
      (
        SELECT COUNT(*)
        FROM mangas
        WHERE description IS NULL
          OR TRIM(description) = ''
          OR description = 'Sem descrição disponível.'
      ) AS missing_description,
      (
        SELECT COUNT(*)
        FROM mangas m
        WHERE NOT EXISTS (
          SELECT 1
          FROM manga_categories mc
          WHERE mc.manga_id = m.id
        )
      ) AS missing_genres,
      (
        SELECT COUNT(*)
        FROM (
          SELECT normalized_title, COUNT(*) AS qty
          FROM mangas
          WHERE normalized_title IS NOT NULL AND TRIM(normalized_title) <> ''
          GROUP BY normalized_title
          HAVING COUNT(*) > 1
        ) dup
      ) AS duplicated_title_groups
  `).get();

  return {
    totalMangas: Math.max(0, Number(stats?.total_mangas) || 0),
    missingCover: Math.max(0, Number(stats?.missing_cover) || 0),
    missingDescription: Math.max(0, Number(stats?.missing_description) || 0),
    missingGenres: Math.max(0, Number(stats?.missing_genres) || 0),
    duplicatedTitleGroups: Math.max(0, Number(stats?.duplicated_title_groups) || 0)
  };
}

function scoreTitleSimilarity(targetTitle, candidateTitle) {
  const target = normalizeMangaTitleKey(targetTitle);
  const candidate = normalizeMangaTitleKey(candidateTitle);
  if (!target || !candidate) return 0;
  if (target === candidate) return 300;
  if (candidate.startsWith(target) || target.startsWith(candidate)) return 220;
  if (candidate.includes(target) || target.includes(candidate)) return 170;

  const targetWords = target.split(' ').filter(Boolean);
  const candidateWords = candidate.split(' ').filter(Boolean);
  if (targetWords.length === 0 || candidateWords.length === 0) return 0;

  const overlap = targetWords.filter((word) => candidateWords.includes(word)).length;
  if (overlap <= 0) return 0;
  return Math.round((overlap / Math.max(targetWords.length, candidateWords.length)) * 120);
}

function commonPrefixLength(valueA, valueB) {
  const a = String(valueA || '');
  const b = String(valueB || '');
  const max = Math.min(a.length, b.length);
  let size = 0;
  while (size < max && a[size] === b[size]) {
    size += 1;
  }
  return size;
}

function buildInitialism(value) {
  const words = normalizeMangaTitleKey(value).split(' ').filter(Boolean);
  if (words.length === 0) return '';
  return words.map((word) => word[0]).join('');
}

function scoreTokenSimilarity(queryWords, candidateWords) {
  const sourceWords = Array.isArray(queryWords) ? queryWords.filter(Boolean) : [];
  const targetWords = Array.isArray(candidateWords) ? candidateWords.filter(Boolean) : [];
  if (sourceWords.length === 0 || targetWords.length === 0) return 0;

  let total = 0;
  sourceWords.forEach((queryWord) => {
    let best = 0;
    targetWords.forEach((candidateWord) => {
      if (queryWord === candidateWord) {
        best = Math.max(best, 1);
        return;
      }
      if (candidateWord.startsWith(queryWord) || queryWord.startsWith(candidateWord)) {
        best = Math.max(best, 0.88);
        return;
      }
      const prefix = commonPrefixLength(queryWord, candidateWord);
      if (prefix >= 3) {
        best = Math.max(best, 0.62 + Math.min(0.18, (prefix - 2) * 0.06));
      }
    });
    total += best;
  });

  return Math.round((total / sourceWords.length) * 68);
}

function collectSearchAliasesFromRow(row, maxDescriptionItems = 10) {
  const aliases = parseCategoriesString(row?.search_aliases);
  const fromTitle = extractAlternativeTitlesFromTitle(row?.title || '', Math.max(4, Math.round(maxDescriptionItems / 2)));
  const fromDescription = extractAlternativeTitlesFromDescription(row?.description || '', maxDescriptionItems);
  const unique = [];
  const seen = new Set();

  [...aliases, ...fromTitle, ...fromDescription].forEach((value) => {
    const alias = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeMangaTitleKey(alias);
    if (!alias || alias.length < 2 || !normalized || seen.has(normalized)) return;
    seen.add(normalized);
    unique.push(alias);
  });

  return unique;
}

function scoreSearchCandidate(query, row) {
  const rawQuery = String(query || '').trim();
  const normalizedQuery = normalizeMangaTitleKey(rawQuery);
  if (!rawQuery || !normalizedQuery) return 0;
  const queryCompact = normalizedQuery.replace(/\s+/g, '');

  const title = String(row?.title || '').trim();
  const author = String(row?.author || '').trim();
  const normalizedTitle = normalizeMangaTitleKey(title);
  const normalizedAuthor = normalizeMangaTitleKey(author);

  let score = scoreTitleSimilarity(rawQuery, title);

  if (normalizedTitle.startsWith(normalizedQuery)) {
    score += 80;
  } else if (normalizedTitle.includes(normalizedQuery)) {
    score += 45;
  }

  if (normalizedAuthor.startsWith(normalizedQuery)) {
    score = Math.max(score, 150);
  } else if (normalizedAuthor.includes(normalizedQuery)) {
    score = Math.max(score, 105);
  }

  const titleInitialism = buildInitialism(title);
  if (queryCompact.length >= 2 && titleInitialism) {
    if (titleInitialism === queryCompact) {
      score = Math.max(score, 255);
    } else if (titleInitialism.startsWith(queryCompact)) {
      score = Math.max(score, 192);
    }
  }

  const authorInitialism = buildInitialism(author);
  if (queryCompact.length >= 2 && authorInitialism) {
    if (authorInitialism === queryCompact) {
      score = Math.max(score, 175);
    } else if (authorInitialism.startsWith(queryCompact)) {
      score = Math.max(score, 126);
    }
  }

  const queryWords = normalizedQuery.split(' ').filter(Boolean);
  const titleWords = normalizedTitle.split(' ').filter(Boolean);
  const tokenScore = scoreTokenSimilarity(queryWords, titleWords);
  if (tokenScore > 0) {
    score += tokenScore;
  }

  const aliases = collectSearchAliasesFromRow(row, 12);
  let bestAliasScore = 0;
  let bestAliasTokenScore = 0;
  let bestAliasInitialismScore = 0;
  aliases.forEach((alias) => {
    const aliasScore = scoreTitleSimilarity(rawQuery, alias);
    if (aliasScore > bestAliasScore) {
      bestAliasScore = aliasScore;
    }
    const aliasWords = normalizeMangaTitleKey(alias).split(' ').filter(Boolean);
    const aliasTokenScore = scoreTokenSimilarity(queryWords, aliasWords);
    if (aliasTokenScore > bestAliasTokenScore) {
      bestAliasTokenScore = aliasTokenScore;
    }

    const aliasInitialism = buildInitialism(alias);
    if (queryCompact.length >= 2 && aliasInitialism) {
      if (aliasInitialism === queryCompact) {
        bestAliasInitialismScore = Math.max(bestAliasInitialismScore, 240);
      } else if (aliasInitialism.startsWith(queryCompact)) {
        bestAliasInitialismScore = Math.max(bestAliasInitialismScore, 175);
      }
    }
  });
  if (bestAliasScore > 0) {
    score = Math.max(score, bestAliasScore + 28);
  }
  if (bestAliasTokenScore > 0) {
    score = Math.max(score, bestAliasTokenScore + 24);
  }
  if (bestAliasInitialismScore > 0) {
    score = Math.max(score, bestAliasInitialismScore + 22);
  }

  return Math.max(0, Math.round(score));
}

function normalizeLooseText(value) {
  return normalizeMangaTitleKey(value).replace(/\s+/g, ' ').trim();
}

function hasNsfwKeyword(value) {
  const normalized = normalizeLooseText(value);
  if (!normalized) return false;

  return SUWAYOMI_NSFW_SOURCE_KEYWORDS.some((keyword) => {
    const token = normalizeLooseText(keyword);
    if (!token) return false;
    if (normalized.includes(token)) return true;
    return normalized.split(' ').includes(token);
  });
}

function isAdultTitlePrefix(value) {
  const raw = String(value || '').trim();
  return /^\[aA]/.test(raw);
}

function scoreCandidateFit(mangaTitle, candidateTitle, candidateSourceName, candidateSourceLang, targetSourceLang, mangaGenres = []) {
  const titleScore = scoreTitleSimilarity(mangaTitle, candidateTitle);
  let score = titleScore;

  const normalizedTargetLang = normalizeTesteSourceLanguage(targetSourceLang || '');
  const normalizedCandidateLang = normalizeTesteSourceLanguage(candidateSourceLang || '');
  if (normalizedTargetLang && normalizedCandidateLang === normalizedTargetLang) {
    score += 80;
  } else if (normalizedCandidateLang) {
    score += 10;
  }

  const adultPrefix = isAdultTitlePrefix(mangaTitle);
  const titleHasNsfw = hasNsfwKeyword(mangaTitle);
  
  // Verificar se algum gênero é NSFW
  const genreHasNsfw = Array.isArray(mangaGenres) && mangaGenres.some(g => isNsfwCategoryName(g));
  
  // Penaliza apenas se título tem [A] E mangá NÃO é NSFW (nem por gênero, nem por keyword no título)
  if (adultPrefix && !titleHasNsfw && !genreHasNsfw) {
    score -= 500;
  }

  if (titleScore < 80) {
    score -= 30;
  }

  return score;
}

function buildTitleSearchCandidates(title) {
  const raw = String(title || '').trim();
  if (!raw) return [];

  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  pushCandidate(raw);
  pushCandidate(raw.split('|')[0]);

  const withoutBrackets = raw
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*}/g, ' ');
  pushCandidate(withoutBrackets);
  pushCandidate(withoutBrackets.split('|')[0]);

  const alpha = withoutBrackets.replace(/[^a-zA-Z0-9\s]/g, ' ');
  pushCandidate(alpha);

  const compactWords = alpha.split(/\s+/).filter((word) => word.length >= 2);
  if (compactWords.length > 0) {
    pushCandidate(compactWords.slice(0, 6).join(' '));
    pushCandidate(compactWords.slice(0, 4).join(' '));
  }

  return candidates;
}

function extractAlternativeTitlesFromTitle(title, maxItems = 10) {
  const raw = String(title || '').trim();
  if (!raw) return [];

  const aliases = [];
  const seen = new Set();
  const normalizedMainTitle = normalizeMangaTitleKey(raw);
  const addAlias = (value) => {
    const alias = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeMangaTitleKey(alias);
    if (!alias || alias.length < 2 || !normalized || seen.has(normalized)) return;
    if (normalized === normalizedMainTitle) return;
    if (/^https?:\/\//i.test(alias)) return;
    if (/^[0-9._-]+$/.test(alias)) return;
    seen.add(normalized);
    aliases.push(alias);
  };

  raw
    .split(/\s(?:\||\/|•|·|-)\s/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach(addAlias);

  return aliases.slice(0, Math.max(1, Number(maxItems) || 10));
}

function extractAlternativeTitlesFromRawPayload(rawPayload, maxItems = 24) {
  const source = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
  const aliases = [];
  const seen = new Set();
  const mainTitle = String(source?.title || '').trim();
  const normalizedMainTitle = normalizeMangaTitleKey(mainTitle);

  const addAlias = (value) => {
    const alias = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeMangaTitleKey(alias);
    if (!alias || alias.length < 2 || !normalized || seen.has(normalized)) return;
    if (normalized === normalizedMainTitle) return;
    if (/^https?:\/\//i.test(alias)) return;
    if (/^[0-9._-]+$/.test(alias)) return;
    seen.add(normalized);
    aliases.push(alias);
  };

  const collectStrings = (value, depth = 0) => {
    if (depth > 4 || aliases.length >= maxItems) return;
    if (Array.isArray(value)) {
      value.forEach((item) => collectStrings(item, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => collectStrings(item, depth + 1));
      return;
    }
    addAlias(value);
  };

  [
    source.altTitles,
    source.alternativeTitles,
    source.alternateTitles,
    source.otherTitles,
    source.synonyms,
    source.aliases,
    source.titles,
    source.titleVariants,
    source.meta
  ].forEach((value) => collectStrings(value, 0));

  extractAlternativeTitlesFromTitle(mainTitle, 12).forEach(addAlias);
  extractAlternativeTitlesFromDescription(source.description || '', 20).forEach(addAlias);

  return aliases.slice(0, Math.max(1, Number(maxItems) || 24));
}

function extractAlternativeTitlesFromDescription(description, maxItems = 20) {
  const raw = String(description || '').trim();
  if (!raw) return [];

  const aliases = [];
  const seen = new Set();
  const addAlias = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeMangaTitleKey(text);
    if (!text || text.length < 2 || !normalized || normalized.length < 2 || seen.has(normalized)) return;
    seen.add(normalized);
    aliases.push(text);
  };

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const aliasHeaderPattern =
    /^(?:alternative\s*titles?|alternatives?|alt\.?\s*titles?|also\s*known\s*as|aka|sin[oô]nimos?|t[ií]tulos?\s*alternativos?|tamb[eé]m\s*conhecido\s*como)\s*[:\-]\s*(.+)$/i;

  lines.forEach((line) => {
    const headerMatch = aliasHeaderPattern.exec(line);
    if (!headerMatch) return;
    const payload = String(headerMatch[1] || '');
    payload
      .split(/[;,|/]/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach(addAlias);
  });

  const inlinePattern = /\b(?:aka|also known as|tamb[eé]m conhecido como)\b\s*[:\-]?\s*([^.;\n]+)/ig;
  let match = inlinePattern.exec(raw);
  while (match) {
    String(match[1] || '')
      .split(/[;,|/]/)
      .map((token) => token.trim())
      .filter(Boolean)
      .forEach(addAlias);
    match = inlinePattern.exec(raw);
  }

  return aliases.slice(0, Math.max(1, Number(maxItems) || 20));
}

function saveMangaAliases(mangaId, aliases = [], source = 'runtime') {
  const targetMangaId = Number(mangaId);
  if (!Number.isInteger(targetMangaId) || targetMangaId < 1 || !Array.isArray(aliases) || aliases.length === 0) {
    return;
  }

  const normalizedSource = String(source || '').trim().slice(0, 80);
  const insertAlias = db.prepare(`
    INSERT INTO manga_aliases (manga_id, alias, normalized_alias, source, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(manga_id, normalized_alias) DO UPDATE SET
      alias = excluded.alias,
      source = CASE
        WHEN excluded.source <> '' THEN excluded.source
        ELSE manga_aliases.source
      END
  `);

  const tx = db.transaction((items) => {
    items.forEach((alias) => {
      const value = String(alias || '').replace(/\s+/g, ' ').trim();
      const normalizedAlias = normalizeMangaTitleKey(value);
      if (!value || value.length < 2 || !normalizedAlias) return;
      insertAlias.run(targetMangaId, value.slice(0, 220), normalizedAlias, normalizedSource);
    });
  });
  tx(aliases);
}

function getMangaAliases(mangaId, limit = 24) {
  const targetMangaId = Number(mangaId);
  if (!Number.isInteger(targetMangaId) || targetMangaId < 1) return [];

  const safeLimit = Math.max(1, Math.min(80, Number(limit) || 24));
  const rows = db
    .prepare(`
      SELECT alias, normalized_alias
      FROM manga_aliases
      WHERE manga_id = ?
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    `)
    .all(targetMangaId);

  return rows.map((row) => ({
    alias: String(row?.alias || '').trim(),
    normalizedAlias: String(row?.normalized_alias || '').trim()
  }));
}

function scoreSource(main, candidate, options = {}) {
  // Se o título principal tem prefixo [A], considera como NSFW
  const mainTitleIsAdult = isAdultTitlePrefix(main.title);
  const isCandidateNsfw = options?.candidateIsNsfw || isNsfwCategoryName(candidate.sourceName) || String(candidate.sourceName || '').toLowerCase().includes('hentai');
  const mainGenres = Array.isArray(main.genres) ? main.genres : [];
  const mainHasNsfwGenre = mainGenres.some((g) => isNsfwCategoryName(g));

  // Se título tem [A] mas não tem gênero Adult, bloqueia origens não-NSFW
  if (mainTitleIsAdult && !mainHasNsfwGenre && !isCandidateNsfw) {
    return -999;
  }

  // Se título tem [A] mas já tem gênero Adult, permite livremente
  // Se não tem [A], usa lógica de sempre

  // Filtragem estrita de idiomas
  const supportedLangs = ['pt-br', 'en', 'es'];
  if (!supportedLangs.includes(candidate.sourceLang)) {
    return -999;
  }

  // Verificar se a fonte está na whitelist do admin (apenas para o provedor suwayomi)
  if (candidate.provider === 'suwayomi') {
    const isEnabled = db.prepare('SELECT 1 FROM enabled_sources WHERE source_id = ? AND is_active = 1').get(candidate.sourceId);
    if (!isEnabled) {
      return -999;
    }
  }

  let score = 0;
  const mainTitleKey = normalizeMangaTitleKey(main.title);
  const candidateTitleKey = normalizeMangaTitleKey(candidate.title);

  if (mainTitleKey === candidateTitleKey) {
    score += 60;
  } else {
    // Token-based matching for non-exact titles
    const mainTokens = mainTitleKey.split(' ').filter((t) => t.length > 1);
    const candidateTokens = candidateTitleKey.split(' ').filter((t) => t.length > 1);
    if (mainTokens.length > 0 && candidateTokens.length > 0) {
      let matches = 0;
      for (const t of mainTokens) {
        if (candidateTokens.includes(t)) matches++;
      }
      const tokenScore = matches / Math.max(mainTokens.length, candidateTokens.length);
      if (tokenScore > 0.4) {
        score += Math.floor(tokenScore * 40);
      } else if (tokenScore < 0.2 && !options?.ignoreLowTokenScore) {
        // Se a correspondência de tokens for muito baixa, penaliza fortemente (evita lixo)
        score -= 100;
      }
    }
  }

  // Early exit for very good matches
  if (score >= 60 && main.author && candidate.author) {
    const mainAuthorKey = normalizeMangaTitleKey(main.author);
    const candidateAuthorKey = normalizeMangaTitleKey(candidate.author);
    if (mainAuthorKey === candidateAuthorKey) return score + 40;
  }

  if (Array.isArray(main.aliases) && main.aliases.length > 0) {
    const mainAliasKeys = new Set(
      main.aliases
        .map((a) => normalizeMangaTitleKey(a.alias || a))
        .filter(Boolean)
    );
    const candidateTitleNorm = normalizeMangaTitleKey(candidate.title);
    if (mainAliasKeys.has(candidateTitleNorm)) {
      score += 50;
    }
  }

  if (main.author && candidate.author) {
    const mainAuthorKey = normalizeMangaTitleKey(main.author);
    const candidateAuthorKey = normalizeMangaTitleKey(candidate.author);
    if (mainAuthorKey && mainAuthorKey === candidateAuthorKey) {
      score += 40;
    }
  }

  const candidateGenres = Array.isArray(candidate.genres) ? candidate.genres : [];
  if (mainGenres.length > 0 && candidateGenres.length > 0) {
    const normalizedMainGenres = new Set(mainGenres.map((g) => normalizeGenreToken(g)));
    const matchedGenres = candidateGenres
      .map((g) => normalizeGenreToken(g))
      .filter((g) => normalizedMainGenres.has(g)).length;
    score += matchedGenres * 5;
  }

  const candidateNsfwGenres = candidateGenres.filter((g) => isNsfwCategoryName(g));
  
  // Regra Anti-Hentai Errado (Forte penalização se a fonte é NSFW e o mangá não é)
  if (!mainHasNsfwGenre && (candidateNsfwGenres.length > 0 || options?.candidateIsNsfw)) {
    return -999; 
  }

  const mainChapters = Number(main.totalChapters) || Number(main.total_chapters) || 0;
  const candidateChapters = Number(candidate.totalChapters) || Number(candidate.chapterCount) || 0;
  const chapterDiff = Math.abs(mainChapters - candidateChapters);
  if (chapterDiff === 0) score += 20;
  else if (chapterDiff < 5) score += 10;
  else if (chapterDiff > 50) score -= 20; // Penaliza grandes discrepâncias

  if (candidate.sourceLang === main.sourceLang) score += 10;

  const mainCover = String(main.coverUrl || main.cover_url || '').trim();
  const candidateCover = String(candidate.coverUrl || '').trim();
  if (mainCover && candidateCover && mainCover === candidateCover) score += 50;

  return score;
}

function buildSearchTermsWithAliases(title, aliases = []) {
  const terms = [];
  const seen = new Set();
  const addTerm = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const normalized = normalizeMangaTitleKey(text);
    if (!text || !normalized || seen.has(normalized)) return;
    seen.add(normalized);
    terms.push(text);
  };

  buildTitleSearchCandidates(title).forEach(addTerm);
  (Array.isArray(aliases) ? aliases : []).forEach((alias) => {
    buildTitleSearchCandidates(alias).forEach(addTerm);
  });

  return terms;
}

function normalizeSourceMetadata(meta = {}, fallbackLanguage = '') {
  const sourceId = String(meta?.sourceId || '').trim();
  const sourceName = String(meta?.sourceName || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const sourceLanguage = normalizeProfileLanguage(meta?.sourceLanguage || meta?.sourceLang, '') || normalizeTesteSourceLanguage(meta?.sourceLanguage || meta?.sourceLang || fallbackLanguage);
  return {
    sourceId: sourceId.slice(0, 220),
    sourceName,
    sourceLanguage: sourceLanguage || normalizeTesteSourceLanguage(fallbackLanguage || '')
  };
}

function upsertMangaSourceCacheEntry(mangaId, entry) {
  const targetMangaId = Number(mangaId);
  if (!Number.isInteger(targetMangaId) || targetMangaId < 1 || !entry || typeof entry !== 'object') return;

  const sourceKey = String(entry.sourceKey || '').trim();
  const externalId = String(entry.externalId || '').trim();
  const sourceId = String(entry.sourceId || '').trim();
  const provider = String(entry.provider || '').trim().toLowerCase() || 'suwayomi';
  if (!sourceKey || (!externalId && !sourceId)) return;

  const sourceName = String(entry.sourceName || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const sourceUrl = String(entry.sourceUrl || '').trim().slice(0, 400);
  const sourceLang = normalizeTesteSourceLanguage(entry.sourceLang || '');
  const chapterCount = Math.max(0, Number(entry.chapterCount) || 0);

  db.prepare(`
    INSERT INTO manga_source_cache (
      manga_id,
      source_key,
      provider,
      source_id,
      source_name,
      source_url,
      external_id,
      source_lang,
      chapter_count,
      last_checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(manga_id, source_key) DO UPDATE SET
      provider = excluded.provider,
      source_id = excluded.source_id,
      source_name = CASE WHEN excluded.source_name <> '' THEN excluded.source_name ELSE manga_source_cache.source_name END,
      source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE manga_source_cache.source_url END,
      external_id = CASE WHEN excluded.external_id <> '' THEN excluded.external_id ELSE manga_source_cache.external_id END,
      source_lang = CASE WHEN excluded.source_lang <> '' THEN excluded.source_lang ELSE manga_source_cache.source_lang END,
      chapter_count = CASE
        WHEN excluded.chapter_count > manga_source_cache.chapter_count THEN excluded.chapter_count
        WHEN manga_source_cache.chapter_count = 0 THEN excluded.chapter_count
        ELSE manga_source_cache.chapter_count
      END,
      last_checked_at = excluded.last_checked_at
  `).run(
    targetMangaId,
    sourceKey,
    provider,
    sourceId,
    sourceName,
    sourceUrl,
    externalId,
    sourceLang,
    chapterCount
  );
}

function upsertMangaChaptersCache(sourceKey, externalId, chapters) {
  if (!sourceKey || !externalId || !Array.isArray(chapters)) return;
  try {
    const chaptersJson = JSON.stringify(chapters);
    db.prepare(`
      INSERT INTO manga_chapters_cache (source_key, external_id, chapters_json, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(source_key, external_id) DO UPDATE SET
        chapters_json = excluded.chapters_json,
        updated_at = excluded.updated_at
    `).run(sourceKey, externalId, chaptersJson);
  } catch (error) {
    // console.error('Erro ao salvar cache de capítulos:', error);
  }
}

function readCachedMangaChapters(sourceKey, externalId) {
  if (!sourceKey || !externalId) return null;
  try {
    const row = db.prepare(`
      SELECT chapters_json
      FROM manga_chapters_cache
      WHERE source_key = ? AND external_id = ?
      LIMIT 1
    `).get(sourceKey, externalId);

    if (row?.chapters_json) {
      return JSON.parse(row.chapters_json);
    }
  } catch {
    return null;
  }
  return null;
}

function readCachedMangaSourceEntries(mangaId, targetLanguage = '', maxItems = 40) {
  const targetMangaId = Number(mangaId);
  if (!Number.isInteger(targetMangaId) || targetMangaId < 1) return [];

  const safeLimit = Math.max(1, Math.min(120, Number(maxItems) || 40));
  const normalizedTargetLanguage = normalizeTesteSourceLanguage(targetLanguage || '');
  const rows = db.prepare(`
    SELECT
      source_key,
      provider,
      source_id,
      source_name,
      source_url,
      external_id,
      source_lang,
      chapter_count
    FROM manga_source_cache
    WHERE manga_id = ?
    ORDER BY chapter_count DESC, last_checked_at DESC
    LIMIT ${safeLimit}
  `).all(targetMangaId);

  return rows
    .map((row) => ({
      sourceKey: String(row?.source_key || '').trim(),
      provider: String(row?.provider || '').trim().toLowerCase() || 'suwayomi',
      sourceId: String(row?.source_id || '').trim(),
      sourceName: String(row?.source_name || '').trim(),
      sourceUrl: String(row?.source_url || '').trim(),
      externalId: String(row?.external_id || '').trim(),
      sourceLang: normalizeTesteSourceLanguage(row?.source_lang || ''),
      chapterCount: Math.max(0, Number(row?.chapter_count) || 0)
    }))
    .filter((item) => item.sourceKey && item.externalId)
    .filter((item) => {
      if (!normalizedTargetLanguage) return true;
      if (!item.sourceLang) return true;
      return item.sourceLang === normalizedTargetLanguage;
    });
}

async function fetchTesteSourcesMap(language = 'all') {
  const normalizedLanguage = String(language || 'all').trim().toLowerCase() || 'all';
  const payload = await fetchTesteJson('/sources', { lang: normalizedLanguage }, { ttlMs: 5 * 60 * 1000, timeoutMs: 6000 });
  const list = Array.isArray(payload?.sources) ? payload.sources : [];
  const map = new Map();
  list.forEach((source) => {
    const sourceId = String(source?.id || '').trim();
    if (!sourceId) return;
    map.set(sourceId, {
      id: sourceId,
      name: String(source?.name || 'Fonte Suwayomi').trim(),
      lang: normalizeTesteSourceLanguage(source?.lang || ''),
      supportsLatest: parseBooleanLike(source?.supportsLatest, false)
    });
  });
  return map;
}

async function ingestSearchResultsFromTeste(searchTerm, preferredLanguage) {
  const query = String(searchTerm || '').trim();
  if (!query) return [];

  let payload;
  try {
    payload = await fetchTesteJson('/search', {
      q: query,
      page: 1,
      lang: 'all'
    }, {
      ttlMs: 60_000
    });
  } catch {
    return [];
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) return [];

  const preferredTesteLang = mapProfileLanguageToTesteLanguage(preferredLanguage, 'pt');
  const dedupe = new Set();
  const scored = results
    .map((item) => {
      const sourceLang = normalizeTesteSourceLanguage(item?.lang || item?.source_lang || preferredTesteLang);
      const title = String(item?.title || '').trim();
      const titleKey = normalizeMangaTitleKey(title);
      const langScore =
        sourceLang && sourceLang === normalizeTesteSourceLanguage(preferredTesteLang)
          ? 50
          : sourceLang
            ? 12
            : 0;
      return {
        raw: item,
        sourceLang,
        titleKey,
        score: scoreTitleSimilarity(query, title) + langScore
      };
    })
    .filter((item) => item.titleKey)
    .sort((a, b) => b.score - a.score);

  const importedIds = [];
  for (const item of scored) {
    if (dedupe.has(item.titleKey)) continue;
    dedupe.add(item.titleKey);
    const mangaId = upsertSuwayomiManga(item.raw, item.sourceLang);
    if (Number.isInteger(mangaId)) {
      importedIds.push(mangaId);
    }
    if (importedIds.length >= 180) break;
  }

  return importedIds;
}

async function ingestPopularFromTeste(preferredLanguage) {
  let sourceMap = new Map();
  try {
    sourceMap = await fetchTesteSourcesMap(mapProfileLanguageToTesteLanguage(preferredLanguage, 'pt'));
  } catch {
    return [];
  }
  const preferredTesteLang = mapProfileLanguageToTesteLanguage(preferredLanguage, 'pt');

  const orderedSources = Array.from(sourceMap.values()).sort((a, b) => {
    const aPreferred = a.lang === normalizeTesteSourceLanguage(preferredTesteLang) ? 1 : 0;
    const bPreferred = b.lang === normalizeTesteSourceLanguage(preferredTesteLang) ? 1 : 0;
    if (aPreferred !== bPreferred) return bPreferred - aPreferred;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });

  const selectedSources = orderedSources.slice(0, 6);
  const importedIds = [];
  const seenTitles = new Set();

  await Promise.all(
    selectedSources.map(async (source) => {
      try {
        const payload = await fetchTesteJson('/popular', {
          source_id: source.id,
          page: 1
        }, {
          ttlMs: 90_000
        });
        const results = Array.isArray(payload?.results) ? payload.results : [];
        results.forEach((item) => {
          const titleKey = normalizeMangaTitleKey(item?.title);
          if (!titleKey || seenTitles.has(titleKey)) return;
          seenTitles.add(titleKey);
          const mangaId = upsertSuwayomiManga(item, source.lang);
          if (Number.isInteger(mangaId)) {
            importedIds.push(mangaId);
          }
        });
      } catch {
        // Fonte individual é best-effort.
      }
    })
  );

  return importedIds;
}

function decodeSuwayomiChapterId(chapterId) {
  const raw = String(chapterId || '').trim();
  const match = /^sw:([^:]+):(.+)$/i.exec(raw);
  if (!match) return null;
  return {
    mangaExternalId: match[1],
    chapterRef: match[2]
  };
}

async function searchMangadexByTitle(title, limit = 8, aliases = [], includeNsfw = false) {
  const searchTerms = buildSearchTermsWithAliases(title, aliases).slice(0, 4);
  if (searchTerms.length === 0) return [];

  const cappedLimit = Math.max(1, Math.min(16, Number(limit) || 8));
  const collected = new Map();

  for (const term of searchTerms) {
    const params = new URLSearchParams();
    params.set('title', term);
    params.set('limit', String(cappedLimit));
    params.set('order[relevance]', 'desc');
    params.set('hasAvailableChapters', 'true');
    params.set('includes[]', 'author');
    params.append('includes[]', 'cover_art');

    if (!includeNsfw) {
      params.set('contentRating[]', 'safe');
      params.append('contentRating[]', 'suggestive');
    }

    const searchUrl = `https://api.mangadex.org/manga?${params.toString()}`;
    let payload;
    try {
      // eslint-disable-next-line no-await-in-loop
      payload = await fetchJson(searchUrl, {
        cacheKey: `mangadex:search:${searchUrl}`,
        ttlMs: 5 * 60 * 1000
      });
    } catch {
      // Termo individual é best-effort.
      // eslint-disable-next-line no-continue
      continue;
    }

    const rows = Array.isArray(payload?.data) ? payload.data : [];
    rows.forEach((item) => {
      const externalId = String(item?.id || '').trim();
      if (!externalId) return;
      const attributes = item?.attributes || {};
      const titleCandidate = pickLocalizedTitle(attributes?.title);
      const altTitles = Array.isArray(attributes?.altTitles) ? attributes.altTitles : [];
      const altAliases = [];
      altTitles.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        Object.values(entry).forEach((value) => {
          const text = String(value || '').replace(/\s+/g, ' ').trim();
          if (text) altAliases.push(text);
        });
      });
      extractAlternativeTitlesFromDescription(pickLocalizedTitle(attributes?.description || {}), 10)
        .forEach((alias) => altAliases.push(alias));

      const score = Math.max(
        scoreTitleSimilarity(title, titleCandidate || title),
        ...altAliases.map((alias) => scoreTitleSimilarity(title, alias))
      );

      const existing = collected.get(externalId);
      if (!existing || score > existing.score) {
        collected.set(externalId, {
          externalId,
          sourceName: 'MangaDex',
          sourceUrl: 'https://mangadex.org',
          title: titleCandidate || term,
          aliases: altAliases,
          score
        });
      }
    });
  }

  return Array.from(collected.values())
    .sort((a, b) => {
      const diff = b.score - a.score;
      if (diff !== 0) return diff;
      return a.externalId.localeCompare(b.externalId, 'pt-BR');
    })
    .slice(0, cappedLimit);
}

async function loadMangadexFallbackChapters(manga, options = {}) {
  if (!manga?.id) return null;

  const languageMode = String(options.languageMode || 'preferred').trim().toLowerCase() || 'preferred';
  const targetSourceLang = normalizeTesteSourceLanguage(options.targetSourceLang || '');
  const searchAliases = Array.isArray(options.searchAliases) ? options.searchAliases : [];
  const preferredLanguages =
    targetSourceLang === 'en'
      ? ['en', 'es', 'pt-br', 'pt']
      : targetSourceLang === 'es'
        ? ['es', 'en', 'pt-br', 'pt']
        : ['pt-br', 'pt', 'en', 'es'];

  const knownOrigins = getMangaOrigins(manga.id)
    .filter((origin) => String(origin?.source_url || '').includes('mangadex.org'))
    .map((origin) => ({
      externalId: String(origin.external_id || '').trim(),
      sourceName: origin.source_name || 'MangaDex',
      sourceUrl: origin.source_url || 'https://mangadex.org',
      title: manga.title
    }))
    .filter((item) => item.externalId);

  const searchedOrigins = knownOrigins.length > 0 ? [] : await searchMangadexByTitle(manga.title, 10, searchAliases);
  const mergedCandidates = [...knownOrigins, ...searchedOrigins];
  if (mergedCandidates.length === 0) return null;

  const deduped = [];
  const seenIds = new Set();
  mergedCandidates.forEach((candidate) => {
    if (!candidate?.externalId || seenIds.has(candidate.externalId)) return;
    seenIds.add(candidate.externalId);
    const aliasesForScore = Array.isArray(candidate.aliases) ? candidate.aliases : [];
    const candidateScore = Math.max(
      scoreTitleSimilarity(manga.title, candidate.title || manga.title),
      ...aliasesForScore.map((alias) => scoreTitleSimilarity(manga.title, alias))
    );
    deduped.push({
      ...candidate,
      score: candidateScore
    });
  });

  deduped.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.externalId.localeCompare(b.externalId, 'pt-BR');
  });

  const languageModeForFetch = languageMode === 'all' ? 'all' : languageMode === 'preferred' ? 'preferred' : targetSourceLang || 'preferred';

  for (const candidate of deduped.slice(0, 8)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const payload = await fetchMangadexChapters(candidate.externalId, {
        preferredLanguages,
        languageMode: languageModeForFetch
      });
      if (!Array.isArray(payload?.chapters) || payload.chapters.length === 0) {
        // eslint-disable-next-line no-continue
        continue;
      }

      return {
        candidate,
        chapters: payload.chapters,
        availableLanguages: Array.isArray(payload.availableLanguages) ? payload.availableLanguages : [],
        aliases: Array.isArray(candidate.aliases) ? candidate.aliases : []
      };
    } catch {
      // Candidato individual é best-effort.
    }
  }

  return null;
}

function pickLocalizedTitle(titleObj) {
  if (!titleObj || typeof titleObj !== 'object') return '';
  const direct = titleObj['pt-br'] || titleObj.pt || titleObj.es || titleObj.en;
  if (direct && String(direct).trim()) return String(direct).trim();
  const first = Object.values(titleObj).find((value) => String(value || '').trim());
  return first ? String(first).trim() : '';
}

function upsertMangaOrigin(mangaId, sourceName, sourceUrl, externalId) {
  if (!Number.isInteger(Number(mangaId)) || !externalId) return;
  db.prepare(`
    INSERT INTO manga_origins (manga_id, source_name, source_url, external_id, imported_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_url, external_id) DO UPDATE SET
      manga_id = excluded.manga_id,
      source_name = excluded.source_name,
      imported_at = excluded.imported_at
  `).run(mangaId, sourceName || 'Fonte externa', sourceUrl || '', String(externalId));
}

app.post('/api/auth/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  const preferredLanguage = normalizeProfileLanguage(req.body?.preferredLanguage, 'pt-br');
  const clientIp = getRequestIp(req);

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Preencha username, email e senha.' });
  }

  if (password.length < 8 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ error: 'Senha deve ter ao menos 8 caracteres, com letras e números.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedUsername = String(username).trim();

  const existing = db
    .prepare('SELECT id FROM users WHERE email = ? OR username = ?')
    .get(normalizedEmail, normalizedUsername);
  if (existing) {
    return res.status(409).json({ error: 'Email ou username já cadastrado.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = db
    .prepare('INSERT INTO users (username, email, password_hash, last_ip) VALUES (?, ?, ?, ?)')
    .run(normalizedUsername, normalizedEmail, passwordHash, normalizeIpAddress(clientIp) || null);

  const userId = Number(result.lastInsertRowid);
  ensureUserPreference(userId);
  if (PROFILE_LANGUAGES.has(preferredLanguage)) {
    db.prepare(`
      UPDATE user_preferences
      SET preferred_language = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(preferredLanguage, userId);
  }

  const user = db.prepare('SELECT id, username, email, is_admin, created_at FROM users WHERE id = ?').get(userId);
  const token = signToken(user);

  return res.status(201).json({
    token,
    user: {
      ...serializeUserRow(user),
      preferredLanguage
    }
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const clientIp = getRequestIp(req);
  const now = Date.now();
  const attemptKey = getAuthAttemptKey(clientIp, email);
  const attemptState = getAuthAttemptState(attemptKey, now);

  if (attemptState.lockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attemptState.lockedUntil - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: `Muitas tentativas de login. Tente novamente em ${retryAfterSeconds}s.`
    });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'Preencha email e senha.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!userRow) {
    registerAuthFailure(attemptKey, now);
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  const valid = await bcrypt.compare(password, userRow.password_hash);
  if (!valid) {
    registerAuthFailure(attemptKey, now);
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  clearAuthFailures(attemptKey);
  ensureUserPreference(userRow.id);
  touchUserLastIp(userRow.id, clientIp);

  const user = {
    id: userRow.id,
    username: userRow.username,
    email: userRow.email,
    is_admin: userRow.is_admin,
    is_owner: userRow.is_owner
  };

  const token = signToken(user);
  return res.json({
    token,
    user: {
      id: userRow.id,
      username: userRow.username,
      email: userRow.email,
      isAdmin: (userRow.is_admin === 1 || userRow.is_owner === 1),
      isOwner: userRow.is_owner === 1
    }
  });
});

app.get('/api/suwayomi-sources', requireAuth, requireOwner, async (req, res) => {
  try {
    const sourceMap = await fetchTesteSourcesMap('all');
    const sources = Array.from(sourceMap.values())
      .map(s => ({
        id: s.id,
        name: s.name,
        lang: s.lang,
        provider: 'suwayomi'
      }))
      .filter(s => {
        const lang = normalizeTesteSourceLanguage(s.lang);
        return ['pt-br', 'en', 'es'].includes(lang);
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

    // Adicionar MangaDex manualmente como opção nativa
    sources.unshift({
      id: 'mangadex',
      name: 'MangaDex (Nativo)',
      lang: 'all',
      provider: 'mangadex'
    });

    return res.json({ sources });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar fontes do Suwayomi: ' + err.message });
  }
});

async function isSourceEnabled(sourceIdOrName) {
  try {
    const row = db.prepare(`
      SELECT 1 FROM enabled_sources 
      WHERE (source_id = ? OR source_name = ?) 
      AND is_active = 1
    `).get(sourceIdOrName, sourceIdOrName);
    return !!row;
  } catch {
    return false;
  }
}

app.get('/api/admin/sources/:sourceId/remote-search', requireAuth, requireOwner, async (req, res) => {
  const sourceId = req.params.sourceId;
  const search = String(req.query.q || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);

  try {
    if (sourceId === 'mangadex') {
      const params = new URLSearchParams();
      params.set('limit', '20');
      params.set('offset', String((page - 1) * 20));
      params.set('includes[]', 'cover_art');
      params.append('includes[]', 'author');
      params.set('hasAvailableChapters', 'true');
      params.set('contentRating[]', 'safe');
      params.append('contentRating[]', 'suggestive');

      if (search) {
        params.set('title', search);
        params.set('order[relevance]', 'desc');
      } else {
        params.set('order[followedCount]', 'desc');
      }

      const mdUrl = `https://api.mangadex.org/manga?${params.toString()}`;
      const payload = await fetchJson(mdUrl, {
        cacheKey: `mangadex:admin-remote:${mdUrl}`,
        ttlMs: 2 * 60 * 1000
      });

      const mangas = (payload?.data || []).map((item) => {
        const attrs = item.attributes || {};
        const authorObj = (item.relationships || []).find((r) => r.type === 'author');
        const coverObj = (item.relationships || []).find((r) => r.type === 'cover_art');
        const fileName = coverObj?.attributes?.fileName;
        const coverUrl = fileName ? `https://uploads.mangadex.org/covers/${item.id}/${fileName}.256.jpg` : null;

        return {
          id: item.id,
          title: pickLocalizedTitle(attrs.title),
          coverUrl,
          author: authorObj?.attributes?.name || 'Autor desconhecido',
          sourceId: 'mangadex',
          sourceName: 'MangaDex'
        };
      });

      return res.json({ mangas });
    }

    const SUWAYOMI_BASE = String(process.env.SUWAYOMI_BASE || 'http://127.0.0.1:4567').replace(/\/+$/, '');
    let url = `${SUWAYOMI_BASE}/api/v1/source/${encodeURIComponent(sourceId)}/popular/${page}`;
    
    if (search) {
      // O Suwayomi v1 usa 'searchTerm' e a página vai na query, não no path para busca
      url = `${SUWAYOMI_BASE}/api/v1/source/${encodeURIComponent(sourceId)}/search?searchTerm=${encodeURIComponent(search)}&page=${page}`;
    }

    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      
      // Suwayomi v1 usa 'mangaList', Mihon usa 'mangas' ou 'results'
      const rawResults = payload.mangaList || payload.results || payload.mangas || payload.data || (Array.isArray(payload) ? payload : []);
      const results = Array.isArray(rawResults) ? rawResults : [];
      
      console.log(`[admin:remote-search] Fonte ${sourceId}: detectados ${results.length} itens.`);

      return res.json({
        mangas: results.map(item => {
          // Captura o ID/URL que identifica o mangá na fonte
          const mId = item.id || item.url || (item.url && typeof item.url === 'object' ? item.url.url : null);
          //thumbnailUrl do Suwayomi é um caminho local, usar proxy se necessário
          let coverUrl = item.thumbnailUrl || '';
          if (coverUrl.startsWith('/')) {
            //Converter URL local do Suwayomi para usar o image-proxy
            coverUrl = `/api/image-proxy?url=${encodeURIComponent(`${SUWAYOMI_BASE}${coverUrl}`)}`;
          }
          return {
            id: mId,
            title: item.title || 'Título desconhecido',
            coverUrl,
            author: item.author || '',
            genres: Array.isArray(item.genre) ? item.genre : [],
            sourceId: item.sourceId || sourceId,
            sourceName: item.sourceName || ''
          };
        }).filter(m => m.id && m.title)
      });
    } catch (err) {
      console.error(`[admin:remote-search] Erro ao buscar dados de ${sourceId}:`, err.message);
      return res.json({ mangas: [], error: err.message });
    }
  } catch (err) {
    console.error(`[admin:remote-search] Erro ao buscar dados de ${sourceId}:`, err);
    return res.status(500).json({ error: 'Erro ao buscar dados remotos da fonte: ' + err.message });
  }
});

function syncSpecificSource(sourceId) {
  const projectRoot = path.join(__dirname, '..');
  const scriptPath = path.join(projectRoot, 'scripts', 'sync-mihon-repos.js');
  
  console.log(`[sync:background] Iniciando sincronização em background para a fonte: ${sourceId}`);
  
  const child = spawn(process.execPath, [scriptPath, '--source', sourceId], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SYNC_CONTINUOUS: '0'
    },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true
  });
  
  child.unref();
}

function removeSourceData(source) {
  if (!source) return;
  const { source_id: sourceId, provider } = source;

  if (provider === 'mangadex' || sourceId === 'mangadex' || sourceId === '1') {
    db.prepare('DELETE FROM manga_origins WHERE source_url LIKE ? OR source_name = ?').run('%mangadex.org%', 'MangaDex');
    db.prepare('DELETE FROM manga_source_cache WHERE provider = ?').run('mangadex');
    db.prepare('DELETE FROM manga_chapters_cache WHERE source_key LIKE ?').run('md:%');
  } else {
    const sourceUrl = `suwayomi://source/${sourceId}`;
    db.prepare('DELETE FROM manga_origins WHERE source_url = ? OR source_url LIKE ?').run(sourceUrl, `%/${sourceId}`);
    db.prepare('DELETE FROM manga_source_cache WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM manga_chapters_cache WHERE source_key LIKE ?').run(`sw:${sourceId}:%`);
    
    // Limpa referências de capítulos do Suwayomi que ficaram órfãs desta fonte
    db.prepare(`
      DELETE FROM suwayomi_chapter_refs 
      WHERE manga_external_id NOT IN (SELECT external_id FROM manga_origins)
    `).run();
  }
}

function cleanupOrphanMangas() {
  const orphanMangas = db.prepare(`
    SELECT id FROM mangas 
    WHERE id NOT IN (SELECT DISTINCT manga_id FROM manga_origins)
  `).all();

  if (orphanMangas.length > 0) {
    const orphanIds = orphanMangas.map(m => m.id);
    const placeholders = orphanIds.map(() => '?').join(',');

    const tablesToClean = [
      'manga_categories',
      'manga_languages',
      'library_entries',
      'favorites',
      'reading_history',
      'manga_aliases',
      'manga_source_cache',
      'page_comments',
      'chapter_comments',
      'page_bookmarks',
      'user_manga_categories',
      'banned_mangas'
    ];

    const tx = db.transaction(() => {
      for (const table of tablesToClean) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE manga_id IN (${placeholders})`).run(...orphanIds);
        } catch (err) {
          // Silencioso se a tabela/coluna não existir
        }
      }
      db.prepare(`DELETE FROM mangas WHERE id IN (${placeholders})`).run(...orphanIds);
    });
    tx();

    console.log(`[admin:cleanup] Removidos ${orphanIds.length} mangás órfãos das tabelas secundárias e da tabela principal.`);
  }
}

app.get('/api/admin/sources/remote', requireAuth, requireOwner, async (req, res) => {
  try {
    const sources = await fetchSuwayomiSources('all');
    return res.json({ sources });
  } catch (error) {
    return res.status(502).json({ error: `Falha ao listar fontes remotas: ${error.message}` });
  }
});

app.get('/api/sources/enabled', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT source_id, source_name, lang, provider
    FROM enabled_sources
    WHERE is_active = 1
    ORDER BY source_name ASC
  `).all();
  return res.json({ sources: rows });
});

app.get('/api/admin/sources', requireAuth, requireOwner, (req, res) => {
  const rows = db.prepare(`
    SELECT 
      es.*,
      (SELECT COUNT(*) FROM manga_origins mo 
       WHERE mo.source_url = 'suwayomi://source/' || es.source_id 
          OR (es.source_id = 'mangadex' AND mo.source_url LIKE '%mangadex.org%')
      ) as manga_count
    FROM enabled_sources es
    ORDER BY es.source_name ASC
  `).all();
  return res.json({ sources: rows });
});

app.post('/api/admin/sources', requireAuth, requireOwner, (req, res) => {
  const { sourceId, sourceName, lang, provider, isActive } = req.body;
  if (!sourceId || !sourceName || !lang) return res.status(400).json({ error: 'Dados incompletos.' });

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO enabled_sources (source_id, source_name, lang, provider, is_active)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        source_name = excluded.source_name,
        lang = excluded.lang,
        is_active = excluded.is_active
    `).run(sourceId, sourceName, normalizeTesteSourceLanguage(lang), provider || 'suwayomi', isActive ? 1 : 0);

    if (!isActive) {
      console.log(`[admin:sources] Desabilitando fonte ${sourceId} e limpando dados...`);
      removeSourceData({ source_id: sourceId, provider: provider || 'suwayomi' });
      cleanupOrphanMangas();
    }
  });
  tx();

  // Aborta o processo de sincronização atual para que ele reinicie respeitando as mudanças
  stopSync();

  if (isActive) {
    syncSpecificSource(sourceId);
  }

  return res.json({ success: true });
});

app.delete('/api/admin/sources/:sourceId', requireAuth, requireOwner, (req, res) => {
  const sourceId = req.params.sourceId;
  const tx = db.transaction(() => {
    const source = db.prepare('SELECT * FROM enabled_sources WHERE source_id = ?').get(sourceId);
    if (!source) return;

    db.prepare('DELETE FROM enabled_sources WHERE source_id = ?').run(sourceId);
    removeSourceData(source);
    cleanupOrphanMangas();
  });
  tx();

  // Aborta o processo de sincronização atual para refletir a exclusão
  stopSync();

  return res.json({ success: true });
});

app.get('/api/admin/sources/:sourceId/mangas', requireAuth, requireOwner, (req, res) => {
  const sourceId = req.params.sourceId;
  const sourceUrl = `suwayomi://source/${sourceId}`;
  
  const rows = db.prepare(`
    SELECT m.id, m.title, m.cover_url
    FROM mangas m
    JOIN manga_origins mo ON mo.manga_id = m.id
    WHERE mo.source_url = ?
    LIMIT 100
  `).all(sourceUrl);

  return res.json({ mangas: rows });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = getUserById(req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  const preferredLanguage = getUserPreferredLanguage(req.user.userId);
  return res.json({ user: { ...serializeUserRow(user), preferredLanguage } });
});

app.get('/api/genres', (req, res) => {
  const userId = req.user?.userId;
  const nsfwEnabled = userId ? getNsfwProtection(userId) === 0 : false;
  const nsfwPattern = nsfwEnabled ? '' : "AND c.name NOT LIKE '%Adult%' AND c.name NOT LIKE '%Hentai%' AND c.name NOT LIKE '%Ecchi%' AND c.name NOT LIKE '%Yaoi%' AND c.name NOT LIKE '%Yuri%' AND c.name NOT LIKE '%Smut%' AND c.name NOT LIKE '%Sexual%' AND c.name NOT LIKE '%Mature%'";

  const genres = db
    .prepare(`
      SELECT c.id, c.name, COUNT(mc.manga_id) AS manga_count
      FROM categories c
      LEFT JOIN manga_categories mc ON mc.category_id = c.id
      WHERE c.name NOT GLOB '[0-9]*' AND c.name NOT GLOB '[0-9][0-9][0-9][0-9]*' ${nsfwPattern}
      GROUP BY c.id
      ORDER BY c.name
    `)
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      mangaCount: row.manga_count || 0
    }));

  return res.json({ genres });
});

app.get('/api/categories', requireAuth, (req, res) => {
  const categories = db
    .prepare(`
      SELECT uc.id, uc.name, COUNT(umc.manga_id) AS manga_count
      FROM user_categories uc
      LEFT JOIN user_manga_categories umc ON umc.category_id = uc.id AND umc.user_id = uc.user_id
      WHERE uc.user_id = ?
      GROUP BY uc.id
      ORDER BY uc.name
    `)
    .all(req.user.userId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      mangaCount: row.manga_count || 0
    }));

  return res.json({ categories });
});

app.post('/api/categories', requireAuth, (req, res) => {
  const { name } = req.body || {};
  const normalizedName = String(name || '').trim();

  if (!normalizedName) {
    return res.status(400).json({ error: 'Nome da categoria é obrigatório.' });
  }

  db.prepare('INSERT OR IGNORE INTO user_categories (user_id, name) VALUES (?, ?)').run(req.user.userId, normalizedName);
  const category = db
    .prepare('SELECT id, name FROM user_categories WHERE user_id = ? AND name = ?')
    .get(req.user.userId, normalizedName);
  return res.status(201).json({ category });
});

app.patch('/api/categories/:id', requireAuth, (req, res) => {
  const categoryId = Number(req.params.id);
  const name = String(req.body?.name || '').trim();

  if (!Number.isInteger(categoryId)) {
    return res.status(400).json({ error: 'ID de categoria inválido.' });
  }

  if (!name) {
    return res.status(400).json({ error: 'Nome da categoria é obrigatório.' });
  }

  const category = db
    .prepare('SELECT id FROM user_categories WHERE id = ? AND user_id = ?')
    .get(categoryId, req.user.userId);
  if (!category) {
    return res.status(404).json({ error: 'Categoria não encontrada.' });
  }

  const existingByName = db
    .prepare('SELECT id FROM user_categories WHERE user_id = ? AND name = ? AND id <> ?')
    .get(req.user.userId, name, categoryId);
  if (existingByName) {
    return res.status(409).json({ error: 'Já existe uma categoria com esse nome.' });
  }

  db.prepare('UPDATE user_categories SET name = ? WHERE id = ? AND user_id = ?').run(name, categoryId, req.user.userId);
  const updated = db
    .prepare('SELECT id, name FROM user_categories WHERE id = ? AND user_id = ?')
    .get(categoryId, req.user.userId);
  return res.json({ category: updated });
});

app.delete('/api/categories/:id', requireAuth, (req, res) => {
  const categoryId = Number(req.params.id);
  if (!Number.isInteger(categoryId)) {
    return res.status(400).json({ error: 'ID de categoria inválido.' });
  }

  const exists = db
    .prepare('SELECT id FROM user_categories WHERE id = ? AND user_id = ?')
    .get(categoryId, req.user.userId);
  if (!exists) {
    return res.status(404).json({ error: 'Categoria não encontrada.' });
  }

  db.prepare('DELETE FROM user_categories WHERE id = ? AND user_id = ?').run(categoryId, req.user.userId);
  return res.json({ message: 'Categoria removida com sucesso.' });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const preferredLanguage = getUserPreferredLanguage(req.user.userId);

  const stats = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM library_entries WHERE user_id = ?) AS library_count,
        (SELECT COUNT(*) FROM favorites WHERE user_id = ?) AS favorite_count,
        (SELECT COALESCE(SUM(current_chapter), 0) FROM library_entries WHERE user_id = ?) AS chapters_read,
        (SELECT COALESCE(SUM(last_page), 0) FROM library_entries WHERE user_id = ?) AS pages_read,
        (SELECT COUNT(*) FROM library_entries le JOIN mangas m ON m.id = le.manga_id WHERE le.user_id = ? AND m.publication_status = 'completed') AS completed_in_library,
        (SELECT COUNT(*) FROM library_entries le JOIN mangas m ON m.id = le.manga_id WHERE le.user_id = ? AND m.publication_status IN ('ongoing', 'hiatus')) AS ongoing_in_library,
        (SELECT COUNT(*) FROM user_categories WHERE user_id = ?) AS categories_count
    `)
    .get(
      req.user.userId,
      req.user.userId,
      req.user.userId,
      req.user.userId,
      req.user.userId,
      req.user.userId,
      req.user.userId
    );

  return res.json({
    preferences: {
      preferredLanguage,
      nsfwProtection: getUserNsfwProtection(req.user.userId)
    },
    stats: {
      libraryCount: stats.library_count || 0,
      favoriteCount: stats.favorite_count || 0,
      chaptersRead: stats.chapters_read || 0,
      pagesRead: stats.pages_read || 0,
      completedInLibrary: stats.completed_in_library || 0,
      ongoingInLibrary: stats.ongoing_in_library || 0,
      categoriesCount: stats.categories_count || 0
    }
  });
});

app.patch('/api/settings/language', requireAuth, (req, res) => {
  const preferredLanguage = normalizeProfileLanguage(req.body?.preferredLanguage, '');

  if (!preferredLanguage || !PROFILE_LANGUAGES.has(preferredLanguage)) {
    return res.status(400).json({ error: 'Idioma inválido. Use pt-br, en ou es.' });
  }

  ensureUserPreference(req.user.userId);
  db.prepare(`
    UPDATE user_preferences
    SET preferred_language = ?, updated_at = datetime('now')
    WHERE user_id = ?
  `).run(preferredLanguage, req.user.userId);

  return res.json({ preferredLanguage });
});

app.patch('/api/settings/nsfw', requireAuth, (req, res) => {
  const nsfwProtection = req.body?.nsfwProtection === true || req.body?.nsfwProtection === 1 || req.body?.nsfwProtection === 'true' ? 1 : 0;
  setUserNsfwProtection(req.user.userId, nsfwProtection);
  return res.json({ nsfwProtection });
});

app.get('/api/mangas', attachOptionalUser, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const hasSearch = search.length >= 2;
  const genre = getGenreFilterValue(req.query);
  const status = String(req.query.status || '').trim();
  const requestedLanguage = String(req.query.language || '').trim();
  const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 24));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const userId = req.user?.userId || -1;
  const preferredLanguage = req.user?.userId ? getUserPreferredLanguage(req.user.userId) : 'pt-br';
  const userNsfwProtection = req.user?.userId ? getUserNsfwProtection(req.user.userId) : 1;
  const language = requestedLanguage === 'preferred' ? preferredLanguage : requestedLanguage;
  await refreshSuwayomiSourceHealthSnapshot();

  const userSelectParams = [userId, userId, userId];
  const filterParams = [];
  const whereParts = ['1=1', ...buildSavedCatalogWhereParts('m'), buildExcludedBannedMangasClause('m')];

appendCategoryFilter(whereParts, filterParams, genre, 'm');
  appendStatusFilter(whereParts, filterParams, status, 'm');
  appendLanguageFilter(whereParts, filterParams, language, 'm');

  // Advanced Filters
  const includeGenres = String(req.query.includeGenres || '').split(',').filter(Boolean);
  const excludeGenres = String(req.query.excludeGenres || '').split(',').filter(Boolean);
  const filterSources = String(req.query.sources || '').split(',').filter(Boolean);
  const strictInclude = String(req.query.strictInclude) === '1';

  if (includeGenres.length > 0) {
    if (strictInclude) {
      includeGenres.forEach(g => {
        whereParts.push(`EXISTS (SELECT 1 FROM manga_categories mc_inc JOIN categories c_inc ON c_inc.id = mc_inc.category_id WHERE mc_inc.manga_id = m.id AND c_inc.name = ?)`);
        filterParams.push(g);
      });
    } else {
      const placeholders = includeGenres.map(() => '?').join(',');
      whereParts.push(`EXISTS (SELECT 1 FROM manga_categories mc_inc JOIN categories c_inc ON c_inc.id = mc_inc.category_id WHERE mc_inc.manga_id = m.id AND c_inc.name IN (${placeholders}))`);
      filterParams.push(...includeGenres);
    }
  }

  if (excludeGenres.length > 0) {
    const placeholders = excludeGenres.map(() => '?').join(',');
    whereParts.push(`NOT EXISTS (SELECT 1 FROM manga_categories mc_exc JOIN categories c_exc ON c_exc.id = mc_exc.category_id WHERE mc_exc.manga_id = m.id AND c_exc.name IN (${placeholders}))`);
    filterParams.push(...excludeGenres);
  }

  if (filterSources.length > 0) {
    const placeholders = filterSources.map(() => '?').join(',');
    whereParts.push(`EXISTS (SELECT 1 FROM manga_origins mo_src WHERE mo_src.manga_id = m.id AND (mo_src.source_url LIKE 'suwayomi://source/%' AND SUBSTR(mo_src.source_url, 20) IN (${placeholders})))`);
    filterParams.push(...filterSources);
  }

  // Filtro NSFW: usar coluna direta
  if (userNsfwProtection) {
    whereParts.push(`(m.is_nsfw = 0 OR m.is_nsfw IS NULL)`);
  }

  const countRow = db
    .prepare(`
      SELECT COUNT(DISTINCT m.id) AS total_count
      FROM mangas m
      WHERE ${whereParts.join(' AND ')}
    `)
    .get(...filterParams);

  const rows = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        (
          SELECT GROUP_CONCAT(DISTINCT ma.alias)
          FROM manga_aliases ma
          WHERE ma.manga_id = m.id
        ) AS search_aliases,
        EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.manga_id = m.id) AS is_favorited,
        EXISTS(SELECT 1 FROM library_entries le WHERE le.user_id = ? AND le.manga_id = m.id) AS in_library,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.manga_id = m.id AND umc.user_id = ?
        ) AS user_categories
      FROM mangas m
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE ${whereParts.join(' AND ')}
      GROUP BY m.id
      ORDER BY COALESCE(m.last_synced_at, m.created_at) DESC, m.title ASC
      LIMIT ? OFFSET ?
    `)
    .all(
      ...userSelectParams,
      ...filterParams,
      hasSearch ? Math.max(500, Math.min(12000, limit * 250)) : Math.max(limit * 4, limit + 1),
      hasSearch ? 0 : offset
    );

  let rankedRows = rows;
  if (hasSearch) {
    rankedRows = rows
      .map((row) => ({
        row,
        score: scoreSearchCandidate(search, row)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        const scoreDiff = b.score - a.score;
        if (scoreDiff !== 0) return scoreDiff;
        const favoritesDiff = (Number(b.row?.favorite_count) || 0) - (Number(a.row?.favorite_count) || 0);
        if (favoritesDiff !== 0) return favoritesDiff;
        return String(a.row?.title || '').localeCompare(String(b.row?.title || ''), 'pt-BR');
      })
      .map((entry) => entry.row);
  }

  const deduped = dedupeMangaItems(rankedRows.map(serializeMangaRow));
  const totalCount = hasSearch
    ? deduped.length
    : Math.max(0, Number(countRow?.total_count) || 0);
  const slicedRows = hasSearch
    ? deduped.slice(offset, offset + limit)
    : deduped.slice(0, limit);
  const hasMore = hasSearch
    ? offset + slicedRows.length < totalCount
    : offset + rows.length < totalCount || deduped.length > limit;
  const nextOffset = hasMore
    ? offset + slicedRows.length
    : null;

  return res.json({
    mangas: slicedRows,
    pagination: {
      limit,
      offset,
      hasMore,
      nextOffset
    }
  });
});

app.get('/api/mangas/suggestions', attachOptionalUser, async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) {
    return res.json({ suggestions: [] });
  }

  await refreshSuwayomiSourceHealthSnapshot();

  const whereParts = [...buildSavedCatalogWhereParts('m'), buildExcludedBannedMangasClause('m')];
  const rows = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.author,
        m.description,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        (
          SELECT GROUP_CONCAT(DISTINCT ma.alias)
          FROM manga_aliases ma
          WHERE ma.manga_id = m.id
        ) AS search_aliases
      FROM mangas m
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY COALESCE(fc.favorite_count, 0) DESC, m.title ASC
      LIMIT 2400
    `)
    .all();

  const ranked = rows
    .map((row) => ({
      row,
      score: scoreSearchCandidate(query, row)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      const favoritesDiff = (Number(b.row?.favorite_count) || 0) - (Number(a.row?.favorite_count) || 0);
      if (favoritesDiff !== 0) return favoritesDiff;
      return String(a.row?.title || '').localeCompare(String(b.row?.title || ''), 'pt-BR');
    });

  const seen = new Set();
  const suggestions = [];
  ranked.forEach(({ row }) => {
    const title = String(row?.title || '').trim();
    if (!title || seen.has(title.toLowerCase())) return;
    seen.add(title.toLowerCase());
    suggestions.push(title);
  });

  const useMangadex = ENABLE_MANGADEX_FALLBACK || await isSourceEnabled('mangadex');
  if (useMangadex && suggestions.length < 5) {
    try {
      const mdResults = await searchMangadexByTitle(query, 10);
      mdResults.forEach(m => {
        const title = (m.title || '').trim();
        if (title && !seen.has(title.toLowerCase())) {
          seen.add(title.toLowerCase());
          suggestions.push(title);
        }
      });
    } catch (e) {
      // Ignorar erros na busca do mangadex
    }
  }

  return res.json({ suggestions: suggestions.slice(0, 20) });
});

app.get('/api/mangas/recommended', attachOptionalUser, async (req, res) => {
  const limit = Math.max(1, Math.min(40, Number(req.query.limit) || 16));
  const random = req.query.random === '1';
  const forceRefreshSources = String(req.query.refreshSources || '').trim() === '1';
  await refreshSuwayomiSourceHealthSnapshot({ force: forceRefreshSources });
  const userId = req.user?.userId || -1;
  const mangas = buildRecommendedMangas(userId, limit, random);

  return res.json({
    mangas,
    generatedAt: new Date().toISOString(),
    mode: random ? 'random' : (userId > 0 ? 'latest_personalized' : 'latest')
  });
});

app.get('/api/mangas/:id', attachOptionalUser, (req, res) => {
  const mangaId = Number(req.params.id);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  // Verificar se está banido
  if (isMangaBanned(mangaId)) {
    return res.status(404).json({ error: 'Mangá não encontrado.' });
  }

  const userId = req.user?.userId || -1;
  const row = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        m.is_nsfw,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        EXISTS(SELECT 1 FROM favorites f WHERE f.user_id = ? AND f.manga_id = m.id) AS is_favorited,
        EXISTS(SELECT 1 FROM library_entries le WHERE le.user_id = ? AND le.manga_id = m.id) AS in_library,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.manga_id = m.id AND umc.user_id = ?
        ) AS user_categories,
        le.current_chapter,
        le.last_page,
        le.source_id,
        le.source_name,
        le.source_language,
        le.updated_at
      FROM mangas m
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      LEFT JOIN library_entries le ON le.manga_id = m.id AND le.user_id = ?
      WHERE m.id = ?
      GROUP BY m.id
    `)
    .get(userId, userId, userId, userId, mangaId);

  if (!row) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  const manga = {
    ...serializeMangaRow(row),
    progress: row.current_chapter
      ? {
          currentChapter: row.current_chapter,
          lastPage: row.last_page,
          sourceId: row.source_id || '',
          sourceName: row.source_name || '',
          sourceLanguage: row.source_language || row.source_lang || '',
          updatedAt: row.updated_at
        }
      : null
  };

  return res.json({ manga });
});

app.get('/api/mangas/:id/chapters', attachOptionalUser, async (req, res) => {
  const mangaId = Number(req.params.id);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const manga = db
    .prepare(`
      SELECT
        m.id, m.title, m.author, m.description, m.total_chapters,
        m.publication_status, m.chapters_consistent, m.cover_url, m.is_nsfw,
        GROUP_CONCAT(DISTINCT g.name) AS genres
      FROM mangas m
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE m.id = ?
      GROUP BY m.id
    `)
    .get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  const mangaGenres = parseCategoriesString(manga.genres);
  const mangaIsNsfwDirect = manga.is_nsfw === 1 || mangaGenres.some(g => isNsfwCategoryName(g));

  const requestedMode = normalizeDetailLanguage(req.query.lang, 'preferred');
  const requestedSourceId = String(req.query.sourceId || '').trim();
  const allowExpandedSearch = String(req.query.checkSources || '').trim() === '1';
  const preferredLanguage = req.user?.userId
    ? getUserPreferredLanguage(req.user.userId)
    : normalizeProfileLanguage(requestedMode, 'pt-br');
  const resolvedMode = requestedMode === 'preferred' ? preferredLanguage : requestedMode;
  const mode = SUPPORTED_DETAIL_LANGUAGES.has(resolvedMode) ? resolvedMode : preferredLanguage;
  const targetSourceLang = normalizeTesteSourceLanguage(mapProfileLanguageToTesteLanguage(mode, 'pt'));

  const responseCacheKey = `manga:${mangaId}:chapters:${mode}:${requestedSourceId || '-'}:${preferredLanguage}:${allowExpandedSearch ? '1' : '0'}`;
  const cachedResponse = mangaChaptersResponseCache.get(responseCacheKey);
  if (cachedResponse) {
    return res.json(cachedResponse);
  }

  const aliasesFromDescription = extractAlternativeTitlesFromDescription(manga.description || '', 18);
  const aliasesFromDb = getMangaAliases(mangaId, 36);
  const allAliases = Array.from(new Set([...aliasesFromDb, ...aliasesFromDescription]));
  if (aliasesFromDescription.length > 0) {
    saveMangaAliases(mangaId, aliasesFromDescription, 'description');
  }

  let sourceMap = new Map();
  try {
    sourceMap = await fetchTesteSourcesMap('all');
  } catch {
    sourceMap = new Map();
  }
  const blockedSourceUrls = getBlockedSourceUrlSet();

  const maxCandidatesToCheck = allowExpandedSearch
    ? SUWAYOMI_DETAIL_SEARCH_EXPANDED_CANDIDATES
    : SUWAYOMI_DETAIL_SEARCH_DEFAULT_CANDIDATES;

  const candidates = [];
  const seenCandidateIds = new Set();
  const addSuwayomiCandidate = (input, scoreBoost = 0) => {
    const externalId = String(input?.externalId || '').trim();
    const sourceId = String(input?.sourceId || '').trim();
    if (!externalId || !sourceId) return;

    const candidateId = `sw:${sourceId}:${externalId}`;
    if (seenCandidateIds.has(candidateId)) return;

    const sourceUrl = `suwayomi://source/${sourceId}`;
    if (blockedSourceUrls.has(sourceUrl)) return;

    const sourceInfo = sourceMap.get(sourceId);
    if (sourceMap.size > 0 && !sourceInfo) {
      const fallbackName = String(input?.sourceName || `Fonte ${sourceId}`).trim() || `Fonte ${sourceId}`;
      markSourceAsDown(sourceUrl, fallbackName, 'Fonte não encontrada no Suwayomi.');
      blockedSourceUrls.add(sourceUrl);
      return;
    }

    const sourceName = String(input?.sourceName || sourceInfo?.name || `Fonte ${sourceId}`).trim();
    const sourceLang = normalizeTesteSourceLanguage(input?.sourceLang || sourceInfo?.lang || targetSourceLang || '');
    if (sourceLang && targetSourceLang && sourceLang !== targetSourceLang) return;

    const candidateIsNsfw = getExtensionSourceNsfwFlag(sourceId, sourceLang) || hasNsfwKeyword(sourceName);
    const titleForScore = input?.candidateTitle || manga.title;
    const authorForScore = String(input?.author || manga.author || '').trim();
    const score = scoreSource(
      {
        title: manga.title,
        author: authorForScore,
        aliases: allAliases,
        genres: mangaGenres,
        totalChapters: manga.total_chapters,
        sourceLang: targetSourceLang || '',
        coverUrl: manga.cover_url || ''
      },
      {
        title: titleForScore,
        author: authorForScore,
        aliases: [],
        genres: [],
        totalChapters: Math.max(0, Number(input?.chapterCount) || 0),
        sourceLang,
        sourceName,
        sourceId,
        provider: 'suwayomi',
        coverUrl: ''
      },
      { candidateIsNsfw }
    ) + scoreBoost;

    seenCandidateIds.add(candidateId);
    candidates.push({
      id: candidateId,
      provider: 'suwayomi',
      externalId,
      sourceId,
      sourceName,
      sourceLang,
      sourceUrl,
      score,
      cachedChapterCount: Math.max(0, Number(input?.chapterCount) || 0)
    });
  };

  const cachedEntries = readCachedMangaSourceEntries(mangaId, targetSourceLang, allowExpandedSearch ? 60 : 36);
  cachedEntries.forEach((entry) => {
    if (entry.provider !== 'suwayomi') return;
    addSuwayomiCandidate({
      externalId: entry.externalId,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName,
      sourceLang: entry.sourceLang,
      chapterCount: entry.chapterCount
    }, 190);
  });

  const knownOrigins = getMangaOrigins(mangaId)
    .filter((origin) => String(origin?.source_url || '').startsWith('suwayomi://source/'));
  for (const origin of knownOrigins) {
    addSuwayomiCandidate({
      externalId: String(origin.external_id || '').trim(),
      sourceId: String(origin.source_url || '').replace('suwayomi://source/', '').trim(),
      sourceName: origin.source_name || '',
      sourceLang: '',
      chapterCount: 0
    }, 170);
  }

  const requestedSwSource = /^sw:([^:]+):(.+)$/i.exec(requestedSourceId);
  if (requestedSwSource) {
    addSuwayomiCandidate({
      sourceId: requestedSwSource[1],
      externalId: requestedSwSource[2],
      sourceName: sourceMap.get(requestedSwSource[1])?.name || `Fonte ${requestedSwSource[1]}`,
      sourceLang: sourceMap.get(requestedSwSource[1])?.lang || targetSourceLang
    }, 220);
  }

  const shouldSearchByTitle = candidates.length === 0 || (!requestedSourceId && candidates.every((item) => item.score < 260));
  if (shouldSearchByTitle) {
    const searchTerms = buildSearchTermsWithAliases(manga.title, allAliases).slice(0, allowExpandedSearch ? 5 : 3);
    if (searchTerms.length === 0) {
      searchTerms.push(String(manga.title || '').trim());
    }
    const searchResults = [];
    const seenSearchKey = new Set();
    const searchLangCandidates = [];
    if (targetSourceLang === 'en') {
      searchLangCandidates.push('en');
    } else if (targetSourceLang === 'es') {
      searchLangCandidates.push('es');
    } else {
      searchLangCandidates.push('pt');
    }
    if (allowExpandedSearch && !searchLangCandidates.includes('all')) {
      searchLangCandidates.push('all');
    }
    const maxSearchResults = allowExpandedSearch ? 24 : 12;

    try {
      searchLoop:
      for (const lang of searchLangCandidates) {
        for (const term of searchTerms) {
          const searchPayload = await fetchTesteJson('/search', {
            q: term,
            page: 1,
            lang
          }, {
            ttlMs: 60_000
          });
          const partial = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
          for (const result of partial) {
            const key = `${result?.source_id || ''}:${result?.id || ''}`;
            if (!key || seenSearchKey.has(key)) continue;
            seenSearchKey.add(key);
            searchResults.push(result);
          }
          if (searchResults.length >= maxSearchResults) break searchLoop;
        }
      }
    } catch (error) {
      return res.status(502).json({ error: `Falha ao pesquisar capítulos no Suwayomi: ${error.message}` });
    }

    if (searchResults.length === 0) {
      const emptyPayload = {
        mangaId,
        mangaTitle: manga.title,
        source: '',
        selectedSourceId: '',
        sources: [],
        chapters: [],
        availableLanguages: [],
        searchInfo: {
          checkedCandidates: 0,
          searchedAlternatives: allowExpandedSearch,
          fallbackToAllLanguages: false,
          noSourcesForLanguage: true
        }
      };
      mangaChaptersResponseCache.set(responseCacheKey, emptyPayload, 60_000);
      return res.json(emptyPayload);
    }

    for (const item of searchResults) {
      addSuwayomiCandidate({
        externalId: String(item?.id || '').trim(),
        sourceId: String(item?.source_id || '').trim(),
        sourceName: item?.source_name || sourceMap.get(String(item?.source_id || '').trim())?.name || '',
        sourceLang: normalizeTesteSourceLanguage(item?.lang || item?.source_lang || targetSourceLang),
        candidateTitle: String(item?.title || '').trim()
      }, 0);
    }
  }

  candidates.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    const cachedDiff = b.cachedChapterCount - a.cachedChapterCount;
    if (cachedDiff !== 0) return cachedDiff;
    return a.id.localeCompare(b.id, 'pt-BR');
  });

  let selectedCandidates = candidates.slice(0, maxCandidatesToCheck);
  if (requestedSourceId && !selectedCandidates.find((item) => item.id === requestedSourceId)) {
    const requestedCandidate = candidates.find((item) => item.id === requestedSourceId);
    if (requestedCandidate) {
      selectedCandidates = [requestedCandidate]
        .concat(selectedCandidates.filter((item) => item.id !== requestedCandidate.id))
        .slice(0, maxCandidatesToCheck);
    }
  }

  const suwayomiAttempts = await Promise.all(
    selectedCandidates.map(async (candidate) => {
      const sourceUrl = normalizeSourceUrl(candidate?.sourceUrl || `suwayomi://source/${candidate?.sourceId || ''}`);
      const sourceName = String(candidate?.sourceName || '').trim();

      // Verificar se fonte está habilitada antes de buscar
      const isEnabled = db.prepare('SELECT 1 FROM enabled_sources WHERE source_id = ? AND is_active = 1').get(candidate?.sourceId);
      if (!isEnabled) {
        return null;
      }

      // Tentar cache persistente (SQLite) primeiro
      const cachedChapters = readCachedMangaChapters(candidate.id, candidate.externalId, 720);
      if (Array.isArray(cachedChapters) && cachedChapters.length > 0) {
        return {
          candidate,
          chapters: cachedChapters
        };
      }

      try {
        const payload = await fetchTesteJson(`/manga/${candidate.externalId}/chapters`, {
          order: 'asc'
        }, {
          ttlMs: 90_000
        });
        markSourceAsUp(sourceUrl, sourceName);
        const rawChapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
        const seenChapterIds = new Set();
        const chapters = rawChapters
          .map((chapter, index) => {
            const chapterRef = String(chapter?.chapter_id || chapter?.id || '').trim();
            if (!chapterRef) return null;
            const chapterId = `sw:${candidate.externalId}:${chapterRef}`;
            if (seenChapterIds.has(chapterId)) return null;
            seenChapterIds.add(chapterId);

            const chapterNumberRaw = Number(chapter?.index);
            const chapterIndexFallback = Number(chapter?.chapter_index);
            const fallbackChapterNumber = normalizeChapterNumber(chapterIndexFallback, index + 1);
            const chapterNumber = normalizeChapterNumber(chapterNumberRaw, fallbackChapterNumber);
            const rawChapterLabel = String(chapter?.index ?? '').trim();
            const chapterLabel = normalizeChapterNumber(rawChapterLabel, 0) > 0
              ? rawChapterLabel
              : String(chapterNumber);
            const rawPages = Number(chapter?.pages);
            const pages = Number.isFinite(rawPages) && rawPages > 0 ? Math.round(rawPages) : 1;
            const chapterRouteIndexRaw = Number(chapter?.chapter_index);
            const chapterRouteIndex =
              Number.isFinite(chapterRouteIndexRaw) && chapterRouteIndexRaw >= 0
                ? Math.round(chapterRouteIndexRaw)
                : null;
            const uploadTimestamp = Number(chapter?.date_upload);
            const publishedAt = Number.isFinite(uploadTimestamp) && uploadTimestamp > 0
              ? new Date(uploadTimestamp).toISOString()
              : null;

            if (Number.isInteger(chapterRouteIndex) && chapterRouteIndex >= 0) {
              cacheSuwayomiChapterRef(candidate.externalId, chapterRef, chapterRouteIndex, pages);
            }

            return {
              id: chapterId,
              chapterRef,
              routeIndex: chapterRouteIndex,
              mangaExternalId: candidate.externalId,
              sourceId: candidate.id,
              sourceName: candidate.sourceName,
              sourceLanguage: candidate.sourceLang || targetSourceLang || 'pt-br',
              number: chapterLabel,
              chapterNumber,
              title: String(chapter?.name || '').trim(),
              pages,
              language: candidate.sourceLang || targetSourceLang || 'pt-br',
              publishedAt
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.chapterNumber - b.chapterNumber);

        // Salvar no cache persistente se houver resultados
        if (chapters.length > 0) {
          upsertMangaChaptersCache(candidate.id, candidate.externalId, chapters);
        }

        return {
          candidate,
          chapters
        };
      } catch (error) {
        markSourceAsDown(sourceUrl, sourceName, error?.message || 'Falha ao acessar capítulos da fonte.');
        blockedSourceUrls.add(sourceUrl);
        return null;
      }
    })
  );

  const validAttempts = suwayomiAttempts.filter((item) => item && item.chapters.length > 0);

  const useMangadex = ENABLE_MANGADEX_FALLBACK || await isSourceEnabled('mangadex');
  const mangadexFallback = useMangadex
    ? await loadMangadexFallbackChapters(manga, {
      languageMode: mode,
      targetSourceLang,
      searchAliases: allAliases
    })
    : null;

  if (useMangadex && mangadexFallback && Array.isArray(mangadexFallback.chapters) && mangadexFallback.chapters.length > 0) {
    markSourceAsUp('https://mangadex.org', 'MangaDex');
    const fallbackSourceId = `md:${mangadexFallback.candidate.externalId}`;
    const fallbackSourceLang = normalizeTesteSourceLanguage(
      targetSourceLang
      || (mangadexFallback.availableLanguages.includes('pt-br') ? 'pt-br' : mangadexFallback.availableLanguages[0] || 'en')
    );

    const mappedChapters = mangadexFallback.chapters.map((chapter) => ({
      ...chapter,
      sourceId: fallbackSourceId,
      sourceName: mangadexFallback.candidate.sourceName || 'MangaDex',
      sourceLanguage: chapter.language || fallbackSourceLang || targetSourceLang || 'pt-br'
    }));

    validAttempts.push({
      candidate: {
        id: fallbackSourceId,
        provider: 'mangadex',
        externalId: mangadexFallback.candidate.externalId,
        sourceId: fallbackSourceId,
        sourceName: mangadexFallback.candidate.sourceName || 'MangaDex',
        sourceLang: fallbackSourceLang || targetSourceLang || '',
        sourceUrl: mangadexFallback.candidate.sourceUrl || 'https://mangadex.org',
        score: 480,
        cachedChapterCount: mappedChapters.length
      },
      chapters: mappedChapters,
      availableLanguages: Array.isArray(mangadexFallback.availableLanguages) ? mangadexFallback.availableLanguages : []
    });

    saveMangaAliases(mangaId, mangadexFallback.aliases || [], 'mangadex');
  }

  if (validAttempts.length === 0) {
    const emptyPayload = {
      mangaId,
      mangaTitle: manga.title,
      source: '',
      selectedSourceId: '',
      selectedSourceName: '',
      selectedSourceLanguage: targetSourceLang || mode,
      sources: [],
      chapters: [],
      availableLanguages: [],
      searchInfo: {
        checkedCandidates: selectedCandidates.length,
        searchedAlternatives: allowExpandedSearch,
        fallbackToAllLanguages: false,
        noSourcesForLanguage: true
      }
    };
    mangaChaptersResponseCache.set(responseCacheKey, emptyPayload, 60_000);
    return res.json(emptyPayload);
  }

  const languagePool = validAttempts.filter((item) => {
    const sourceLang = normalizeTesteSourceLanguage(item?.candidate?.sourceLang || '');
    if (!targetSourceLang) return true;
    if (!sourceLang) return true;
    return sourceLang === targetSourceLang;
  });
  const fallbackToAllLanguages = Boolean(targetSourceLang && languagePool.length === 0);

  const pool = (languagePool.length > 0 ? languagePool : validAttempts).sort((a, b) => {
    const chapterDiff = b.chapters.length - a.chapters.length;
    if (chapterDiff !== 0) return chapterDiff;
    const providerDiff = Number(b.candidate.provider === 'mangadex') - Number(a.candidate.provider === 'mangadex');
    if (providerDiff !== 0) return providerDiff;
    const scoreDiff = b.candidate.score - a.candidate.score;
    if (scoreDiff !== 0) return scoreDiff;
    return a.candidate.id.localeCompare(b.candidate.id, 'pt-BR');
  });

  let selectedAttempt = pool[0];
  if (requestedSourceId) {
    const requested = pool.find((item) => item.candidate.id === requestedSourceId);
    if (requested) {
      selectedAttempt = requested;
    }
  } else {
    const preferredMangadex = pool.find(
      (item) => item.candidate.provider === 'mangadex'
        && (!targetSourceLang || normalizeTesteSourceLanguage(item.candidate.sourceLang) === targetSourceLang)
    );
    if (preferredMangadex) {
      selectedAttempt = preferredMangadex;
    }
  }

  const selectedSourceId = selectedAttempt.candidate.id;
  const selectedSourceLang = selectedAttempt.candidate.sourceLang || targetSourceLang || '';

  const bestTotal = validAttempts.reduce((maxValue, item) => Math.max(maxValue, item.chapters.length), 1);
  db.prepare(`
    UPDATE mangas
    SET total_chapters = ?, source_lang = ?, last_synced_at = datetime('now')
    WHERE id = ?
  `).run(bestTotal, selectedSourceLang || null, mangaId);

  if (selectedSourceLang) {
    db.prepare('INSERT OR IGNORE INTO manga_languages (manga_id, language) VALUES (?, ?)')
      .run(mangaId, selectedSourceLang);
  }

  validAttempts.forEach((attempt) => {
    const provider = attempt?.candidate?.provider || 'suwayomi';
    const sourceName = attempt?.candidate?.sourceName || 'Fonte externa';
    const sourceUrl = provider === 'mangadex'
      ? (attempt?.candidate?.sourceUrl || 'https://mangadex.org')
      : `suwayomi://source/${attempt?.candidate?.sourceId}`;

    upsertMangaOrigin(
      mangaId,
      sourceName,
      sourceUrl,
      attempt?.candidate?.externalId
    );

    upsertMangaSourceCacheEntry(mangaId, {
      sourceKey: attempt?.candidate?.id,
      provider,
      sourceId: attempt?.candidate?.sourceId,
      sourceName,
      sourceUrl,
      externalId: attempt?.candidate?.externalId,
      sourceLang: attempt?.candidate?.sourceLang,
      chapterCount: attempt?.chapters?.length || 0
    });
  });

  const sources = pool
    .map((item) => ({
      id: item.candidate.id,
      name: String(item?.candidate?.sourceName || 'Fonte externa').trim() || 'Fonte externa',
      url: item?.candidate?.provider === 'mangadex'
        ? (item?.candidate?.sourceUrl || 'https://mangadex.org')
        : `suwayomi://source/${item?.candidate?.sourceId}`,
      language: normalizeTesteSourceLanguage(item?.candidate?.sourceLang || ''),
      chaptersInLanguage: item.chapters.length,
      totalChapters: item.chapters.length,
      discovered: true
    }))
    .sort((a, b) => {
      const chapterDiff = b.chaptersInLanguage - a.chaptersInLanguage;
      if (chapterDiff !== 0) return chapterDiff;
      return a.name.localeCompare(b.name, 'pt-BR');
    });

  const availableLanguages = Array.from(
    new Set(
      validAttempts
        .filter((item) => item.chapters.length > 0)
        .map((item) => normalizeTesteSourceLanguage(item?.candidate?.sourceLang || ''))
        .filter((lang) => lang && lang !== 'unknown' && SUPPORTED_DETAIL_LANGUAGES.has(lang))
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR'));

  const responsePayload = {
    mangaId,
    mangaTitle: manga.title,
    source: selectedAttempt.candidate.sourceName,
    selectedSourceId,
    selectedSourceName: selectedAttempt.candidate.sourceName,
    selectedSourceLanguage: selectedSourceLang || mode,
    sources,
    chapters: selectedAttempt.chapters,
    availableLanguages,
    searchInfo: {
      checkedCandidates: selectedCandidates.length,
      searchedAlternatives: allowExpandedSearch,
      fallbackToAllLanguages,
      noSourcesForLanguage: false,
      fallbackProvider: selectedAttempt.candidate.provider === 'mangadex' ? 'mangadex' : 'suwayomi'
    }
  };

  mangaChaptersResponseCache.set(responseCacheKey, responsePayload, MANGA_CHAPTERS_RESPONSE_CACHE_TTL_MS);
  return res.json(responsePayload);
});

app.get('/api/chapters/:chapterId/pages', attachOptionalUser, async (req, res) => {
  const chapterId = String(req.params.chapterId || '').trim();
  const requestedOffset = Math.max(0, Number(req.query.offset) || 0);
  const requestedLimit = Number(req.query.limit);
  const hasLimitParam = Number.isFinite(requestedLimit) && requestedLimit > 0;
  const minimalPayload = String(req.query.minimal || '').trim() === '1';
  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId inválido.' });
  }

  const suwayomiRef = decodeSuwayomiChapterId(chapterId);
  if (suwayomiRef) {
    try {
      const requestedRouteIndex = Number(req.query.routeIndex);
      const routeIndex =
        Number.isInteger(requestedRouteIndex) && requestedRouteIndex >= 0
          ? requestedRouteIndex
          : null;

      const payload = await chapterPagesCache.wrap(
        `swpages:${suwayomiRef.mangaExternalId}:${suwayomiRef.chapterRef}:${routeIndex ?? '-'}`,
        () => fetchTesteJson(
          `/manga/${suwayomiRef.mangaExternalId}/chapter/${suwayomiRef.chapterRef}`,
          {
            routeIndex
          },
          {
            ttlMs: CHAPTER_PAGES_CACHE_TTL_MS
          }
        ),
        CHAPTER_PAGES_CACHE_TTL_MS
      );
      const rawPages = Array.isArray(payload?.pages) ? payload.pages : [];
      const totalPages = rawPages.length;
      if (totalPages === 0) {
        return res.status(404).json({ error: 'Páginas do capítulo não disponíveis.' });
      }

      const safeOffset = Math.max(0, Math.min(totalPages - 1, requestedOffset));
      const limit = hasLimitParam ? Math.max(1, Math.min(120, Math.round(requestedLimit))) : totalPages;
      const offset = hasLimitParam ? safeOffset : 0;
      const end = Math.min(totalPages, offset + limit);

      const pages = rawPages.slice(offset, end).map((page, index) => {
        const sourceUrl = normalizeSuwayomiImageUrl(page?.url || '');
        const mapped = {
          index: offset + index + 1,
          url: sourceUrl ? `/api/suwayomi-image?url=${encodeURIComponent(sourceUrl)}` : ''
        };
        if (!minimalPayload) {
          mapped.fileName = `page-${mapped.index}`;
        }
        return mapped;
      });

      return res.json({
        chapterId,
        totalPages,
        offset,
        limit: end - offset,
        hasMore: end < totalPages,
        pages,
        pagesSaver: pages
      });
    } catch (error) {
      const statusCode = String(error.message || '').toLowerCase().includes('não disponíveis') ? 404 : 502;
      return res.status(statusCode).json({ error: `Falha ao carregar páginas: ${error.message}` });
    }
  }

  const useMangadex = ENABLE_MANGADEX_FALLBACK || await isSourceEnabled('mangadex');
  if (!useMangadex) {
    return res.status(404).json({ error: 'Capítulo não disponível na fonte ativa.' });
  }

  try {
    const manifest = await chapterPagesCache.wrap(
      `chapter:${chapterId}`,
      async () => {
        const atHome = await fetchJson(`https://api.mangadex.org/at-home/server/${chapterId}`, {
          cacheKey: `mangadex:chapter:${chapterId}`,
          ttlMs: 60 * 1000
        });

        const hash = atHome?.chapter?.hash;
        const data = Array.isArray(atHome?.chapter?.data) ? atHome.chapter.data : [];
        const dataSaver = Array.isArray(atHome?.chapter?.dataSaver) ? atHome.chapter.dataSaver : [];
        const baseUrl = atHome?.baseUrl;

        if (!hash || !baseUrl || data.length === 0) {
          throw new Error('Páginas do capítulo não disponíveis.');
        }

        return {
          hash,
          baseUrl,
          data,
          dataSaver
        };
      },
      5 * 60 * 1000
    );

    const totalPages = manifest.data.length;
    const safeOffset = Math.max(0, Math.min(totalPages - 1, requestedOffset));
    const limit = hasLimitParam ? Math.max(1, Math.min(120, Math.round(requestedLimit))) : totalPages;
    const offset = hasLimitParam ? safeOffset : 0;
    const end = Math.min(totalPages, offset + limit);

    const toPayload = (fileName, index, folder) => {
      const page = {
        index: offset + index + 1,
        url: buildImageProxyUrl(`${manifest.baseUrl}/${folder}/${manifest.hash}/${fileName}`)
      };
      if (!minimalPayload) {
        page.fileName = fileName;
      }
      return page;
    };

    const pages = manifest.data.slice(offset, end).map((fileName, index) => toPayload(fileName, index, 'data'));
    const pagesSaver = manifest.dataSaver.slice(offset, end).map((fileName, index) => toPayload(fileName, index, 'data-saver'));

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    return res.json({
      chapterId,
      totalPages,
      offset,
      limit: end - offset,
      hasMore: end < totalPages,
      pages,
      pagesSaver
    });
  } catch (error) {
    if (String(error.message || '').includes('não disponíveis')) {
      return res.status(404).json({ error: 'Páginas do capítulo não disponíveis.' });
    }
    return res.status(502).json({ error: `Falha ao carregar páginas: ${error.message}` });
  }
});

app.get('/api/image-proxy', async (req, res) => {
  try {
    const imageUrl = normalizeExternalImageUrl(req.query.url);
    if (!imageUrl) {
      return res.status(400).json({ error: 'Parâmetro url inválido.' });
    }

    const parsed = new URL(imageUrl);
    if (isLocalOrPrivateHost(parsed.hostname)) {
      return res.status(403).json({ error: 'Host bloqueado por segurança.' });
    }

    const forwardedAccept = String(req.headers.accept || '').trim();
    const acceptedFormats = forwardedAccept.includes('image/')
      ? forwardedAccept
      : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Quadroz/1.0',
          Accept: acceptedFormats,
          Referer: 'https://mangadex.org/'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok || !response.body) {
      return res.status(502).json({ error: `Falha ao carregar imagem remota (${response.status}).` });
    }

    const contentType = String(response.headers.get('content-type') || '').trim();
    if (!contentType.startsWith('image/')) {
      return res.status(415).json({ error: 'URL remota não retornou uma imagem válida.' });
    }

    const upstreamCache = String(response.headers.get('cache-control') || '').trim();
    const cacheHeader =
      upstreamCache && !/private|no-store|max-age=0/i.test(upstreamCache)
        ? upstreamCache
        : 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheHeader);
    res.setHeader('CDN-Cache-Control', 'public, max-age=2592000, stale-while-revalidate=604800');
    res.setHeader('Vary', 'Accept, Accept-Encoding');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const length = response.headers.get('content-length');
    if (length) {
      res.setHeader('Content-Length', length);
    }
    const etag = response.headers.get('etag');
    if (etag) {
      res.setHeader('ETag', etag);
    }

    Readable.fromWeb(response.body).pipe(res);
    return undefined;
  } catch (error) {
    return res.status(502).json({ error: `Falha no proxy de imagem: ${error.message}` });
  }
});

app.get('/api/suwayomi-image', async (req, res) => {
  try {
    const imageUrl = normalizeSuwayomiImageUrl(req.query.url);
    if (!imageUrl) {
      return res.status(400).json({ error: 'URL de imagem Suwayomi inválida.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
      response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Quadroz/1.0',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok || !response.body) {
      return res.status(502).json({ error: `Falha ao carregar imagem do Suwayomi (${response.status}).` });
    }

    const contentType = String(response.headers.get('content-type') || '').trim();
    if (!contentType.startsWith('image/')) {
      return res.status(415).json({ error: 'Recurso retornado não é uma imagem válida.' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=3600, stale-while-revalidate=7200');
    res.setHeader('Vary', 'Accept, Accept-Encoding');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const etag = response.headers.get('etag');
    if (etag) {
      res.setHeader('ETag', etag);
    }
    const length = response.headers.get('content-length');
    if (length) {
      res.setHeader('Content-Length', length);
    }
    Readable.fromWeb(response.body).pipe(res);
    return undefined;
  } catch (error) {
    return res.status(502).json({ error: `Falha no proxy de imagem Suwayomi: ${error.message}` });
  }
});

app.get('/api/bookmarks/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const bookmark = db
    .prepare(`
      SELECT manga_id, chapter_id, page_index, updated_at
      FROM page_bookmarks
      WHERE user_id = ? AND manga_id = ?
    `)
    .get(req.user.userId, mangaId);

  return res.json({
    bookmark: bookmark
      ? {
          mangaId: bookmark.manga_id,
          chapterId: bookmark.chapter_id,
          pageIndex: bookmark.page_index,
          updatedAt: bookmark.updated_at
        }
      : null
  });
});

app.put('/api/bookmarks/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  const chapterId = String(req.body?.chapterId || '').trim();
  const pageIndex = Number(req.body?.pageIndex);

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId é obrigatório.' });
  }

  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return res.status(400).json({ error: 'pageIndex deve ser inteiro >= 1.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  db.prepare(`
    INSERT INTO page_bookmarks (user_id, manga_id, chapter_id, page_index, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, manga_id) DO UPDATE SET
      chapter_id = excluded.chapter_id,
      page_index = excluded.page_index,
      updated_at = excluded.updated_at
  `).run(req.user.userId, mangaId, chapterId, pageIndex);

  return res.json({
    bookmark: {
      mangaId,
      chapterId,
      pageIndex
    }
  });
});

app.delete('/api/bookmarks/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const result = db
    .prepare('DELETE FROM page_bookmarks WHERE user_id = ? AND manga_id = ?')
    .run(req.user.userId, mangaId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Nenhuma página marcada para esse mangá.' });
  }

  return res.json({ message: 'Marcador removido.' });
});

app.get('/api/history', requireAuth, (req, res) => {
  const userNsfwProtection = getUserNsfwProtection(req.user.userId) === 1;
  const history = db
    .prepare(`
      WITH ranked_history AS (
        SELECT
          rh.id,
          rh.manga_id,
          rh.chapter_id,
          rh.chapter_number,
          rh.page_index,
          rh.source_id,
          rh.source_name,
          rh.source_language,
          rh.updated_at,
          m.title,
          m.cover_url,
          m.author,
          m.publication_status,
          m.source_lang,
          m.is_nsfw,
          ROW_NUMBER() OVER (
            PARTITION BY rh.user_id, rh.manga_id
            ORDER BY rh.updated_at DESC, rh.id DESC
          ) AS row_rank
        FROM reading_history rh
        JOIN mangas m ON m.id = rh.manga_id
        WHERE rh.user_id = ?
          AND NOT EXISTS (SELECT 1 FROM banned_mangas bm WHERE bm.manga_id = m.id)
          ${userNsfwProtection ? 'AND m.is_nsfw = 0' : ''}
      )
      SELECT
        id,
        manga_id,
        chapter_id,
        chapter_number,
        page_index,
        source_id,
        source_name,
        source_language,
        updated_at,
        title,
        cover_url,
        author,
        publication_status,
        source_lang
      FROM ranked_history
      WHERE row_rank = 1
      ORDER BY updated_at DESC, id DESC
      LIMIT 250
    `)
    .all(req.user.userId)
    .map((row) => ({
      id: row.id,
      mangaId: row.manga_id,
      chapterId: row.chapter_id,
      chapterNumber: row.chapter_number,
      pageIndex: row.page_index,
      updatedAt: row.updated_at,
      sourceId: row.source_id || '',
      sourceName: row.source_name || '',
      sourceLanguage: row.source_language || row.source_lang || '',
      title: row.title,
      author: row.author,
      publicationStatus: row.publication_status || 'unknown',
      sourceLang: row.source_language || row.source_lang || '',
      coverUrl: buildImageProxyUrl(row.cover_url) || row.cover_url
    }));

  return res.json({ history });
});

app.put('/api/history', requireAuth, (req, res) => {
  const mangaId = Number(req.body?.mangaId);
  const chapterId = String(req.body?.chapterId || '').trim();
  const chapterNumber = Number(req.body?.chapterNumber);
  const pageIndex = Number(req.body?.pageIndex);
  const sourceMeta = normalizeSourceMetadata({
    sourceId: req.body?.sourceId,
    sourceName: req.body?.sourceName,
    sourceLanguage: req.body?.sourceLanguage || req.body?.sourceLang
  });

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'mangaId inválido.' });
  }

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId é obrigatório.' });
  }

  if (!Number.isFinite(chapterNumber) || chapterNumber < 0) {
    return res.status(400).json({ error: 'chapterNumber inválido.' });
  }

  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return res.status(400).json({ error: 'pageIndex deve ser inteiro >= 1.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  saveReadingHistory(req.user.userId, mangaId, chapterId, chapterNumber, pageIndex, sourceMeta);

  return res.json({
    history: {
      mangaId,
      chapterId,
      chapterNumber,
      pageIndex,
      sourceId: sourceMeta.sourceId,
      sourceName: sourceMeta.sourceName,
      sourceLanguage: sourceMeta.sourceLanguage
    }
  });
});

app.delete('/api/history/:historyId', requireAuth, (req, res) => {
  const historyId = Number(req.params.historyId);
  if (!Number.isInteger(historyId)) {
    return res.status(400).json({ error: 'ID do histórico inválido.' });
  }

  const result = db
    .prepare('DELETE FROM reading_history WHERE id = ? AND user_id = ?')
    .run(historyId, req.user.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Item de histórico não encontrado.' });
  }

  return res.json({ message: 'Item removido do histórico.' });
});

app.delete('/api/history', requireAuth, (req, res) => {
  db.prepare('DELETE FROM reading_history WHERE user_id = ?').run(req.user.userId);
  return res.json({ message: 'Histórico limpo com sucesso.' });
});

app.get('/api/chapters/:chapterId/comments', requireAuth, (req, res) => {
  const chapterId = String(req.params.chapterId || '').trim();
  const language = String(req.query.language || '').trim().toLowerCase();

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId inválido.' });
  }

  const whereParts = ['cc.chapter_id = ?'];
  const params = [chapterId];
  const normalizedLanguage = normalizeLanguageCode(language, '');
  if (normalizedLanguage && normalizedLanguage !== 'all') {
    whereParts.push('cc.language = ?');
    params.push(normalizedLanguage);
  }

  const comments = db
    .prepare(`
      SELECT
        cc.id,
        cc.user_id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        u.username
      FROM chapter_comments cc
      JOIN users u ON u.id = cc.user_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY cc.created_at DESC
      LIMIT 150
    `)
    .all(...params)
    .map(serializeChapterCommentRow);

  return res.json({ comments });
});

app.post('/api/chapters/:chapterId/comments', requireAuth, (req, res) => {
  const chapterId = String(req.params.chapterId || '').trim();
  const mangaId = Number(req.body?.mangaId);
  const body = normalizeCommentBody(req.body?.body);
  const defaultLanguage = getUserPreferredLanguage(req.user.userId);
  const language = normalizeLanguageCode(req.body?.language, defaultLanguage);

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId inválido.' });
  }

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'mangaId inválido.' });
  }

  if (!body) {
    return res.status(400).json({ error: 'Comentário vazio.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  const result = db
    .prepare(`
      INSERT INTO chapter_comments (user_id, manga_id, chapter_id, language, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    .run(req.user.userId, mangaId, chapterId, language, body);

  const inserted = db
    .prepare(`
      SELECT
        cc.id,
        cc.user_id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        u.username
      FROM chapter_comments cc
      JOIN users u ON u.id = cc.user_id
      WHERE cc.id = ?
    `)
    .get(Number(result.lastInsertRowid));

  return res.status(201).json({
    comment: serializeChapterCommentRow(inserted)
  });
});

// Compatibilidade legada (comentários por página redirecionados para capítulo).
app.get('/api/chapters/:chapterId/pages/:page/comments', requireAuth, (req, res) => {
  const chapterId = String(req.params.chapterId || '').trim();
  const language = String(req.query.language || '').trim().toLowerCase();

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId inválido.' });
  }

  const whereParts = ['cc.chapter_id = ?'];
  const params = [chapterId];
  const normalizedLanguage = normalizeLanguageCode(language, '');
  if (normalizedLanguage && normalizedLanguage !== 'all') {
    whereParts.push('cc.language = ?');
    params.push(normalizedLanguage);
  }

  const comments = db
    .prepare(`
      SELECT
        cc.id,
        cc.user_id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        u.username
      FROM chapter_comments cc
      JOIN users u ON u.id = cc.user_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY cc.created_at DESC
      LIMIT 150
    `)
    .all(...params)
    .map(serializeChapterCommentRow);

  return res.json({ comments });
});

app.post('/api/chapters/:chapterId/pages/:page/comments', requireAuth, (req, res) => {
  const chapterId = String(req.params.chapterId || '').trim();
  const mangaId = Number(req.body?.mangaId);
  const body = normalizeCommentBody(req.body?.body);
  const defaultLanguage = getUserPreferredLanguage(req.user.userId);
  const language = normalizeLanguageCode(req.body?.language, defaultLanguage);

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId inválido.' });
  }

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'mangaId inválido.' });
  }

  if (!body) {
    return res.status(400).json({ error: 'Comentário vazio.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  const result = db
    .prepare(`
      INSERT INTO chapter_comments (user_id, manga_id, chapter_id, language, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    .run(req.user.userId, mangaId, chapterId, language, body);

  const inserted = db
    .prepare(`
      SELECT
        cc.id,
        cc.user_id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        u.username
      FROM chapter_comments cc
      JOIN users u ON u.id = cc.user_id
      WHERE cc.id = ?
    `)
    .get(Number(result.lastInsertRowid));

  return res.status(201).json({
    comment: serializeChapterCommentRow(inserted)
  });
});

app.get('/api/comments/history', requireAuth, (req, res) => {
  const comments = db
    .prepare(`
      SELECT
        cc.id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        m.title AS manga_title
      FROM chapter_comments cc
      JOIN mangas m ON m.id = cc.manga_id
      WHERE cc.user_id = ?
      ORDER BY cc.created_at DESC
      LIMIT 300
    `)
    .all(req.user.userId)
    .map((row) => ({
      id: row.id,
      mangaId: row.manga_id,
      mangaTitle: row.manga_title,
      chapterId: row.chapter_id,
      language: row.language,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

  return res.json({ comments });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const commentId = Number(req.params.id);
  if (!Number.isInteger(commentId)) {
    return res.status(400).json({ error: 'ID de comentário inválido.' });
  }

  const comment = db
    .prepare('SELECT id, user_id FROM chapter_comments WHERE id = ?')
    .get(commentId);
  if (!comment) {
    return res.status(404).json({ error: 'Comentário não encontrado.' });
  }

  const canDelete = comment.user_id === req.user.userId || isUserAdmin(req.user.userId);
  if (!canDelete) {
    return res.status(403).json({ error: 'Você não pode remover este comentário.' });
  }

  db.prepare('DELETE FROM chapter_comments WHERE id = ?').run(commentId);
  return res.json({ message: 'Comentário removido com sucesso.' });
});

app.post('/api/comments/:id/report', requireAuth, (req, res) => {
  const commentId = Number(req.params.id);
  const reason = normalizeReportReason(req.body?.reason);
  const details = normalizeLongText(req.body?.details, 2000);

  if (!Number.isInteger(commentId)) {
    return res.status(400).json({ error: 'ID de comentário inválido.' });
  }

  if (!reason) {
    return res.status(400).json({ error: 'Motivo de denúncia inválido.' });
  }

  const comment = db.prepare('SELECT id FROM chapter_comments WHERE id = ?').get(commentId);
  if (!comment) {
    return res.status(404).json({ error: 'Comentário não encontrado.' });
  }

  const result = db
    .prepare(`
      INSERT INTO content_reports (
        reporter_user_id,
        target_type,
        target_id,
        reason,
        details,
        status,
        admin_notes,
        created_at,
        updated_at
      )
      VALUES (?, 'comment', ?, ?, ?, 'open', '', datetime('now'), datetime('now'))
    `)
    .run(req.user.userId, String(commentId), reason, details);

  return res.status(201).json({
    report: {
      id: Number(result.lastInsertRowid),
      targetType: 'comment',
      targetId: String(commentId),
      reason
    }
  });
});

app.post('/api/reports', requireAuth, (req, res) => {
  const targetType = normalizeReportTargetType(req.body?.targetType);
  const targetId = String(req.body?.targetId || '').trim();
  const reason = normalizeReportReason(req.body?.reason);
  const details = normalizeLongText(req.body?.details, 2000);

  if (!targetType) {
    return res.status(400).json({ error: 'targetType inválido.' });
  }

  if (!reason) {
    return res.status(400).json({ error: 'Motivo de denúncia inválido.' });
  }

  if (targetType === 'manga') {
    const mangaId = Number(targetId);
    if (!Number.isInteger(mangaId) || !db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId)) {
      return res.status(404).json({ error: 'Mangá/HQ não encontrado para denúncia.' });
    }
  }

  if (targetType === 'comment') {
    const commentId = Number(targetId);
    if (!Number.isInteger(commentId) || !db.prepare('SELECT id FROM chapter_comments WHERE id = ?').get(commentId)) {
      return res.status(404).json({ error: 'Comentário não encontrado para denúncia.' });
    }
  }

  const result = db
    .prepare(`
      INSERT INTO content_reports (
        reporter_user_id,
        target_type,
        target_id,
        reason,
        details,
        status,
        admin_notes,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'open', '', datetime('now'), datetime('now'))
    `)
    .run(req.user.userId, targetType, targetId || null, reason, details);

  return res.status(201).json({
    report: {
      id: Number(result.lastInsertRowid),
      targetType,
      targetId: targetId || null,
      reason
    }
  });
});

app.post('/api/feedback', requireAuth, (req, res) => {
  const category = normalizeFeedbackCategory(req.body?.category);
  const message = normalizeLongText(req.body?.message, 2400);

  if (!message) {
    return res.status(400).json({ error: 'Escreva uma mensagem de feedback.' });
  }

  const result = db
    .prepare(`
      INSERT INTO feedback_messages (
        user_id,
        category,
        message,
        status,
        admin_notes,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, 'new', '', datetime('now'), datetime('now'))
    `)
    .run(req.user.userId, category, message);

  return res.status(201).json({
    feedback: {
      id: Number(result.lastInsertRowid),
      category,
      message
    }
  });
});

app.get('/api/feedback/my', requireAuth, (req, res) => {
  const feedback = db
    .prepare(`
      SELECT
        id,
        user_id,
        category,
        message,
        status,
        admin_notes,
        created_at,
        updated_at
      FROM feedback_messages
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all(req.user.userId)
    .map((row) => ({
      id: row.id,
      userId: row.user_id,
      category: row.category,
      message: row.message,
      status: row.status,
      adminNotes: row.admin_notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

  return res.json({ feedback });
});

app.post('/api/comments/translate', requireAuth, async (req, res) => {
  const text = normalizeCommentBody(req.body?.text);
  const targetLanguage = normalizeLanguageForTranslation(req.body?.targetLanguage, 'pt');
  const sourceLanguage = normalizeLanguageForTranslation(req.body?.sourceLanguage, 'auto');

  if (!text) {
    return res.status(400).json({ error: 'Texto é obrigatório.' });
  }

  if (!targetLanguage) {
    return res.status(400).json({ error: 'Idioma de destino inválido.' });
  }

  if (sourceLanguage !== 'auto' && sourceLanguage === targetLanguage) {
    return res.json({
      translatedText: text,
      sourceLanguage,
      targetLanguage,
      provider: 'identity'
    });
  }

  const translateWithMyMemory = async () => {
    const params = new URLSearchParams();
    params.set('q', text);
    params.set('langpair', `${sourceLanguage}|${targetLanguage}`);

    const response = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`, {
      headers: {
        'User-Agent': 'Quadroz/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`serviço indisponível (${response.status})`);
    }

    const payload = await response.json();
    const translatedText = String(payload?.responseData?.translatedText || '').trim();

    if (!translatedText) {
      throw new Error('resposta vazia do tradutor');
    }

    return translatedText;
  };

  const translateWithGoogleFallback = async () => {
    const params = new URLSearchParams();
    params.set('client', 'gtx');
    params.set('sl', sourceLanguage || 'auto');
    params.set('tl', targetLanguage);
    params.set('dt', 't');
    params.set('q', text);

    const response = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      headers: {
        'User-Agent': 'Quadroz/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`fallback indisponível (${response.status})`);
    }

    const payload = await response.json();
    const chunks = Array.isArray(payload?.[0]) ? payload[0] : [];
    const translatedText = chunks
      .map((entry) => (Array.isArray(entry) ? String(entry[0] || '').trim() : ''))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!translatedText) {
      throw new Error('fallback retornou vazio');
    }

    return translatedText;
  };

  const providers = [
    { name: 'mymemory', run: translateWithMyMemory },
    { name: 'google', run: translateWithGoogleFallback }
  ];

  let lastError = null;
  for (const provider of providers) {
    try {
      const translatedText = await provider.run();
      return res.json({
        translatedText,
        sourceLanguage,
        targetLanguage,
        provider: provider.name
      });
    } catch (error) {
      lastError = error;
    }
  }

  return res.status(502).json({ error: `Falha na tradução: ${lastError?.message || 'serviço indisponível'}` });
});

app.post('/api/mangas/:id/categories', requireAuth, (req, res) => {
  const mangaId = Number(req.params.id);
  const { categoryName, categoryId } = req.body || {};
  const sourceMeta = normalizeSourceMetadata({
    sourceId: req.body?.sourceId,
    sourceName: req.body?.sourceName,
    sourceLanguage: req.body?.sourceLanguage || req.body?.sourceLang
  });

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID de mangá inválido.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  let category = null;

  if (categoryId) {
    category = db
      .prepare('SELECT id, name FROM user_categories WHERE id = ? AND user_id = ?')
      .get(Number(categoryId), req.user.userId);
  } else if (categoryName) {
    const normalizedName = String(categoryName).trim();
    if (!normalizedName) {
      return res.status(400).json({ error: 'Nome da categoria inválido.' });
    }
    db.prepare('INSERT OR IGNORE INTO user_categories (user_id, name) VALUES (?, ?)').run(req.user.userId, normalizedName);
    category = db
      .prepare('SELECT id, name FROM user_categories WHERE user_id = ? AND name = ?')
      .get(req.user.userId, normalizedName);
  }

  if (!category) {
    return res.status(400).json({ error: 'Informe categoryId ou categoryName.' });
  }

  db.prepare('INSERT OR IGNORE INTO user_manga_categories (user_id, manga_id, category_id) VALUES (?, ?, ?)')
    .run(req.user.userId, mangaId, category.id);

  addMangaToLibrary(req.user.userId, mangaId, sourceMeta);

  return res.status(201).json({
    message: 'Categoria de biblioteca vinculada com sucesso e mangá adicionado à biblioteca.',
    category
  });
});

app.delete('/api/mangas/:id/categories/:categoryId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.id);
  const categoryId = Number(req.params.categoryId);

  if (!Number.isInteger(mangaId) || !Number.isInteger(categoryId)) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  const result = db
    .prepare('DELETE FROM user_manga_categories WHERE user_id = ? AND manga_id = ? AND category_id = ?')
    .run(req.user.userId, mangaId, categoryId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Categoria não vinculada a esse mangá.' });
  }

  return res.json({ message: 'Categoria removida do mangá.' });
});

app.post('/api/library/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  const sourceMeta = normalizeSourceMetadata({
    sourceId: req.body?.sourceId,
    sourceName: req.body?.sourceName,
    sourceLanguage: req.body?.sourceLanguage || req.body?.sourceLang
  });
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  addMangaToLibrary(req.user.userId, mangaId, sourceMeta);

  return res.status(201).json({ message: 'Mangá adicionado à biblioteca.' });
});

app.get('/api/library', requireAuth, (req, res) => {
  const search = String(req.query.search || '').trim();
  const genre = getGenreFilterValue(req.query);
  const status = String(req.query.status || '').trim();
  const language = String(req.query.language || '').trim();

  const whereParts = ['le.user_id = ?'];
  const params = [];

  if (search) {
    whereParts.push('m.title LIKE ?');
    params.push(`%${search}%`);
  }

  appendCategoryFilter(whereParts, params, genre, 'm');
  appendStatusFilter(whereParts, params, status, 'm');
  appendLanguageFilter(whereParts, params, language, 'm');

  // Excluir mangás banidos
  whereParts.push('NOT EXISTS (SELECT 1 FROM banned_mangas bm WHERE bm.manga_id = m.id)');

  // Buscar apenas library entries (lendo)
  const libraryQuery = db
    .prepare(`
      SELECT
        le.id,
        le.status,
        le.current_chapter,
        le.last_page,
        le.source_id,
        le.source_name,
        le.source_language,
        le.updated_at,
        m.id AS manga_id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        COALESCE(fav.id, 0) > 0 AS is_favorited,
        0 AS favorited_at,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.user_id = ? AND umc.manga_id = m.id
        ) AS user_categories
      FROM library_entries le
      JOIN mangas m ON m.id = le.manga_id
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      LEFT JOIN favorites fav ON fav.user_id = ? AND fav.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE ${whereParts.join(' AND ')}
      GROUP BY le.id
    `);

  const favParts = ['fav.user_id = ?'];
  const favParams = [req.user.userId];
  if (search) {
    favParts.push('m.title LIKE ?');
    favParams.push(`%${search}%`);
  }
  appendCategoryFilter(favParts, favParams, genre, 'm');
  appendStatusFilter(favParts, favParams, status, 'm');
  appendLanguageFilter(favParts, favParams, language, 'm');
  favParts.push('NOT EXISTS (SELECT 1 FROM banned_mangas bm WHERE bm.manga_id = m.id)');

  const favoritesQuery = db
    .prepare(`
      SELECT
        1 AS is_favorite_entry,
        0 AS id,
        '' AS status,
        0 AS current_chapter,
        0 AS last_page,
        '' AS source_id,
        '' AS source_name,
        '' AS source_language,
        fav.created_at AS updated_at,
        m.id AS manga_id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        COALESCE(fc.favorite_count, 0) AS favorite_count,
        1 AS is_favorited,
        fav.created_at AS favorited_at,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.user_id = ? AND umc.manga_id = m.id
        ) AS user_categories
      FROM favorites fav
      JOIN mangas m ON m.id = fav.manga_id
      LEFT JOIN (
        SELECT manga_id, COUNT(*) AS favorite_count
        FROM favorites
        GROUP BY manga_id
      ) fc ON fc.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE ${favParts.join(' AND ')}
      GROUP BY fav.id
    `);

  const queryParams = [req.user.userId, req.user.userId, req.user.userId, ...params];
  const libraryRows = libraryQuery.all(...queryParams);

  const favParamsFull = [req.user.userId, req.user.userId, req.user.userId, ...favParams];
  const favoritesRows = favoritesQuery.all(...favParamsFull);

  console.log(`[API /library] User ${req.user.userId} (${req.user.username}) - Library rows: ${libraryRows.length}, Favorites rows: ${favoritesRows.length}`);

  const mergedMap = new Map();

  libraryRows.forEach((row) => {
    mergedMap.set(row.manga_id, {
      id: row.id,
      mangaId: row.manga_id,
      title: row.title,
      description: row.description,
      author: row.author,
      coverUrl: buildImageProxyUrl(row.cover_url) || row.cover_url,
      totalChapters: row.total_chapters,
      publicationStatus: row.publication_status || 'unknown',
      sourceLang: row.source_language || row.source_lang || '',
      sourceId: row.source_id || '',
      sourceName: row.source_name || '',
      sourceLanguage: row.source_language || row.source_lang || '',
      chaptersConsistent: row.chapters_consistent === 1,
      favoriteCount: row.favorite_count || 0,
      isFavorited: Boolean(row.is_favorited),
      genres: parseCategoriesString(row.genres),
      categories: parseCategoriesString(row.user_categories),
      status: row.status,
      progress: {
        currentChapter: row.current_chapter,
        lastPage: row.last_page,
        sourceId: row.source_id || '',
        sourceName: row.source_name || '',
        sourceLanguage: row.source_language || row.source_lang || '',
        updatedAt: row.updated_at
      }
    });
  });

  favoritesRows.forEach((row) => {
    if (mergedMap.has(row.manga_id)) {
      // Se já está no mapa, apenas garante que isFavorited seja true
      mergedMap.get(row.manga_id).isFavorited = true;
    } else {
      mergedMap.set(row.manga_id, {
        id: row.id,
        mangaId: row.manga_id,
        title: row.title,
        description: row.description,
        author: row.author,
        coverUrl: buildImageProxyUrl(row.cover_url) || row.cover_url,
        totalChapters: row.total_chapters,
        publicationStatus: row.publication_status || 'unknown',
        sourceLang: row.source_language || row.source_lang || '',
        sourceId: row.source_id || '',
        sourceName: row.source_name || '',
        sourceLanguage: row.source_language || row.source_lang || '',
        chaptersConsistent: row.chapters_consistent === 1,
        favoriteCount: row.favorite_count || 0,
        isFavorited: true,
        genres: parseCategoriesString(row.genres),
        categories: parseCategoriesString(row.user_categories),
        status: 'favorite',
        progress: {
          currentChapter: 1,
          lastPage: 1,
          sourceId: '',
          sourceName: '',
          sourceLanguage: '',
          updatedAt: row.updated_at
        }
      });
    }
  });

  const library = Array.from(mergedMap.values());
  console.log(`[API /library] Final library count for user ${req.user.userId}: ${library.length}`);
  return res.json({ library });
});

app.delete('/api/library/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const result = db.prepare('DELETE FROM library_entries WHERE user_id = ? AND manga_id = ?').run(req.user.userId, mangaId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Mangá não está na sua biblioteca.' });
  }

  return res.json({ message: 'Mangá removido da biblioteca.' });
});

app.patch('/api/library/:mangaId/progress', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  const currentChapter = Number(req.body?.currentChapter);
  const lastPage = Number(req.body?.lastPage);
  const sourceMeta = normalizeSourceMetadata({
    sourceId: req.body?.sourceId,
    sourceName: req.body?.sourceName,
    sourceLanguage: req.body?.sourceLanguage || req.body?.sourceLang
  });

  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  if (!Number.isInteger(currentChapter) || currentChapter < 1 || !Number.isInteger(lastPage) || lastPage < 1) {
    return res.status(400).json({ error: 'currentChapter e lastPage devem ser inteiros >= 1.' });
  }

  const entry = db
    .prepare('SELECT id FROM library_entries WHERE user_id = ? AND manga_id = ?')
    .get(req.user.userId, mangaId);

  if (!entry) {
    return res.status(404).json({ error: 'Mangá não está na sua biblioteca.' });
  }

  db.prepare(`
    UPDATE library_entries
    SET
      current_chapter = ?,
      last_page = ?,
      source_id = CASE WHEN ? <> '' THEN ? ELSE source_id END,
      source_name = CASE WHEN ? <> '' THEN ? ELSE source_name END,
      source_language = CASE WHEN ? <> '' THEN ? ELSE source_language END,
      updated_at = datetime('now')
    WHERE user_id = ? AND manga_id = ?
  `).run(
    currentChapter,
    lastPage,
    sourceMeta.sourceId,
    sourceMeta.sourceId,
    sourceMeta.sourceName,
    sourceMeta.sourceName,
    sourceMeta.sourceLanguage,
    sourceMeta.sourceLanguage,
    req.user.userId,
    mangaId
  );

  return res.json({ message: 'Progresso atualizado.' });
});

app.post('/api/favorites/:mangaId', requireAuth, (req, res) => {
  const mangaId = Number(req.params.mangaId);
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const manga = db.prepare('SELECT id FROM mangas WHERE id = ?').get(mangaId);
  if (!manga) {
    return res.status(404).json({ error: 'Mangá/HQ não encontrado.' });
  }

  const existing = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND manga_id = ?').get(req.user.userId, mangaId);

  let isFavorited = false;

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND manga_id = ?').run(req.user.userId, mangaId);
    isFavorited = false;
  } else {
    db.prepare('INSERT INTO favorites (user_id, manga_id) VALUES (?, ?)').run(req.user.userId, mangaId);
    isFavorited = true;
  }

  const favoriteCount = db.prepare('SELECT COUNT(*) as count FROM favorites WHERE manga_id = ?').get(mangaId).count;
  return res.json({ isFavorited, favoriteCount });
});

app.get('/api/ranking', attachOptionalUser, (req, res) => {
  const userId = req.user?.userId || -1;
  const userNsfwProtection = getUserNsfwProtection(userId) === 1;
  const genre = getGenreFilterValue(req.query);
  const status = String(req.query.status || '').trim();
  const language = String(req.query.language || '').trim();

  const whereParts = [
    '1=1',
    "m.cover_url IS NOT NULL AND TRIM(m.cover_url) <> ''",
    'EXISTS (SELECT 1 FROM manga_categories mg2 WHERE mg2.manga_id = m.id)'
  ];
  if (userNsfwProtection) {
    whereParts.push('m.is_nsfw = 0');
  }
  const params = [userId, userId];

  appendCategoryFilter(whereParts, params, genre, 'm');
  appendStatusFilter(whereParts, params, status, 'm');
  appendLanguageFilter(whereParts, params, language, 'm');

  const ranking = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.description,
        m.author,
        m.cover_url,
        m.total_chapters,
        m.publication_status,
        m.source_lang,
        m.chapters_consistent,
        COUNT(DISTINCT f.user_id) AS favorite_count,
        EXISTS(SELECT 1 FROM favorites f2 WHERE f2.user_id = ? AND f2.manga_id = m.id) AS is_favorited,
        GROUP_CONCAT(DISTINCT g.name) AS genres,
        (
          SELECT GROUP_CONCAT(DISTINCT uc.name)
          FROM user_manga_categories umc
          JOIN user_categories uc ON uc.id = umc.category_id
          WHERE umc.user_id = ? AND umc.manga_id = m.id
        ) AS user_categories
      FROM mangas m
      LEFT JOIN favorites f ON f.manga_id = m.id
      LEFT JOIN manga_categories mg ON mg.manga_id = m.id
      LEFT JOIN categories g ON g.id = mg.category_id
      WHERE ${whereParts.join(' AND ')}
      GROUP BY m.id
      ORDER BY favorite_count DESC, m.title ASC
      LIMIT 50
    `)
    .all(...params)
    .map((row, index) => ({
      rank: index + 1,
      ...serializeMangaRow(row)
    }));

  return res.json({ ranking });
});

app.get('/api/admin/catalog/health', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const totalMangas = db.prepare('SELECT COUNT(*) as count FROM mangas').get().count;
    const missingCover = db.prepare('SELECT COUNT(*) as count FROM mangas WHERE cover_url IS NULL OR cover_url = \'\'').get().count;
    const missingDescription = db.prepare('SELECT COUNT(*) as count FROM mangas WHERE description IS NULL OR description = \'\'').get().count;
    const missingGenres = db.prepare('SELECT COUNT(*) as count FROM mangas m WHERE NOT EXISTS (SELECT 1 FROM manga_categories mc WHERE mc.manga_id = m.id)').get().count;
    const duplicatedTitleGroups = 0; // Placeholder ou implementar lógica real de duplicados se necessário

    return res.json({
      health: {
        totalMangas,
        missingCover,
        missingDescription,
        missingGenres,
        duplicatedTitleGroups
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/overview', requireAuth, requireAdmin, async (req, res) => {
  await refreshSuwayomiSourceHealthSnapshot();
  const discoverCatalogWhere = buildSavedCatalogWhereParts('m').join(' AND ');
  const savedCatalogWhere = buildSavedCatalogWhereParts('m')
    .concat([buildChapterReadySourceExistsClause('m')])
    .join(' AND ');
  const stats = db
    .prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users_count,
        (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins_count,
        (SELECT COUNT(*) FROM mangas) AS raw_mangas_count,
        (SELECT COUNT(*) FROM mangas m WHERE ${discoverCatalogWhere}) AS mangas_count,
        (SELECT COUNT(*) FROM mangas WHERE total_chapters > 0) AS saved_mangas_count,
        (SELECT COUNT(*) FROM library_entries) AS library_entries_count,
        (SELECT COUNT(*) FROM chapter_comments) AS comments_count,
        (SELECT COUNT(*) FROM content_reports WHERE status IN ('open', 'in_review')) AS pending_reports_count,
        (SELECT COUNT(*) FROM feedback_messages WHERE status IN ('new', 'reviewing')) AS pending_feedback_count
    `)
    .get();
  const catalogHealth = getCatalogHealthStats();
  const sync = getSyncStatus();
  const sourceHealth = getSourceHealthSummary();

  return res.json({
    stats: {
      usersCount: stats.users_count || 0,
      adminsCount: stats.admins_count || 0,
      mangasCount: stats.mangas_count || 0,
      savedMangasCount: stats.saved_mangas_count || 0,
      rawMangasCount: stats.raw_mangas_count || 0,
      libraryEntriesCount: stats.library_entries_count || 0,
      commentsCount: stats.comments_count || 0,
      pendingReportsCount: stats.pending_reports_count || 0,
      pendingFeedbackCount: stats.pending_feedback_count || 0,
      missingCoverCount: catalogHealth.missingCover,
      missingDescriptionCount: catalogHealth.missingDescription,
      missingGenresCount: catalogHealth.missingGenres,
      duplicatedTitleGroups: catalogHealth.duplicatedTitleGroups
    },
    catalogHealth,
    sync,
    sourceHealth
  });
});

app.get('/api/admin/sync/status', requireAuth, requireAdmin, async (_req, res) => {
  await refreshSuwayomiSourceHealthSnapshot();
  const sync = getSyncStatus();
  const catalogHealth = getCatalogHealthStats();
  const sourceHealth = getSourceHealthSummary();
  return res.json({
    sync,
    catalogHealth,
    sourceHealth
  });
});

app.get('/api/admin/mangas/saved', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query?.limit) || 100, 500);
  const offset = Number(req.query?.offset) || 0;
  const search = String(req.query?.search || '').trim();

  const whereParts = ['m.total_chapters > 0'];
  if (search) {
    whereParts.push(`m.title LIKE '%' || ? || '%'`);
  }

  const whereClause = `WHERE ${whereParts.join(' AND ')}`;

  const mangas = db
    .prepare(`
      SELECT m.id, m.title, m.total_chapters, m.last_synced_at
      FROM mangas m
      ${whereClause}
      ORDER BY COALESCE(m.last_synced_at, m.created_at) DESC
      LIMIT ? OFFSET ?
    `)
    .all(...(search ? [search, limit, offset] : [limit, offset]));

  const countResult = db
    .prepare(`SELECT COUNT(*) as count FROM mangas m ${whereClause}`)
    .get(...(search ? [search] : []));

  res.json({
    mangas: mangas.map(m => ({
      id: m.id,
      title: m.title,
      totalChapters: m.total_chapters,
      lastSyncedAt: m.last_synced_at
    })),
    total: countResult.count,
    limit,
    offset
  });
});

app.post('/api/admin/sync/run', requireAuth, requireAdmin, (req, res) => {
  const trigger = String(req.body?.trigger || 'admin').trim().slice(0, 40) || 'admin';
  const result = runSync(trigger);
  if (!result.started) {
    return res.status(409).json({
      error: 'Sincronização já está em execução.',
      sync: getSyncStatus()
    });
  }

  return res.status(202).json({
    message: 'Sincronização iniciada.',
    sync: getSyncStatus()
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db
    .prepare(`
      SELECT
        u.id,
        u.username,
        u.email,
        u.last_ip,
        u.is_admin,
        u.created_at,
        EXISTS(
          SELECT 1
          FROM banned_ips bi
          WHERE bi.ip = u.last_ip
        ) AS is_ip_banned,
        (
          SELECT COUNT(*)
          FROM chapter_comments cc
          WHERE cc.user_id = u.id
        ) AS comments_count,
        (
          SELECT COUNT(*)
          FROM content_reports cr
          WHERE cr.reporter_user_id = u.id
        ) AS reports_count
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 500
    `)
    .all()
    .map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      lastIp: normalizeIpAddress(row.last_ip),
      isAdmin: row.is_admin === 1,
      isIpBanned: row.is_ip_banned === 1,
      createdAt: row.created_at,
      commentsCount: row.comments_count || 0,
      reportsCount: row.reports_count || 0
    }));

  return res.json({ users });
});

app.patch('/api/admin/users/:id/admin', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const isAdmin = Boolean(req.body?.isAdmin);
  const currentUserId = req.user.userId;

  // Apenas o DONO pode alterar status de admin
  if (!isUserOwner(currentUserId)) {
    return res.status(403).json({ error: 'Apenas o DONO pode alterar status de admin.' });
  }

  // Não pode remover o DONO do admin
  if (isUserOwner(userId) && !isAdmin) {
    return res.status(403).json({ error: 'O DONO não pode ser removido do admin.' });
  }

  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'ID de usuário inválido.' });
  }

  const user = db.prepare('SELECT id, username, email, created_at, is_admin FROM users WHERE id = ?').get(userId);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
  const updated = getUserById(userId);
  return res.json({ user: serializeUserRow(updated) });
});

app.post('/api/admin/users/ban-ip', requireAuth, requireAdmin, (req, res) => {
  const userIds = normalizeUserIdList(req.body?.userIds);
  if (userIds.length === 0) {
    return res.status(400).json({ error: 'Selecione ao menos um usuário.' });
  }

  const placeholders = userIds.map(() => '?').join(', ');
  const users = db
    .prepare(`
      SELECT id, username, last_ip, is_admin, is_owner
      FROM users
      WHERE id IN (${placeholders})
    `)
    .all(...userIds);

  if (users.length === 0) {
    return res.status(404).json({ error: 'Nenhum usuário encontrado para banimento por IP.' });
  }

  // Apenas DONO pode banir IPs de admins ou do DONO
  const hasTargetAdmin = users.some(u => u.is_admin === 1 || u.is_owner === 1);
  if (hasTargetAdmin && !isUserOwner(req.user.userId)) {
    return res.status(403).json({ error: 'Apenas o DONO pode banir IPs de administradores ou do próprio DONO.' });
  }

  const requesterIp = normalizeIpAddress(getRequestIp(req));
  const usersWithoutIp = [];
  const uniqueIps = new Set();

  users.forEach((user) => {
    const normalizedIp = normalizeIpAddress(user.last_ip);
    if (!normalizedIp) {
      usersWithoutIp.push(user.id);
      return;
    }
    uniqueIps.add(normalizedIp);
  });

  const ipsToBan = Array.from(uniqueIps).filter((ip) => ip && ip !== requesterIp);

  if (ipsToBan.length === 0) {
    return res.status(400).json({ error: 'Nenhum IP válido encontrado para banir.' });
  }

  const saveBan = db.prepare(`
    INSERT INTO banned_ips (ip, created_by, created_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(ip) DO UPDATE SET
      created_by = excluded.created_by,
      created_at = excluded.created_at
  `);

  const tx = db.transaction((ips) => {
    ips.forEach((ip) => saveBan.run(ip, req.user.userId));
  });
  tx(ipsToBan);

  const bannedIpSet = new Set(ipsToBan);
  const affectedUserIds = users
    .filter((user) => bannedIpSet.has(normalizeIpAddress(user.last_ip)))
    .map((user) => user.id);

  return res.json({
    message: 'Banimento por IP aplicado com sucesso.',
    bannedIps: ipsToBan,
    bannedIpsCount: ipsToBan.length,
    affectedUserIds,
    skippedUserIdsWithoutIp: usersWithoutIp,
    skippedRequesterIp: Boolean(requesterIp && uniqueIps.has(requesterIp))
  });
});

app.delete('/api/admin/users/ban-ip', requireAuth, requireAdmin, (req, res) => {
  const ip = normalizeIpAddress(req.body?.ip || '');
  if (!ip) {
    return res.status(400).json({ error: 'IP inválido para desbloqueio.' });
  }

  const result = db.prepare('DELETE FROM banned_ips WHERE ip = ?').run(ip);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'IP não encontrado na lista de bloqueio.' });
  }

  return res.json({
    message: 'IP desbloqueado com sucesso.',
    ip
  });
});

app.delete('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const requestedIds = normalizeUserIdList(req.body?.userIds);
  const currentUserId = req.user.userId;

  // Apenas DONO pode excluir admins ou o DONO
  const hasTargetAdmin = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE id IN (" + requestedIds.map(() => '?').join(',') + ") AND (is_admin = 1 OR is_owner = 1)").all(...requestedIds)[0]?.cnt > 0;
  if (hasTargetAdmin && !isUserOwner(currentUserId)) {
    return res.status(403).json({ error: 'Apenas o DONO pode excluir administradores ou o próprio DONO.' });
  }

  if (requestedIds.length === 0) {
    return res.status(400).json({ error: 'Selecione ao menos um usuário para apagar.' });
  }

  const userIds = requestedIds.filter((id) => id !== req.user.userId);
  if (userIds.length === 0) {
    return res.status(400).json({ error: 'Não é permitido apagar a própria conta neste endpoint.' });
  }

  const placeholders = userIds.map(() => '?').join(', ');
  const existingUsers = db
    .prepare(`
      SELECT id
      FROM users
      WHERE id IN (${placeholders})
    `)
    .all(...userIds)
    .map((row) => row.id);

  if (existingUsers.length === 0) {
    return res.status(404).json({ error: 'Nenhum usuário encontrado para remoção.' });
  }

  const removeUser = db.prepare('DELETE FROM users WHERE id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id) => removeUser.run(id));
  });
  tx(existingUsers);

  return res.json({
    message: 'Contas removidas com sucesso.',
    deletedUserIds: existingUsers,
    deletedCount: existingUsers.length,
    skippedSelf: requestedIds.length !== userIds.length
  });
});

app.get('/api/admin/comments', requireAuth, requireAdmin, (req, res) => {
  const comments = db
    .prepare(`
      SELECT
        cc.id,
        cc.user_id,
        cc.manga_id,
        cc.chapter_id,
        cc.language,
        cc.body,
        cc.created_at,
        cc.updated_at,
        u.username,
        m.title AS manga_title
      FROM chapter_comments cc
      JOIN users u ON u.id = cc.user_id
      JOIN mangas m ON m.id = cc.manga_id
      ORDER BY cc.created_at DESC
      LIMIT 300
    `)
    .all()
    .map((row) => ({
      ...serializeChapterCommentRow(row),
      mangaTitle: row.manga_title
    }));

  return res.json({ comments });
});

app.delete('/api/admin/comments/:id', requireAuth, requireAdmin, (req, res) => {
  const commentId = Number(req.params.id);
  if (!Number.isInteger(commentId)) {
    return res.status(400).json({ error: 'ID de comentário inválido.' });
  }

  const result = db.prepare('DELETE FROM chapter_comments WHERE id = ?').run(commentId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Comentário não encontrado.' });
  }

  return res.json({ message: 'Comentário removido com sucesso.' });
});

app.get('/api/admin/reports', requireAuth, requireAdmin, (req, res) => {
  const reports = db
    .prepare(`
      SELECT
        cr.id,
        cr.reporter_user_id,
        cr.target_type,
        cr.target_id,
        cr.reason,
        cr.details,
        cr.status,
        cr.admin_notes,
        cr.created_at,
        cr.updated_at,
        cr.resolved_by,
        reporter.username AS reporter_username,
        resolver.username AS resolved_by_username
      FROM content_reports cr
      JOIN users reporter ON reporter.id = cr.reporter_user_id
      LEFT JOIN users resolver ON resolver.id = cr.resolved_by
      ORDER BY
        CASE cr.status WHEN 'open' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,
        cr.created_at DESC
      LIMIT 500
    `)
    .all()
    .map(serializeReportRow);

  return res.json({ reports });
});

app.delete('/api/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const reportId = Number(req.params.id);
  if (!Number.isInteger(reportId)) {
    return res.status(400).json({ error: 'ID de denúncia inválido.' });
  }
  const existing = db.prepare('SELECT id FROM content_reports WHERE id = ?').get(reportId);
  if (!existing) {
    return res.status(404).json({ error: 'Denúncia não encontrada.' });
  }
  db.prepare('DELETE FROM content_reports WHERE id = ?').run(reportId);
  return res.json({ message: 'Denúncia deletada.' });
});

app.patch('/api/admin/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const reportId = Number(req.params.id);
  const action = String(req.body?.action || '').trim().toLowerCase();

  if (!Number.isInteger(reportId)) {
    return res.status(400).json({ error: 'ID de denúncia inválido.' });
  }

  const existing = db.prepare('SELECT id, target_type, target_id FROM content_reports WHERE id = ?').get(reportId);
  if (!existing) {
    return res.status(404).json({ error: 'Denúncia não encontrada.' });
  }

  if (action === 'ban_manga' && existing.target_type === 'manga') {
    const mangaId = Number(existing.target_id);
    if (Number.isInteger(mangaId)) {
      const alreadyBanned = db.prepare('SELECT id FROM banned_mangas WHERE manga_id = ?').get(mangaId);
      if (!alreadyBanned) {
        db.prepare(`
          INSERT INTO banned_mangas (manga_id, reason, banned_by, created_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(mangaId, `Banido via denúncia #${reportId}`, req.user.userId);
        invalidateBannedMangasCache();
      }
    }
  }

  if (action === 'ban_user' && existing.target_type === 'comment') {
    const comment = db.prepare('SELECT user_id FROM comments WHERE id = ?').get(existing.target_id);
    if (comment) {
      const userId = Number(comment.user_id);
      if (Number.isInteger(userId)) {
        const alreadyBanned = db.prepare('SELECT id FROM banned_users WHERE user_id = ?').get(userId);
        if (!alreadyBanned) {
          db.prepare(`
            INSERT INTO banned_users (user_id, reason, banned_by, created_at)
            VALUES (?, ?, ?, datetime('now'))
          `).run(userId, `Banido via denúncia #${reportId}`, req.user.userId);
        }
        db.prepare('DELETE FROM comments WHERE user_id = ?').run(userId);
      }
    }
  }

  if (action === 'delete_comment' && existing.target_type === 'comment') {
    db.prepare('DELETE FROM comments WHERE id = ?').run(existing.target_id);
  }

  return res.json({ message: 'Ação executada.' });
});

app.get('/api/admin/feedback', requireAuth, requireAdmin, (req, res) => {
  const feedback = db
    .prepare(`
      SELECT
        f.id,
        f.user_id,
        f.category,
        f.message,
        f.status,
        f.admin_notes,
        f.created_at,
        f.updated_at,
        f.reviewed_by,
        author.username AS username,
        reviewer.username AS reviewed_by_username
      FROM feedback_messages f
      JOIN users author ON author.id = f.user_id
      LEFT JOIN users reviewer ON reviewer.id = f.reviewed_by
      ORDER BY
        CASE f.status WHEN 'new' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,
        f.created_at DESC
      LIMIT 500
    `)
    .all()
    .map(serializeFeedbackRow);

  return res.json({ feedback });
});

app.delete('/api/admin/feedback/:id', requireAuth, requireAdmin, (req, res) => {
  const feedbackId = Number(req.params.id);
  if (!Number.isInteger(feedbackId)) {
    return res.status(400).json({ error: 'ID de feedback inválido.' });
  }
  const existing = db.prepare('SELECT id FROM feedback_messages WHERE id = ?').get(feedbackId);
  if (!existing) {
    return res.status(404).json({ error: 'Feedback não encontrado.' });
  }
  db.prepare('DELETE FROM feedback_messages WHERE id = ?').run(feedbackId);
  return res.json({ message: 'Feedback deletado.' });
});

// Endpoints para banned-mangas
app.get('/api/admin/banned-mangas', requireAuth, requireAdmin, (_req, res) => {
  const bannedMangas = db.prepare(`
    SELECT 
      bm.id, 
      bm.manga_id as mangaId, 
      bm.reason, 
      bm.created_at as createdAt, 
      u.username as bannedByUsername,
      m.title as title
    FROM banned_mangas bm
    LEFT JOIN users u ON u.id = bm.banned_by
    LEFT JOIN mangas m ON m.id = bm.manga_id
    ORDER BY bm.created_at DESC
  `).all();
  res.json({ bannedMangas });
});

app.post('/api/admin/banned-mangas', requireAuth, requireAdmin, (req, res) => {
  const mangaId = Number(req.body?.mangaId);
  const reason = String(req.body?.reason || 'admin ban').trim();
  
  if (!Number.isInteger(mangaId)) {
    return res.status(400).json({ error: 'mangaId inválido.' });
  }
  
  db.prepare(`
    INSERT OR IGNORE INTO banned_mangas (manga_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(mangaId, reason, req.user.userId);
  
  invalidateBannedMangasCache();
  res.json({ success: true });
});

app.delete('/api/admin/banned-mangas/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  db.prepare('DELETE FROM banned_mangas WHERE id = ?').run(id);
  invalidateBannedMangasCache();
  res.json({ success: true });
});

// Endpoints para banned-users
app.get('/api/admin/banned-users', requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT 
      bu.id, 
      bu.user_id as userId, 
      bu.reason, 
      bu.created_at as createdAt, 
      u.username, 
      u.email
    FROM banned_users bu
    LEFT JOIN users u ON u.id = bu.user_id
    ORDER BY bu.created_at DESC 
    LIMIT 200
  `).all();
  return res.json({ bannedUsers: users });
});

app.get('/api/admin/mangas', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const search = String(req.query.search || '').trim();

  let where = '1=1';
  const params = [];
  if (search) {
    where += ' AND (m.title LIKE ? OR m.normalized_title LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern);
  }

  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM mangas m WHERE ${where}`).get(...params);
  const total = Number(countRow?.total || 0);

  const rows = db
    .prepare(`
      SELECT m.id, m.title, m.author, m.total_chapters, m.source_lang, m.created_at
      FROM mangas m
      WHERE ${where}
      ORDER BY m.id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  return res.json({ mangas: rows, total, limit, offset });
});

app.post('/api/admin/banned-users', requireAuth, requireAdmin, (req, res) => {
  const { userId, reason } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId é obrigatório.' });
  }

  // Verificar se o alvo é Admin ou Dono
  const target = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(userId);
  if (target && (target.is_admin === 1 || target.is_owner === 1)) {
    if (!isUserOwner(req.user.userId)) {
      return res.status(403).json({ error: 'Apenas o DONO pode banir administradores ou o DONO.' });
    }
  }

  db.prepare(`
    INSERT OR IGNORE INTO banned_users (user_id, reason, banned_by, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, reason || 'admin ban', req.user.userId);
  res.json({ success: true });
});

app.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  const { action } = req.body;
  if (action === 'vacuum') {
    db.exec('VACUUM');
    return res.json({ success: true, message: 'Banco compactado.' });
  }
  if (action === 'cleanup-old-history') {
    const days = Math.max(30, Number(req.body.days) || 90);
    const deleted = db.prepare(`
      DELETE FROM reading_history WHERE updated_at < datetime('now', ? || ' days')
    `).run(`-${days}`).changes;
    return res.json({ success: true, deleted });
  }
  res.status(400).json({ error: 'Ação inválida.' });
});

app.delete('/api/admin/banned-users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM banned_users WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/health', health);

app.post('/api/admin/migrate-nsfw', requireAdmin, (_req, res) => {
  const allMangas = db.prepare(`
    SELECT m.id, m.genres, m.categories
    FROM mangas m
    WHERE m.is_nsfw = 0
  `).all();
  
  let updatedCount = 0;
  for (const manga of allMangas) {
    const genres = [
      ...(manga.genres || '').split(',').filter(Boolean),
      ...(manga.categories || '').split(',').filter(Boolean)
    ];
    if (genres.some(g => isNsfwCategoryName(g))) {
      db.prepare('UPDATE mangas SET is_nsfw = 1 WHERE id = ?').run(manga.id);
      updatedCount++;
    }
  }
  
  res.json({ success: true, updatedCount });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(STATIC_ROOT, 'index.html'));
});

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Quadroz iniciado em http://localhost:${PORT}`);
  if (process.env.DISABLE_DAILY_SYNC !== '1') {
    startDailySyncScheduler();
  }
});

function gracefulShutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} recebido, encerrando gracefully...`);
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('Servidor fechado');
    process.exit(0);
  });
  setTimeout(() => {
    // eslint-disable-next-line no-console
    console.log('Forçando salida');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

setInterval(() => pruneAuthAttempts(), AUTH_ATTEMPT_WINDOW_MS);
