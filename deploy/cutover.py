#!/usr/bin/env python3
"""Explicit one-time migration. Never starts a maintenance window without a working HTTPS platform."""
import datetime, fcntl, hashlib, json, os, pathlib, shutil, sqlite3, subprocess, sys, tarfile, time, urllib.request, urllib.error

ROOT = pathlib.Path('/opt/sci_image')
OLD = ROOT / 'yinglan-prod'
NEW = ROOT / 'platform-prod'
RUNTIME = ROOT / 'migration-runtime'
PLATFORM_URL = 'https://biohub.zhangwuji.work:49998'
TOOL_URL = 'https://image.zhangwuji.work:49998'
PLATFORM_IMAGE = 'biohub-platform:migration-20261029'
TOOL_IMAGE = 'yinglan-image:platform-migration-20261029'

def run(args, **kw):
    return subprocess.run([str(x) for x in args], check=True, **kw)

def settings(file):
    return dict(line.split('=', 1) for line in file.read_text().splitlines() if line and not line.startswith('#') and '=' in line)

def write_env(file, values):
    file.write_text(''.join(k + '=' + v + '\n' for k, v in values.items()))
    file.chmod(0o600)

def compose(app, *args):
    root = NEW if app == 'platform' else OLD
    env = os.environ.copy()
    if app == 'yinglan':
        env.update(YINGLAN_ENV_FILE=str(root / '.env'), YINGLAN_DATA_DIR=str(root / 'data'))
    return run(['docker', 'compose', '--project-directory', root / 'source', '--env-file', root / 'release.env', '-f', root / 'source/docker-compose.yml', *args], env=env)

def state():
    with sqlite3.connect('file:' + str(OLD / 'data/yinglan.sqlite') + '?mode=ro', uri=True) as db:
        return json.loads(db.execute('SELECT state FROM app_state WHERE id=1').fetchone()[0])

def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()

def preflight():
    if not (NEW/'data/.maintenance').exists():raise RuntimeError('Target platform must remain in maintenance until migration')
    for image in (PLATFORM_IMAGE, TOOL_IMAGE, 'nginx:stable-alpine'):
        run(['docker', 'image', 'inspect', image], stdout=subprocess.DEVNULL)
    status, body = fetch(PLATFORM_URL + '/api/v1/health')
    if status != 200 or json.loads(body).get('service') != 'biohub-platform':
        raise RuntimeError('Platform HTTPS/reverse proxy is not ready; old site stays online')
    status, body = fetch(PLATFORM_URL + '/oidc/.well-known/openid-configuration')
    if status != 200 or json.loads(body).get('issuer') != PLATFORM_URL + '/oidc':
        raise RuntimeError('OIDC issuer/proxy check failed')
    if fetch(TOOL_URL + '/api/health')[0] != 200:
        raise RuntimeError('Existing tool HTTPS is unavailable')
    with sqlite3.connect('file:' + str(NEW / 'data/platform.sqlite') + '?mode=ro', uri=True) as db:
        if db.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
            raise RuntimeError('Platform must be empty before first migration')
    print('Preflight passed: HTTPS, OIDC discovery, empty target and built images.', flush=True)

def health(app):
    port, suffix = (3002, '/api/v1/health') if app == 'platform' else (3001, '/api/ready')
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        try:
            if fetch('http://192.168.6.111:' + str(port) + suffix)[0] == 200:
                return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError(app + ' failed readiness')

def worker_env(app, data):
    env = os.environ.copy()
    env.update(settings((NEW if app == 'platform' else OLD) / '.env'))
    env['DATA_DIR'] = str(data)
    if app == 'yinglan':
        env['SQLITE_FILE'] = str(data / 'yinglan.sqlite')
        env['AUTH_MODE'] = 'standalone'
    return env

def ownership(directory):
    for base, dirs, files in os.walk(directory):
        os.chown(base, 1000, 1000)
        for file in files:
            os.chown(pathlib.Path(base) / file, 1000, 1000)

def execute():
    preflight()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    attempt = RUNTIME / ('cutover-' + stamp)
    attempt.mkdir(mode=0o700)
    for name, root in [('yinglan', OLD), ('platform', NEW)]:
        shutil.copy2(root / '.env', attempt / (name + '.env'))
        shutil.copy2(root / 'release.env', attempt / (name + '-release.env'))
    switched = False
    old_stopped = False
    platform_stopped = False
    backup_ready = False
    try:
        (OLD / 'data/.maintenance').write_text(stamp)
        deadline = time.monotonic() + 720
        time.sleep(3)
        while any(j['status'] in ('queued', 'running') for j in state()['jobs']):
            if time.monotonic() > deadline:
                raise RuntimeError('Task drain timeout; migration cancelled')
            time.sleep(3)
        compose('yinglan', 'stop', 'web'); old_stopped = True
        run(['docker', 'run', '-d', '--name', 'yinglan-upgrade', '--restart', 'unless-stopped', '-p', '192.168.6.111:3001:80', '-v', str(ROOT / 'yinglan/deploy/upgrade/nginx.conf') + ':/etc/nginx/nginx.conf:ro', '-v', str(ROOT / 'yinglan/deploy/upgrade/index.html') + ':/usr/share/nginx/html/upgrade.html:ro', 'nginx:stable-alpine'], stdout=subprocess.DEVNULL)
        if fetch(TOOL_URL)[0] != 503:
            raise RuntimeError('Upgrade page not visible through public URL')
        compose('platform', 'stop', 'web'); platform_stopped = True
        archive = attempt / 'before-cutover.tgz'
        with tarfile.open(archive, 'w:gz') as tar:
            tar.add(OLD / 'data', 'yinglan/data')
            tar.add(NEW / 'data', 'platform/data')
            for name in ('yinglan.env', 'platform.env', 'yinglan-release.env', 'platform-release.env'):
                tar.add(attempt / name, name)
        archive.chmod(0o600)
        (attempt / 'before-cutover.tgz.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  before-cutover.tgz\n')
        backup_ready = True
        candidate_tool, candidate_platform = attempt / 'yinglan-data', attempt / 'platform-data'
        shutil.copytree(OLD / 'data', candidate_tool)
        candidate_platform.mkdir(mode=0o700)
        export = attempt / 'accounts-wallet-export.json'
        run(['node', '--import', 'tsx', 'scripts/export-platform-migration.ts', 'export', export], cwd=ROOT / 'yinglan', env=worker_env('yinglan', candidate_tool))
        run(['node', '--import', 'tsx', 'scripts/import-yinglan.ts', export], cwd=ROOT / 'platform', env=worker_env('platform', candidate_platform))
        run(['node', '--import', 'tsx', 'scripts/export-platform-migration.ts', 'link', PLATFORM_URL + '/oidc'], cwd=ROOT / 'yinglan', env=worker_env('yinglan', candidate_tool))
        (candidate_platform / '.maintenance').write_text(stamp)
        # Original directories are retained intact for rollback. Both services are stopped.
        (OLD / 'data').rename(attempt / 'original-yinglan-data')
        (NEW / 'data').rename(attempt / 'original-platform-data')
        candidate_tool.rename(OLD / 'data'); candidate_platform.rename(NEW / 'data'); switched = True
        ownership(OLD / 'data'); ownership(NEW / 'data')
        env = settings(OLD / '.env'); platform = settings(NEW / '.env')
        env.update(AUTH_MODE='platform', PLATFORM_URL=PLATFORM_URL, OIDC_ISSUER=PLATFORM_URL + '/oidc', YINGLAN_CLIENT_SECRET=platform['YINGLAN_CLIENT_SECRET'], YINGLAN_WORKER_SECRET=platform['YINGLAN_WORKER_SECRET'], DEV_MOCK_IMAGES='false', REGISTRATION_ENABLED='false')
        write_env(OLD / '.env', env)
        release = settings(OLD / 'release.env'); release['YINGLAN_IMAGE'] = TOOL_IMAGE; write_env(OLD / 'release.env', release)
        compose('platform', 'up', '-d', '--no-build', 'web'); platform_stopped = False; health('platform')
        run(['docker', 'rm', '-f', 'yinglan-upgrade'], stdout=subprocess.DEVNULL)
        compose('yinglan', 'up', '-d', '--no-build', 'web'); old_stopped = False; health('yinglan')
        run(['node', '--import', 'tsx', 'scripts/production-smoke.ts', '--migrated'], cwd=ROOT / 'platform', env={**os.environ, 'BIOHUB_PROD_DIR': str(NEW), 'BIOHUB_MIGRATION_EXPORT': str(export)})
        (NEW / 'data/.maintenance').unlink(missing_ok=True)
        (OLD / 'data/.maintenance').unlink(missing_ok=True)
        report = {'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'backup': str(archive), 'platform_url': PLATFORM_URL, 'tool_url': TOOL_URL, 'rollback': 'Requires maintenance and joint data restore; never roll back only the tool image after wallet writes.'}
        (NEW / 'migration-completed.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)
    except BaseException:
        print('Cutover failed. Restoring the prior services before reopening writes.', flush=True)
        if switched:
            compose('yinglan', 'stop', 'web'); compose('platform', 'stop', 'web')
            (OLD / 'data').rename(attempt / 'failed-yinglan-data'); (NEW / 'data').rename(attempt / 'failed-platform-data')
            (attempt / 'original-yinglan-data').rename(OLD / 'data'); (attempt / 'original-platform-data').rename(NEW / 'data')
            for name, root in [('yinglan', OLD), ('platform', NEW)]:
                shutil.copy2(attempt / (name + '.env'), root / '.env'); shutil.copy2(attempt / (name + '-release.env'), root / 'release.env')
        subprocess.run(['docker', 'rm', '-f', 'yinglan-upgrade'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if old_stopped or switched: compose('yinglan', 'up', '-d', '--no-build', 'web')
        if platform_stopped or switched: compose('platform', 'up', '-d', '--no-build', 'web')
        (OLD / 'data/.maintenance').unlink(missing_ok=True)
        if backup_ready: print('Pre-cutover backup retained at ' + str(attempt), flush=True)
        raise

if __name__ == '__main__':
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    with (OLD / '.operation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if sys.argv[1:] == ['--execute']: execute()
        elif sys.argv[1:] == ['--check']: preflight()
        else: raise SystemExit('Usage: cutover.py --check | --execute')
