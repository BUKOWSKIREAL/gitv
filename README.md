一个git的可视化的工具
prompt来自于jyy 生成式软件工程
使用的模型为SWE-2MAX（RL on kimik3 by devin）

# gitv

Visualize a git repository's object graph from its raw files and bytes — loose
objects, packfiles, refs, HEAD, the index, and the working tree — rendered as an
interactive graph in the browser. Zero runtime dependencies.

## Usage

Requires Node.js >= 22 and `git` on `PATH`.

```
gitv [repo-path] [options]
```

| option | description |
| ------ | ----------- |
| `-p`, `--port N` | port to listen on, integer 0–65535 (default `4700`; `0` picks a free port; if busy the next free port is tried) |
| `-m`, `--max N` | maximum objects to display, positive integer (default `8000`) |
| `--no-open` | do not open a browser window |
| `--` | stop parsing options (for paths starting with `-`) |
| `-h`, `--help` | show help |

From a source checkout, run `node bin/gitv.js <repo>`. Installed as a package,
the `gitv` bin is on `PATH`.

## Architecture

- `bin/gitv.js` — CLI entry point. Parses and validates arguments, then hands
  off to the server.
- `src/repo.js` — reads `.git` directly without shelling out for object data:
  zlib-inflated loose objects, packfiles (idx v2, ofs/ref delta chains), loose
  and packed refs, `HEAD`, the index, and `git status --porcelain` for worktree
  state. Computes reachability and produces a per-object "parse story" for the
  detail panel.
- Object type/size metadata is enumerated with `git cat-file --batch-check`.
  Only the selected objects are decoded by the raw byte parsers. Pack bodies
  are read in bounded windows; resolved delta bases may require extra decodes.
- `src/index-reader.js` — index v2/v3/v4 parsing, including compressed paths.
- `src/server.js` — HTTP server: `GET /api/state`, `GET /api/detail`, an SSE
  stream at `/events`, and static files. `fs.watch` on `.git` and the worktree
  triggers a rebuild + diff broadcast on change.
- `src/repo-worker.js` and `src/worker-client.js` — run builds and details in
  a worker thread. The HTTP service stays responsive while parsing; changes
  are coalesced and linked worktrees watch their shared Git directory too.
- `public/` — dependency-free frontend that renders the object graph.

## Security

- The server binds to `127.0.0.1` only; it is not reachable from other hosts.
- Detail ids are validated: object ids must be 40 lowercase hex chars, refs
  must be well-formed `refs/...` names, and workdir paths are resolved and
  confined to the worktree (symlinks are realpath-checked). Worktree reads
  cannot access Git metadata, including through symlinks.
- Static serving is confined to `public/` — traversal and symlink escapes get
  a 404.

## Development

```
npm test    # node --test — no build step, no dependencies
```

- `test/cli.test.js` — argument parsing and spawned-CLI behavior
- `test/security.test.js` — path traversal, ref/object id validation, server
- `test/frontend.test.js` — frontend graph logic under a DOM stub in `node:vm`
- `test/index.test.js` — real Git indexes plus malformed input
- `test/performance.test.js` — decode limits, packs/deltas and cache bounds
- `test/server.test.js` — responsiveness, worker lifecycle and shared refs

CI runs the suite on Node 22 and 24, on Ubuntu and macOS.

## Current limits

- SHA-1 repositories only (no SHA-256 object ids).
- Index v2/v3/v4 are supported. Split and sparse indexes produce a visible
  warning rather than claiming a complete staging view.
- `--max` bounds selected object bodies, not metadata enumeration. Selection
  prioritizes commits, then trees, blobs and tags in storage enumeration
  order; selected commits are displayed by date. It is not a newest-N query.
- Rebuilds still enumerate object metadata, refs and the index, and run Git
  status/diff. Metadata memory and scan time grow with repository size.
  Alternate object stores are not rendered by the raw parser.
- Object inflation is capped at 8 MiB, delta recursion at 64 levels, and
  worktree preview reads at 64 KiB. Oversized/failed objects are listed in
  `state.errors` and summarized in the UI. Loose cache is capped at 64 MiB;
  each of up to eight cached packs has a 64 MiB decoded-object cache.
- A partial graph suppresses unreachable styling and shows a warning:
  objects omitted by the limit cannot prove reachability of the full graph.
- Worker requests are limited to 64 pending operations and a 60-second
  timeout. A worker timeout requires restarting the server; the last good
  state remains available until then. The initial loading state returns 503.
- The tool is intended for local, trusted repositories. It is not a Git
  integrity checker or a sandbox for hostile repositories. Windows is not
  covered by the current CI matrix.
