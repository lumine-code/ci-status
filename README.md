# ci-status

Run every lumine-code package's specs at master against a real editor build.

This repository owns no packages; its result artifacts distinguish package regressions from setup failures.

## Features

- **Discovery from the organization**: sweeps every lumine-code repository whose manifest declares an `engines.lumine` range, so nothing needs editing when a package is added or retired.
- **Every package, not just the catalogued ones**: covers packages the editor bundles as well as packages the install catalog lists, and both at `master`.
- **Three platforms**: Linux, macOS and Windows, against one editor build per platform.
- **One check per package and platform**: every suite runs as its own Linux, macOS and Windows job with a private `LUMINE_HOME`.
- **Nothing hides**: a package reports its own pending, passing or failing check instead of disappearing behind a fleet summary.
- **Immutable inputs**: discovery fixes each package and editor commit before jobs start; every platform uploads its actual input commits and result, including setup and test failures.

## What it answers

Each package is swept at `master`, so this answers _does the fleet work as it stands today_. That is deliberately a different question from the one the install catalog's own checks answer, which is _does the ref a user would install work_ — the newest stable tag a repository publishes, and `master` only when it has never been tagged.

The branch is a discovery selector: jobs fetch its recorded commit rather than resolving the branch again. `npm run spec -- --editor /path/to/lumine` records the local editor's HEAD in the plan; a manually produced plan needs `--editor-sha <full-sha>`. Result files retain the planned and observed package and editor commits, and a mismatch fails before the suite runs. Each CI job uploads its `spec-result-<platform>-<package>` artifact even when setup or specs fail.

These receipts attest the primary package and editor commits. A package's `specPackages` peers are ordinary checkouts at `master`; their actual checkout commits are not recorded, so the runner does not attest a frozen dependency closure.

Linux headless setup retains `xvfb`, `libsecret-1-0`, `fonts-noto-cjk` and normal recommended packages. Each source gets 90 seconds for authenticated metadata and 180 seconds for downloads; metadata or download failures on the configured source switch to official Ubuntu archive endpoints with the same signing configuration. Installation uses the authenticated cache without downloads, has a 180-second budget and is never retried. Commands have a further 10-second kill grace within a 15-minute setup step. Failure on both sources or during cached installation stops setup and retains an error result.

After installing a package's dependencies, the runner executes its declared nonempty `pretest` script once with `npm run pretest`, before native rebuild and editor specs. A pretest failure records an error and stops that package's spec launch.

If setup stops before the runner, an always-run fallback records an error with the expected commits and any commit metadata it can still observe. Unknown observations stay null, test execution remains unattested, and any earlier runner report is preserved.

It is also the only place a bundled package is tested at `master`. The editor's own CI runs each bundled package's suite at the commit the editor pins, so a package whose `master` has moved past its pin goes untested there until someone repins it.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
