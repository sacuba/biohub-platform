#!/usr/bin/env python3
"""Controlled Sanger integration release. TLS gate first; never restarts Yinglan."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.request

ROOT=Path('/opt/sci_image')
PLATFORM=ROOT/'platform-prod'
SANGER=ROOT/'sanger-prod'
STATE=ROOT/'release-runtime/sanger'
PLATFORM_URL='https://biohub.zhangwuji.work:49998'
TOOL_URL='https://sanger.zhangwuji.work'


def run(args,**kwargs):
    return subprocess.check_output([str(x) for x in args],text=True,**kwargs)


def compose(app,*args):
    root=PLATFORM if app=='platform' else SANGER
    env={**os.environ}
    if app=='platform':env.update(BIOHUB_ENV_FILE=str(root/'.env'),BIOHUB_DATA_DIR=str(root/'data'))
    else:env.update(SANGER_ENV_FILE=str(root/'.env'),SANGER_DATA_DIR=str(root/'data'))
    return run(['docker','compose','--project-directory',root/'source','--env-file',root/'release.env','-f',root/'source/docker-compose.yml',*args],env=env)


def check():
    for url,service in [(PLATFORM_URL+'/api/v1/health','biohub-platform'),(TOOL_URL+'/api/health','sanger')]:
        with urllib.request.urlopen(url,timeout=15) as response:
            data=json.load(response)
            if data.get('service')!=service:raise RuntimeError('HTTPS route points to unexpected service')
    if not (SANGER/'data/legacy-migration.json').exists():raise RuntimeError('Verified legacy migration is required')
    if not (SANGER/'data/.maintenance').exists():raise RuntimeError('Initial Sanger release must still be held')
    if (PLATFORM/'data/.maintenance').exists():raise RuntimeError('Platform already in maintenance')
    for name in ('platform.env.candidate','platform-identity.json'):
        if not (STATE/name).is_file():raise RuntimeError('Missing prepared release input '+name)
    for image in ('biohub-platform:sanger-20261029','abtrace-sanger:biohub-20261029-release'):
        run(['docker','image','inspect',image],stderr=subprocess.DEVNULL)
    print('TLS routes, migrated data, exact images and release inputs verified',flush=True)


def health(app):
    port,path=(3002,'/api/v1/health') if app=='platform' else (3003,'/api/ready')
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen(f'http://192.168.6.111:{port}{path}',timeout=3) as response:
                if response.status==200:return
        except Exception:pass
        time.sleep(.5)
    raise RuntimeError(app+' health timed out')


def execute():
    os.umask(0o077)
    locks=[]
    for file in (PLATFORM/'.operation.lock',SANGER/'.operation.lock',ROOT/'yinglan-prod/.operation.lock'):
        lock=file.open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(lock)
    check()
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    attempt=STATE/('cutover-'+stamp);attempt.mkdir(mode=0o700)
    target_email=json.loads((STATE/'platform-identity.json').read_text())['target']['email']
    previous_image=next(line.split('=',1)[1] for line in (PLATFORM/'release.env').read_text().splitlines() if line.startswith('BIOHUB_IMAGE='))
    for name in ('.env','release.env'):shutil.copy2(PLATFORM/name,attempt/('platform'+name))
    marker=PLATFORM/'data/.maintenance';marker.write_text('Sanger integration release')
    stopped=False;switched=False;source_switched=False
    old_source=PLATFORM/('source-before-sanger-'+stamp)
    try:
        deadline=time.monotonic()+240
        while True:
            code="const D=require('better-sqlite3');const d=new D('/app/data/platform.sqlite',{readonly:true});console.log(d.prepare(\"SELECT COUNT(*) n FROM reservations WHERE state='reserved'\").get().n);d.close();"
            count=int(compose('platform','exec','-T','web','node','-e',code))
            if count==0:break
            if time.monotonic()>deadline:raise RuntimeError('Existing wallet holds did not drain; release aborted')
            time.sleep(2)
        compose('platform','stop','web');stopped=True
        archive=attempt/'platform-before.tgz'
        with tarfile.open(archive,'w:gz') as bundle:
            for name in ('data','.env','release.env'):bundle.add(PLATFORM/name,name)
        archive.with_suffix('.tgz.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
        # Permissions are applied by the owning platform's operator tool, never the Sanger code.
        fingerprint=attempt/'platform-before-fingerprint.json'
        run(['node','--import','tsx',ROOT/'platform/scripts/sanger-release.ts','fingerprint',fingerprint,target_email],cwd=ROOT/'platform')
        journal=attempt/'permission-journal.json'
        run(['node','--import','tsx',ROOT/'platform/scripts/sanger-release.ts','grant',journal,target_email],cwd=ROOT/'platform')
        shutil.copy2(STATE/'platform.env.candidate',PLATFORM/'.env')
        text=(PLATFORM/'release.env').read_text().replace('BIOHUB_IMAGE='+previous_image,'BIOHUB_IMAGE=biohub-platform:sanger-20261029')
        (PLATFORM/'release.env').write_text(text)
        (PLATFORM/'source').rename(old_source)
        (PLATFORM/'source-sanger-candidate').rename(PLATFORM/'source');source_switched=True
        compose('platform','up','-d','--no-build','web');stopped=False;switched=True;health('platform')
        # Sanger is a new instance, so switch its image without touching original legacy files.
        (SANGER/'release.env').write_text((SANGER/'release.env').read_text().replace('abtrace-sanger:biohub-20261029-final','abtrace-sanger:biohub-20261029-release'))
        compose('sanger','up','-d','--no-build','web');health('sanger')
        run(['node','--import','tsx',ROOT/'platform/scripts/sanger-release.ts','verify-fingerprint',fingerprint,target_email],cwd=ROOT/'platform')
        # All real user data remain in their existing directories; only configuration/image changed.
        marker.unlink()
        (SANGER/'data/.maintenance').unlink()
        report={'switched_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'platform_previous_image':previous_image,'platform_source_backup':str(old_source),'backup':str(archive),'permission_journal':str(journal),'status':'awaiting-public-smoke'}
        (STATE/'cutover-current.json').write_text(json.dumps(report,indent=2)+'\n')
        print('Docker services switched; run the HTTPS release smoke before recording completion',flush=True)
    except BaseException:
        # Schema changes are additive. Never restore a wallet snapshot over newer user transactions.
        if switched:compose('platform','stop','web')
        for name in ('.env','release.env'):shutil.copy2(attempt/('platform'+name),PLATFORM/name)
        if source_switched:
            (PLATFORM/'source').rename(PLATFORM/('source-failed-sanger-'+stamp));old_source.rename(PLATFORM/'source')
        journal=attempt/'permission-journal.json'
        if journal.exists():run(['node','--import','tsx',ROOT/'platform/scripts/sanger-release.ts','rollback-grants',journal,target_email],cwd=ROOT/'platform')
        if stopped or switched:compose('platform','up','-d','--no-build','web');health('platform')
        marker.unlink(missing_ok=True)
        (SANGER/'data/.maintenance').write_text('Initial release: failed gate; original data preserved')
        raise
    finally:
        for lock in locks:lock.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');args=parser.parse_args()
    if args.execute:execute()
    else:check()
