#!/usr/bin/env bash
set -euo pipefail

python3 .github/boringcache-time.py npm-install npm ci --ignore-scripts
python3 .github/boringcache-time.py codegen env TRUAPI_SKIP_PACKAGE_BUILD=1 ./scripts/codegen.sh
python3 .github/boringcache-time.py host-xcframework ./ios/truapi-host/scripts/rebuild.sh
python3 .github/boringcache-time.py provider-bindings make provider-swift
python3 .github/boringcache-time.py provider-sync sh ios/truapi-provider/scripts/sync-bindings.sh

test -d ios/truapi-host/Binaries/truapi_server.xcframework
test -d ios/truapi-host/Sources/truapi_serverFFI/include
test -d ios/truapi-provider/Sources
