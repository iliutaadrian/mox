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

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/engine"
	"github.com/iliutaadrian/spark-cli/internal/mail"
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
	fetchOnly := flag.Bool("fetch", false, "fetch + store new mail only (no AI classification), then exit")
	syncOnly := flag.Bool("sync", false, "fetch + classify, then exit (headless backend for the Ink TUI)")
	mark := flag.String("mark", "", "mark -ids read|unread on the server, then exit")
	move := flag.String("move", "", "move -ids to this category (manual), then exit")
	idsCSV := flag.String("ids", "", "comma-separated local db message ids for -mark/-move")
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

	// Fetch-only: pull + store new mail for every account, no AI classification,
	// then exit. Per-account so one failure (e.g. a throttled server) doesn't
	// abort the rest. Lets the messages be analysed before spending on the AI.
	if *fetchOnly {
		total := 0
		for _, acc := range cfg.Accounts {
			n, err := mail.Sync(st, acc, cfg.FetchLimit, cfg.FetchSinceDays)
			total += n
			if err != nil {
				fmt.Fprintf(os.Stderr, "  %-10s error: %v (stored %d)\n", acc.Name, err, n)
				continue
			}
			fmt.Printf("  %-10s stored %d\n", acc.Name, n)
		}
		fmt.Printf("done — %d new messages stored (not classified)\n", total)
		return nil
	}

	// Headless backend modes for the Ink TUI. Each prints one summary line to
	// stdout and exits; errors go to stderr with exit code 1.
	switch {
	case *syncOnly:
		newMail, filed, err := engine.Refresh(st, cfg)
		if err != nil {
			return err
		}
		fmt.Printf("fetched=%d filed=%d\n", newMail, filed)
		return nil
	case *mark != "":
		ids, err := parseIDs(*idsCSV)
		if err != nil {
			return err
		}
		seen := *mark == "read"
		if !seen && *mark != "unread" {
			return fmt.Errorf("-mark must be read or unread")
		}
		n, err := markSeen(st, cfg, ids, seen)
		if err != nil {
			return err
		}
		fmt.Printf("marked=%d\n", n)
		return nil
	case *move != "":
		ids, err := parseIDs(*idsCSV)
		if err != nil {
			return err
		}
		if err := st.SetCategoryManual(ids, *move); err != nil {
			return err
		}
		fmt.Printf("moved=%d\n", len(ids))
		return nil
	}

	return tui.Run(st, cfg, *cfgPath)
}

func parseIDs(csv string) ([]int64, error) {
	if strings.TrimSpace(csv) == "" {
		return nil, fmt.Errorf("-ids required")
	}
	var ids []int64
	for _, part := range strings.Split(csv, ",") {
		var id int64
		if _, err := fmt.Sscanf(strings.TrimSpace(part), "%d", &id); err != nil || id <= 0 {
			return nil, fmt.Errorf("bad id %q", part)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// markSeen sets \Seen on the server for the given db ids (grouped by account,
// one connection each) and mirrors the flag locally. Same behavior as the Go
// TUI's M/U keys.
func markSeen(st *store.Store, cfg *config.Config, ids []int64, seen bool) (int, error) {
	msgs, err := st.All()
	if err != nil {
		return 0, err
	}
	byID := make(map[int64]store.Message, len(msgs))
	for _, m := range msgs {
		byID[m.ID] = m
	}
	accByName := make(map[string]config.Account, len(cfg.Accounts))
	for _, a := range cfg.Accounts {
		accByName[a.Name] = a
	}
	uidsByAcc := map[string][]uint32{}
	idsByAcc := map[string][]int64{}
	for _, id := range ids {
		m, ok := byID[id]
		if !ok {
			return 0, fmt.Errorf("unknown id %d", id)
		}
		uidsByAcc[m.Account] = append(uidsByAcc[m.Account], m.UID)
		idsByAcc[m.Account] = append(idsByAcc[m.Account], id)
	}
	n := 0
	for accName, uids := range uidsByAcc {
		acc, ok := accByName[accName]
		if !ok {
			return n, fmt.Errorf("account %q not in config", accName)
		}
		if err := mail.SetSeen(acc, uids, seen); err != nil {
			return n, err
		}
		for _, id := range idsByAcc[accName] {
			if err := st.SetSeen(id, seen); err != nil {
				return n, err
			}
		}
		n += len(uids)
	}
	return n, nil
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
