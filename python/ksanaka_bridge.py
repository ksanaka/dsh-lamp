#!/usr/bin/env python3
"""dsh-lamp <-> ksanaka codex-lamp bridge.

Feeds session state into the *installed* ksanaka codex-lamp StateStore so its
daemon drives the lamp, without reimplementing locking or aggregation.

Run with the codex-lamp venv python so ``import codex_lamp`` resolves to the
installed package (dsh-lamp auto-detects that python):

    <codex-lamp-home>/venv/bin/python ksanaka_bridge.py --home <home> update <session_id> <state>
    <codex-lamp-home>/venv/bin/python ksanaka_bridge.py --home <home> remove <session_id>

The bridge is fail-open: any error exits non-zero and dsh-lamp logs a warning
without disturbing the harness.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from codex_lamp.config import load_settings
from codex_lamp.state import StateStore

CANONICAL_STATES = ("off", "idle", "working", "input")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dsh-lamp ksanaka bridge")
    parser.add_argument(
        "--home",
        required=True,
        type=Path,
        help="codex-lamp data root (the CODEX_LAMP_HOME the daemon uses)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    update_parser = subparsers.add_parser("update")
    update_parser.add_argument("session_id")
    update_parser.add_argument("state", choices=CANONICAL_STATES)

    remove_parser = subparsers.add_parser("remove")
    remove_parser.add_argument("session_id")

    args = parser.parse_args(argv)
    store = StateStore(load_settings(args.home))
    if args.command == "update":
        store.update(args.session_id, args.state, time.time_ns())
    else:
        store.remove(args.session_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
