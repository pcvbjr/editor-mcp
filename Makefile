PNPM ?= pnpm

.DEFAULT_GOAL := help

.PHONY: help setup install build clean format format-check lint test test-watch coverage typecheck check

help:
	@printf '%s\n' \
		'Available targets:' \
		'  setup         Install dependencies and update the lockfile' \
		'  install       Install exactly from the lockfile' \
		'  build         Build TypeScript projects' \
		'  typecheck     Check TypeScript without emitting files' \
		'  lint          Run ESLint' \
		'  format        Format tracked project files' \
		'  format-check  Verify formatting' \
		'  test          Run tests once' \
		'  test-watch    Run tests in watch mode' \
		'  coverage      Run tests with V8 coverage' \
		'  check         Run all pre-commit checks' \
		'  clean         Remove TypeScript build outputs'

setup:
	$(PNPM) install

install:
	$(PNPM) install --frozen-lockfile

build:
	$(PNPM) build

clean:
	$(PNPM) clean

format:
	$(PNPM) format

format-check:
	$(PNPM) format:check

lint:
	$(PNPM) lint

test:
	$(PNPM) test

test-watch:
	$(PNPM) test:watch

coverage:
	$(PNPM) test:coverage

typecheck:
	$(PNPM) typecheck

check:
	$(PNPM) check
