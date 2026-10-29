import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

test('Sanger release grants only normal tool access, preserves other roles and can revert its own changes',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sanger-permissions-'));
 const root=path.join(tmp,'platform-prod');fs.mkdirSync(path.join(root,'data'),{recursive:true});
 const db=new Database(path.join(root,'data/platform.sqlite'));
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,active INTEGER,verified INTEGER,role TEXT,tool_roles TEXT);CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT,target TEXT,detail TEXT,created_at TEXT)");
 const insert=db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)');
 insert.run('owner','owner@release.test',1,1,'admin',JSON.stringify({yinglan:'admin'}));
 insert.run('normal','normal@release.test',1,1,'user',JSON.stringify({yinglan:'user'}));
 insert.run('disabled','disabled@release.test',0,1,'user',JSON.stringify({yinglan:'user'}));
 const journal=path.join(tmp,'permissions.json');
 function run(command:string){return spawnSync(process.execPath,['--import','tsx','scripts/sanger-release.ts',command,journal,'owner@release.test'],{cwd:process.cwd(),env:{...process.env,BIOHUB_RELEASE_ROOT:root},encoding:'utf8'});}
 try{
  const grant=run('grant');assert.equal(grant.status,0,grant.stderr);
  const roles=(id:string)=>JSON.parse((db.prepare('SELECT tool_roles FROM users WHERE id=?').get(id) as any).tool_roles);
  assert.deepEqual(roles('owner'),{yinglan:'admin',sanger:'user'});
  assert.deepEqual(roles('normal'),{yinglan:'user',sanger:'user'});
  assert.deepEqual(roles('disabled'),{yinglan:'user'});
  assert.equal((db.prepare('SELECT COUNT(*) n FROM audit').get() as any).n,2);
  const rollback=run('rollback-grants');assert.equal(rollback.status,0,rollback.stderr);
  assert.deepEqual(roles('owner'),{yinglan:'admin'});assert.deepEqual(roles('normal'),{yinglan:'user'});
 }finally{db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
