import { fileURLToPath } from 'url';

const COLORS = {
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m'
};

/**
 * Helper to execute a test case with logging.
 * @param {string} name - The name of the test case.
 * @param {Function} fn - The async test function.
 */
export async function runTest(name, fn) {
  process.stdout.write(`  • ${name}... `);
  try {
    await fn();
    console.log(`${COLORS.GREEN}[PASS]${COLORS.RESET}`);
    return true;
  } catch (err) {
    console.log(`${COLORS.RED}[FAIL]${COLORS.RESET}`);
    console.error(err.stack || err);
    return false;
  }
}

/**
 * Main runner that executes all defined test suites.
 */
export async function runAll() {
  console.log(`${COLORS.CYAN}=== EloTracker Test Runner ===${COLORS.RESET}\n`);

  const suites = [
    { name: 'EloCalculator', file: './test-elo-calculator.js' },
    { name: 'EloSessionManager', file: './test-elo-session-manager.js' },
    { name: 'EloDatabase', file: './test-elo-database.js' },
    { name: 'EloTracker', file: './test-elo-tracker.js' }
  ];

  for (const suite of suites) {
    console.log(`${COLORS.YELLOW}Running Suite: ${suite.name}${COLORS.RESET}`);
    try {
      // Dynamic import allows the runner to work even if files are missing during dev
      const module = await import(suite.file);
      
      // Expecting default export to be a function accepting runTest
      if (module.default && typeof module.default === 'function') {
        await module.default(runTest);
      } else {
        console.log(`${COLORS.RED}  Skipped: No default export function found in ${suite.file}${COLORS.RESET}`);
      }
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        console.log(`${COLORS.RED}  Skipped: File not found (${suite.file})${COLORS.RESET}`);
      } else {
        console.error(`${COLORS.RED}  Error loading suite:${COLORS.RESET}`, err);
      }
    }
    console.log('');
  }

  console.log(`${COLORS.CYAN}=== All Tests Completed ===${COLORS.RESET}`);
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll();
}