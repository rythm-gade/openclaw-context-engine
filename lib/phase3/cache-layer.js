/**
 * Phase 3.2: Multi-tier Caching Layer
 * lib/phase3/cache-layer.js
 */

const LRU = require('lru-cache');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

class MultiTierCache {
  constructor(options = {}) {
    this.l1 = new LRU({
      max: options.l1Size || 100,
      ttl: options.l1TTL || 1000 * 60 * 5,
      updateAgeOnGet: true
    });
    this.l2Path = options.l2Path || path.join(process.env.HOME, '.openclaw', 'cache', 'l2');
    this.l2MaxSize = options.l2MaxSize || 100 * 1024 * 1024;
    this.l3Enabled = options.l3Enabled !== false;
    this.semanticThreshold = options.semanticThreshold || 0.85;
    this.stats = { l1: { hits: 0, misses: 0 }, l2: { hits: 0, misses: 0 }, l3: { hits: 0, misses: 0 } };
    this.prefetchPatterns = new Map();
    this.l3Cache = new Map(); // In-memory fallback for L3
  }

  async init() {
    await fs.mkdir(this.l2Path, { recursive: true });
    await this.loadPrefetchPatterns();
    await this.warmL1();
  }

  generateKey(query) {
    return crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex');
  }

  async get(key) {
    // L1 check
    const l1Value = this.l1.get(key);
    if (l1Value) { this.stats.l1.hits++; return l1Value; }
    this.stats.l1.misses++;

    // L2 check
    try {
      const l2Data = await fs.readFile(path.join(this.l2Path, `${key}.json`), 'utf8');
      const value = JSON.parse(l2Data);
      this.l1.set(key, value); // Promote to L1
      this.stats.l2.hits++;
      return value;
    } catch { this.stats.l2.misses++; }

    // L3 check (semantic)
    if (this.l3Enabled) {
      const l3Value = this.l3Cache.get(key);
      if (l3Value) { this.stats.l3.hits++; return l3Value; }
      this.stats.l3.misses++;
    }

    return null;
  }

  async set(key, value, options = {}) {
    this.l1.set(key, value);
    
    if (options.l2 !== false) {
      await fs.writeFile(path.join(this.l2Path, `${key}.json`), JSON.stringify(value));
      await this.enforceL2Limit();
    }
    
    if (options.l3 !== false && this.l3Enabled) {
      this.l3Cache.set(key, value);
    }
  }

  async enforceL2Limit() {
    const files = await fs.readdir(this.l2Path);
    let totalSize = 0;
    const fileStats = [];
    
    for (const file of files) {
      const stat = await fs.stat(path.join(this.l2Path, file));
      totalSize += stat.size;
      fileStats.push({ file, size: stat.size, mtime: stat.mtime });
    }
    
    if (totalSize > this.l2MaxSize) {
      fileStats.sort((a, b) => a.mtime - b.mtime);
      let sizeToFree = totalSize - this.l2MaxSize * 0.9;
      for (const { file, size } of fileStats) {
        if (sizeToFree <= 0) break;
        await fs.unlink(path.join(this.l2Path, file));
        sizeToFree -= size;
      }
    }
  }

  async getSemantic(query, threshold = null) {
    if (!this.l3Enabled) return null;
    // Simple exact match fallback - real implementation would use embeddings
    const key = this.generateKey(query);
    return this.l3Cache.get(key);
  }

  async prefetch(taskType, context) {
    const patterns = this.prefetchPatterns.get(taskType) || [];
    for (const key of patterns.slice(0, 5)) {
      const value = await this.get(key);
      if (value) this.l1.set(key, value);
    }
  }

  recordPattern(taskType, key) {
    if (!this.prefetchPatterns.has(taskType)) this.prefetchPatterns.set(taskType, []);
    const patterns = this.prefetchPatterns.get(taskType);
    if (!patterns.includes(key)) patterns.push(key);
  }

  async warm(keys) {
    for (const key of keys) await this.get(key);
  }

  async loadPrefetchPatterns() {
    try {
      const data = await fs.readFile(path.join(this.l2Path, '..', 'patterns.json'), 'utf8');
      this.prefetchPatterns = new Map(JSON.parse(data));
    } catch { /* No saved patterns */ }
  }

  async warmL1() {
    // Warm with most recently used L2 entries
  }

  getStats() {
    return { ...this.stats, l1Size: this.l1.size, l3Size: this.l3Cache.size };
  }

  async invalidate(pattern) {
    for (const key of this.l1.keys()) {
      if (key.match(pattern)) this.l1.delete(key);
    }
  }

  async clear() {
    this.l1.clear();
    this.l3Cache.clear();
    const files = await fs.readdir(this.l2Path);
    for (const file of files) await fs.unlink(path.join(this.l2Path, file));
  }
}

module.exports = { MultiTierCache };
