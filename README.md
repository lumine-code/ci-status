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
`last.log`, commits it, and then dispatches the sweep, so each sweep reports on a commit no other
run has touched.

That indirection buys an honest badge. GitHub reports a repository's status as the aggregate of
every check suite on its HEAD, not the newest one, so wherever HEAD sits still the status only
ratchets: one red sweep pins the badge red however many green ones follow it, and nothing is coming
along to clear it. Moving HEAD once per sweep gives each result a commit of its own, so the badge
means the last sweep.

The order is the point. Stamping afterwards would leave the result on the previous commit and the
new one with no status at all. The dispatch is not a convenience either — a push made with
`GITHUB_TOKEN` deliberately does not trigger workflows, so the stamp commit has to ask for the
sweep rather than cause it.

The same three steps run locally against a checkout of the editor:

```
node scripts/plan-specs.js --only "linter marker-*" --shards 1
node scripts/run-specs.js --plan plan.json --shard 0 --editor ../lumine
node scripts/summarize-specs.js --results results --plan plan.json
```

Discovery lists the organization through the GitHub API, so set `GITHUB_TOKEN` for a local run;
everything after that reads manifests and refs directly and costs no API quota.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your
thoughts on GitHub. Any feedback is welcome!
