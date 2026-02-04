/**
 * Test runner for OpenClaw Context Engine
 */

const { runProductionTest } = require('./test-phase2b-production');
const { runMetricsAnalysis } = require('./test-phase-metrics');

async function runAllTests() {
  console.log('🧪 Running OpenClaw Context Engine Tests\n');
  
  try {
    console.log('1️⃣ Phase 2B Production Tests...');
    const phase2Results = await runProductionTest();
    
    console.log('\n2️⃣ Metrics Analysis...');
    const metricsResults = await runMetricsAnalysis();
    
    console.log('\n✅ All tests completed!');
    return { phase2: phase2Results, metrics: metricsResults };
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runAllTests();
}

module.exports = { runAllTests };
