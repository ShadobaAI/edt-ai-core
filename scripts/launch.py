#!/usr/bin/env python3
"""Dependency-free entrypoint for a plugin-prepared Python environment."""
import argparse
import os
from pathlib import Path

parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--python", type=Path, required=True)
args, remainder = parser.parse_known_args()
interpreter = args.python.resolve()
if not interpreter.is_file():
    parser.error("Prepared Python environment is missing; rerun install.ps1")
os.execv(str(interpreter), [str(interpreter),
    str(Path(__file__).resolve().with_name("managed_mcp.py")), *remainder])

