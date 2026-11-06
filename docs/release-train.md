# Release train — publishing & consuming `@platform/*` packages

How `@platform/*` packages are versioned, published, and consumed
(ADR-012 §2: coordinated releases — one train for all packages, changelog
per release, breaking changes require a major bump + decision-record
reference).

## One-time prerequisites (owner actions)

1. **Register the GitHub org `platform` and transfer this repo into it.**

   GitHub Packages' npm registry requires the npm scope to equal the GitHub
   account that owns the publishing repo. `@platform/*` can therefore only be
   published from an account literally named `platform` (constraint + decision
   recorded in ADR-012, resolved 2026-11-06; the account was unregistered at
   the time of writing — `api.github.com/users/platform` → 404).

   Until the transfer, `.github/workflows/release.yml` is a deliberate no-op
   (`repository_owner == 'platform'` guard) and nothing can publish.

   - Transfer notes: Actions secrets/variables and branch protection carry
     over with the repo; re-verify branch protection after the transfer and
     update local remotes (old URLs redirect).
   - **Fallback rule** (if `platform` turns out to be unavailable/reserved):
     decide the final org name first, then rename the npm scope corpus-wide
     in the same pass (ADRs, requirements, package manifests, imports).
     Zero packages are published and zero consumers exist today, so the
     rename is cheap now and a breaking change after the first publish.
     Do NOT fall back to a personal-account scope (`@oliverlubinus/*`) or
     per-dependency `npm:` alias shims — both couple every app to a personal
     account and turn any later org move into a breaking rename.
2. **Org workflow permissions:** allow GitHub Actions read/write. The
   release workflow declares `packages: write` + `contents: write`, so the
   workflow's `GITHUB_TOKEN` is a valid publish credential — no PAT
   bootstrap in CI (R-ENV-03: secrets live outside repos). `release.yml`
   passes `registry-url` to `actions/setup-node`, which writes the
   user-level `~/.npmrc` auth line from `NODE_AUTH_TOKEN`.

## Publishing (the train)

- Every PR that should change a package version adds a changeset:
  `pnpm changeset` → commit the generated `.changeset/*.md` with the PR.
- Merge to `main` → `release.yml` opens/updates the **Version Packages** PR.
  All `@platform/*` versions move together (`fixed` grouping in
  `.changeset/config.json` — one train, ADR-012 §2) with a generated
  changelog.
- Merge that PR → `release.yml` re-runs the CI gates (typecheck/test/build)
  and then `pnpm release` (`changeset publish`): publishes every package
  whose version is ahead of the registry and pushes `name@version` tags.
- **Initial publish (v0.1.0):** server-core is already at 0.1.0 and the
  registry has no versions yet. The first post-transfer merge to `main`
  publishes it automatically (the train publishes every version the registry
  does not have yet). To control the timing instead, publish manually before
  merging anything:

  ```powershell
  $env:NODE_AUTH_TOKEN = "<classic PAT with write:packages>"  # tool-managed credential, never committed (R-ENV-03)
  pnpm release
  ```

  From then on the train is the only publish path (ADR-012 §2: hotfixes
  ride the next train or an explicitly expedited release).
- **Pre-first-release quirk:** until the first release tag exists, every
  commit counts as "changed" — `pnpm changeset status` errors with "no
  changesets found" even on a clean tree. Expected; it self-corrects after
  the first publish.

## Consuming (app repos)

`pnpm add @platform/server-core` resolves from GitHub Packages once:

1. The app repo carries a committed `.npmrc` with the scope mapping and the
   env-var token reference (no token value in the repo):

   ```
   @platform:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
   ```

2. Auth:
   - **App CI:** grant the consuming repo read access to the package
     (package → "Manage access", or the org-level default for new packages),
     then give the workflow a token: `actions/setup-node` with
     `registry-url: https://npm.pkg.github.com` writes the user-level
     `~/.npmrc` auth line from `NODE_AUTH_TOKEN`
     (`${{ secrets.GITHUB_TOKEN }}` works once access is granted). pnpm
     deliberately ignores repo-level env-var auth tokens — the token line
     never belongs in the committed `.npmrc`.
   - **Local dev:** a classic PAT with `read:packages` lives in the
     tool-managed credentials store outside VCS (R-ENV-03) and goes into the
     user-level `~/.npmrc` — never into a repo.
3. Version pinning: apps pin majors (N/N-1 policy, integration contract) —
   caret ranges within the current major (`^0.1.0`) are correct.

## Guard-rails

- **Scope == owner account.** The npm scope and the owning GitHub account
  change together or not at all (ADR-012, 2026-11-06).
- **Publishable manifests:** no `workspace:` protocol ranges (the publish
  step is npm-based and cannot resolve them — peerDependencies carry real
  semver ranges), no `private: true`, and `repository.url` must match the
  publishing repo (update it in the same commit as an org transfer).
- **Non-publication packages** (scaffolds/templates, e.g. app-template
  until it ships as a consumer-facing artifact) stay `private: true` and
  are excluded from the train by design.
- The train publishes only from `main` after all gates are green.
