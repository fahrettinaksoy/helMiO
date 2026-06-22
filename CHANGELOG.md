# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Open-source project hygiene: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, `CHANGELOG.md`.
- ESLint (flat config) + Prettier + `.editorconfig` with `lint`/`format` scripts.
- GitHub Actions CI (lint, build and smoke tests on Node 20 & 22; Python syntax
  check for the event listener).
- Docker support: `Dockerfile`, `docker-compose.yml` and `.dockerignore`.
- Issue/PR templates, Dependabot configuration and `CODEOWNERS`.

### Changed

- Removed committed `.DS_Store` files and ignored them going forward.

## [0.1.0] - 2026-06-22

### Added

- Initial public release of Helmio — a multi-server Supervisor management
  dashboard.
- Backend API (`@helmio/backend`): authentication, RBAC, audit log, API tokens,
  notification channels, health checks with auto-restart, and fleet
  orchestration.
- Multiple connectors: TCP XML-RPC, SSH Unix socket, local, Docker and the
  Helmio agent.
- Frontend dashboard (`@helmio/frontend`): Vue 3 + Vuetify UI with realtime
  updates over Socket.IO, bilingual (EN/TR).
- Helmio Agent (`@helmio/agent`) and a Supervisor event listener bridge.

[Unreleased]: https://github.com/fahrettinaksoy/helmio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fahrettinaksoy/helmio/releases/tag/v0.1.0
