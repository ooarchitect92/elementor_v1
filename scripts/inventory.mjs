import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const normalize = (value) => value.replaceAll('\\', '/');
const files = [];

async function walk(dir) {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relativePath = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'generated', 'dist', '.git'].includes(entry.name)) {
      await walk(relativePath);
    } else if (entry.isFile() && /\.(tsx?|prisma)$/.test(relativePath)) {
      files.push(normalize(relativePath));
    }
  }
}

for (const dir of ['backend/src', 'frontend/src', 'backend/prisma']) {
  await walk(dir);
}

const read = async (file) => readFile(path.join(root, file), 'utf8');
const routeCandidates = [];
const frontendCalls = [];

for (const file of files) {
  const text = await read(file);
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/(?:router|app)\.(get|post|put|patch|delete|use)\s*\(/.test(line)) {
      routeCandidates.push({ file, line: index + 1, kind: 'route_candidate', text: line.trim() });
    }
    if (file.startsWith('frontend/src/') && /(fetch\s*\(|axios\.|\bapi\.(get|post|put|patch|delete)\s*\()/i.test(line)) {
      frontendCalls.push({ file, line: index + 1, text: line.trim() });
    }
  }
}

const appPath = 'backend/src/app.ts';
const appText = await read(appPath);
const importedRouteNames = new Set();
for (const match of appText.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']\.\/routes\/index\.js["']/g)) {
  for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) {
    importedRouteNames.add(name);
  }
}

const mounts = [];
for (const match of appText.matchAll(/app\.use\(\s*["']([^"']+)["']\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
  mounts.push({ prefix: match[1], router: match[2] });
}
const mountedRouteNames = new Set(mounts.map((mount) => mount.router));
const importedButUnmounted = [...importedRouteNames]
  .filter((name) => name.endsWith('Routes') && !mountedRouteNames.has(name))
  .sort();

const routeDirectory = path.join(root, 'backend/src/routes');
const routeFiles = (await readdir(routeDirectory))
  .filter((name) => name.endsWith('.routes.ts'))
  .map((name) => `backend/src/routes/${name}`)
  .sort();

const prismaText = await read('backend/prisma/schema.prisma');
const prismaModels = [...prismaText.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((match) => match[1]);

const highRiskUnmounted = importedButUnmounted.filter((name) => ['integrationRoutes', 'formRoutes'].includes(name));

const inventory = {
  generatedAt: new Date().toISOString(),
  scope: 'Static F01 certification inventory. This identifies wiring candidates and gaps; it is not proof of runtime authorization, persistence, or delivery.',
  sourceFilesInspected: files.length,
  backend: {
    routeFiles,
    routeCandidates,
    appMounts: mounts,
    importedRouteNames: [...importedRouteNames].sort(),
    importedButUnmounted,
    highRiskUnmounted,
  },
  frontend: {
    apiCallCandidates: frontendCalls,
  },
  database: {
    prismaModels,
  },
};

await mkdir(path.join(root, '.foundation'), { recursive: true });
await writeFile(path.join(root, '.foundation/inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);

const report = `# F01 static application inventory\n\nGenerated: ${inventory.generatedAt}\n\nThis report is generated from source and is intentionally conservative. A route being present does **not** prove authentication, tenant isolation, persistence, or a real third-party delivery.\n\n## Summary\n\n- Source files inspected: ${files.length}\n- Backend route files: ${routeFiles.length}\n- Route/mount candidates: ${routeCandidates.length}\n- App router mounts: ${mounts.length}\n- Frontend API call candidates: ${frontendCalls.length}\n- Prisma models: ${prismaModels.length}\n- Imported but unmounted routers: ${importedButUnmounted.length ? importedButUnmounted.join(', ') : 'none'}\n\n## Safety gate\n\n${highRiskUnmounted.length ? `The following unmounted routers require explicit security review before they are made reachable: **${highRiskUnmounted.join(', ')}**. Payment, CRM, webhook, form submission and arbitrary outbound-request handlers must not be enabled merely to make an endpoint return HTTP 200.` : 'No known high-risk imported-but-unmounted router was detected by this static check.'}\n\n## Next certification steps\n\n1. Reproduce clean backend/frontend installs and builds.\n2. Trace each user-visible workflow from UI to API mount, route, handler, authorization and Prisma operation.\n3. Classify every integration as real, simulated, disconnected or incomplete.\n4. Run representative save/reload, authentication, template, form and publishing tests against a disposable database.\n5. Only then promote legacy CI from informational to required.\n`;
await writeFile(path.join(root, '.foundation/F01-INVENTORY.md'), report);

console.log(`${files.length} source files inspected; ${routeCandidates.length} route candidates; ${frontendCalls.length} frontend API call candidates.`);
if (importedButUnmounted.length) {
  console.log(`Imported but unmounted routers: ${importedButUnmounted.join(', ')}`);
}
console.log('See .foundation/inventory.json and .foundation/F01-INVENTORY.md.');
