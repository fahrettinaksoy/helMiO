# Contributing to Helmio

First off, thank you for taking the time to contribute! 🎉 Helmio is an
open-source, multi-server Supervisor management platform and every issue, idea
and pull request helps.

This document explains how to set up the project, the conventions we follow and
how to get your changes merged.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Project layout](#project-layout)
- [Local development setup](#local-development-setup)
- [Coding standards](#coding-standards)
- [Commit messages](#commit-messages)
- [Pull request process](#pull-request-process)
- [Reporting bugs & requesting features](#reporting-bugs--requesting-features)
- [Security issues](#security-issues)

## Code of Conduct

This project and everyone participating in it is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to
uphold it.

## Ways to contribute

- 🐛 Report bugs and regressions.
- 💡 Propose features or improvements.
- 📖 Improve documentation (including the Turkish `README.tr.md`).
- 🌐 Add or improve translations under `frontend/src/i18n/locales/`.
- 🔧 Submit code: bug fixes, connectors, panels, tests.

## Project layout

Helmio is an npm **workspaces** monorepo:

| Path             | Package            | Description                                  |
| ---------------- | ------------------ | -------------------------------------------- |
| `backend/`       | `@helmio/backend`  | Node.js API, connectors, realtime, services. |
| `frontend/`      | `@helmio/frontend` | Vue 3 + Vuetify panel.                       |
| `agent/`         | `@helmio/agent`    | Lightweight server-side agent.               |
| `eventlistener/` | —                  | Python Supervisor event listener.            |
| `test/`          | —                  | Smoke tests & Docker harness.                |

## Local development setup

**Prerequisites:** Node.js `>= 20` (see [`.nvmrc`](.nvmrc)) and npm `>= 9`.
Python 3 is only needed if you work on the event listener.

```bash
# 1) Clone your fork
git clone https://github.com/<your-username>/helMiO.git
cd helMiO

# 2) Install all workspace dependencies
npm install

# 3) Copy environment templates and fill in values
cp backend/.env.example backend/.env
cp agent/.env.example agent/.env

# 4) Run backend (:3001) + frontend (:5173) together
npm run dev
```

Useful scripts (root `package.json`):

```bash
npm run dev          # backend + frontend in watch mode
npm run dev:backend  # backend only
npm run dev:frontend # frontend only
npm run build        # build the frontend
npm run lint         # run ESLint across the repo
npm run format       # format with Prettier
npm test             # run the smoke test
```

## Coding standards

- **Formatting** is enforced by [Prettier](https://prettier.io). Run
  `npm run format` before committing.
- **Linting** is enforced by [ESLint](https://eslint.org). CI fails on lint
  errors — run `npm run lint` locally.
- Match the style of the surrounding code (naming, structure, comment density).
- Keep changes focused; unrelated refactors belong in separate PRs.
- Add or update tests when you change behaviour.

An [`.editorconfig`](.editorconfig) is provided so most editors pick up
indentation and line-ending rules automatically.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(optional scope): <short summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`,
`perf`, `build`.

Examples:

```
feat(backend): add SSH unix-socket connector retry logic
fix(frontend): correct donut chart legend overflow
docs: clarify TCP XML-RPC prerequisites
```

## Pull request process

1. Fork the repo and create a topic branch off `main`
   (`git checkout -b feat/my-change`).
2. Make your changes, including tests and docs where relevant.
3. Ensure `npm run lint` and `npm test` pass locally.
4. Push to your fork and open a PR against `main`.
5. Fill out the PR template and link any related issues
   (`Closes #123`).
6. A maintainer will review; please be responsive to feedback. Once approved
   and CI is green, it will be merged.

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers the project.

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/fahrettinaksoy/helMiO/issues/new/choose).
Please search existing issues first to avoid duplicates, and include version,
environment and reproduction steps for bugs.

## Security issues

**Do not** report security vulnerabilities through public issues. See our
[Security Policy](SECURITY.md) for private disclosure instructions.
