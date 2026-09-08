import {readFile} from 'node:fs/promises';
const registry=JSON.parse(await readFile(new URL('../docs/team/work-packages.json',import.meta.url),'utf8'));
console.table(registry.packages.map(({id,priority,status,title})=>({id,priority,status,title})));
console.log(registry.note);
