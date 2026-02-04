/**
 * Phase 3.1: Context Diffing & Persistence
 * lib/phase3/context-manager.js
 * 
 * IMPLEMENTATION NOTES:
 * - Uses content hashing (SHA256) to detect changes
 * - Stores context state in SQLite for cross-session persistence
 * - Generates human-readable diffs for subagent context updates
 */

const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const diffLib = require('diff');

class ContextManager {
  constructor(options = {}) {
    this.dbPath = options.dbPath || path.join(process.env.HOME, '.openclaw', 'persistence.db');
    this.diffStrategy = options.diffStrategy || 'unified'; // 'unified' | 'patch' | 'summary'
    this.maxContextSize = options.maxContextSize || 32000; // tokens
    this.pruneThreshold = options.pruneThreshold || 0.3; // importance score cutoff
    this.db = null;
  }

  /**
   * Initialize SQLite database and tables
   * REQUIRED: Call before any other methods
   */
  async init() {
    // Ensure directory exists
    const dbDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Open database connection
    this.db = new sqlite3.Database(this.dbPath);

    // Create tables
    await new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS context_state (
          session_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          context_json TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `, (err) => err ? reject(err) : resolve());
    });

    await new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS context_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          delta TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          new_hash TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `, (err) => err ? reject(err) : resolve());
    });

    await new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS importance_scores (
          memory_id TEXT PRIMARY KEY,
          score REAL NOT NULL,
          last_accessed INTEGER NOT NULL,
          access_count INTEGER DEFAULT 1
        )
      `, (err) => err ? reject(err) : resolve());
    });

    // Create indexes
    await new Promise((resolve, reject) => {
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_history_session ON context_history(session_id)`,
        (err) => err ? reject(err) : resolve());
    });
  }

  computeHash(context) {
    const content = JSON.stringify(context);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  calculateImportance(contextItems, currentGoal) {
    const now = Date.now();
    const goalText = currentGoal ? JSON.stringify(currentGoal).toLowerCase() : '';
    
    return contextItems.map(item => {
      const accessCount = item.accessCount || 1;
      const frequency = Math.log(accessCount + 1);
      
      const lastAccessed = item.lastAccessed || now;
      const ageMs = now - lastAccessed;
      const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
      const recencyScore = Math.max(0, 1 - (ageMs / maxAgeMs));
      
      let semanticDistance = 1.0;
      if (currentGoal && item.content) {
        const itemText = typeof item.content === 'string' 
          ? item.content.toLowerCase() 
          : JSON.stringify(item.content).toLowerCase();
        const goalWords = new Set(goalText.split(/\s+/).filter(w => w.length > 3));
        const itemWords = new Set(itemText.split(/\s+/).filter(w => w.length > 3));
        if (goalWords.size > 0) {
          const overlap = [...goalWords].filter(w => itemWords.has(w)).length;
          semanticDistance = 1 - (overlap / Math.max(goalWords.size, itemWords.size));
        }
      }
      semanticDistance = Math.max(0.1, semanticDistance);
      
      return {
        ...item,
        importance: (frequency * recencyScore) / semanticDistance,
        frequency,
        recencyScore,
        semanticDistance
      };
    }).sort((a, b) => b.importance - a.importance);
  }

  estimateTokenCount(items) {
    return Math.ceil(JSON.stringify(items).length / 4);
  }

  smartPrune(contextItems, targetSize) {
    if (!contextItems?.length) return [];

    const scored = this.calculateImportance(contextItems, null);
    let pruned = scored.filter(item => item.importance >= this.pruneThreshold);
    
    while (this.estimateTokenCount(pruned) > targetSize && pruned.length > 1) {
      pruned.pop();
    }
    
    const prunedKeys = new Set(pruned.map(item => item.id || JSON.stringify(item)));
    return contextItems.filter(item => prunedKeys.has(item.id || JSON.stringify(item)));
  }

  generateDiff(oldContext, newContext) {
    switch (this.diffStrategy) {
      case 'patch': return this.generatePatchDiff(oldContext, newContext);
      case 'summary': return this.generateSummaryDiff(oldContext, newContext);
      default: return this.generateUnifiedDiff(oldContext, newContext);
    }
  }

  generateUnifiedDiff(oldContext, newContext) {
    const diff = diffLib.createTwoFilesPatch(
      'context-old', 'context-new',
      JSON.stringify(oldContext, null, 2),
      JSON.stringify(newContext, null, 2),
      '', '', { context: 3 }
    );
    return { type: 'unified', patch: diff, oldHash: this.computeHash(oldContext), newHash: this.computeHash(newContext) };
  }

  generatePatchDiff(oldContext, newContext) {
    const changes = { additions: [], removals: [], modifications: [] };
    const oldKeys = Object.keys(oldContext || {});
    const newKeys = Object.keys(newContext || {});
    
    for (const key of newKeys) {
      if (!(key in (oldContext || {}))) {
        changes.additions.push({ key, value: newContext[key] });
      } else if (JSON.stringify(oldContext[key]) !== JSON.stringify(newContext[key])) {
        changes.modifications.push({ key, oldValue: oldContext[key], newValue: newContext[key] });
      }
    }
    
    for (const key of oldKeys) {
      if (!(key in (newContext || {}))) changes.removals.push({ key, value: oldContext[key] });
    }
    
    return { type: 'patch', changes, oldHash: this.computeHash(oldContext), newHash: this.computeHash(newContext) };
  }

  generateSummaryDiff(oldContext, newContext) {
    const patch = this.generatePatchDiff(oldContext, newContext);
    const summary = [];
    if (patch.changes.additions.length) summary.push(`Added ${patch.changes.additions.length} item(s)`);
    if (patch.changes.removals.length) summary.push(`Removed ${patch.changes.removals.length} item(s)`);
    if (patch.changes.modifications.length) summary.push(`Modified ${patch.changes.modifications.length} item(s)`);
    
    return { 
      type: 'summary', 
      summary: summary.join(', ') || 'No changes',
      stats: { added: patch.changes.additions.length, removed: patch.changes.removals.length, modified: patch.changes.modifications.length },
      oldHash: patch.oldHash, newHash: patch.newHash 
    };
  }

  applyDiff(context, diff) {
    if (!diff) throw new Error('No diff provided');
    let result = { ...(context || {}) };
    
    if (diff.type === 'patch') {
      for (const r of diff.changes?.removals || []) delete result[r.key];
      for (const a of diff.changes?.additions || []) result[a.key] = a.value;
      for (const m of diff.changes?.modifications || []) result[m.key] = m.newValue;
    } else {
      throw new Error(`Cannot apply ${diff.type} diff`);
    }
    return result;
  }

  async persistContext(sessionId, context) {
    if (!this.db) throw new Error('Database not initialized');
    
    const hash = this.computeHash(context);
    const existing = await this.loadContext(sessionId);
    
    if (existing && this.computeHash(existing) === hash) {
      return { changed: false, hash };
    }
    
    if (existing) {
      const diff = this.generateDiff(existing, context);
      await new Promise((resolve, reject) => {
        this.db.run(
          `INSERT INTO context_history (session_id, delta, previous_hash, new_hash, timestamp) VALUES (?, ?, ?, ?, ?)`,
          [sessionId, JSON.stringify(diff), this.computeHash(existing), hash, Date.now()],
          (err) => err ? reject(err) : resolve()
        );
      });
    }
    
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO context_state (session_id, content_hash, context_json, timestamp) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET content_hash=excluded.content_hash, context_json=excluded.context_json, timestamp=excluded.timestamp`,
        [sessionId, hash, JSON.stringify(context), Date.now()],
        (err) => err ? reject(err) : resolve({ changed: true, hash })
      );
    });
  }

  async loadContext(sessionId) {
    if (!this.db) throw new Error('Database not initialized');
    
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT context_json FROM context_state WHERE session_id = ?`, [sessionId], (err, row) => {
        if (err) reject(err);
        else resolve(row ? JSON.parse(row.context_json) : null);
      });
    });
  }

  async prepareContext(newContext, sessionId) {
    const existing = await this.loadContext(sessionId);
    if (!existing) return { type: 'full', context: newContext };
    
    const diff = this.generateDiff(existing, newContext);
    const diffSize = JSON.stringify(diff).length;
    const fullSize = JSON.stringify(newContext).length;
    
    return diffSize < fullSize * 0.7 ? { type: 'diff', diff } : { type: 'full', context: newContext };
  }

  async close() {
    if (this.db) {
      await new Promise((resolve) => this.db.close(resolve));
      this.db = null;
    }
  }
}

module.exports = { ContextManager };
