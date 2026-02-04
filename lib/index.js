/**
 * Phase 2B: Subagent Intelligence Enhancements
 * Master API Module
 * 
 * Exports: Context seeding, parallel orchestration, browser session management
 */

const { prepareSeededSpawn, extractKeywords, DEFAULT_CONFIG: SEEDING_CONFIG } = require('./context-seeding');
const { parallelMap, pipeline, analyzeDependencies } = require('./parallel-orchestration');
const { BrowserSessionManager, createBrowserSessionManager } = require('./browser-session-manager');

// Master configuration
const DEFAULT_CONFIG = {
  seeding: SEEDING_CONFIG,
  orchestration: {
    maxConcurrency: 4,
    timeoutMs: 300000,
    retries: 1
  },
  browser: {
    idleTimeoutMs: 300000,
    maxTabs: 10,
    reuseSameDomain: true
  }
};

/**
 * Master orchestration API
 * Provides unified interface for Phase 2B capabilities
 */
class SubagentOrchestrator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.browserManager = createBrowserSessionManager(this.config.browser);
  }

  /**
   * Spawn a subagent with context seeding from memory
   */
  async seededSpawn(task, keywords, options = {}) {
    // Import memory_search dynamically to avoid circular deps
    const memorySearch = options.memorySearchFn || global.memorySearch;
    
    if (!memorySearch) {
      throw new Error('memorySearch function required. Pass memorySearchFn option or ensure global.memorySearch is set.');
    }

    const seededOptions = await prepareSeededSpawn(
      { task, keywords, ...options },
      memorySearch
    );

    return {
      ...seededOptions,
      spawnCommand: `sessions_spawn({ task: "${seededOptions.task.substring(0, 50)}...", ... })`
    };
  }

  /**
   * Run multiple tasks in parallel
   */
  async parallel(tasks, options = {}) {
    return parallelMap(tasks, {
      ...this.config.orchestration,
      ...options
    });
  }

  /**
   * Run tasks in a pipeline
   */
  async pipe(stages, initialInput, options = {}) {
    return pipeline(stages, initialInput, options);
  }

  /**
   * Get or create browser tab
   */
  async tab(purpose, url, options = {}) {
    return this.browserManager.getOrCreateTab(purpose, url, options);
  }

  /**
   * Analyze tool calls for parallelization
   */
  analyze(calls) {
    return analyzeDependencies(calls);
  }

  /**
   * Get status of all systems
   */
  status() {
    return {
      browser: this.browserManager.getStats(),
      config: this.config
    };
  }

  /**
   * Cleanup and dispose
   */
  async dispose() {
    await this.browserManager.dispose();
  }
}

/**
 * Create orchestrator instance
 */
function createOrchestrator(config) {
  return new SubagentOrchestrator(config);
}

// Production integration
const { createProductionOrchestrator } = require('./production-integration');
const { loadOpenClawConfig, validateConfig } = require('./config-loader');

/**
 * Create orchestrator with automatic config loading
 */
function createOrchestratorWithConfig(configPath) {
  const config = loadOpenClawConfig(configPath);
  const validation = validateConfig(config);
  
  if (!validation.valid) {
    console.warn('[Orchestrator] Config validation warnings:', validation.errors);
  }
  
  return createProductionOrchestrator(config);
}

// Export individual modules and unified API
module.exports = {
  // Individual modules
  contextSeeding: {
    prepareSeededSpawn,
    extractKeywords
  },
  parallelOrchestration: {
    parallelMap,
    pipeline,
    analyzeDependencies
  },
  browserSession: {
    BrowserSessionManager,
    createBrowserSessionManager
  },
  
  // Configuration
  config: {
    loadOpenClawConfig,
    validateConfig,
    getDefaultConfig: () => require('./config-loader').getDefaultConfig()
  },
  
  // Unified API
  SubagentOrchestrator,
  createOrchestrator,
  createProductionOrchestrator,
  createOrchestratorWithConfig,
  DEFAULT_CONFIG
};
