# Publishing

Publish from a clean, committed worktree using an npm account allowed to publish
`convex-azure-blob-storage`. Use Node.js 24, matching CI, and npm.

## Releasing a version

`main` is protected: changes, including version bumps, arrive through pull
requests, and only tags are pushed directly.

1. On a branch, bump the version without committing or tagging:

   ```sh
   npm version patch --no-git-tag-version   # or minor, major
   npm version prerelease --preid alpha --no-git-tag-version   # alpha
   ```

   Add a `CHANGELOG.md` entry for the version. If component functions or the
   schema changed, run `npm run build:codegen` and commit the generated files
   (this needs a configured Convex development deployment).

2. Open a pull request and merge it once CI passes. CI runs the tests on Node 22
   and 24, Windows, and Azurite.

3. Release from an up-to-date, clean `main`:

   ```sh
   git switch main && git pull
   npm login   # once per machine
   npm run release
   ```

   `npm run release` stops unless the worktree is clean, the branch matches
   GitHub, and the version's tag does not exist yet. It then runs `npm publish`,
   whose `prepublishOnly` hook repeats the full `check`; approve the npm
   two-factor prompt when asked. Finally it creates the annotated tag (for
   example `v0.1.2`) and pushes only the tag.

   An alpha version (`0.2.0-alpha.0`) is published under the `alpha` dist-tag
   and can be released from any pushed branch; users install it with
   `npm install convex-azure-blob-storage@alpha`.

4. Optionally create a GitHub release from the tag:
   `gh release create v0.1.2 --verify-tag --notes-file <notes>`.

Before a release, inspect `npm pack --dry-run` for unintended files. Do not
bypass the publish hook with `--ignore-scripts`.

## Package scripts for releasing

- `check` performs a clean build, tests, lint, type checks and the packed
  consumer check.
- `preversion` runs `check` before `npm version` bumps the version.
- `release` publishes the merged version and pushes its tag
  (`scripts/release.mjs`).
- `prepublishOnly` runs `check` before any ordinary `npm publish`.
- `prepare` builds the package during local install and packing.
- `clean` removes only build output and root TypeScript build caches, using a
  portable Node.js script. `build:clean` cleans and builds without codegen.

`npm run test:package` installs a tarball into a temporary project, checks
TypeScript imports and runtime entry points, and confirms an upload with a
transactional callback. It pins the advertised minimum peers (`convex@1.46.0`
and `react@18.3.1`), including assertions that those versions were installed. It
requires registry access and removes its temporary project afterward.

## Building a one-off package

```sh
npm run build:clean
npm pack
```

You can then provide the .tgz file to others to install via
`npm install ./path/to/your-package.tgz`.
