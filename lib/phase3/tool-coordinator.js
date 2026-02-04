/**
 * Phase 3.4: Tool Coordination
 * lib/phase3/tool-coordinator.js
 */

const { CircuitBreaker } = require('../circuit-breaker');

class ToolCoordinator {
  constructor(options = {}) {
    this.batchWindow = options.batchWindow || 100;
    this.maxBatchSize = options.maxBatchSize || 10;
    this.opportunisticBatching = options.opportunisticBatching !== false;
    this.queues = new Map();
    this.timers = new Map();
    this.breakers = new Map();
    this.streams = new Map();
    this.stats = { batched: 0, individual: 0, streamCount: 0 };
  }

  initCircuitBreakers(toolNames) {
    for (const name of toolNames) {
      this.breakers.set(name, new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000 }));
    }
  }

  async queue(toolName, args) {
    const breaker = this.breakers.get(toolName);
    if (breaker?.isOpen()) throw new Error(`Circuit breaker OPEN for ${toolName}`);
    
    return new Promise((resolve, reject) => {
      if (!this.queues.has(toolName)) this.queues.set(toolName, []);
      this.queues.get(toolName).push({ resolve, reject, args, time: Date.now() });
      
      if (this.opportunisticBatching && this.isAgentIdle()) {
        this.flushBatch(toolName);
      } else {
        if (this.timers.has(toolName)) clearTimeout(this.timers.get(toolName));
        this.timers.set(toolName, setTimeout(() => this.flushBatch(toolName), this.batchWindow));
      }
    });
  }

  async flushBatch(toolName) {
    const queue = this.queues.get(toolName) || [];
    if (queue.length === 0) return;
    
    this.queues.set(toolName, []);
    this.timers.delete(toolName);
    
    const groups = this.groupCompatibleCalls(queue);
    const results = await Promise.allSettled(groups.map(g => this.executeBatch(toolName, g)));
    
    // Route results back
    let idx = 0;
    for (const group of groups) {
      const result = results[idx++];
      for (const call of group) {
        if (result.status === 'fulfilled') call.resolve(result.value);
        else call.reject(result.reason);
      }
    }
    
    this.stats.batched += queue.length;
  }

  async executeImmediate(toolName, args) {
    const breaker = this.breakers.get(toolName);
    if (breaker?.isOpen()) throw new Error(`Circuit breaker OPEN for ${toolName}`);
    
    // Execute tool directly
    this.stats.individual++;
    return args; // Placeholder - real implementation would call actual tool
  }

  startStream(operationId, generator) {
    this.streams.set(operationId, { generator, handlers: [], active: true });
    this.consumeStream(operationId);
    return { operationId };
  }

  async consumeStream(operationId) {
    const stream = this.streams.get(operationId);
    if (!stream) return;
    
    for await (const chunk of stream.generator) {
      if (!stream.active) break;
      for (const handler of stream.handlers) {
        try { handler.onData?.(chunk); } catch {}
      }
    }
    
    for (const handler of stream.handlers) {
      try { handler.onComplete?.(); } catch {}
    }
  }

  subscribeToStream(operationId, handlers) {
    const stream = this.streams.get(operationId);
    if (stream) stream.handlers.push(handlers);
  }

  isAgentIdle() {
    // Simplified - real implementation would check agent state
    return this.queues.size === 0;
  }

  groupCompatibleCalls(calls) {
    // Group by similar args structure
    const groups = [];
    let current = [];
    for (const call of calls) {
      if (current.length >= this.maxBatchSize) {
        groups.push(current);
        current = [];
      }
      current.push(call);
    }
    if (current.length) groups.push(current);
    return groups;
  }

  async executeBatch(toolName, calls) {
    // Parallel execution
    const results = await Promise.allSettled(calls.map(c => c.args));
    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  }

  getStats() { return this.stats; }
  
  async flushAll() {
    for (const [toolName] of this.queues) await this.flushBatch(toolName);
  }
  
  resetCircuitBreakers() {
    for (const breaker of this.breakers.values()) {
      breaker.state = 'CLOSED';
      breaker.failureCount = 0;
    }
  }
}

class ReadBatcher {
  static async batch(paths) {
    const fs = require('fs').promises;
    const results = await Promise.allSettled(paths.map(p => fs.readFile(p, 'utf8')));
    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  }
}

class WebFetchBatcher {
  static async batch(urls, concurrency = 3) {
    const results = [];
    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(batch.map(u => fetch(u).then(r => r.text())));
      results.push(...batchResults);
    }
    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  }
}

module.exports = { ToolCoordinator, ReadBatcher, WebFetchBatcher };
