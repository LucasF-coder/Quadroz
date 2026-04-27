import { state } from '../state.js';

let requestCacheInstance = null;

export function authHeaders(contentType = true) {
  const headers = {};
  if (contentType) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  return headers;
}

export function initRequestCache(cache) {
  requestCacheInstance = cache;
}

export async function request(url, options = {}) {
  const method = String(options.method || 'GET').trim().toUpperCase();
  const shouldCache = method === 'GET' && !options.skipCache;
  const cacheTtlMs = Math.max(500, Number(options.cacheTtlMs) || 12000);
  const cacheKey = `${method}:${url}:${state.token || 'public'}`;

  const fetchOptions = { ...options };
  delete fetchOptions.skipCache;
  delete fetchOptions.cacheTtlMs;

  const headers = { ...authHeaders(method !== 'GET') };
  if (options.headers) {
    Object.assign(headers, options.headers);
  }
  fetchOptions.headers = headers;

  const execute = async () => {
    const response = await fetch(url, fetchOptions);
    let data = null;

    try {
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error(data?.error || `Request error (${response.status}).`);
    }

    return data;
  };

  if (shouldCache && requestCacheInstance) {
    return requestCacheInstance.wrap(cacheKey, execute, cacheTtlMs);
  }

  const payload = await execute();

  if (method !== 'GET' && requestCacheInstance) {
    requestCacheInstance.clear();
  }

  return payload;
}
