import {spawn,spawnSync} from 'node:child_process';
import {environment} from './runtime.mjs';
const env=environment('platform');
const seed=spawnSync(process.execPath,['--import','tsx','scripts/seed.ts'],{stdio:'inherit',env});if(seed.status!==0)process.exit(seed.status||1);
const child=spawn(process.execPath,['--import','tsx','server.ts'],{stdio:'inherit',env});for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill(sig));child.on('exit',code=>process.exit(code||0));
