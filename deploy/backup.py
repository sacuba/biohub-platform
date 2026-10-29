#!/usr/bin/env python3
"""Joint cold backup for the platform wallet and tool files, with automatic service resumption."""
import datetime, fcntl, hashlib, json, pathlib, sqlite3, tarfile, time, subprocess, os
from cutover import ROOT, OLD, NEW, compose, health

def pending():
    with sqlite3.connect('file:'+str(OLD/'data/yinglan.sqlite')+'?mode=ro',uri=True) as db:
        store=json.loads(db.execute('SELECT state FROM app_state WHERE id=1').fetchone()[0])
        return sum(j['status'] in ('queued','running') or bool(j.get('platformWallet') and j['platformWallet']['state'] not in ('settled','released')) for j in store['jobs'])

SANGER=ROOT/'sanger-prod'
def sanger_compose(*args):
    env={**os.environ,'SANGER_ENV_FILE':str(SANGER/'.env'),'SANGER_DATA_DIR':str(SANGER/'data')}
    return subprocess.check_output(['docker','compose','--project-directory',str(SANGER/'source'),'--env-file',str(SANGER/'release.env'),'-f',str(SANGER/'source/docker-compose.yml'),*args],env=env,text=True)

def sanger_pending():
    result=json.loads(sanger_compose('exec','-T','web','/app/runtime/python/bin/python','-m','app.server.ops','status'))
    return result['active_runs']+result['pending_wallet']

if __name__=='__main__':
    if not (NEW/'migration-completed.json').exists():raise SystemExit('Joint backup is enabled after migration completion only')
    with (OLD/'.operation.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        marked=[];stopped=[]
        roots=(NEW,OLD)
        has_sanger=(SANGER/'release-completed.json').exists()
        if has_sanger:
            sanger_lock=(SANGER/'.operation.lock').open('a')
            fcntl.flock(sanger_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            roots=(*roots,SANGER)
        try:
            for root in roots:
                marker=root/'data/.maintenance'
                if marker.exists():raise RuntimeError('Another maintenance operation is in progress')
            for root in roots:
                marker=root/'data/.maintenance';marker.write_text('Joint backup');marked.append(marker)
            deadline=time.monotonic()+720;time.sleep(3)
            while pending() or (has_sanger and sanger_pending()):
                if time.monotonic()>deadline:raise RuntimeError('Task/wallet drain timed out; backup aborted')
                time.sleep(3)
            if has_sanger:sanger_compose('stop','web');stopped.append('sanger')
            for app in ('yinglan','platform'):compose(app,'stop','web');stopped.append(app)
            directory=pathlib.Path('/opt/biohub-backups');directory.mkdir(mode=0o700,exist_ok=True)
            target=directory/('biohub-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.tgz')
            with tarfile.open(target,'w:gz') as tar:
                for app,root in [('platform',NEW),('yinglan',OLD)]+([('sanger',SANGER)] if has_sanger else []):
                    for name in ['data','.env','release.env']:
                        tar.add(root/name,app+'/'+name,filter=lambda info:None if pathlib.Path(info.name).name in ('.maintenance','.migration-probe') else info)
                tar.add(NEW/'migration-completed.json','migration-completed.json')
            target.chmod(0o600);target.with_suffix('.tgz.sha256').write_text(hashlib.sha256(target.read_bytes()).hexdigest()+'  '+target.name+'\n')
            print(target)
        finally:
            for app in reversed(stopped):
                if app=='sanger':sanger_compose('up','-d','--no-build','web')
                else:compose(app,'up','-d','--no-build','web');health(app)
            for marker in marked:marker.unlink(missing_ok=True)
