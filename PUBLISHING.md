# Publishing

Publish from a clean, committed worktree using an npm account allowed to publish
`convex-azure-blob`. Use Node.js 24, matching CI, and npm.

## First release

1. Confirm the name and version in `package.json`, and update `CHANGELOG.md`.
2. Run `npm ci` to install the committed dependency versions.
3. If component functions or the schema changed, run `npm run build:codegen` and
   commit the generated files. This requires a configured Convex development
   deployment; ordinary builds and publish checks use the committed bindings.
4. Run `npm run check`. This makes a clean build, runs tests, lint and type
   checks, then tests the packed package in an isolated consumer project.
5. Run the Azurite integration tests as described in
   [CONTRIBUTING.md](./CONTRIBUTING.md). CI also runs these before release.
6. Inspect `npm pack --dry-run` for unintended files.
7. Run `npm login`, then `npm publish --access public`. The publish hook repeats
   all required checks; do not bypass it with `--ignore-scripts`.
8. Tag the published commit with an annotated tag:
   `git tag -a v0.1.0 -m "Release 0.1.0"`, then `git push --follow-tags`.

Publish `0.1.0` directly for the initial release. `npm run release` increments
the patch version first, so it would publish `0.1.1`.

## Package scripts for releasing

- `check` performs a clean build, tests, lint, type checks and the packed
  consumer check.
- `preversion` runs `check` before `npm version` creates a version commit/tag.
- `prepublishOnly` runs `check` before any ordinary `npm publish`.
- `prepare` builds the package during local install and packing.
- `clean` removes only build output and root TypeScript build caches, using a
  portable Node.js script. `build:clean` cleans and builds without codegen.

`npm run test:package` installs a tarball into a temporary project, checks
TypeScript imports and runtime entry points, and confirms an upload with a
transactional callback. It pins the advertised minimum peers (`convex@1.46.0`
and `react@18.3.1`), including assertions that those versions were installed. It
requires registry access and removes its temporary project afterward.

## Deploying a new alpha version

```sh
npm run alpha
```

This will create a prerelease version with an `@alpha` tag. It will then publish
the package to npm and push the code and new tag. Users can install the package
with `npm install convex-azure-blob@alpha`.

## Deploying a new release version

```sh
npm run release
```

This will create a patch version and publish as `latest`. It will then publish
the package to npm and push the code and new tag. To publish a new minor or
major version, you can run the commands manually:

```sh
npm version minor # or major
npm publish
git push --follow-tags
```

## Building a one-off package

```sh
npm run build:clean
npm pack
```

You can then provide the .tgz file to others to install via
`npm install ./path/to/your-package.tgz`.
