# racevis

Visualize Go race conditions directly in VS Code.

Runs `go test -race` on your package and renders an ECG-style timeline 
showing goroutine collisions, collision zones, and source snippets.

## Usage

1. Open a Go project
2. `Cmd+Shift+P` → `racevis: Analyze current package`
3. The timeline opens in the right panel

## Requirements

- `racevis` binary on PATH: `go install github.com/bramakrishna16/racevis@latest`

## Settings

- `racevis.binaryPath` — path to binary (default: `racevis`)
- `racevis.target` — package to analyze (default: `.`)
