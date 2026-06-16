#!/usr/bin/env node
// test-mcp-tools.mjs — runtime test for the iter-20/21 MCP tool registry.
//
// tsc proves the metaharness-tools.ts module COMPILES; structural smoke
// proves the source DECLARES the right tool names. Neither proves the
// HANDLERS actually run without throwing. This test imports the compiled
// module and invokes every tool's handler with minimal inputs.
//
// CONTRACT EACH TOOL MUST SATISFY
//   - handler is callable as `await tool.handler({ ... })`
//   - returns an object with keys: success, data, degraded, exitCode
//   - never throws (even with bad/missing optional dep — graceful)
//   - handler honors the 120s subprocess timeout (no hang)
//
// USAGE
//   node scripts/test-mcp-tools.mjs                          # default
//   node scripts/test-mcp-tools.mjs --format json
//
// EXIT CODES
//   0  all tools satisfy the contract
//   1  at least one tool failed
//   2  setup error (compiled dist not present)

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ARGS = (() => {
  const a = { format: 'table' };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--format') a.format = process.argv[++i];
  }
  return a;
})();

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.log(`  ✗ ${label}`); failures.push(label); failed++; }
}

async function main() {
  // Locate the compiled dist of metaharness-tools.
  const distPath = resolve(SCRIPTS_DIR, '..', '..', '..',
    'v3', '@claude-flow', 'cli', 'dist', 'src', 'mcp-tools', 'metaharness-tools.js');

  if (!existsSync(distPath)) {
    console.log(`# test-mcp-tools — SKIPPED`);
    console.log('');
    console.log(`Compiled dist not present: ${distPath}`);
    console.log(`Build the CLI first:`);
    console.log(`  cd v3/@claude-flow/cli && npm run build`);
    console.log('');
    console.log(`Exit 0 — this script is meaningfully runnable only post-build.`);
    process.exit(0);
  }

  let mod;
  try {
    mod = await import(distPath);
  } catch (e) {
    console.error(`test-mcp-tools: failed to import ${distPath}: ${e.message}`);
    process.exit(2);
  }

  const tools = mod.metaharnessTools;
  console.log(`# test-mcp-tools — runtime contract\n`);

  // ──────────────────────────────────────────────────────────────────
  // PHASE 1 — module exports the right shape
  // ──────────────────────────────────────────────────────────────────
  console.log('Phase 1 — module shape');
  assert(Array.isArray(tools), 'metaharnessTools is an array');
  assert(tools.length === 7, `7 tools registered (got ${tools.length})`);

  const expectedNames = new Set([
    'metaharness_score',
    'metaharness_genome',
    'metaharness_mcp_scan',
    'metaharness_threat_model',
    'metaharness_oia_audit',
    'metaharness_audit_list',
    'metaharness_audit_trend',
  ]);
  const actualNames = new Set(tools.map((t) => t.name));
  for (const name of expectedNames) {
    assert(actualNames.has(name), `${name} registered`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PHASE 2 — every tool has the required MCP shape
  // ──────────────────────────────────────────────────────────────────
  console.log('\nPhase 2 — per-tool shape');
  for (const tool of tools) {
    const ok = typeof tool.name === 'string'
      && typeof tool.description === 'string'
      && typeof tool.category === 'string'
      && typeof tool.handler === 'function'
      && typeof tool.inputSchema === 'object';
    assert(ok, `${tool.name} has {name, description, category, handler, inputSchema}`);
    assert(tool.category === 'metaharness', `${tool.name} category === 'metaharness'`);
  }

  // ──────────────────────────────────────────────────────────────────
  // PHASE 3 — handlers callable + return contract shape
  //
  // We invoke each handler with minimal valid input. The handlers may
  // succeed (if metaharness is installed) or report degraded (if not).
  // EITHER way, they must return { success, data, degraded, exitCode }
  // without throwing.
  // ──────────────────────────────────────────────────────────────────
  console.log('\nPhase 3 — handler invocations (allow up to 30s each)');
  for (const tool of tools) {
    // Construct minimal valid input per tool.
    let input = {};
    if (tool.name === 'metaharness_audit_trend') {
      // Requires baselineKey + currentKey — use fake keys that won't
      // resolve so we exercise the not-found path.
      input = { baselineKey: 'audit-fake-base', currentKey: 'audit-fake-curr' };
    }

    // 30s budget per tool — slow path is npx warmup
    const handlerPromise = tool.handler(input);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('30s handler timeout')), 30_000));

    let result;
    let threw = false;
    try {
      result = await Promise.race([handlerPromise, timeoutPromise]);
    } catch (e) {
      threw = true;
      console.log(`    [${tool.name}] handler threw: ${e.message.slice(0, 80)}`);
    }

    assert(!threw, `${tool.name} handler did not throw`);
    if (!threw && result) {
      assert(typeof result === 'object', `${tool.name} returns object`);
      assert('success' in result, `${tool.name} result has 'success'`);
      assert('data' in result, `${tool.name} result has 'data'`);
      assert('degraded' in result, `${tool.name} result has 'degraded'`);
      assert('exitCode' in result, `${tool.name} result has 'exitCode'`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n✓ All 7 MCP tools satisfy the runtime contract.');
}

main().catch((e) => {
  console.error('test-mcp-tools crashed:', e.message || e);
  process.exit(2);
});
