// Command spark-cli is a terminal email client with AI-powered, Spark-style
// categorization. Categories are a local display grouping only — they are
// never written back to the mail server.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/iliutaadrian/spark-cli/internal/ai"
	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/store"
	"github.com/iliutaadrian/spark-cli/internal/tui"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "spark-cli:", err)
		os.Exit(1)
	}
}

func run() error {
	defaultCfg, _ := config.DefaultPath()
	cfgPath := flag.String("config", defaultCfg, "path to config.yaml")
	dbPath := flag.String("db", "", "path to local SQLite db (default: alongside config)")
	flag.Parse()

	// Load secrets from a .env file alongside the config (e.g. OPENAI_API_KEY).
	// A real environment variable always wins over the file.
	loadDotEnv(filepath.Join(filepath.Dir(*cfgPath), ".env"))

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return fmt.Errorf("%w\n\nCreate one at %s (see config.example.yaml)", err, *cfgPath)
	}

	dbFile := *dbPath
	if dbFile == "" {
		dbFile = filepath.Join(filepath.Dir(*cfgPath), "spark-cli.db")
	}
	if err := os.MkdirAll(filepath.Dir(dbFile), 0o755); err != nil {
		return err
	}

	st, err := store.Open(dbFile)
	if err != nil {
		return err
	}
	defer st.Close()

	// API key resolves from OPENAI_API_KEY when passed empty.
	cls := ai.New(os.Getenv("OPENAI_API_KEY"), cfg.Model)

	return tui.Run(st, cfg, cls, *cfgPath)
}

// loadDotEnv reads KEY=VALUE lines from path and sets each in the process
// environment unless that variable is already set (a real env var wins). A
// missing file is fine. Blank lines and # comments are ignored; matching quotes
// around a value are stripped.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, val)
		}
	}
}
