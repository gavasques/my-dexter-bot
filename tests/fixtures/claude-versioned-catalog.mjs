// Capability-only fixture: any request beyond version/help is rejected.
const mode = process.env.DEXTER_FIXTURE_MODE ?? 'current';
const versions = { current: '2.1.295', beforeHaiku: '2.1.292', older: '2.1.218', unknown: 'unrecognized' };
if (process.argv[2] === '--version') {
  console.log(`${versions[mode] ?? versions.current} (Claude Code)`);
} else if (process.argv[2] === '--help') {
  console.log('Usage: claude [options]');
  if (mode !== 'noModel') console.log("  --model <model> Model for this session (e.g. 'opus', 'sonnet', 'fable')");
  if (mode !== 'noEffort') console.log(`  --effort <level> Effort level (${mode === 'limitedEffort' ? 'low, high' : 'low, medium, high, xhigh, max'})`);
} else {
  process.exitCode = 84;
}
