/**
 * OpenClaw Tool Integration Layer
 * 
 * Wires Phase 2B modules to actual OpenClaw tool calls.
 * This is the production glue between our modules and the runtime.
 */

const { memory_search, memory_get, sessions_spawn, sessions_list, sessions_history, process } = require('./tool-adapters');
const { createOrchestrator, DEFAULT_CONFIG } = require('./index');

/**
 * Create production-ready orchestrator with OpenClaw tool integration
 * 
 * @param {Object} config - Configuration overrides
 * @returns {Object} Configured orchestrator with live tools
 */
function createProductionOrchestrator(config = {}) {
  // Merge with defaults
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    seeding: { ...DEFAULT_CONFIG.seeding, ...config.seeding },
    orchestration: { ...DEFAULT_CONFIG.orchestration, ...config.orchestration },
    browser: { ...DEFAULT_CONFIG.browser, ...config.browser }
  };

  // Create base orchestrator
  const orchestrator = createOrchestrator(mergedConfig);

  // Inject OpenClaw tool implementations
  return enhanceWithOpenClawTools(orchestrator, mergedConfig);
}

/**
 * Enhance orchestrator with actual OpenClaw tool calls
 */
function enhanceWithOpenClawTools(orchestrator, config) {
  return {
    ...orchestrator,

    /**
     * Spawn a subagent with context seeding from memory
     * 
     * @param {string} task - Task description
     * @param {string[]} keywords - Memory search keywords
     * @param {Object} options - Spawn options
     * @returns {Promise<Object>} Spawned subagent session
     */
    async seededSpawn(task, keywords, options = {}) {
      // Step 1: Search memory for relevant context
      const searchResults = await Promise.all(
        keywords.map(keyword => this.searchMemory(keyword, { maxResults: 10 }))
      );

      // Step 2: Prepare seeded context
      const seededOptions = await this.prepareSeededContext(task, searchResults.flat(), options);

      // Step 3: Spawn actual subagent
      return this.spawnSubagent(seededOptions);
    },

    /**
     * Search memory using OpenClaw memory_search tool
     */
    async searchMemory(query, options = {}) {
      try {
        const results = await memory_search({ 
          query, 
          maxResults: options.maxResults || 5 
        });
        return results.results || [];
      } catch (error) {
        console.warn(`[Orchestrator] Memory search failed for "${query}":`, error.message);
        return []; // Graceful degradation
      }
    },

    /**
     * Get specific memory content
     */
    async getMemory(path, options = {}) {
      try {
        return await memory_get({ path, ...options });
      } catch (error) {
        console.warn(`[Orchestrator] Memory get failed for "${path}":`, error.message);
        return null;
      }
    },

    /**
     * Spawn subagent using OpenClaw sessions_spawn
     */
    async spawnSubagent(options) {
      const { task, model, agentId, label, cleanup = 'keep', timeoutSeconds } = options;

      try {
        const session = await sessions_spawn({
          task,
          model: model || config.model || 'openrouter/moonshotai/kimi-k2.5',
          agentId: agentId || 'main',
          label: label || `subagent-${Date.now()}`,
          cleanup,
          timeoutSeconds: timeoutSeconds || config.orchestration.timeoutMs / 1000
        });

        return {
          ...session,
          status: 'spawned',
          spawnedAt: Date.now()
        };
      } catch (error) {
        console.error(`[Orchestrator] Failed to spawn subagent:`, error.message);
        throw error;
      }
    },

    /**
     * Run tasks in parallel with actual subagent spawning
     */
    async parallel(tasks, options = {}) {
      const { maxConcurrency = config.orchestration.maxConcurrency, retries = config.orchestration.retries } = options;

      const semaphore = new Array(maxConcurrency).fill(Promise.resolve());
      const results = new Map();
      const errors = new Map();

      const executeTask = async (taskSpec, index) => {
        const execute = async (attempt = 0) => {
          try {
            const subagent = await this.seededSpawn(
              taskSpec.task,
              taskSpec.keywords || [taskSpec.task.substring(0, 50)],
              {
                model: taskSpec.model,
                label: taskSpec.id || `task-${index}`,
                timeoutSeconds: taskSpec.timeoutSeconds
              }
            );

            // Wait for completion and fetch results
            const result = await this.waitForSubagent(subagent.sessionKey, {
              timeoutMs: options.timeoutMs || config.orchestration.timeoutMs,
              pollIntervalMs: options.pollIntervalMs || 1000
            });

            results.set(taskSpec.id || index, {
              id: taskSpec.id || index,
              status: 'success',
              result,
              attempts: attempt + 1
            });

          } catch (error) {
            if (attempt < retries) {
              await delay(Math.pow(2, attempt) * 1000); // Exponential backoff
              return execute(attempt + 1);
            }

            errors.set(taskSpec.id || index, {
              id: taskSpec.id || index,
              status: 'failed',
              error: error.message,
              attempts: attempt + 1
            });

            if (!options.continueOnError) {
              throw error;
            }
          }
        };

        return execute();
      };

      // Execute with concurrency limit
      const taskPromises = tasks.map(async (taskSpec, index) => {
        const slot = await Promise.race(semaphore.map((p, i) => p.then(() => i)));
        semaphore[slot] = executeTask(taskSpec, index).then(() => slot);
        return semaphore[slot];
      });

      await Promise.all(taskPromises);

      return {
        results: Array.from(results.values()),
        errors: Array.from(errors.values()),
        summary: {
          total: tasks.length,
          succeeded: results.size,
          failed: errors.size,
          successRate: results.size / tasks.length
        }
      };
    },

    /**
     * Wait for subagent completion
     */
    async waitForSubagent(sessionKey, options = {}) {
      const { timeoutMs = 300000, pollIntervalMs = 1000 } = options;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        try {
          // Check session status via history
          const history = await sessions_history({ sessionKey, limit: 1 });
          
          // If we can fetch history, session exists
          // Look for completion indicators in recent messages
          const lastMessage = history[history.length - 1];
          
          if (lastMessage && this.isComplete(lastMessage)) {
            return {
              sessionKey,
              completed: true,
              lastMessage,
              duration: Date.now() - startTime
            };
          }

        } catch (error) {
          // Session may have ended or not started yet
          if (error.message.includes('not found')) {
            return {
              sessionKey,
              completed: true,
              status: 'session_ended',
              duration: Date.now() - startTime
            };
          }
        }

        await delay(pollIntervalMs);
      }

      throw new Error(`Subagent ${sessionKey} timed out after ${timeoutMs}ms`);
    },

    /**
     * Check if message indicates completion
     */
    isComplete(message) {
      // Check for completion indicators
      const completionPatterns = [
        /completed successfully/i,
        /task complete/i,
        /finished/i,
        /report generated/i,
        /summary:/i
      ];

      const text = JSON.stringify(message).toLowerCase();
      return completionPatterns.some(pattern => pattern.test(text));
    },

    /**
     * Pipeline execution with actual subagents
     */
    async pipe(stages, initialInput, options = {}) {
      const { stopOnError = true } = options;
      const intermediateResults = [];
      let currentInput = initialInput;

      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];

        try {
          // Build task with current input
          const taskWithInput = typeof stage.task === 'function'
            ? stage.task(currentInput, i, intermediateResults)
            : `${stage.task}\n\nInput: ${JSON.stringify(currentInput, null, 2)}`;

          // Spawn subagent for this stage
          const subagent = await this.seededSpawn(
            taskWithInput,
            stage.keywords || [stage.name],
            { model: stage.model, label: stage.name }
          );

          // Wait for result
          const result = await this.waitForSubagent(subagent.sessionKey, options);

          // Apply transform if provided
          const transformedOutput = stage.transform
            ? stage.transform(result, currentInput)
            : result;

          intermediateResults.push({
            stage: stage.name || `stage-${i}`,
            input: currentInput,
            output: transformedOutput,
            status: 'success'
          });

          currentInput = transformedOutput;

        } catch (error) {
          intermediateResults.push({
            stage: stage.name || `stage-${i}`,
            input: currentInput,
            error: error.message,
            status: 'failed'
          });

          if (stopOnError) {
            throw {
              message: `Pipeline failed at stage: ${stage.name || i}`,
              stage: i,
              error,
              intermediateResults
            };
          }
        }
      }

      return {
        output: currentInput,
        stages: intermediateResults,
        completed: intermediateResults.filter(r => r.status === 'success').length,
        total: stages.length
      };
    },

    /**
     * Get orchestrator status with live metrics
     */
    async getStatus() {
      const baseStatus = orchestrator.status();
      
      // Add OpenClaw-specific metrics
      try {
        const sessions = await sessions_list({ limit: 50 });
        baseStatus.openclaw = {
          activeSessions: sessions.filter(s => s.active).length,
          totalSessions: sessions.length,
          recentSessions: sessions.slice(0, 10).map(s => ({
            key: s.sessionKey,
            lastActivity: s.lastActivityAt
          }))
        };
      } catch (error) {
        baseStatus.openclaw = { error: error.message };
      }

      return baseStatus;
    },

    /**
     * Cleanup and dispose
     */
    async dispose() {
      // Close browser manager
      await orchestrator.dispose();
      
      // Additional cleanup if needed
      console.log('[Orchestrator] Production orchestrator disposed');
    }
  };
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Prepare seeded context from search results
 */
async function prepareSeededContext(task, searchResults, options) {
  const { compressContext, buildSeededPrompt, extractKeywords } = require('./context-seeding');
  
  // Extract or use provided keywords
  const keywords = options.keywords || extractKeywords(task);

  // Rank and deduplicate (simplified - in production use full ranking)
  const uniqueResults = [...new Map(searchResults.map(r => [r.id, r])).values()];
  
  // Compress to fit budget
  const { chunks } = compressContext(uniqueResults.slice(0, 10), {
    tokenBudget: options.tokenBudget || 8000,
    compressionLevel: options.compressionLevel || 'light',
    includeMetadata: true
  });

  // Build seeded task
  const seededTask = buildSeededPrompt(task, chunks, keywords);

  return {
    ...options,
    task: seededTask,
    originalTask: task,
    metadata: {
      seeded: true,
      keywords,
      chunksInjected: chunks.length,
      sources: [...new Set(chunks.map(c => c.originalSource))]
    }
  };
}

module.exports = {
  createProductionOrchestrator,
  enhanceWithOpenClawTools
};
