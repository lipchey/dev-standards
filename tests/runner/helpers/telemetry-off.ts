/* Default the effectiveness-telemetry sink OFF for direct (non-npm) test execution.
 *
 * The package-level `off` default lives only in the npm `test*` scripts
 * (package.json). A bare `node --test` / `tsx --test` / IDE run does NOT set it, so
 * any in-process runTier/doctor call — or a spawned bundled runner — would append to
 * the operator's REAL home-dir events.jsonl. Import this FIRST (side-effect import) in
 * every test whose import graph reaches the telemetry emitter.
 *
 * `??=` assigns only when unset, so it preserves an npm-provided `off`, a telemetry
 * test's explicit override, and any custom sink a developer set on purpose. */
process.env.DS_TELEMETRY_PATH ??= 'off';
