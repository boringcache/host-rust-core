#!/usr/bin/env python3
"""Measure released proxy startup using the benchmark's existing cache tag."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

WORKSPACE = 'boringcache/host-rust-core'
TAG = 'parity-ios-core-20260922-b-macos-26-arm64'
API = 'https://api.boringcache.com'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--modes', nargs='+', default=['auto', '64', 'auto'])
    args = parser.parse_args()
    token = os.environ['BORINGCACHE_RESTORE_TOKEN'].strip()
    if not token:
        raise SystemExit('Restore token is empty')
    binary = str(args.binary.resolve())
    args.output.mkdir(parents=True, exist_ok=False)

    def redact(value):
        value = value.replace(token, '[REDACTED]')
        value = re.sub(r'bc_wrk_[A-Za-z0-9]+:[A-Za-z0-9]+', '[REDACTED]', value)
        return re.sub(r'https?://[^\s?"<>]+\?[^\s"<>]+', '[SIGNED_URL_REDACTED]', value)

    def save(path, value):
        path.write_text(redact(json.dumps(value, indent=2)) + '\n')

    def command_output(command):
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=5)
            return (result.stdout + result.stderr).strip()
        except (OSError, subprocess.TimeoutExpired) as error:
            return type(error).__name__

    def api_request(path, body=None):
        request = urllib.request.Request(
            API + '/v2/workspaces/' + WORKSPACE + '/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json',
                     'Content-Type': 'application/json', 'User-Agent': 'boringcache/1.31.0'},
        )
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.load(response)

    save(args.output / 'identity.json', {
        'workspace': WORKSPACE, 'tag': TAG, 'read_only': True,
        'version': command_output([binary, '--version']),
        'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
        'run_id': os.environ.get('GITHUB_RUN_ID'),
        'ref': os.environ.get('GITHUB_REF'), 'sha': os.environ.get('GITHUB_SHA'),
        'uname': command_output(['uname', '-a']),
        'hardware': command_output(['sysctl', 'hw.ncpu', 'hw.memsize', 'machdep.cpu.brand_string']),
        'disk': command_output(['df', '-h', str(args.output)]),
    })
    query = urllib.parse.urlencode({'tag': TAG, 'limit': 1, 'version': 'current'})
    if not api_request('cache-kv-entries?' + query).get('entries'):
        raise SystemExit('The existing cache tag has no current entries')

    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    results = []
    for index, mode in enumerate(args.modes, 1):
        output = args.output / f'{index}-{mode}'
        output.mkdir()
        with tempfile.TemporaryDirectory(prefix='proxy-diagnostics-') as directory:
            root = Path(directory)
            ready = root / 'proxy.ready'
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            env = {key: value for key, value in os.environ.items()
                   if (key.startswith('GITHUB_') and 'TOKEN' not in key) or key in ['PATH', 'CI', 'RUNNER_OS', 'RUNNER_ARCH']}
            env.update({
                'HOME': directory, 'TMPDIR': directory,
                'BORINGCACHE_API_URL': API, 'BORINGCACHE_RESTORE_TOKEN': token,
                'BORINGCACHE_BLOB_READ_CACHE_DIR': str(root / 'blobs'),
                'BORINGCACHE_OBSERVABILITY_JSONL_PATH': str(root / 'events.jsonl'),
            })
            if mode != 'auto':
                env['BORINGCACHE_BLOB_PREFETCH_CONCURRENCY'] = str(int(mode))
            command = [binary, 'cache-registry', WORKSPACE, TAG,
                       '--host', '127.0.0.1', '--port', str(port), '--no-git', '--no-platform',
                       '--read-only', '--startup-mode', 'eager', '--warmup-strategy', 'current-version',
                       '--ready-file', str(ready), '--metadata-hint', 'tool=sccache', '--verbose']
            started = time.monotonic()
            proxy = subprocess.Popen(command, env=env, cwd=directory,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            stopped = threading.Event()

            def drain():
                with (output / 'proxy.log').open('w') as log:
                    for line in proxy.stdout:
                        log.write(f'{time.monotonic() - started:.3f}s ' + redact(line))
                        log.flush()

            def sample():
                with (output / 'resources.jsonl').open('w') as log:
                    while not stopped.is_set():
                        row = {'elapsed_s': time.monotonic() - started, 'loadavg': os.getloadavg(),
                               'vm_stat': command_output(['vm_stat']),
                               'swap': command_output(['sysctl', '-n', 'vm.swapusage']),
                               'process': command_output(['ps', '-p', str(proxy.pid), '-o', 'pid,pcpu,rss,time,state'])}
                        log.write(json.dumps(row) + '\n')
                        log.flush()
                        stopped.wait(1)

            reader = threading.Thread(target=drain, daemon=True)
            sampler = threading.Thread(target=sample, daemon=True)
            reader.start()
            sampler.start()
            disk_log = (output / 'iostat.txt').open('w')
            try:
                disk_monitor = subprocess.Popen(['iostat', '-w', '1'], stdout=disk_log, stderr=disk_log)
            except OSError:
                disk_monitor = None
            snapshots = []
            latest = {}
            listener_seconds = None
            next_sample = 0
            next_report = 10
            result = {'mode': mode, 'index': index, 'temp_device': root.stat().st_dev}
            try:
                while True:
                    elapsed = time.monotonic() - started
                    if proxy.poll() is not None:
                        raise RuntimeError(f'Proxy exited with code {proxy.returncode}')
                    if elapsed > 330:
                        raise TimeoutError('Proxy was not ready within 330 seconds')
                    if elapsed >= next_sample or ready.exists():
                        try:
                            with http.open(f'http://127.0.0.1:{port}/_boringcache/status', timeout=1) as response:
                                latest = json.load(response)
                            if listener_seconds is None:
                                listener_seconds = time.monotonic() - started
                            snapshots.append({'elapsed_s': time.monotonic() - started, 'status': latest})
                        except (OSError, urllib.error.URLError):
                            pass
                        next_sample = elapsed + 1
                    if elapsed >= next_report:
                        print(json.dumps({'mode': mode, 'elapsed_s': round(elapsed, 1),
                                          'phase': latest.get('phase')}), flush=True)
                        next_report = elapsed + 10
                    if ready.exists():
                        result.update({'ready_seconds': time.monotonic() - started,
                                       'listener_seconds': listener_seconds, 'status': latest})
                        break
                    time.sleep(0.2)
            except (RuntimeError, TimeoutError) as error:
                result['error'] = str(error)
            finally:
                stopped.set()
                if proxy.poll() is None:
                    proxy.send_signal(signal.SIGTERM)
                    try:
                        proxy.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        proxy.kill()
                        proxy.wait()
                if disk_monitor is not None and disk_monitor.poll() is None:
                    disk_monitor.terminate()
                    disk_monitor.wait(timeout=5)
                disk_log.close()
                reader.join(timeout=5)
                sampler.join(timeout=10)
                save(output / 'status-timeline.json', snapshots)
                save(output / 'result.json', result)
                events = root / 'events.jsonl'
                if events.exists():
                    (output / 'events.jsonl').write_text(redact(events.read_text()))
            results.append(result)
            print(json.dumps({key: value for key, value in result.items() if key != 'status'}), flush=True)
    save(args.output / 'results.json', results)

    # These serial reads occur after startup measurements and are separate network samples.
    try:
        query = urllib.parse.urlencode({'tag': TAG, 'limit': 2000, 'version': 'current'})
        entries = api_request('cache-kv-entries?' + query)['entries']
        blobs = sorted({entry['blob']['digest']: entry['blob'] for entry in entries}.values(),
                       key=lambda blob: blob['size_bytes'])
        chosen = [blobs[int((len(blobs) - 1) * fraction)] for fraction in [0.1, 0.5, 0.9]]
        urls = api_request('cache-kv-entries/download-urls', {'tag': TAG, 'blobs': chosen})['download_urls']
        samples = []
        for item in urls:
            started = time.monotonic()
            request = urllib.request.Request(item['url'], headers=item.get('headers', {}))
            with urllib.request.urlopen(request, timeout=60) as response:
                headers_seconds = time.monotonic() - started
                headers = {name.lower(): value for name, value in response.headers.items()
                           if name.lower() in ['x-tigris-served-from', 'server-timing', 'x-bc-delivery',
                                               'x-bc-source', 'x-bc-edge-location', 'x-bc-cache', 'content-length']}
                byte_count = 0
                digest = hashlib.sha256()
                while chunk := response.read(256 * 1024):
                    byte_count += len(chunk)
                    digest.update(chunk)
            total_seconds = time.monotonic() - started
            samples.append({'digest': item['digest'], 'bytes': byte_count,
                            'digest_matches': 'sha256:' + digest.hexdigest() == item['digest'],
                            'host': urllib.parse.urlsplit(item['url']).hostname,
                            'headers_seconds': headers_seconds, 'total_seconds': total_seconds,
                            'mib_per_second': byte_count / 1048576 / total_seconds, 'headers': headers})
        save(args.output / 'storage-samples.json', samples)
    except Exception as error:
        save(args.output / 'storage-samples.json', {'error_type': type(error).__name__})
    if any('error' in result for result in results):
        raise SystemExit('One or more proxy startups failed; see diagnostic artifacts')


if __name__ == '__main__':
    main()
