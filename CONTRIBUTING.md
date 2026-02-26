# Contributing to MGW

Thanks for your interest in contributing to MGW. This document covers guidelines for working with the repository.

## Getting Started

1. Fork the repository and clone your fork
2. Install dependencies: `npm install`
3. Create a feature branch from `main`
4. Make your changes and test locally
5. Open a pull request against `main`

See the [README](README.md) for full installation and usage details.

## Branch Protection

The following branch protection settings are recommended for repo admins. These are **not enforced automatically** -- they must be configured manually in **Settings > Branches > Branch protection rules** for the `main` branch.

### Recommended Settings

- **Require a pull request before merging**
  - Enable "Require approvals" with at least 1 required reviewer
  - Enable "Dismiss stale pull request approvals when new commits are pushed"
  - Enable "Require review from Code Owners" (works with the `CODEOWNERS` file in this repo)

- **Require status checks to pass before merging**
  - Enable "Require branches to be up to date before merging"
  - Add any CI/CD checks as required status checks once they exist

- **Additional recommendations**
  - Enable "Require conversation resolution before merging" so review comments are addressed
  - Enable "Do not allow bypassing the above settings" to apply rules consistently, even for admins

### Why These Settings Matter

MGW uses a pipeline-driven workflow where issues flow through triage, execution, and PR creation. Branch protection ensures that every change -- whether authored by a human or the MGW pipeline -- goes through the same review and validation process before landing on `main`.
