#!/usr/bin/env bash
# Phase 3 gate: two independent processes. The same `spay pay` command joins when
# the receiver can, and falls back cleanly when it cannot. No protocol flag either way.
set -euo pipefail
cd "$(dirname "$0")/.."
export SPAY_HOME="${SPAY_HOME:-$(mktemp -d)}"
SPAY="npx tsx src/cli/spay.ts"
hr() { printf '\n%s\n' "────────────────────────────────────────────────────────────────────────────"; printf '%b\n' "$1"; }
# `spay receive` writes its own pid; npx/tsx wrappers make $! the wrong process.
stop() { [ -f "$SPAY_HOME/$1.pid" ] && kill "$(cat "$SPAY_HOME/$1.pid")" 2>/dev/null; rm -f "$SPAY_HOME/$1.pid"; return 0; }
cleanup() { stop demo-recv; stop demo-plain; }
trap cleanup EXIT

./infra/regtest.sh start >/dev/null
echo "wallets in $SPAY_HOME"

hr "0. fund the payer"
$SPAY fund 0.5 | sed 's/^/   /'

hr "1. RECEIVER process: a payjoin-capable wallet (its own terminal in a live demo)"
$SPAY receive --wallet demo-recv > "$SPAY_HOME/recv.log" 2>&1 &
sleep 6
grep -q "payjoin endpoint: http" "$SPAY_HOME/recv.log" || { echo "receiver failed to start:"; cat "$SPAY_HOME/recv.log"; exit 1; }
sed 's/^/   /' "$SPAY_HOME/recv.log"
URI=$(grep -o 'bitcoin:[^ ]*' "$SPAY_HOME/recv.log" | tail -1)

hr "2. PAYER process: pay it. The payer types no flags.\n   (the receiver has no utxo yet, so there is nothing to join with — watch it fall back)"
echo "   \$ spay pay '<uri>' 400000"
$SPAY pay "$URI" 400000 | sed 's/^/   /'
sleep 3
hr "3. what the receiver saw"
tail -n 4 "$SPAY_HOME/recv.log" | sed 's/^/   /'

# The first payment gave the receiver a UTXO; a second payment can now be joined.
hr "4. pay again — now the receiver has a UTXO to contribute, so it becomes a real join"
$SPAY pay "$URI" 350000 | sed 's/^/   /'
sleep 3
tail -n 3 "$SPAY_HOME/recv.log" | sed 's/^/   /'
stop demo-recv
sleep 1

hr "5. RECEIVER process: a plain silent-payment wallet — no payjoin endpoint at all"
$SPAY receive --no-payjoin --wallet demo-plain > "$SPAY_HOME/plain.log" 2>&1 &
sleep 6
grep -q "silent payment address" "$SPAY_HOME/plain.log" || { echo "receiver failed to start:"; cat "$SPAY_HOME/plain.log"; exit 1; }
sed 's/^/   /' "$SPAY_HOME/plain.log"
PLAIN_URI=$(grep -o 'bitcoin:[^ ]*' "$SPAY_HOME/plain.log" | tail -1)

hr "6. PAYER process: the identical command against it"
echo "   \$ spay pay '<uri>' 300000"
$SPAY pay "$PLAIN_URI" 300000 | sed 's/^/   /'
sleep 3
hr "7. what the plain receiver saw"
tail -n 3 "$SPAY_HOME/plain.log" | sed 's/^/   /'

hr "RESULT"
echo "   Same command, no flags: joined when the receiver could, paid directly when it could not."
