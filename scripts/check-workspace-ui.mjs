import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
rmSync(new URL('../.foundation/workspace-ui/', import.meta.url), { recursive: true, force: true });
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['node_modules/typescript/bin/tsc', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--lib', 'ES2022,DOM', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--outDir', '.foundation/workspace-ui',
  'frontend/src/features/workspaces/workspace-client.ts', 'frontend/src/features/workspaces/workspace-controller.ts']);
run(['--test', 'tests/frontend/workspace-client.test.mjs', 'tests/frontend/workspace-controller.test.mjs']);
