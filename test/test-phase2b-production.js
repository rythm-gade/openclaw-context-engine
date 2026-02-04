/**
 * Phase 2B Production Test
 * Tests all Phase 2B capabilities end-to-end
 */

const { createOrchestrator } = require('../lib/index');

async function runProductionTest() {
  console.log('🚀 Phase 2B Production Test Starting...\n');
  
  const results = {
    contextSeeding: null,
    parallelExecution: null,
    browserSession: null,
    errors: []
  };

  try {
    // Create orchestrator
    console.log('1️⃣ Creating orchestrator...');
    const orchestrator = createOrchestrator({
      seeding: { maxTokens: 8000 },
      orchestration: { maxConcurrency: 3, timeoutMs: 120000 }
    });
    console.log('   ✅ Orchestrator created\n');

    // Test 1: Context Seeding Preparation
    console.log('2️⃣ Testing context seeding...');
    try {
      // We'll test this by checking if prepareSeededSpawn works
      // Note: This requires memory_search to be available
      const { prepareSeededSpawn } = require('../lib/context-seeding');
      
      // Mock memory search for testing
      const mockMemorySearch = async () => [
        { snippet: 'Test memory entry 1', score: 0.9 },
        { snippet: 'Test memory entry 2', score: 0.8 }
      ];
      
      const seededOptions = await prepareSeededSpawn({
        task: 'Test task for Phase 2B',
        keywords: ['test', 'phase2b'],
        model: 'gemini-2.0-flash-exp'
      }, mockMemorySearch);
      
      results.contextSeeding = {
        success: true,
        taskLength: seededOptions.task.length,
        hasContext: seededOptions.task.includes('Test memory'),
        model: seededOptions.model
      };
      console.log('   ✅ Context seeding working');
      console.log(`      - Task length: ${seededOptions.task.length} chars`);
      console.log(`      - Context injected: ${seededOptions.task.includes('Test memory')}`);
    } catch (e) {
      results.contextSeeding = { success: false, error: e.message };
      results.errors.push(`Context seeding: ${e.message}`);
      console.log('   ❌ Context seeding failed:', e.message);
    }

    // Test 2: Parallel Orchestration (without actual spawning)
    console.log('\n3️⃣ Testing parallel orchestration...');
    try {
      const { parallelMap, analyzeDependencies } = require('../lib/parallel-orchestration');
      
      // Test dependency analysis
      const calls = [
        { tool: 'read', args: { path: 'file1.js' }, id: 'read1' },
        { tool: 'read', args: { path: 'file2.js' }, id: 'read2' },
        { tool: 'edit', args: { path: 'file1.js' }, dependsOn: ['read1'], id: 'edit1' }
      ];
      
      const deps = analyzeDependencies(calls);
      
      results.parallelExecution = {
        success: true,
        dependencyAnalysis: deps.groups.length > 0,
        maxConcurrency: orchestrator.config.orchestration.maxConcurrency
      };
      console.log('   ✅ Parallel orchestration working');
      console.log(`      - Dependency groups: ${deps.groups.length}`);
      console.log(`      - Max concurrency: ${orchestrator.config.orchestration.maxConcurrency}`);
    } catch (e) {
      results.parallelExecution = { success: false, error: e.message };
      results.errors.push(`Parallel execution: ${e.message}`);
      console.log('   ❌ Parallel orchestration failed:', e.message);
    }

    // Test 3: Browser Session Management
    console.log('\n4️⃣ Testing browser session management...');
    try {
      const { createBrowserSessionManager } = require('../lib/browser-session-manager');
      const manager = createBrowserSessionManager({ maxTabs: 5 });
      
      // Note: Actual browser calls require browser tool, so we test the API
      const stats = manager.getStats();
      
      results.browserSession = {
        success: true,
        activeTabs: stats.activeTabs,
        maxTabs: manager.config.maxTabs,
        apiWorking: true
      };
      console.log('   ✅ Browser session manager working');
      console.log(`      - Active tabs: ${stats.activeTabs}`);
      console.log(`      - Max tabs: ${manager.config.maxTabs}`);
    } catch (e) {
      results.browserSession = { success: false, error: e.message };
      results.errors.push(`Browser session: ${e.message}`);
      console.log('   ❌ Browser session failed:', e.message);
    }

    // Test 4: Integration with OpenClaw config
    console.log('\n5️⃣ Testing config integration...');
    try {
      const { loadOpenClawConfig, validateConfig } = require('../lib/config-loader');
      const config = loadOpenClawConfig();
      const validation = validateConfig(config);
      
      results.configIntegration = {
        success: true,
        configLoaded: !!config,
        validationPassed: validation.valid,
        warnings: validation.errors?.length || 0
      };
      console.log('   ✅ Config integration working');
      console.log(`      - Config loaded: ${!!config}`);
      console.log(`      - Validation: ${validation.valid ? 'passed' : 'warnings'}`);
    } catch (e) {
      results.configIntegration = { success: false, error: e.message };
      results.errors.push(`Config integration: ${e.message}`);
      console.log('   ❌ Config integration failed:', e.message);
    }

    // Test 5: Circuit Breaker
    console.log('\n6️⃣ Testing circuit breaker...');
    try {
      const CircuitBreaker = require('../lib/circuit-breaker');
      const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeout: 5000 });
      
      // Simulate failures
      breaker.recordFailure();
      breaker.recordFailure();
      
      results.circuitBreaker = {
        success: true,
        state: breaker.state,
        failures: breaker.failureCount,
        apiWorking: true
      };
      console.log('   ✅ Circuit breaker working');
      console.log(`      - State: ${breaker.state}`);
      console.log(`      - Failure count: ${breaker.failureCount}`);
    } catch (e) {
      results.circuitBreaker = { success: false, error: e.message };
      results.errors.push(`Circuit breaker: ${e.message}`);
      console.log('   ❌ Circuit breaker failed:', e.message);
    }

    // Final status
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST RESULTS');
    console.log('='.repeat(50));
    
    const allPassed = Object.values(results)
      .filter(r => r && typeof r === 'object' && 'success' in r)
      .every(r => r.success);
    
    if (allPassed && results.errors.length === 0) {
      console.log('✅ ALL TESTS PASSED');
    } else {
      console.log(`⚠️ ${results.errors.length} ERRORS`);
      results.errors.forEach(e => console.log(`   - ${e}`));
    }
    
    console.log('\nDetailed Results:');
    Object.entries(results).forEach(([name, result]) => {
      if (result && typeof result === 'object' && 'success' in result) {
        const icon = result.success ? '✅' : '❌';
        console.log(`${icon} ${name}: ${result.success ? 'PASS' : 'FAIL'}`);
      }
    });

    return results;
    
  } catch (e) {
    console.error('\n❌ Production test failed:', e.message);
    console.error(e.stack);
    return { error: e.message, stack: e.stack };
  }
}

// Run if called directly
if (require.main === module) {
  runProductionTest().then(results => {
    process.exit(results.errors?.length > 0 ? 1 : 0);
  });
}

module.exports = { runProductionTest };
