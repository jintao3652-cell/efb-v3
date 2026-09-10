export interface CachedResourceMeta {
  source: "network" | "cache";
  stale: boolean;
  cachedAt: number;
  error?: string;
}

export interface CachedResource<T> {
  data: T;
  meta: CachedResourceMeta;
}

interface CacheRecord<T> {
  key: string;
  cachedAt: number;
  data: T;
  size?: number;
}

interface CachedResourceOptions<T> {
  cacheKey: string;
  ttlMs: number;
  signal?: AbortSignal;
  load: (signal: AbortSignal) => Promise<T>;
}

interface FetchJsonOptions extends Omit<RequestInit, "signal"> {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

const databaseName = "skyboard-network-cache";
const storeName = "responses";
const maxCacheRecords = 180;
const maxCacheAgeMs = 14 * 24 * 60 * 60_000;
const maxCacheBytes = 64 * 1024 * 1024;
const memoryCache = new Map<string, CacheRecord<unknown>>();
const inFlightRequests = new Map<string, Promise<CachedResource<unknown>>>();
let databasePromise: Promise<IDBDatabase | undefined> | undefined;
let cacheGeneration = 0;

class HttpError extends Error {
  constructor(public status: number, statusText: string) {
    super(`${status} ${statusText}`);
  }
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (!("indexedDB" in globalThis)) {
      resolve(undefined);
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
  return databasePromise;
}

async function readCache<T>(key: string): Promise<CacheRecord<T> | undefined> {
  const memoryRecord = memoryCache.get(key) as CacheRecord<T> | undefined;
  if (memoryRecord) return memoryRecord;
  const database = await openDatabase();
  if (!database) return undefined;
  try {
    return await new Promise((resolve) => {
      const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
      request.onsuccess = () => {
        const record = request.result as CacheRecord<T> | undefined;
        if (record) memoryCache.set(key, record);
        resolve(record);
      };
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

async function writeCache<T>(record: CacheRecord<T>) {
  memoryCache.set(record.key, record);
  pruneMemoryCache();
  const database = await openDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve) => {
      const request = database.transaction(storeName, "readwrite").objectStore(storeName).put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    await prunePersistentCache(database);
  } catch {
    return;
  }
}

function recordsToDelete(records: CacheRecord<unknown>[]) {
  const cutoff = Date.now() - maxCacheAgeMs;
  const sorted = [...records].sort((first, second) => second.cachedAt - first.cachedAt);
  let retainedBytes = 0;
  return sorted.filter((record, index) => {
    if (record.cachedAt < cutoff || index >= maxCacheRecords) return true;
    const size = record.size ?? estimatedSize(record.data);
    if (retainedBytes + size > maxCacheBytes) return true;
    retainedBytes += size;
    return false;
  }).map((record) => record.key);
}

function estimatedSize(value: unknown) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return 0; }
}

function pruneMemoryCache() {
  for (const key of recordsToDelete([...memoryCache.values()])) memoryCache.delete(key);
}

async function prunePersistentCache(database: IDBDatabase) {
  const records = await new Promise<CacheRecord<unknown>[]>((resolve) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as CacheRecord<unknown>[]);
    request.onerror = () => resolve([]);
  });
  const keys = recordsToDelete(records);
  if (!keys.length) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    for (const key of keys) store.delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
}

export async function clearNetworkCache() {
  cacheGeneration += 1;
  memoryCache.clear();
  const database = await openDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const request = database.transaction(storeName, "readwrite").objectStore(storeName).clear();
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

function abortError() {
  return new DOMException("请求已取消", "AbortError");
}

export function waitFor(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

async function withTimeout<T>(timeoutMs: number, parentSignal: AbortSignal | undefined, request: (signal: AbortSignal) => Promise<T>) {
  if (parentSignal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const handleAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", handleAbort, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await request(controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", handleAbort);
  }
}

function shouldRetry(error: Error) {
  if (error.name === "AbortError") return false;
  if (error instanceof HttpError) return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  return true;
}

export async function fetchJsonWithRetry<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { signal, timeoutMs = 12_000, retries = 1, retryDelayMs = 700, ...requestInit } = options;
  let lastError = new Error("网络请求失败");
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await withTimeout(timeoutMs, signal, async (requestSignal) => {
        const response = await fetch(url, { ...requestInit, signal: requestSignal });
        if (!response.ok) throw new HttpError(response.status, response.statusText);
        return response.json() as Promise<T>;
      });
    } catch (error) {
      lastError = asError(error);
      if (signal?.aborted || attempt >= retries || !shouldRetry(lastError)) throw lastError;
      await waitFor(retryDelayMs * 2 ** attempt, signal);
    }
  }
  throw lastError;
}

export async function loadCachedResource<T>({ cacheKey, ttlMs, signal, load }: CachedResourceOptions<T>): Promise<CachedResource<T>> {
  const existingRequest = inFlightRequests.get(cacheKey) as Promise<CachedResource<T>> | undefined;
  if (existingRequest) return existingRequest;
  const generation = cacheGeneration;
  const request: Promise<CachedResource<T>> = (async () => {
    const cached = await readCache<T>(cacheKey);
    const age = cached ? Date.now() - cached.cachedAt : Number.POSITIVE_INFINITY;
    if (cached && age <= ttlMs) return { data: cached.data, meta: { source: "cache", stale: false, cachedAt: cached.cachedAt } };
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      if (cached) return { data: cached.data, meta: { source: "cache", stale: true, cachedAt: cached.cachedAt, error: "当前离线" } };
      throw new Error("当前离线，且没有可用缓存");
    }
    try {
      const data = await load(signal ?? new AbortController().signal);
      const record = { key: cacheKey, cachedAt: Date.now(), data, size: estimatedSize(data) };
      if (generation === cacheGeneration) await writeCache(record);
      return { data, meta: { source: "network", stale: false, cachedAt: record.cachedAt } };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (cached) return { data: cached.data, meta: { source: "cache", stale: true, cachedAt: cached.cachedAt, error: asError(error).message } };
      throw error;
    }
  })();
  inFlightRequests.set(cacheKey, request as Promise<CachedResource<unknown>>);
  try {
    return await request;
  } finally {
    if (inFlightRequests.get(cacheKey) === request) inFlightRequests.delete(cacheKey);
  }
}
