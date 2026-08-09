# ci-status

Run every lumine-code package's specs at master against a real editor build.

This repository owns no packages; it reports on them. A red run here means a package regressed,
never that this repository is broken.

## Features

- **Discovery from the organization**: sweeps every lumine-code repository whose manifest declares
  an `engines.lumine` range, so nothing needs editing when a package is added or retired.
- **Every package, not just the catalogued ones**: covers packages the editor bundles as well as
  packages the install catalog lists, and both at `master`.
- **Three platforms**: Linux, macOS and Windows, against one editor build per platform.
- **Sharded**: the fleet is spread over parallel spec jobs, each running its packages one at a time
  in its own Electron session with a private `LUMINE_HOME`.
- **Nothing hides**: every shard reports whatever it got through, and a package no shard reported on
  is named rather than passing silently.

## What it answers

Each package is swept at `master`, so this answers *does the fleet work as it stands today*. That is
deliberately a different question from the one the install catalog's own checks answer, which is
*does the ref a user would install work* — the newest stable tag a repository publishes, and
`master` only when it has never been tagged.

It is also the only place a bundled package is tested at `master`. The editor's own CI runs each
bundled package's suite at the commit the editor pins, so a package whose `master` has moved past
its pin goes untested there until someone repins it.

## Running it

The sweep runs on every push here, once a day, and on demand from the Actions tab — where a run can
be narrowed to a few packages, fewer platforms, a different editor build, or a different package
branch.

The daily run belongs to `Stamp and sweep` rather than to the sweep itself. It writes the time into
`last.log` and commits it, and that push is what starts the sweep, so each sweep reports on a commit
no other run has touched.

That indirection buys an honest badge. GitHub reports a repository's status as the aggregate of
every check suite on its HEAD, not the newest one, so wherever HEAD sits still the status only
ratchets: one red sweep pins the badge red however many green ones follow it, and nothing is coming
along to clear it. Moving HEAD once per sweep gives each result a commit of its own, so the badge
means the last sweep.

The order is the point. Stamping afterwards would leave the result on the previous commit and the
new one with no status at all.

The stamp pushes with a `STAMP_TOKEN` secret — a fine-grained token holding `contents: write` on
this repository — because a push made with `GITHUB_TOKEN` deliberately triggers no workflow.
Dispatching the sweep instead is not a substitute, which is subtler and was worth learning once:
GitHub assembles the status a commit displays only from the check suites a `push` raised, and drops
the ones raised by `workflow_dispatch` and `schedule`. A dispatched sweep is attached to the stamp
commit in the Actions tab and absent from the commit itself, which leaves the stamp carrying nothing
and the badge reading no state at all — a worse failure than the ratchet stamping exists to fix.

The whole sweep runs locally in one command. Point it at any editor checkout:

```
npm run spec -- --editor /path/to/lumine --only "linter marker-*"
```

It plans, runs every shard in turn, and summarizes, failing the way CI would. Pass `--shards` to
split the work, `--ref` to sweep a branch other than `master`, and `--help` for the rest. The three
steps are still separate scripts underneath, because CI runs them on separate machines:

```
node scripts/plan-specs.js --only "linter marker-*" --shards 1
node scripts/run-specs.js --plan plan.json --shard 0 --editor /path/to/lumine
node scripts/summarize-specs.js --results results --plan plan.json
```

Discovery lists the organization through the GitHub API, so set `GITHUB_TOKEN` for a local run;
everything after that reads manifests and refs directly and costs no API quota. The sweep drives npm
and the spec timeout through `bash`, which every runner has and Windows does not — a local Windows
run falls back to the one Git for Windows installs.

`npm run stamp` does by hand what the scheduled workflow does: writes the time into `last.log`,
commits it, and pushes. Pushed with your own credentials rather than `GITHUB_TOKEN`, it starts the
sweep the same way the workflow's stamp does.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your
thoughts on GitHub. Any feedback is welcome!
