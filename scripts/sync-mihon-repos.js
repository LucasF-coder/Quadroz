#!/usr/bin/env node

const { db, initDb } = require('../server/db');

const DEFAULT_REPOS = [
  'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json'
];

const IMPORT_COMPLETED_LIMIT = Math.max(0, Number(process.env.MIHON_IMPORT_COMPLETED_LIMIT || 500));
const IMPORT_ONGOING_LIMIT = Math.max(0, Number(process.env.MIHON_IMPORT_ONGOING_LIMIT || 2000));
const CHAPTER_ANALYZE_LIMIT = Math.max(0, Number(process.env.MIHON_CHAPTER_ANALYZE_LIMIT || 500));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// MangaDex recomenda max 5 req/s. Usamos ~2 req/s para segurança.
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);
// Tempo máximo por requisição antes de abortar
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20_000);
// Tentativas de retry em caso de erro transitório
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

let lastRequestTime = 0;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url, options = {}) {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_DELAY_MS) {
    await sleep(REQUEST_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
  return fetch(url, options);
}

// ─── fetchJson com retry, timeout e rate limiting ─────────────────────────────
async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await rateLimitedFetch(url, {
        headers: { 'User-Agent': 'QuadrozSync/1.0' },
        signal: controller.signal
      });

      clearTimeout(timer);

      // 429 = rate limit → espera e tenta de novo
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') || 5);
        console.warn(`  [rate-limit] 429 em ${url}; aguardando ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        lastError = new Error(`HTTP 429`);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} em ${url}`);
      }

      return await response.json();

    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      const isAbort = err.name === 'AbortError';
      const isTransient = isAbort || err.message?.includes('fetch failed') || err.code === 'UND_ERR_CONNECT_TIMEOUT';

      if (isTransient && attempt < MAX_RETRIES) {
        const backoff = attempt * 2000; // 2s, 4s, 6s
        console.warn(`  [retry ${attempt}/${MAX_RETRIES}] ${isAbort ? 'timeout' : 'fetch failed'} em ${url}; tentando em ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

// ─── Normalizações ────────────────────────────────────────────────────────────
const STATUS_IMPORT_ORDER = ['completed', 'ongoing'];
const SUPPORTED_TRANSLATED_LANGS = ['pt-br', 'pt', 'en'];
const FILTERED_PROFILE_LANGS = ['pt-br', 'en'];

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pickLocalizedText(obj, fallbacks = ['pt-br', 'pt', 'en']) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of fallbacks) {
    if (obj[key] && String(obj[key]).trim()) return String(obj[key]).trim();
  }
  const first = Object.values(obj).find((v) => String(v || '').trim());
  return first ? String(first).trim() : '';
}

function pickTitle(attributes) {
  const direct = pickLocalizedText(attributes.title);
  if (direct) return direct;
  if (Array.isArray(attributes.altTitles)) {
    for (const alt of attributes.altTitles) {
      const picked = pickLocalizedText(alt);
      if (picked) return picked;
    }
  }
  return '';
}

function pickDescription(attributes) {
  return pickLocalizedText(attributes.description) || 'Sem descrição disponível.';
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = { completed: 'completed', ongoing: 'ongoing', hiatus: 'hiatus', cancelled: 'cancelled', canceled: 'cancelled' };
  return map[normalized] || 'unknown';
}

function normalizeCatalogLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'en') return 'en';
  if (normalized === 'pt-br' || normalized === 'pt') return 'pt-br';
  if (normalized === 'es' || normalized === 'es-la' || normalized === 'es-419') return 'es';
  return '';
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractSupportedTranslatedLanguages(attributes) {
  const available = Array.isArray(attributes?.availableTranslatedLanguages)
    ? attributes.availableTranslatedLanguages : [];
  return uniq(available.map((l) => normalizeCatalogLanguage(l)).filter((l) => FILTERED_PROFILE_LANGS.includes(l)));
}

function pickAuthor(relationships) {
  const author = (relationships || []).find((item) => item.type === 'author');
  return author?.attributes?.name || 'Autor desconhecido';
}

// ─── Categorias ───────────────────────────────────────────────────────────────
const VALID_CATEGORIES = new Set([
  'action', 'adventure', 'comedy', 'drama', 'fantasy', 'horror', 'romance',
  'sci-fi', 'slice of life', 'mystery', 'thriller', 'sports', 'music',
  'historical', 'supernatural', 'martial arts', 'school life', 'harem',
  'shounen', 'shoujo', 'seinen', 'josei', 'ecchi', 'hentai',
  'yaoi', 'yuri', 'shounen ai', 'shoujo ai', 'bl', 'gl',
  'demons', 'angels', 'vampires', 'werewolves', 'magic', 'witches', 'wizards',
  'isekai', 'reincarnation', 'transmigration', 'regression',
  'monsters', 'robots', 'cyborgs', 'aliens', 'ghosts', 'zombies', 'gods',
  'warriors', 'samurai', 'ninjas', 'ninja', 'knights', 'fairies', 'elves', 'dwarves',
  'dragons', 'mermaids', 'workplace', 'office', 'police', 'military', 'army',
  'cooking', 'food', 'restaurant', 'bakery', 'animals', 'cats', 'dogs',
  'yandere', 'tsundere', 'cute', 'fluffy', 'wholesome', 'heartwarming',
  'dark', 'gore', 'violence', 'blood', 'depression', 'psychological', 'tragedy',
  'parody', 'gaming', 'video games', 'esports', 'idol', 'band', 'singer',
  'doujinshi', 'one shot', 'oneshot', 'monster girls', 'magical girls',
  'time travel', 'time loop', 'virtual reality', 'full color', 'color',
  'smut', 'erotic', 'academy', 'university', 'college', 'romantic comedy', 'romcom',
  'dark fantasy', 'urban fantasy', 'cyberpunk', 'steampunk', 'detective', 'investigation',
  'mecha', 'superhero', 'villainess', 'survival', 'post-apocalyptic',
  'wuxia', 'xianxia', 'cultivation', 'delinquents', 'crime', 'mafia',
  'incest', 'loli', 'shota', 'medical', 'philosophical', 'anthology', 'adaptation',
  // pt-br
  'acao', 'comedia', 'fantasia', 'terror', 'misterio', 'esportes',
  'sobrenatural', 'artes marciais', 'vida escolar', 'psicologico', 'tragedia',
  'reencarnacao', 'suspense'
].map((s) => s.toLowerCase().trim()));

const CATEGORY_BLACKLIST = new Set([
  '10', '12', '14', '16', '18',
  '1800s', '1900s', '1960s', '1970s', '1980s', '1990s', '2000s',
  '2000', '2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '2009',
  '2010', '2011', '2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019',
  '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027',
  'english', 'portuguese', 'japanese', 'spanish', 'french', 'german',
  'italian', 'korean', 'chinese', 'russian', 'thai', 'vietnamese',
  'indonesian', 'polish', 'turkish', 'hindi', 'arabic',
  'ingles', 'portugues', 'espanhol', 'japones', 'coreano', 'chines',
  'manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'comics', 'light novel',
  'brasil', 'america', 'japan', 'korea', 'china', 'thailand', 'indonesia',
  /^character\s+/i, /^artist\s+/i,
  /scan$/i, /fansub$/i, /traducoes$/i,
  /^\d+s?$/,
  /^(19|20)\d{2}s?$/,
  /.{41,}/
]);

function isValidCategory(name) {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 40) return false;
  const lower = trimmed.toLowerCase();
  if (VALID_CATEGORIES.has(lower)) return true;
  for (const pattern of CATEGORY_BLACKLIST) {
    if (typeof pattern === 'string') {
      if (lower === pattern) return false;
    } else if (pattern instanceof RegExp && pattern.test(trimmed)) {
      return false;
    }
  }
  return true;
}

function extractCategories(attributes) {
  if (!Array.isArray(attributes.tags)) return [];
  return attributes.tags
    .map((tag) => pickLocalizedText(tag.attributes?.name))
    .map((name) => String(name || '').trim())
    .filter(Boolean)
    .filter((name) => isValidCategory(name))
    .slice(0, 10);
}

function parseChapterFromAttributes(attributes) {
  const chapter = Number(attributes?.lastChapter);
  if (Number.isFinite(chapter) && chapter > 0) return Math.floor(chapter);
  return 1;
}

// ─── MangaDex API ─────────────────────────────────────────────────────────────
async function fetchMangadexCoverFileName(mangaId) {
  const params = new URLSearchParams();
  params.set('limit', '1');
  params.set('manga[]', mangaId);
  params.set('order[volume]', 'asc');
  const cover = await fetchJson(`https://api.mangadex.org/cover?${params.toString()}`);
  const first = Array.isArray(cover?.data) ? cover.data[0] : null;
  return first?.attributes?.fileName || null;
}

async function buildMangadexCoverUrl(mangaId, relationships) {
  let fileName = (relationships || []).find((item) => item.type === 'cover_art')?.attributes?.fileName;
  if (!fileName) {
    try {
      fileName = await fetchMangadexCoverFileName(mangaId);
    } catch {
      return null;
    }
  }
  if (!fileName) return null;
  return `https://uploads.mangadex.org/covers/${mangaId}/${fileName}.512.jpg`;
}

async function analyzeMangadexChapters(externalId) {
  let offset = 0;
  const limit = 100;
  const maxItems = 1200;
  const rows = [];

  while (offset < maxItems) {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    params.set('order[chapter]', 'asc');
    params.set('includeExternalUrl', '0');

    const feed = await fetchJson(`https://api.mangadex.org/manga/${externalId}/feed?${params.toString()}`);
    const data = Array.isArray(feed?.data) ? feed.data : [];
    if (data.length === 0) break;

    rows.push(...data);
    const total = Number(feed?.total || rows.length);
    offset += Number(feed?.limit || limit);
    if (offset >= total) break;
  }

  const uniqueChapters = new Set();
  const availableLanguages = new Set();
  let missingPagesCount = 0;

  rows.forEach((item) => {
    const attrs = item?.attributes || {};
    const numeric = Number(String(attrs.chapter || '').trim());
    if (Number.isFinite(numeric) && numeric > 0) uniqueChapters.add(Math.floor(numeric));

    const normalizedLanguage = normalizeCatalogLanguage(attrs.translatedLanguage);
    if (FILTERED_PROFILE_LANGS.includes(normalizedLanguage)) availableLanguages.add(normalizedLanguage);

    const pages = Number(attrs.pages);
    if (!Number.isFinite(pages) || pages < 1) missingPagesCount += 1;
  });

  const ordered = Array.from(uniqueChapters).sort((a, b) => a - b);
  if (ordered.length === 0) {
    return {
      totalChapters: rows.length || 1,
      chaptersConsistent: rows.length > 0 && missingPagesCount === 0,
      missingPagesCount,
      availableLanguages: Array.from(availableLanguages),
      analyzedRows: rows.length,
      missingCount: 0
    };
  }

  const min = ordered[0];
  const max = ordered[ordered.length - 1];
  let missingCount = 0;
  for (let n = min; n <= max; n += 1) {
    if (!uniqueChapters.has(n)) missingCount += 1;
  }

  return {
    totalChapters: max,
    chaptersConsistent: missingCount === 0 && missingPagesCount === 0,
    missingPagesCount,
    availableLanguages: Array.from(availableLanguages),
    analyzedRows: rows.length,
    missingCount
  };
}

async function fetchMangadexCatalogPage(status, offset, limit) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('includes[]', 'cover_art');
  params.append('includes[]', 'author');
  params.set('order[followedCount]', 'desc');
  params.set('hasAvailableChapters', 'true');
  params.set('status[]', status);
  params.set('contentRating[]', 'safe');
  params.append('contentRating[]', 'suggestive');
  SUPPORTED_TRANSLATED_LANGS.forEach((lang, index) => {
    if (index === 0) params.set('availableTranslatedLanguage[]', lang);
    else params.append('availableTranslatedLanguage[]', lang);
  });
  return fetchJson(`https://api.mangadex.org/manga?${params.toString()}`);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────
function ensureRepoTracked(repoUrl) {
  const isNsfw = repoUrl.toLowerCase().includes('luscious') || repoUrl.toLowerCase().includes('adult');
  db.prepare(`
    INSERT INTO extension_repos (url, fetched_at, is_nsfw)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, is_nsfw = excluded.is_nsfw
  `).run(repoUrl, isNsfw ? 1 : 0);
}

function syncSources(repoUrl, extensions) {
  const isNsfw = repoUrl.toLowerCase().includes('luscious') || repoUrl.toLowerCase().includes('adult') ? 1 : 0;
  const upsertSource = db.prepare(`
    INSERT INTO extension_sources (repo_url, source_name, lang, source_id, base_url, extension_pkg, extension_name, last_seen_at, is_nsfw)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(repo_url, source_id, lang) DO UPDATE SET
      source_name = excluded.source_name, base_url = excluded.base_url,
      extension_pkg = excluded.extension_pkg, extension_name = excluded.extension_name,
      last_seen_at = excluded.last_seen_at, is_nsfw = excluded.is_nsfw
  `);

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const extension of extensions) {
      for (const source of extension.sources || []) {
        upsertSource.run(
          repoUrl, source.name || 'Sem nome', source.lang || 'unknown',
          String(source.id || ''), source.baseUrl || '',
          extension.pkg || '', extension.name || '', isNsfw
        );
        inserted += 1;
      }
    }
  });
  tx();
  return inserted;
}

function collectSupportedSources() {
  return db.prepare(`
    SELECT DISTINCT source_name, lang, source_id, base_url
    FROM extension_sources
    WHERE base_url LIKE '%mangadex.org%'
    ORDER BY source_name ASC
  `).all();
}

// ─── Import principal ─────────────────────────────────────────────────────────
async function importMangadexCatalog(sourceMeta, status, targetCount, chapterAnalyzeCounter) {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let offset = 0;
  const limit = 100;

  const findByNormalized = db.prepare('SELECT id, sync_frozen FROM mangas WHERE normalized_title = ?');
  const findByTitle = db.prepare('SELECT id, sync_frozen FROM mangas WHERE title = ?');

  const insertManga = db.prepare(`
    INSERT INTO mangas (title, normalized_title, description, author, cover_url, publication_status,
      source_lang, chapters_consistent, sync_frozen, total_chapters, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const updateManga = db.prepare(`
    UPDATE mangas SET
      title = ?, normalized_title = ?, description = ?, author = ?,
      cover_url = CASE WHEN ? IS NOT NULL AND ? <> '' THEN ? ELSE cover_url END,
      publication_status = ?, source_lang = ?, chapters_consistent = ?,
      sync_frozen = ?, total_chapters = ?, last_synced_at = datetime('now')
    WHERE id = ?
  `);

  const upsertOrigin = db.prepare(`
    INSERT INTO manga_origins (manga_id, source_name, source_url, external_id, imported_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_url, external_id) DO UPDATE SET
      manga_id = excluded.manga_id, source_name = excluded.source_name, imported_at = excluded.imported_at
  `);

  const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  const findCategoryByName = db.prepare('SELECT id FROM categories WHERE name = ?');
  const linkCategory = db.prepare('INSERT OR IGNORE INTO manga_categories (manga_id, category_id) VALUES (?, ?)');
  const clearMangaLanguages = db.prepare('DELETE FROM manga_languages WHERE manga_id = ?');
  const linkMangaLanguage = db.prepare('INSERT OR IGNORE INTO manga_languages (manga_id, language) VALUES (?, ?)');

  while (imported < targetCount) {
    // Re-verificar se MangaDex ainda está habilitada (Bug 2 / Fix 2)
    const stillActive = db.prepare("SELECT 1 FROM enabled_sources WHERE (source_id = 'mangadex' OR provider = 'mangadex') AND is_active = 1").get();
    if (!stillActive) {
      console.log('  [abort] MangaDex foi desabilitada durante o sync. Abortando.');
      break;
    }

    // ── Buscar página de catálogo ──
    let page;
    try {
      page = await fetchMangadexCatalogPage(status, offset, limit);
    } catch (err) {
      console.error(`  [erro] falha ao buscar página offset=${offset}: ${err.message}`);
      // Interrompe o loop deste status mas não mata o processo inteiro
      break;
    }

    const entries = Array.isArray(page?.data) ? page.data : [];
    if (entries.length === 0) break;

    // ── Processar cada entrada ──
    for (const entry of entries) {
      if (imported >= targetCount) break;

      try {
        const attrs = entry.attributes || {};
        const title = pickTitle(attrs);
        if (!title) { skipped++; continue; }

        const normalizedTitle = normalizeTitle(title);
        if (!normalizedTitle) { skipped++; continue; }

        const description = pickDescription(attrs);
        const author = pickAuthor(entry.relationships);
        const statusValue = normalizeStatus(attrs.status);
        const fallbackTotal = parseChapterFromAttributes(attrs);
        let translatedLanguages = extractSupportedTranslatedLanguages(attrs);

        // Análise de capítulos (com proteção individual por try/catch)
        let chapterInfo = {
          totalChapters: fallbackTotal,
          chaptersConsistent: statusValue !== 'completed',
          missingPagesCount: 0,
          availableLanguages: [],
          analyzedRows: 0,
          missingCount: 0
        };

        const shouldForceAnalyze = statusValue === 'completed';
        if (shouldForceAnalyze || chapterAnalyzeCounter.value < CHAPTER_ANALYZE_LIMIT) {
          try {
            chapterInfo = await analyzeMangadexChapters(entry.id);
            chapterAnalyzeCounter.value += 1;
          } catch (analyzeErr) {
            console.warn(`  [aviso] falha ao analisar capítulos de "${title}": ${analyzeErr.message}`);
            // Mantém chapterInfo com fallback, não interrompe
          }
        }

        if (translatedLanguages.length === 0 && Array.isArray(chapterInfo.availableLanguages)) {
          translatedLanguages = chapterInfo.availableLanguages;
        }

        translatedLanguages = uniq(
          translatedLanguages.map((l) => normalizeCatalogLanguage(l)).filter((l) => FILTERED_PROFILE_LANGS.includes(l))
        );
        if (translatedLanguages.length === 0) { skipped++; continue; }

        const resolvedTotalChapters = Math.max(1, Number(fallbackTotal) || 1, Number(chapterInfo.totalChapters) || 1);
        const sparseCatalogForCompleted =
          statusValue === 'completed' &&
          resolvedTotalChapters >= 5 &&
          ((Number(chapterInfo.totalChapters) || 0) <= 1 || (Number(chapterInfo.analyzedRows) || 0) <= 1);
        const chaptersConsistent = Boolean(chapterInfo.chaptersConsistent) && !sparseCatalogForCompleted;
        const sourceLang = translatedLanguages.includes('pt-br') ? 'pt-br' : 'en';
        const shouldFreezeSync = statusValue === 'completed' && chaptersConsistent && resolvedTotalChapters >= 5;

        const coverUrl = await buildMangadexCoverUrl(entry.id, entry.relationships);

        let manga = findByNormalized.get(normalizedTitle);
        if (!manga) manga = findByTitle.get(title);

        if (manga?.sync_frozen === 1) { imported++; continue; }

        if (!manga) {
          const result = insertManga.run(
            title, normalizedTitle, description, author, coverUrl,
            statusValue, sourceLang, chaptersConsistent ? 1 : 0,
            shouldFreezeSync ? 1 : 0, resolvedTotalChapters
          );
          manga = { id: Number(result.lastInsertRowid) };
        } else {
          updateManga.run(
            title, normalizedTitle, description, author,
            coverUrl, coverUrl || '', coverUrl,
            statusValue, sourceLang, chaptersConsistent ? 1 : 0,
            shouldFreezeSync ? 1 : 0, resolvedTotalChapters, manga.id
          );
        }

        upsertOrigin.run(manga.id, sourceMeta.source_name, sourceMeta.base_url, String(entry.id));

        db.prepare(`
          INSERT INTO manga_source_cache (
            manga_id, source_key, provider, source_id, source_name,
            source_url, external_id, source_lang, chapter_count, last_checked_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(manga_id, source_key) DO UPDATE SET
            chapter_count = CASE
              WHEN excluded.chapter_count > manga_source_cache.chapter_count THEN excluded.chapter_count
              ELSE manga_source_cache.chapter_count
            END,
            last_checked_at = excluded.last_checked_at
        `).run(
          manga.id,
          `md:${entry.id}`,
          'mangadex',
          `md:${entry.id}`,
          'MangaDex',
          `https://mangadex.org/manga/${entry.id}`,
          entry.id,
          sourceLang,
          resolvedTotalChapters
        );

        const categories = extractCategories(attrs);
        linkMangaCategories(manga.id, categories);

        clearMangaLanguages.run(manga.id);
        for (const lang of translatedLanguages) {
          linkMangaLanguage.run(manga.id, lang);
        }

        imported += 1;

      } catch (entryErr) {
        errors++;
        console.warn(`  [aviso] falha ao processar entrada "${entry?.id}": ${entryErr.message}`);
        // Continua o loop — não deixa um manga ruim derrubar tudo
      }
    }

    const total = Number(page?.total || imported);
    offset += Number(page?.limit || limit);

    // Progresso a cada página
    console.log(`  [progresso] ${imported}/${targetCount} importados, offset=${offset}, total_api=${total}`);

    if (offset >= total) break;
  }

  if (errors > 0) {
    console.warn(`  [aviso] ${errors} entrada(s) puladas por erro neste status.`);
  }

  return imported;
}

function removeOrphanCategories() {
  return db
    .prepare('DELETE FROM categories WHERE id NOT IN (SELECT DISTINCT category_id FROM manga_categories)')
    .run().changes;
}

async function fetchSuwayomiPopular(sourceId, page = 1) {
  const SUWAYOMI_BASE = String(process.env.SUWAYOMI_BASE || 'http://127.0.0.1:4567').replace(/\/+$/, '');
  const url = `${SUWAYOMI_BASE}/api/v1/source/${encodeURIComponent(sourceId)}/popular/${page}`;
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return payload;
  } catch (err) {
    throw err;
  }
}

function linkMangaCategories(mangaId, categoryNames) {
  const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
  const findCategoryByName = db.prepare('SELECT id FROM categories WHERE name = ?');
  const linkCategory = db.prepare('INSERT OR IGNORE INTO manga_categories (manga_id, category_id) VALUES (?, ?)');

  for (const name of categoryNames) {
    const trimmed = String(name || '').trim();
    if (isValidCategory(trimmed)) {
      insertCategory.run(trimmed);
      const category = findCategoryByName.get(trimmed);
      if (category) linkCategory.run(mangaId, category.id);
    }
  }
}

function upsertSuwayomiManga(item, lang, sourceName) {
  const title = String(item.title || '').trim();
  if (!title) return null;

  const SUWAYOMI_BASE = String(process.env.SUWAYOMI_BASE || 'http://127.0.0.1:4567').replace(/\/+$/, '');
  let coverUrl = String(item.thumbnailUrl || '').trim();
  if (coverUrl.startsWith('/')) {
    coverUrl = `${SUWAYOMI_BASE}${coverUrl}`;
  }

  const normalizedTitle = normalizeTitle(title);
  
  // Detecção de NSFW por gêneros e descrição
  const genres = Array.isArray(item.genre) ? item.genre : (Array.isArray(item.genres) ? item.genres : []);
  const description = String(item.description || '').toLowerCase();
  const titleLower = title.toLowerCase();
  
  // Termos explícitos que definem conteúdo NSFW
  const EXPLICIT_NSFW_TERMS = [
    'hentai', 'ecchi', 'yaoi', 'yuri', 'smut', 'erotic', 'nsfw', 'porn', 'sex',
    'hot', 'tits', 'boobs', 'amateur', 'blowjob', 'anal', 'creampie', 'ahegao',
    'bdsm', 'fetish', 'gangbang', 'milf', 'masturbation', 'straight sex', 'pictures',
    'mature'
  ];
  const SOFT_NSFW_TERMS = ['adult', '18+']; // Termos que podem aparecer mas exigem cautela

  let isNsfw = 0;
  
  // 1. Checar gêneros (mais confiável)
  if (genres.some(g => {
    const gl = String(g).toLowerCase();
    return EXPLICIT_NSFW_TERMS.some(term => gl.includes(term)) || SOFT_NSFW_TERMS.includes(gl);
  })) {
    isNsfw = 1;
  } 
  // 2. Checar título para termos explícitos
  else if (EXPLICIT_NSFW_TERMS.some(term => titleLower.includes(term))) {
    isNsfw = 1;
  }
  // 3. Checar descrição apenas para termos EXTREMAMENTE explícitos com limites de palavra
  else if (/\b(hentai|smut|porn|sex|tits|boobs|hot)\b/.test(description)) {
    isNsfw = 1;
  }

  let manga = db.prepare('SELECT id FROM mangas WHERE normalized_title = ?').get(normalizedTitle);
  
  if (!manga) {
    const insert = db.prepare(`
      INSERT INTO mangas (title, normalized_title, description, author, cover_url, source_lang, is_nsfw, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(title, normalizedTitle, item.description || '', item.author || '', coverUrl, lang, isNsfw);
    manga = { id: insert.lastInsertRowid };
  } else {
    db.prepare(`
      UPDATE mangas SET
        title = ?,
        description = ?,
        author = ?,
        cover_url = ?,
        source_lang = ?,
        is_nsfw = ?,
        last_synced_at = datetime('now')
      WHERE id = ?
    `).run(title, item.description || '', item.author || '', coverUrl, lang, isNsfw, manga.id);
  }

  // Vincular categorias/gêneros (limpar antigos primeiro para evitar herança indesejada de fontes diferentes)
  if (genres.length > 0) {
    db.prepare('DELETE FROM manga_categories WHERE manga_id = ?').run(manga.id);
    linkMangaCategories(manga.id, genres);
  }

  // Vincular origem
  db.prepare(`
    INSERT INTO manga_origins (manga_id, source_name, source_url, external_id, imported_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_url, external_id) DO UPDATE SET
      source_name = excluded.source_name,
      imported_at = excluded.imported_at
  `).run(manga.id, sourceName || item.sourceName || 'Suwayomi', `suwayomi://source/${item.sourceId}`, String(item.id));

  // Vincular idioma
  if (lang) {
    db.prepare('INSERT OR IGNORE INTO manga_languages (manga_id, language) VALUES (?, ?)')
      .run(manga.id, lang);
  }

  return manga.id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  initDb();

  const args = process.argv.slice(2);
  const specificSourceIndex = args.indexOf('--source');
  let specificSourceId = null;
  if (specificSourceIndex !== -1 && args[specificSourceIndex + 1]) {
    specificSourceId = args[specificSourceIndex + 1];
    // Remover flags do array de repos
    args.splice(specificSourceIndex, 2);
  }

  const repoUrls = args.length > 0 ? args : DEFAULT_REPOS;
  let syncedSources = 0;
  let successfulRepos = 0;

  if (specificSourceId) {
    console.log(`- Sincronização específica solicitada para a fonte: ${specificSourceId}`);
  }

  for (const repoUrl of repoUrls) {
    try {
      console.log(`- Lendo repositório: ${repoUrl}`);
      const payload = await fetchJson(repoUrl);
      if (!Array.isArray(payload)) throw new Error(`Formato inesperado em ${repoUrl}`);

      ensureRepoTracked(repoUrl);
      const count = syncSources(repoUrl, payload);
      syncedSources += count;
      successfulRepos += 1;
      console.log(`  Fontes sincronizadas: ${count}`);
    } catch (error) {
      console.warn(`  Aviso: não foi possível sincronizar ${repoUrl} (${error.message}).`);
    }
  }

  if (successfulRepos === 0) {
    throw new Error('Nenhum repositório de extensões pôde ser sincronizado.');
  }

  const chapterAnalyzeCounter = { value: 0 };

  if (specificSourceId) {
    // Sincronizar apenas uma fonte específica
    const source = db.prepare('SELECT * FROM enabled_sources WHERE source_id = ? AND is_active = 1').get(specificSourceId);
    if (!source) {
      console.error(`  Erro: Fonte ${specificSourceId} não encontrada ou está desabilitada.`);
      process.exit(0);
    }
    
    const supported = collectSupportedSources();
    await syncSourceDetails(source, supported, chapterAnalyzeCounter);
  } else {
    // Sincronizar todas as fontes habilitadas
    await syncEnabledSources(chapterAnalyzeCounter);
  }

  const removedCategories = removeOrphanCategories();

  console.log('');
  console.log('Sincronização finalizada.');
  console.log(`- Fontes lidas no índice: ${syncedSources}`);
  console.log(`- Verificações de capítulos executadas: ${chapterAnalyzeCounter.value}`);
  console.log(`- Categorias órfãs removidas: ${removedCategories}`);
  console.log('');
  console.log('Observação: o script importa metadados/capas para leitura online e evita duplicatas por título normalizado.');
}

async function syncSourceDetails(source, supported, chapterAnalyzeCounter) {
  const stillActive = db.prepare('SELECT 1 FROM enabled_sources WHERE source_id = ? AND is_active = 1').get(source.source_id);
  if (!stillActive) {
    console.log(`    [skip] Fonte ${source.source_name} não está ativa. Pulando.`);
    return;
  }

  console.log(`  Sincronizando fonte: ${source.source_name} (${source.lang}) [${source.provider}]...`);
  
  if (source.provider === 'mangadex' || source.source_id === 'mangadex') {
    const mangadexSource = supported.find((s) => s.base_url.includes('mangadex.org'));
    if (!mangadexSource) {
      console.warn('    [aviso] fonte MangaDex não encontrada no índice de extensões.');
      return;
    }

    const importedByStatus = {};
    const scope = String(process.env.SYNC_SCOPE || 'all').trim().toLowerCase();
    const statusesToRun = scope === 'ongoing' ? ['ongoing'] : STATUS_IMPORT_ORDER;

    for (const status of statusesToRun) {
      const target = status === 'completed' ? IMPORT_COMPLETED_LIMIT : IMPORT_ONGOING_LIMIT;
      if (target <= 0) {
        importedByStatus[status] = 0;
        continue;
      }
      console.log(`    Importando catálogo MangaDex ${status} (limite ${target})...`);
      const imported = await importMangadexCatalog(mangadexSource, status, target, chapterAnalyzeCounter);
      importedByStatus[status] = imported;
    }
    
    db.prepare("UPDATE enabled_sources SET last_sync_at = datetime('now') WHERE source_id = ? AND is_active = 1").run(source.source_id);
    console.log(`    MangaDex finalizado: ${JSON.stringify(importedByStatus)}`);

  } else if (source.provider === 'suwayomi') {
    try {
      let imported = 0;
      let page = 1;
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 5;

      while (true) {
        console.log(`    Buscando página ${page} de ${source.source_name}...`);
        
        // Tratamento de rate limit para Suwayomi
        let payload;
        let retryCount = 0;
        const MAX_RETRIES_SOURCE = 5;
        
        while (retryCount < MAX_RETRIES_SOURCE) {
          try {
            payload = await fetchSuwayomiPopular(source.source_id, page);
            consecutiveErrors = 0;
            break;
          } catch (err) {
            // Verificar se é rate limit (código específico da fonte)
            if (err.message?.includes('429') || err.message?.includes('rate') || err.message?.includes('Too Many Requests')) {
              consecutiveErrors++;
              const waitTime = Math.min(30000, (retryCount + 1) * 5000);
              console.warn(`    [rate-limit] Aguardando ${waitTime / 1000}s antes de retry...`);
              await sleep(waitTime);
              retryCount++;
              if (retryCount >= MAX_RETRIES_SOURCE) {
                throw new Error(`Rate limit persistente após ${MAX_RETRIES_SOURCE} tentativas.Abortando sync de ${source.source_name}.`);
              }
              continue;
            }
            throw err;
          }
        }
        
        const results = Array.isArray(payload?.mangaList) ? payload.mangaList : (Array.isArray(payload?.results) ? payload.results : []);
        
        if (results.length === 0) break;

        for (const item of results) {
          // Re-verificar se a fonte continua ativa
          const stillActive = db.prepare('SELECT 1 FROM enabled_sources WHERE source_id = ? AND is_active = 1').get(source.source_id);
          if (!stillActive) {
            console.log(`    [abort] Fonte ${source.source_name} foi desabilitada durante o sync.Abortando.`);
            return;
          }

          const lang = normalizeCatalogLanguage(item.lang || source.lang);
          if (!['pt-br', 'en', 'es'].includes(lang)) continue;

          const mangaId = upsertSuwayomiManga(item, lang, source.source_name);
          if (mangaId) imported++;
        }

        if (!payload.hasNextPage) break;
        page++;
        // Segurança para não entrar em loop infinito se a API mentir sobre hasNextPage
        if (page > 100) break; 
      }
      
      db.prepare("UPDATE enabled_sources SET last_sync_at = datetime('now') WHERE source_id = ? AND is_active = 1").run(source.source_id);
      console.log(`    Importados ${imported} mangás de ${source.source_name}`);
    } catch (err) {
      console.error(`    Erro ao sincronizar ${source.source_name}: ${err.message}`);
      db.prepare("UPDATE source_health SET status = 'down', last_error = ?, last_checked_at = datetime('now') WHERE source_url = ?")
        .run(err.message, `suwayomi://source/${source.source_id}`);
    }
  }
}

async function syncEnabledSources(chapterAnalyzeCounter) {
  console.log('- Sincronizando fontes habilitadas...');
  const enabledSources = db.prepare('SELECT * FROM enabled_sources WHERE is_active = 1').all();
  
  if (enabledSources.length === 0) {
    console.log('  Nenhuma fonte ativa no painel admin.');
    return;
  }

  const supported = collectSupportedSources();

  for (const source of enabledSources) {
    await syncSourceDetails(source, supported, chapterAnalyzeCounter);
  }
}


main().catch((error) => {
  console.error('Erro na sincronização:', error.message);
  process.exit(1);
});
