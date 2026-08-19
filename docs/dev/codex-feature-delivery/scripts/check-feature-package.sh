#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
evaluator="$script_dir/evaluate-feature-package.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: 需要 Node.js 24–26。" >&2
  exit 2
fi

if [[ ! -f "$evaluator" ]]; then
  echo "ERROR: 找不到 evaluator：$evaluator" >&2
  exit 2
fi

# 所有退出码与 Gate 语义均由唯一 evaluator 决定；本文件只提供稳定入口。
exec node "$evaluator" "$@"
