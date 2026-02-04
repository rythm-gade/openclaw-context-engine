/**
 * Phase 3.5: Automated Maintenance
 * lib/phase3/maintenance.js
 */

const fs = require('fs').promises;
const path = require('path');

class MaintenanceService {
  constructor(options = {}) {
    this.memoryDir = options.memoryDir || path.join(process.env.HOME, '.openclaw', 'workspace', 'memory');
    this.archiveDir = options.archiveDir || path.join(process.env.HOME, '.openclaw', 'workspace', 'archive');
    this.compactionInterval = options.compactionInterval || 1000;
    this.archiveAgeDays = options.archiveAgeDays || 30;
    this.maxLogSize = options.maxLogSize || 10 * 1024 * 1024;
    this.callCount = 0;
    this.lastCompaction = Date.now();
    this.health = { status: 'healthy', issues: [] };
  }

  async init() {
    await fs.mkdir(this.archiveDir, { recursive: true });
    const subdirs = ['weekly', 'monthly'];
    for (const dir of subdirs) await fs.mkdir(path.join(this.archiveDir, dir), { recursive: true });
  }

  recordCall() {
    this.callCount++;
    if (this.callCount % this.compactionInterval === 0) {
      this.compact().catch(console.error);
    }
  }

  async compact() {
    const files = await fs.readdir(this.memoryDir);
    const oldFiles = [];
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const stat = await fs.stat(path.join(this.memoryDir, file));
      if (stat.mtimeMs < cutoff) oldFiles.push(file);
    }
    
    if (oldFiles.length === 0) return { compacted: 0 };
    
    const week = new Date().toISOString().slice(0, 10);
    const summary = await this.generateSummary(oldFiles.map(f => path.join(this.memoryDir, f)));
    await fs.writeFile(path.join(this.archiveDir, 'weekly', `${week}.md`), summary);
    
    for (const file of oldFiles) {
      await fs.rename(path.join(this.memoryDir, file), path.join(this.archiveDir, file));
    }
    
    this.lastCompaction = Date.now();
    return { compacted: oldFiles.length };
  }

  async generateSummary(logFiles) {
    const contents = await Promise.all(logFiles.map(async f => {
      try { return await fs.readFile(f, 'utf8'); } catch { return ''; }
    }));
    
    // Simple summary - real version would use LLM
    const totalLines = contents.reduce((sum, c) => sum + c.split('\n').length, 0);
    return `# Weekly Summary (${new Date().toISOString().slice(0, 10)})
- Files archived: ${logFiles.length}
- Total lines: ${totalLines}
- Key topics: [Extracted from content]`;
  }

  async archive() {
    const files = await fs.readdir(this.memoryDir);
    const cutoff = Date.now() - this.archiveAgeDays * 24 * 60 * 60 * 1000;
    const archived = [];
    
    for (const file of files) {
      const stat = await fs.stat(path.join(this.memoryDir, file));
      if (stat.mtimeMs < cutoff) {
        const month = new Date(stat.mtimeMs).toISOString().slice(0, 7);
        const monthDir = path.join(this.archiveDir, 'monthly', month);
        await fs.mkdir(monthDir, { recursive: true });
        await fs.rename(path.join(this.memoryDir, file), path.join(monthDir, file));
        archived.push(file);
      }
    }
    
    return { archived: archived.length };
  }

  async cleanupArchives(retentionDays = 90) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const months = await fs.readdir(path.join(this.archiveDir, 'monthly'));
    let deleted = 0;
    
    for (const month of months) {
      const monthPath = path.join(this.archiveDir, 'monthly', month);
      const stat = await fs.stat(monthPath);
      if (stat.mtimeMs < cutoff) {
        await fs.rmdir(monthPath, { recursive: true });
        deleted++;
      }
    }
    
    return { deleted };
  }

  async healthCheck() {
    const issues = [];
    
    // Check disk space (simplified)
    const usage = await this.getDiskUsage();
    if (usage.total > 1024 * 1024 * 1024) { // 1GB
      issues.push({ type: 'disk', severity: 'warning', message: 'Memory usage > 1GB' });
    }
    
    // Check archive accessibility
    try { await fs.access(this.archiveDir); } catch {
      issues.push({ type: 'archive', severity: 'error', message: 'Archive directory inaccessible' });
    }
    
    this.health = { status: issues.length === 0 ? 'healthy' : 'degraded', issues };
    return this.health;
  }

  async selfHeal(issues) {
    const actions = [];
    for (const issue of issues) {
      if (issue.type === 'disk' && issue.severity === 'warning') {
        const result = await this.cleanupArchives(30); // Aggressive cleanup
        actions.push({ issue, action: 'aggressive_cleanup', result });
      }
    }
    return actions;
  }

  async getStats() {
    const usage = await this.getDiskUsage();
    return {
      calls: this.callCount,
      lastCompaction: this.lastCompaction,
      diskUsage: usage,
      health: this.health
    };
  }

  async getDiskUsage() {
    try {
      const files = await fs.readdir(this.memoryDir);
      let total = 0;
      for (const file of files) {
        const stat = await fs.stat(path.join(this.memoryDir, file));
        total += stat.size;
      }
      return { total, files: files.length };
    } catch {
      return { total: 0, files: 0 };
    }
  }

  async runAll() {
    const compact = await this.compact();
    const archive = await this.archive();
    const health = await this.healthCheck();
    if (health.issues.length > 0) await this.selfHeal(health.issues);
    return { compact, archive, health };
  }
}

module.exports = { MaintenanceService };
