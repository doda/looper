# Contributing to Looper

Thank you for your interest in contributing to Looper! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/looper.git`
3. Install dependencies: `pnpm install`
4. Create a branch for your changes: `git checkout -b my-feature`

## Development

### Prerequisites

- Node.js 22+
- pnpm

### Running Tests

```bash
pnpm test
```

### Type Checking

```bash
pnpm lint
```

### Code Style

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Keep code simple and auditable
- Follow existing patterns in the codebase

## Submitting Changes

1. Ensure all tests pass: `pnpm test`
2. Ensure type checking passes: `pnpm lint`
3. Write clear commit messages
4. Push to your fork and open a Pull Request

### Pull Request Guidelines

- Describe what your PR does and why
- Reference any related issues
- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality

## Reporting Issues

When reporting issues, please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Node.js version
- Operating system

## Questions?

Feel free to open an issue for questions or discussion.

