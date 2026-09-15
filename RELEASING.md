# Releasing

Every publishable package (`tollstile`, `@tollstile/*`, `create-tollstile`) is released together, at the same version, from GitHub Actions. Nobody publishes from a laptop.

## What protects a release

| Check | Where | Stops |
|---|---|---|
| `pnpm check` | every PR, and the release | broken code |
| `scripts/release/check-release.mjs` | every PR, and the release | mismatched versions, a tag that does not match, a package depending on one that is not published |
| `scripts/release/pack-smoke.sh` | every PR, and the release | a package that installs but does not work: the packed tarballs go into an empty project, and a paid request, an idempotent retry, and every entry point are exercised |
| `check-release.mjs --registry` + `pack-smoke.sh <version>` | after publishing | a release users cannot install from npm |

Packages are published with npm provenance, so users can verify each one was built from this repository.

## Release a version

1. Set the version everywhere and review the diff:

   ```bash
   pnpm -r --filter './packages/*' exec npm version 0.1.1 --no-git-tag-version
   ```

2. Commit, open a PR, and merge it once CI is green.
3. Tag the merge commit and push the tag:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

4. Watch the **Release** workflow. `verify` installs the published version from npm; the release is done when it is green.

A failed publish can be re-run: versions already on npm are skipped. A published version can never be reused, so fix forward with the next patch version.

## npm authentication

Preferred: **trusted publishing**. On npmjs.com, for each package, add a trusted publisher: GitHub Actions, repository `tollstile/Tollstile`, workflow `release.yml`. No token is stored anywhere.

Trusted publishing can only be configured for a package that already exists on npm. For the first publish of a new package (for example `tollstile` after it was unpublished), add a granular access token with publish rights to those packages as the `NPM_TOKEN` repository secret, release, configure trusted publishing, then delete the secret.

## Unpublishing

Do not. An unpublished name cannot be republished for 24 hours, and its version can never be reused; every package that depends on it stops installing. Deprecate instead: `npm deprecate <package>@<version> "<reason>"`.
