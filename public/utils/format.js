import { FALLBACK_COVER } from '../state.js';

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function truncateText(value, limit = 220) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

export function formatStatusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed') return 'Completo';
  if (normalized === 'ongoing') return 'Ongoing';
  if (normalized === 'hiatus') return 'Hiato';
  if (normalized === 'cancelled') return 'Cancelado';
  return 'Status desconhecido';
}

export function formatLanguageLabel(lang) {
  const normalized = String(lang || '').toLowerCase();
  if (!normalized) return 'Idioma desconhecido';
  if (normalized === 'pt-br') return 'Português (BR)';
  if (normalized === 'pt') return 'Português';
  if (normalized === 'en') return 'Inglês';
  if (normalized === 'es') return 'Espanhol';
  if (normalized === 'ja') return 'Japonês';
  if (normalized === 'ko') return 'Coreano';
  if (normalized === 'zh') return 'Chinês';
  return normalized.toUpperCase();
}

export function formatDateTime(value) {
  const iso = String(value || '').trim();
  if (!iso) return '-';

  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return iso;

  return parsed.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatReportReason(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  if (normalized === 'criminal_content') return 'Criminal content';
  if (normalized === 'missing_chapters') return 'Missing chapters';
  if (normalized === 'source_mismatch') return 'Source mismatch';
  if (normalized === 'bug') return 'Bug';
  if (normalized === 'other') return 'Outro';
  return normalized || 'not informed';
}

export function formatCategories(categories, emptyLabel = 'Sem categoria', chipClass = '') {
  const normalizedClass = String(chipClass || '').trim();
  const classAttr = normalizedClass ? `chip ${normalizedClass}` : 'chip';

  if (!Array.isArray(categories) || categories.length === 0) {
    return `<span class="${classAttr}">${escapeHtml(emptyLabel)}</span>`;
  }

  return categories.map((name) => `<span class="${classAttr}">${escapeHtml(name)}</span>`).join('');
}

export function normalizeSearchQuery(value) {
  return String(value || '').trim();
}

export function normalizeUiProfileLanguage(value, fallback = 'pt-br') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'en') return 'en';
  if (normalized === 'es' || normalized === 'es-la' || normalized === 'es-419') return 'es';
  if (normalized === 'pt' || normalized === 'pt-br') return 'pt-br';
  return fallback;
}

export function normalizeClientReportReason(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const map = {
    criminal: 'criminal_content',
    criminal_content: 'criminal_content',
    missing: 'missing_chapters',
    missing_chapters: 'missing_chapters',
    source: 'source_mismatch',
    source_mismatch: 'source_mismatch',
    wrong_source: 'source_mismatch',
    fonte_errada: 'source_mismatch',
    fonte_incorreta: 'source_mismatch',
    bug: 'bug',
    other: 'other',
    spam: 'spam',
    harassment: 'harassment',
    ofensa: 'harassment'
  };
  return map[normalized] || normalized;
}

export function coverSrc(url) {
  if (!url || !String(url).trim()) return FALLBACK_COVER;
  const rawUrl = String(url).trim();
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('/') || rawUrl.startsWith('blob:')) return rawUrl;
  if (rawUrl.includes('/api/image-proxy')) return rawUrl;
  return `/api/image-proxy?url=${encodeURIComponent(rawUrl)}`;
}
