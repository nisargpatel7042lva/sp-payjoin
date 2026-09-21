#!/usr/bin/env bash
# Local regtest node for the project. Usage: infra/regtest.sh {start|stop|cli ...|fund <addr> <btc>|mine [n]|reset}
set -euo pipefail
cd "$(dirname "$0")/.."
DATADIR="$PWD/infra/bitcoin"
CLI="bitcoin-cli -regtest -datadir=$DATADIR -rpcport=18543"
case "${1:-}" in
  start)
    if $CLI getblockchaininfo >/dev/null 2>&1; then echo "already running"; else
      bitcoind -datadir="$DATADIR" -daemon >/dev/null
      for _ in $(seq 1 30); do $CLI getblockchaininfo >/dev/null 2>&1 && break; sleep 1; done
    fi
    $CLI -named createwallet wallet_name=miner load_on_startup=true >/dev/null 2>&1 || $CLI loadwallet miner >/dev/null 2>&1 || true
    H=$($CLI getblockcount); if [ "$H" -lt 101 ]; then $CLI generatetoaddress $((101 - H + 1)) "$($CLI -rpcwallet=miner getnewaddress)" >/dev/null; fi
    echo "regtest up: height $($CLI getblockcount), miner balance $($CLI -rpcwallet=miner getbalance) BTC" ;;
  stop)  $CLI stop ;;
  cli)   shift; $CLI "$@" ;;
  fund)  $CLI -rpcwallet=miner sendtoaddress "$2" "$3" ;;
  mine)  $CLI generatetoaddress "${2:-1}" "$($CLI -rpcwallet=miner getnewaddress)" ;;
  reset) $CLI stop 2>/dev/null || true; sleep 1; rm -rf "$DATADIR/regtest"; "$0" start ;;
  *) echo "usage: $0 {start|stop|cli ...|fund <addr> <btc>|mine [n]|reset}"; exit 1 ;;
esac
