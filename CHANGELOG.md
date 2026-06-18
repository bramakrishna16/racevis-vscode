# Change Log

All notable changes to the "racevis" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.3] - 2026-06-18

- Automatically resolves a useful Go package when the active file's package has no `_test.go` files.
- Shows visualized tests only: tests involved in a race event or represented by goroutine creation stacks in the runtime trace.
- Fixes internal/runtime/database goroutines being mislabeled as test cases.
- Shortens race stack labels so the UI shows the relevant function or test name instead of the full module path.

## [0.0.2]

- Initial Marketplace package.
