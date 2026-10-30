#!/usr/bin/env python3
"""Platform-only image update: isolated rehearsal, cold backup, verified switch and image rollback.
Never starts/restarts/mounts tool containers; never restores wallet snapshots over newer writes.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request
import ssl

ROOT=Path('/opt/sci_image')
PROJECT=ROOT/'platform'
PROD=ROOT/'platform-prod'
STATE=ROOT/'release-runtime/platform-console'
PUBLIC='https://biohub.zhangwuji.work:49998'
TABLES=('users','buckets','ledger','reservations','quotes','codes','batches','settings','migration_records')


def run(args,**kwargs):
    return subprocess.check_output([str(value) for value in args],text=True,**kwargs)


def save(file,value):
    file.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n');file.chmod(0o600)


def metadata(name):
    data=json.loads(run(['docker','inspect',name]))[0]
    return {'id':data['Id'],'image':data['Config']['Image'],'started_at':data['State']['StartedAt']}


def settings(file):
    return dict(line.split('=',1) for line in file.read_text().splitlines() if line and not line.startswith('#') and '=' in line)


def fingerprint(directory):
    result={}
    with sqlite3.connect('file:'+str(directory/'platform.sqlite')+'?mode=ro',uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('SQLite integrity check failed')
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in TABLES:
            if table not in tables:continue
            rows=db.execute('SELECT * FROM '+table+' ORDER BY rowid').fetchall()
            result[table]={'count':len(rows),'sha256':hashlib.sha256(json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
    return result


def health(base,path='/api/v1/health',rehearsal=False):
    deadline=time.monotonic()+100
    context=ssl._create_unverified_context() if rehearsal and base.startswith('https://localhost:') else None
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(base+path,timeout=3,context=context) as response:
                if response.status==200:return
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError('Service did not become healthy: '+base)


def source_digest(source):
    return hashlib.sha256(''.join(str(file.relative_to(source))+':'+hashlib.sha256(file.read_bytes()).hexdigest()+'\n' for file in sorted(source.rglob('*')) if file.is_file()).encode()).hexdigest()


def prepare():
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    STATE.mkdir(mode=0o700,parents=True,exist_ok=True);attempt=STATE/stamp;attempt.mkdir(mode=0o700)
    source=attempt/'source';source.mkdir()
    files=run(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=PROJECT).split('\0')
    for name in files:
        if not name:continue
        file=PROJECT/name
        if not file.is_file() or file.is_symlink():raise RuntimeError('Unexpected source path')
        if '..' in Path(name).parts or Path(name).name.startswith('.env') and name!='.env.example':raise RuntimeError('Unexpected sensitive source file')
        target=source/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
    manifest={'stamp':stamp,'image':'biohub-platform:console-'+stamp.lower(),'source_sha256':source_digest(source),'contract':json.loads((source/'src/generated/contracts.lock.json').read_text()),'base_commit':run(['git','rev-parse','HEAD'],cwd=PROJECT).strip()}
    save(attempt/'manifest.json',manifest)
    with (attempt/'build.log').open('w') as log:
        subprocess.run(['docker','build','-t',manifest['image'],str(source)],stdout=log,stderr=subprocess.STDOUT,check=True)
    manifest['image_id']=run(['docker','image','inspect',manifest['image'],'--format','{{.Id}}']).strip();save(attempt/'manifest.json',manifest)
    print(json.dumps({'attempt':str(attempt),'image':manifest['image'],'image_id':manifest['image_id']},ensure_ascii=False),flush=True)


def validate(attempt):
    attempt=attempt.resolve()
    if attempt.parent!=STATE.resolve():raise RuntimeError('Unexpected release directory')
    manifest=json.loads((attempt/'manifest.json').read_text())
    if manifest['source_sha256']!=source_digest(attempt/'source'):raise RuntimeError('Prepared source has changed')
    if manifest['image_id']!=run(['docker','image','inspect',manifest['image'],'--format','{{.Id}}']).strip():raise RuntimeError('Prepared image has changed')
    return manifest


def smoke(attempt,root,base,rehearsal=False):
    # Verify the frozen operator check, then use the host's installed browser dependencies.
    relative=Path('scripts/platform-update-smoke.ts')
    if (PROJECT/relative).read_bytes()!=(attempt/'source'/relative).read_bytes():raise RuntimeError('Operator smoke differs from the prepared release')
    command=['node','--import','tsx',PROJECT/'scripts/platform-update-smoke.ts','--root',root,'--url',base]
    if rehearsal:command+=['--rehearsal']
    value=run(command,cwd=PROJECT)
    result=json.loads(value.strip().splitlines()[-1]);save(attempt/('rehearsal-browser.json' if rehearsal else 'production-browser.json'),result)
    print('Browser checks passed: '+result['mode'],flush=True)


def rehearse(attempt):
    manifest=validate(attempt);sandbox=attempt/'rehearsal';sandbox.mkdir(mode=0o700);data=sandbox/'data';data.mkdir(mode=0o700);os.chown(data,1000,1000)
    suffix=manifest['stamp'].lower();network='platform-console-'+suffix;app='platform-console-app-'+suffix;proxy='platform-console-proxy-'+suffix
    run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',sandbox/'key.pem','-out',sandbox/'cert.pem','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],stderr=subprocess.DEVNULL)
    (sandbox/'nginx.conf').write_text('events {}\nhttp { resolver 127.0.0.11; server { listen 443 ssl; ssl_certificate /cert.pem; ssl_certificate_key /key.pem; location / { set $target http://'+app+':3000; proxy_pass $target; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; } } }\n')
    run(['docker','network','create',network])
    try:
        run(['docker','run','-d','--pull','never','--name',proxy,'--network',network,'-p','127.0.0.1::443','-v',str(sandbox/'nginx.conf')+':/etc/nginx/nginx.conf:ro','-v',str(sandbox/'cert.pem')+':/cert.pem:ro','-v',str(sandbox/'key.pem')+':/key.pem:ro','nginx:stable-alpine'])
        port=json.loads(run(['docker','inspect',proxy]))[0]['NetworkSettings']['Ports']['443/tcp'][0]['HostPort'];base='https://localhost:'+port
        env={'APP_URL':base,'YINGLAN_URL':'https://yinglan.invalid','SANGER_ENABLED':'true','SANGER_URL':'https://sanger.invalid','DATA_DIR':'/app/data','SESSION_SECRET':secrets.token_hex(32),'ENCRYPTION_KEY':secrets.token_hex(32),'YINGLAN_CLIENT_SECRET':secrets.token_hex(32),'YINGLAN_WORKER_SECRET':secrets.token_hex(32),'SANGER_CLIENT_SECRET':secrets.token_hex(32),'SANGER_WORKER_SECRET':secrets.token_hex(32),'PLATFORM_SERVICE_SECRET':secrets.token_hex(32),'REGISTRATION_ENABLED':'false'}
        envfile=sandbox/'rehearsal.env';envfile.write_text(''.join(key+'='+value+'\n' for key,value in env.items()));envfile.chmod(0o600)
        def start(image):
            run(['docker','run','-d','--pull','never','--name',app,'--network',network,'--init','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',envfile,'-v',str(data)+':/app/data',image]);health(base,rehearsal=True)
        start(manifest['image']);smoke(attempt,sandbox,base,True);before=fingerprint(data)
        run(['docker','rm','-f',app]);old=metadata('biohub-prod-web-1')['image'];start(old)
        if before!=fingerprint(data):raise RuntimeError('Rollback rehearsal changed business data')
        save(attempt/'rehearsal.json',{'image_id':manifest['image_id'],'candidate_smoke':True,'rollback_image':old,'rollback_startup':True,'synthetic_data_only':True,'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        print('Isolated production image and rollback startup rehearsal passed',flush=True)
    finally:
        for name in (app,proxy):subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


def compose(*args):
    env={**os.environ,'BIOHUB_ENV_FILE':str(PROD/'.env'),'BIOHUB_DATA_DIR':str(PROD/'data')}
    return run(['docker','compose','--project-directory',PROD/'source','--env-file',PROD/'release.env','-f',PROD/'source/docker-compose.yml',*args],env=env)


def execute(attempt):
    manifest=validate(attempt);rehearsal=json.loads((attempt/'rehearsal.json').read_text())
    if rehearsal['image_id']!=manifest['image_id'] or not rehearsal['rollback_startup']:raise RuntimeError('Rehearsal is required for the exact image')
    locks=[]
    for file in (ROOT/'yinglan-prod/.operation.lock',ROOT/'sanger-prod/.operation.lock',PROD/'.operation.lock'):
        lock=file.open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(lock)
    marker=PROD/'data/.maintenance';stopped=False;switched=False;source_switched=False;owned_marker=False
    old_source=PROD/('source-before-console-'+manifest['stamp']);candidate=PROD/('source-console-candidate-'+manifest['stamp'])
    old_release=(PROD/'release.env').read_text();old_env_digest=hashlib.sha256((PROD/'.env').read_bytes()).hexdigest();old_image=settings(PROD/'release.env')['BIOHUB_IMAGE'];tools={name:metadata(name) for name in ('yinglan-prod-web-1','sanger-prod-web-1')}
    try:
        health(PUBLIC)
        if marker.exists() or (PROD/'data/.migration-probe').exists():raise RuntimeError('Another platform maintenance operation exists')
        if metadata('biohub-prod-web-1')['image']!=old_image:raise RuntimeError('Running image and release environment disagree')
        shutil.copytree(attempt/'source',candidate);shutil.copy2(PROD/'release.env',attempt/'before-release.env')
        marker.write_text('Platform console update');owned_marker=True
        print('Platform maintenance enabled; waiting for wallet holds to drain',flush=True)
        deadline=time.monotonic()+240
        while True:
            with sqlite3.connect('file:'+str(PROD/'data/platform.sqlite')+'?mode=ro',uri=True) as db:count=db.execute("SELECT COUNT(*) FROM reservations WHERE state='reserved'").fetchone()[0]
            if count==0:break
            if time.monotonic()>deadline:raise RuntimeError('Wallet holds did not drain; update aborted')
            time.sleep(2)
        compose('stop','web');stopped=True
        before=fingerprint(PROD/'data');save(attempt/'before-data-fingerprint.json',before)
        archive=attempt/'platform-before.tgz'
        with tarfile.open(archive,'w:gz') as bundle:
            for name in ('data','.env','release.env'):bundle.add(PROD/name,name,filter=lambda info:None if Path(info.name).name in ('.maintenance','.migration-probe') else info)
        archive.chmod(0o600);checksum=hashlib.sha256(archive.read_bytes()).hexdigest();(attempt/'platform-before.tgz.sha256').write_text(checksum+'  platform-before.tgz\n')
        restore=attempt/'backup-verification';restore.mkdir(mode=0o700)
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                if member.name.startswith('data/') and member.isfile():
                    target=restore/member.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(bundle.extractfile(member).read())
        if fingerprint(restore/'data')!=before:raise RuntimeError('Cold backup restore/fingerprint verification failed')
        shutil.rmtree(restore);print('Cold backup and isolated SQLite restore verification passed',flush=True)
        (PROD/'source').rename(old_source);candidate.rename(PROD/'source');source_switched=True
        if 'BIOHUB_IMAGE='+old_image not in old_release:raise RuntimeError('Unexpected release image format')
        (PROD/'release.env').write_text(old_release.replace('BIOHUB_IMAGE='+old_image,'BIOHUB_IMAGE='+manifest['image']));(PROD/'release.env').chmod(0o600)
        compose('up','-d','--no-build','--pull','never','--no-deps','web');stopped=False;switched=True;health(PUBLIC)
        smoke(attempt,PROD,PUBLIC)
        if fingerprint(PROD/'data')!=before:raise RuntimeError('Account/permission/wallet data changed during release')
        if hashlib.sha256((PROD/'.env').read_bytes()).hexdigest()!=old_env_digest:raise RuntimeError('Production credentials changed')
        for name,original in tools.items():
            if metadata(name)!=original:raise RuntimeError('An unrelated tool container changed during release')
        if metadata('biohub-prod-web-1')['image']!=manifest['image']:raise RuntimeError('Unexpected production image after switch')
        marker.unlink();owned_marker=False;health(PUBLIC)
        with urllib.request.urlopen(PUBLIC,timeout=15) as response:
            if response.status!=200:raise RuntimeError('Public homepage did not reopen')
        report={'released_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':manifest['image'],'image_id':manifest['image_id'],'previous_image':old_image,'source_sha256':manifest['source_sha256'],'contract':manifest['contract'],'backup':str(archive),'backup_sha256':checksum,'previous_source':str(old_source),'business_data_preserved':True,'credentials_preserved':True,'tool_containers_unchanged':True,'public_https_smoke':True}
        save(attempt/'released.json',report);save(PROD/'console-release.json',report);print(json.dumps(report,ensure_ascii=False),flush=True)
    except BaseException:
        if switched:compose('stop','web');stopped=True
        (PROD/'release.env').write_text(old_release);(PROD/'release.env').chmod(0o600)
        if source_switched:
            (PROD/'source').rename(PROD/('source-failed-console-'+manifest['stamp']));old_source.rename(PROD/'source')
        if stopped:compose('up','-d','--no-build','--pull','never','--no-deps','web');health(PUBLIC)
        if owned_marker:marker.unlink(missing_ok=True);owned_marker=False
        print('Update failed: previous platform image/source restored; live wallet data retained',flush=True)
        raise
    finally:
        for lock in locks:lock.close()


if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','rehearse','execute']);parser.add_argument('attempt',nargs='?');args=parser.parse_args()
    if args.action=='prepare':prepare()
    else:
        if not args.attempt:parser.error('attempt directory is required')
        attempt=Path(args.attempt)
        if args.action=='rehearse':rehearse(attempt)
        else:execute(attempt)
