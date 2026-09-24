# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First release.

### Added

- **Core:** `createPermissions()` with roles, permissions, direct user permissions, `can`,
  `canAny`, `canAll`, `canOwn`, `authorize`, `hasRole`, `hasAnyRole`, `hasAllRoles`,
  `getRoles`, `getPermissions({ expand })` and `sync()`.
- Wildcards: `"posts.*"` and `"*"`.
- Strict mode (on by default): unknown names throw with a "did you mean" suggestion.
- TypeScript autocomplete and compile errors for permission and role names.
- Typed errors (`PermissionDeniedError`, `RoleNotFoundError`, `PermissionNotFoundError`,
  `InvalidInputError`, base `PermissionsError`) with `isPermissionsError()` and
  `isPermissionDeniedError()` that work across CommonJS/ES module copies.
- Built-in per-process cache with TTL, automatic invalidation, and protection against
  caching reads that overlap a change.
- **Adapters:** memory, MySQL / MariaDB (`mysql2`), Postgres (`pg`), MongoDB (`mongodb` or
  `mongoose`). Concurrent `syncRoles()` / `syncPermissions()` are safe on all of them.
- **Express** middleware for Express 4 and 5: `requirePermission`, `requireAnyPermission`,
  `requireAllPermissions`, `requireRole`, `requireAnyRole`, `requireAllRoles`, and
  `permlyExpress()` guards including `own()` for ownership checks.
- **CLI:** `npx permly init` (migration file and starter setup file) and
  `npx permly migrate` (creates tables / collections, never prints passwords).
- Works with `require` and `import`, Node.js 18+, zero runtime dependencies.

[0.1.0]: https://github.com/PJPhukan/permly/releases/tag/v0.1.0
