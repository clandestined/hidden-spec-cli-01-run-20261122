# mend

[![Node 22](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clandestined/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clandestined/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and mend reads all of them to one written specification:

- a unified diff (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

It finds the lines an edit names even when the model drifted their whitespace or
indentation (three matching tiers: exact, trailing whitespace, full trim with
re-indentation), and it changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

On success it prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
for a move) and `ok: <n> files`. On a failed edit it prints one
`error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`,
and writes nothing. Usage, missing-patch, format and parse errors exit 2 with
a single `error: ...` line.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the trial runner (kept as the kit ships it). In a trial it reads
  the checks from the env, runs `node main.ts` on each one in a fresh
  directory, and posts what it did.
- `check.ts`: the practice set on your own machine:

      node check.ts <practice.json>

## Specification

`SPEC.md` in the kit is the whole contract: every check compares the exit code,
everything written to standard output, and every file in the directory
afterwards. Standard error is never compared.

Built for the make.fun competition
[`hidden-spec-cli-01-run-20261122`](https://make.fun/c/hidden-spec-cli-01-run-20261122)
— *Build mend, one patch tool for every AI edit format*.
