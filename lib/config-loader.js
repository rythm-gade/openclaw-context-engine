/**
 * OpenClaw Configuration Loader
 * 
 * Loads orchestrator configuration from openclaw.json
 * with environment-specific overrides.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

/**
 * Load configuration from OpenClaw config file
 * 
 * @param {string} configPath - Path to config file (optional)
 * @returns {Object} Merged configuration
 */
function loadOpenClawConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) {
      console.warn(`[Config] Config not found at ${configPath}, using defaults`);
      return getDefaultConfig();
    }

    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // Extract relevant orchestrator settings from OpenClaw config
    const orchestratorConfig = extractOrchestratorConfig(config);
    
    // Apply environment overrides
    const envConfig = loadEnvironmentOverrides();

    return mergeConfigs(getDefaultConfig(), orchestratorConfig, envConfig);

  } catch (error) {
    console.error(`[Config] Failed to load:`, error.message);
    return getDefaultConfig();
  }
}

/**
 * Extract orchestrator-specific config from OpenClaw config
 */
function extractOrchestratorConfig(openclawConfig) {
  const defaults = openclawConfig.agents?.defaults || {};

  return {
    model: defaults.model?.primary,
    fallbacks: defaults.model?.fallbacks || [],
    workspace: defaults.workspace,
    bootstrapMaxChars: defaults.bootstrapMaxChars,
    
    // Memory search config
    memorySearch: defaults.memorySearch,
    
    // Subagent config
    maxConcurrent: defaults.maxConcurrent,
    subagents: defaults.subagents,
    
    // Tool config
    tools: openclawConfig.tools
  };
}

/**
 * Load environment variable overrides
 */
function loadEnvironmentOverrides() {
  const overrides = {};

  // ORCHESTRATOR_MAX_CONCURRENCY
  if (process.env.ORCHESTRATOR_MAX_CONCURRENCY) {
    overrides.maxConcurrent = parseInt(process.env.ORCHESTRATOR_MAX_CONCURRENCY, 10);
  }

  // ORCHESTRATOR_TIMEOUT_MS
  if (process.env.ORCHESTRATOR_TIMEOUT_MS) {
    overrides.orchestration = {
      timeoutMs: parseInt(process.env.ORCHESTRATOR_TIMEOUT_MS, 10)
    };
  }

  // ORCHESTRATOR_MODEL
  if (process.env.ORCHESTRATOR_MODEL) {
    overrides.model = process.env.ORCHESTRATOR_MODEL;
  }

  // ORCHESTRATOR_LOG_LEVEL
  if (process.env.ORCHESTRATOR_LOG_LEVEL) {
    overrides.logLevel = process.env.ORCHESTRATOR_LOG_LEVEL;
  }

  return overrides;
}

/**
 * Default configuration
 */
function getDefaultConfig() {
  return {
    model: 'openrouter/moonshotai/kimi-k2.5',
    fallbacks: ['openrouter/deepseek/deepseek-v3.2'],
    workspace: path.join(os.homedir(), '.openclaw', 'workspace'),
    
    seeding: {
      topK: 5,
      tokenBudget: 8000,
      compressionLevel: 'light',
      includeMetadata: true,
      modelBudgets: {
        'kimi-k2.5': 8000,
        'deepseek-v3': 6000,
        'gpt-4o': 4000,
        'claude-3.5': 6000,
        'default': 4000
      }
    },

    orchestration: {
      maxConcurrency: 4,
      timeoutMs: 300000,
      retries: 1,
      continueOnError: true
    },

    browser: {
      idleTimeoutMs: 300000,
      maxTabs: 10,
      reuseSameDomain: true,
      cleanupOnStart: true
    },

    logging: {
      level: 'info',
      structured: true,
      metrics: true
    }
  };
}

/**
 * Deep merge configurations
 */
function mergeConfigs(...configs) {
  const result = {};
  
  for (const config of configs) {
    for (const key in config) {
      if (config[key] && typeof config[key] === 'object' && !Array.isArray(config[key])) {
        result[key] = mergeConfigs(result[key] || {}, config[key]);
      } else {
        result[key] = config[key];
      }
    }
  }
  
  return result;
}

/**
 * Validate configuration
 */
function validateConfig(config) {
  const errors = [];

  if (!config.model) {
    errors.push('No primary model specified');
  }

  if (config.orchestration?.maxConcurrency < 1) {
    errors.push('maxConcurrency must be at least 1');
  }

  if (config.orchestration?.timeoutMs < 1000) {
    errors.push('timeoutMs must be at least 1000');
  }

  if (config.seeding?.tokenBudget < 1000) {
    errors.push('tokenBudget must be at least 1000');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  loadOpenClawConfig,
  getDefaultConfig,
  validateConfig,
  mergeConfigs
};
