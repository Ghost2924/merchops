/**
 * Thin bootstrap: runs any TS script in scripts/ with jiti,
 * wiring the @/ path alias to the project root.
 *
 * Usage:
 *   node scripts/run-ts.cjs scripts/reprocess-history.ts [args...]
 */
const path   = require('path');
const jiti   = require('jiti');
const ROOT   = path.resolve(__dirname, '..');
const [, , script, ...rest] = process.argv;

if (!script) {
  console.error('Usage: node scripts/run-ts.cjs <script.ts> [args...]');
  process.exit(1);
}

// Splice args back so the target script sees them in process.argv
process.argv = [process.argv[0], path.resolve(script), ...rest];

const j = jiti(path.resolve(script), {
  interopDefault: true,
  alias: { '@': ROOT },
});

j(path.resolve(script));
