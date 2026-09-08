import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=[];
async function walk(dir){for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory() && !['node_modules','generated','dist','.git'].includes(entry.name)) await walk(p);else if(entry.isFile()&&/\.(tsx?|prisma)$/.test(p)) files.push(p);}}
await walk('backend/src');await walk('frontend/src');await walk('backend/prisma');
const inventory=[];
for(const file of files){const text=await readFile(path.join(root,file),'utf8');const lines=text.split(/\r?\n/);for(let n=0;n<lines.length;n++){if(/(?:router|app)\.(get|post|put|patch|delete|use)\s*\(/.test(lines[n])) inventory.push({file:file.replaceAll('\\','/'),line:n+1,kind:'route_candidate',text:lines[n].trim()});}}
await mkdir(path.join(root,'.foundation'),{recursive:true});
await writeFile(path.join(root,'.foundation/inventory.json'),JSON.stringify({scope:'Heuristic inventory, not a complete call graph or security audit',files:files.length,routes:inventory},null,2));
console.log(`${files.length} source files inspected; ${inventory.length} route candidates. See .foundation/inventory.json.`);
