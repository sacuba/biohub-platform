import fs from 'node:fs';
import {db} from '../src/db';
import {encrypt} from '../src/config';
import {migrateYinglan} from '../src/migrate-yinglan';
try{const file=process.argv[2];if(!file)throw new Error('Provide protected Yinglan export file');console.log(JSON.stringify(migrateYinglan(db,JSON.parse(fs.readFileSync(file,'utf8')),encrypt)));}finally{db.close();}
