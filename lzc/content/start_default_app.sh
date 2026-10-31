#!/bin/bash
set -e

DEFAULT_ROOT=/lzcapp/var/apps/default
PENDING_ARGS_FILE=/tmp/catlink/start_default_app.args

if [ "$CATLINK_APP_ID" = "rwps" ] || [ "$CATLINK_APP_ID" = "rchrome" ]; then
  if [ -f "$PENDING_ARGS_FILE" ]; then
    pending_args=()
    while IFS= read -r -d '' arg; do
        pending_args+=("$arg")
    done < "$PENDING_ARGS_FILE"
    rm -f "$PENDING_ARGS_FILE"
    set -- "${pending_args[@]}"
  fi
fi

if [ -x "$DEFAULT_ROOT/AppRun.wrapper" ]; then
    exec "$DEFAULT_ROOT/AppRun.wrapper" "$@"
fi

if [ -x "$DEFAULT_ROOT/AppRun" ]; then
    exec "$DEFAULT_ROOT/AppRun" "$@"
fi

echo "no runnable default app found under $DEFAULT_ROOT" >&2
exit 127
