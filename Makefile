PNPM ?= pnpm

.DEFAULT_GOAL := help

.PHONY: help setup install build clean format format-check lint test test-watch coverage typecheck check mcp-inspect mcp-http demo demo-dev

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
		'  mcp-inspect   Build and open the MCP server in Inspector' \
		'  mcp-http      Build and run the local Streamable HTTP MCP server' \
		'  demo          Build and run the collaborative editor demo' \
		'  demo-dev      Run the demo server and web client in development' \
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

mcp-inspect:
	$(PNPM) mcp:inspect

mcp-http:
	$(PNPM) mcp:http

demo:
	$(PNPM) demo

demo-dev:
	$(PNPM) demo:dev

typecheck:
	$(PNPM) typecheck

check:
	$(PNPM) check
