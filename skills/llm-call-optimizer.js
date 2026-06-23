// Skill: llm-call-optimizer
// Purpose: Deduplicate equivalent LLM calls, cache responses, and route requests based on cost and intent

import crypto from 'crypto';

const DEFAULT_TTL_SECONDS = parseInt(process.env.LLM_CACHE_TTL_SECONDS ?? '86400', 10);
const REDIS_URL = process.env.LLM_CACHE_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://dify-redis-1:6379';
const REDIS_COOLDOWN_MS = parseInt(process.env.LLM_CACHE_REDIS_COOLDOWN_MS ?? '10000', 10);
const REDIS_CONNECT_TIMEOUT_MS = parseInt(process.env.LLM_CACHE_REDIS_CONNECT_TIMEOUT_MS ?? '600', 10);
const MAX_MEMORY_ITEMS = parseInt(process.env.LLM_CACHE_MAX_MEMORY_ITEMS ?? '250', 10);

const state = (globalThis as any).__assistedlyLLMOptimizer || ((globalThis as any).__assistedlyLLMOptimizer = {
  redisClient: null,
  redisConnectPromise: null,
  redisDisabledUntil: 0,
  memoryCache: new Map(),
});

function normalizePrompt(prompt: any) {
  return String(prompt || '').replace(/s+/g, ' ').trim();
}

function hasSensitiveData(text: string) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+.[A-Z]{2,}/i.test(text)
    || /(?:+?1[-.s]?)?(?:(?d{3})?[-.s]?)d{3}[-.s]?d{4}/.test(text)
    || /(?:password|passcode|ssn|social security|credit card|api key|secret|token)/i.test(text);
}

function buildFingerprint(input: any = {}) {
  const normalizedPrompt = normalizePrompt(input.prompt);
  if (!normalizedPrompt) return { cacheable: false, reason: 'empty prompt' };
  if (normalizedPrompt.length > 6000) return { cacheable: false, reason: 'prompt too long' };
  if (hasSensitiveData(normalizedPrompt)) return { cacheable: false, reason: 'sensitive prompt' };

  const scope = String(input.conversationId || input.sessionId || input.userId || 'global');
  const payload = JSON.stringify({ v: 1, app: 'assistedly-chat', scope, prompt: normalizedPrompt });
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  return {
    cacheable: true,
    cacheKey: `llm-cache:v1:${digest}`,
    promptHash: digest.slice(0, 16),
    scope,
  };
}

function memoryGet(cacheKey: string) {
  const entry = state.memoryCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    state.memoryCache.delete(cacheKey);
    return null;
  }
  return entry.value;
}

function memorySet(cacheKey: string, value: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (state.memoryCache.size >= MAX_MEMORY_ITEMS) {
    const firstKey = state.memoryCache.keys().next().value;
    if (firstKey) state.memoryCache.delete(firstKey);
  }
  state.memoryCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

async function getRedisClient() {
  if (Date.now() < state.redisDisabledUntil) return null;
  if (state.redisClient && state.redisClient.isReady) return state.redisClient;

  if (!state.redisClient) {
    let redisMod: any;
    try {
      redisMod = await import('redis');
    } catch (e) {
      state.redisDisabledUntil = Date.now() + REDIS_COOLDOWN_MS;
      console.warn('[llm-cache] redis module not found, using memory cache only');
      return null;
    }
    const { createClient } = redisMod;
    state.redisClient = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: false,
      },
    });

    state.redisClient.on('error', (err: any) => {
      state.redisDisabledUntil = Date.now() + REDIS_COOLDOWN_MS;
      console.warn('[llm-cache] Redis error:', err && err.message ? err.message : String(err));
    });
  }

  if (!state.redisConnectPromise && !state.redisClient.isOpen) {
    state.redisConnectPromise = state.redisClient.connect().catch((err: any) => {
      state.redisDisabledUntil = Date.now() + REDIS_COOLDOWN_MS;
      console.warn('[llm-cache] Redis connect failed:', err && err.message ? err.message : String(err));
      return null;
    });
  }

  await Promise.race([
    state.redisConnectPromise,
    new Promise((resolve) => setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS + 100)),
  ]);

  return state.redisClient && state.redisClient.isReady ? state.redisClient : null;
}

export function getLLMCacheKey(input: any) {
  const fingerprint = buildFingerprint(input || {});
  return fingerprint.cacheable ? fingerprint.cacheKey : null;
}

export async function optimizeLLMCall(input: any) {
  const fingerprint = buildFingerprint(input || {});
  if (!fingerprint.cacheable) {
    return { handled: false, reason: fingerprint.reason, route: 'powerful' };
  }

  const memoryCached = memoryGet(fingerprint.cacheKey);
  if (memoryCached) {
    console.log('[llm-cache] memory hit:', fingerprint.promptHash);
    return {
      handled: true,
      answer: memoryCached,
      route: memoryCached,
      source: 'memory',
      cacheKey: fingerprint.cacheKey,
      promptHash: fingerprint.promptHash,
    };
  }

  try {
    const client = await getRedisClient();
    if (client) {
      const cached = await client.get(fingerprint.cacheKey);
      if (cached) {
        memorySet(fingerprint.cacheKey, cached);
        console.log('[llm-cache] redis hit:', fingerprint.promptHash);
        return {
          handled: true,
          answer: cached,
          route: cached,
          source: 'redis',
          cacheKey: fingerprint.cacheKey,
          promptHash: fingerprint.promptHash,
        };
      }
    }
  } catch (err: any) {
    console.warn('[llm-cache] Redis get failed:', err && err.message ? err.message : String(err));
  }

  return {
    handled: false,
    reason: 'not cached',
    route: 'powerful',
    cacheKey: fingerprint.cacheKey,
    promptHash: fingerprint.promptHash,
  };
}

export async function cacheLLMResponse(cacheKeyOrInput: any, response?: string, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const cacheKey = typeof cacheKeyOrInput === 'string' ? cacheKeyOrInput : getLLMCacheKey(cacheKeyOrInput || {});
  if (!cacheKey || typeof response !== 'string' || !response.trim()) {
    return { cached: false, reason: 'missing cache key or response' };
  }

  const value = response.trim();
  memorySet(cacheKey, value, ttlSeconds);

  try {
    const client = await getRedisClient();
    if (client) {
      await client.set(cacheKey, value, { EX: ttlSeconds });
      console.log('[llm-cache] stored in redis');
      return { cached: true, source: 'redis', cacheKey };
    }
  } catch (err: any) {
    console.warn('[llm-cache] Redis set failed:', err && err.message ? err.message : String(err));
  }

  console.log('[llm-cache] stored in memory');
  return { cached: true, source: 'memory', cacheKey };
}
