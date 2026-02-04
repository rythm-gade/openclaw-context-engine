/**
 * Parallel Orchestration Engine
 * Phase 2B Implementation
 * 
 * Provides fan-out/fan-in and pipeline patterns for subagent coordination
 */

const { spawn } = require('child_process');

/**
 * Run multiple subagents in parallel with result collection and failure handling
 * 
 * @param {Array} tasks - Array of task objects { id, task, model, options }
 * @param {Object} config - Configuration options
 * @param {number} config.maxConcurrency - Max parallel subagents (default: 4)
 * @param {number} config.timeoutMs - Timeout per subagent (default: 300000 = 5min)
 * @param {number} config.retries - Number of retries for failed tasks (default: 1)
 * @param {boolean} config.continueOnError - Whether to continue if one fails (default: true)
 * @returns {Promise<Object>} Results object with { results: [], errors: [], summary: {} }
 */
async function parallelMap(tasks, config = {}) {
  const {
    maxConcurrency = 4,
    timeoutMs = 300000,
    retries = 1,
    continueOnError = true
  } = config;

  const results = new Map();
  const errors = new Map();
  const semaphore = new Array(maxConcurrency).fill(Promise.resolve());

  // Process tasks with concurrency limit
  const taskPromises = tasks.map(async (taskSpec, index) => {
    // Wait for a slot
    const slot = await Promise.race(semaphore.map((p, i) => p.then(() => i)));
    
    // Execute with retry logic
    const execute = async (attempt = 0) => {
      try {
        const result = await runWithTimeout(
          spawnSubagent(taskSpec),
          timeoutMs
        );
        results.set(taskSpec.id || index, {
          id: taskSpec.id || index,
          status: 'success',
          result,
          attempts: attempt + 1
        });
      } catch (error) {
        if (attempt < retries) {
          // Retry with exponential backoff
          await delay(Math.pow(2, attempt) * 1000);
          return execute(attempt + 1);
        }
        
        errors.set(taskSpec.id || index, {
          id: taskSpec.id || index,
          status: 'failed',
          error: error.message,
          attempts: attempt + 1
        });
        
        if (!continueOnError) {
          throw error;
        }
      }
    };

    // Replace slot with this task's completion
    semaphore[slot] = execute().then(() => slot);
    
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
}

/**
 * Chain subagents in a pipeline where output feeds input
 * 
 * @param {Array} stages - Array of stage objects { name, task, model, transform }
 * @param {any} initialInput - Starting input for first stage
 * @param {Object} config - Configuration
 * @param {boolean} config.stopOnError - Stop pipeline on first failure (default: true)
 * @returns {Promise<Object>} Final output and intermediate results
 */
async function pipeline(stages, initialInput, config = {}) {
  const { stopOnError = true } = config;
  
  const intermediateResults = [];
  let currentInput = initialInput;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    
    try {
      // Build task with current input
      const taskWithInput = typeof stage.task === 'function'
        ? stage.task(currentInput, i, intermediateResults)
        : `${stage.task}\n\nInput: ${JSON.stringify(currentInput, null, 2)}`;

      // Run subagent
      const result = await spawnSubagent({
        task: taskWithInput,
        model: stage.model,
        ...stage.options
      });

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
}

/**
 * Analyze tool calls to identify parallelization opportunities
 * 
 * @param {Array} calls - Array of tool call objects { tool, args, id }
 * @returns {Object} Groups of parallelizable and sequential calls
 */
function analyzeDependencies(calls) {
  const groups = [];
  const currentGroup = [];
  const outputs = new Map(); // track which calls produce outputs

  for (const call of calls) {
    // Check if this call depends on any previous outputs
    const dependencies = findDependencies(call, outputs);
    
    if (dependencies.length === 0) {
      // No dependencies, can run in parallel with current group
      currentGroup.push(call);
    } else {
      // Has dependencies, start new group
      if (currentGroup.length > 0) {
        groups.push([...currentGroup]);
        currentGroup.length = 0;
      }
      
      // Find which group the dependencies are in
      const depGroupIndices = dependencies.map(dep => 
        groups.findIndex(g => g.some(c => c.id === dep))
      );
      
      // Add to group after all dependencies
      const maxDepGroup = Math.max(...depGroupIndices);
      if (!groups[maxDepGroup + 1]) {
        groups[maxDepGroup + 1] = [];
      }
      groups[maxDepGroup + 1].push(call);
    }

    // Track this call's outputs
    if (call.id) {
      outputs.set(call.id, call);
    }
  }

  // Add remaining calls
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return {
    groups,
    parallelGroups: groups.filter(g => g.length > 1).length,
    sequentialGroups: groups.filter(g => g.length === 1).length,
    totalGroups: groups.length,
    estimatedSavings: calculateSavings(groups)
  };
}

/**
 * Find dependencies for a tool call based on argument references
 */
function findDependencies(call, outputs) {
  const deps = [];
  const callStr = JSON.stringify(call.args);
  
  for (const [outputId, outputCall] of outputs) {
    // Check if call references outputId in its arguments
    if (callStr.includes(outputId) || 
        (call.args.dependsOn && call.args.dependsOn.includes(outputId))) {
      deps.push(outputId);
    }
  }
  
  return deps;
}

/**
 * Calculate estimated time savings from parallelization
 */
function calculateSavings(groups) {
  const parallelCount = groups.reduce((sum, g) => sum + (g.length > 1 ? g.length : 0), 0);
  const sequentialCount = groups.length;
  
  // Assume parallel calls take ~same time as one sequential
  // Sequential would take sum of all calls
  const sequentialTime = groups.reduce((sum, g) => sum + g.length, 0);
  const parallelTime = groups.length;
  
  return {
    sequentialCalls: sequentialTime,
    parallelGroups: sequentialCount,
    estimatedReduction: sequentialTime - parallelTime,
    percentImprovement: ((sequentialTime - parallelTime) / sequentialTime * 100).toFixed(1)
  };
}

/**
 * Run function with timeout
 */
function runWithTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

/**
 * Delay helper
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Spawn subagent (placeholder - integrates with OpenClaw sessions_spawn)
 */
async function spawnSubagent(spec) {
  // This would call OpenClaw's sessions_spawn tool
  // For now, returns spec for verification
  return {
    type: 'subagent_spawn_config',
    task: spec.task.substring(0, 100) + '...',
    model: spec.model || 'default',
    options: spec.options || {}
  };
}

/**
 * Usage Examples
 */

// Example 1: Parallel map
const exampleParallel = async () => {
  const tasks = [
    { id: 'research1', task: 'Research option A', model: 'kimi-k2.5' },
    { id: 'research2', task: 'Research option B', model: 'kimi-k2.5' },
    { id: 'research3', task: 'Research option C', model: 'kimi-k2.5' }
  ];
  
  const results = await parallelMap(tasks, {
    maxConcurrency: 3,
    retries: 1,
    continueOnError: true
  });
  
  return results;
};

// Example 2: Pipeline
const examplePipeline = async () => {
  const stages = [
    {
      name: 'extract',
      task: 'Extract key entities from the following data',
      transform: (result) => result.entities
    },
    {
      name: 'analyze',
      task: 'Analyze sentiment of each entity',
      transform: (result) => result.sentiments
    },
    {
      name: 'summarize',
      task: 'Create summary report from sentiments'
    }
  ];
  
  const result = await pipeline(stages, rawData);
  return result;
};

// Example 3: Dependency analysis
const exampleAnalysis = () => {
  const calls = [
    { id: 'fetch1', tool: 'web_fetch', args: { url: 'example.com' } },
    { id: 'fetch2', tool: 'web_fetch', args: { url: 'example.org' } },
    { id: 'analyze', tool: 'analyze', args: { dependsOn: ['fetch1', 'fetch2'] } }
  ];
  
  const plan = analyzeDependencies(calls);
  // Groups: [[fetch1, fetch2], [analyze]]
  // Parallelizable: fetch1 and fetch2 together
  return plan;
};

// Export API
module.exports = {
  parallelMap,
  pipeline,
  analyzeDependencies,
  runWithTimeout
};
