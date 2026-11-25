#!/usr/bin/env bash
# Phase 0 spike: one line every 10 s, so Monitor delivery can be observed.
i=0
while true; do
  i=$((i+1))
  echo "[spike] tick $i at $(date +%H:%M:%S)"
  sleep 10
done
