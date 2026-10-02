import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Read metadata only: never execute an old launcher (its Node/PATH may fail).
export function piagentInstallations({home=os.homedir(), searchPath=process.env.PATH??'', systemRoots=['/opt/homebrew','/usr/local']}={}) {
  const bins=new Set([...searchPath.split(path.delimiter).filter(Boolean),path.join(home,'.local/bin'),path.join(home,'.pi/npm-global/bin'),...systemRoots.map(root=>path.join(root,'bin'))]);
  const found=new Map();
  for(const bin of bins) {
    try {
      const launcher=fs.realpathSync(path.join(bin,'piagent'));
      let root=path.dirname(launcher);
      for(let depth=0;depth<5;depth++,root=path.dirname(root)) {
        const manifest=path.join(root,'package.json');
        if(!fs.existsSync(manifest))continue;
        const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
        if(pkg.name!=='@piagent/platform')continue;
        const managed=path.join(root,'scripts/piagent-studio.mjs');
        const info=found.get(root)??{root,version:String(pkg.version),managed:fs.existsSync(managed),fingerprint:createHash('sha256').update(fs.readFileSync(fs.existsSync(managed)?managed:launcher)).digest('hex').slice(0,12),launchers:[]};
        info.launchers.push(path.join(bin,'piagent'));found.set(root,info);break;
      }
    } catch { /* Missing/broken installation is not executed. */ }
  }
  return [...found.values()];
}
