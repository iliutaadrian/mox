// Package store is the local SQLite database. It holds fetched messages and
// their AI-assigned category. The category lives ONLY here — it is never
// written back to the mail server (the Spark-style "categorize, don't label"
// rule). The server side stays read-only.
package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// SuggestedPseudoCategory is the bucket shown in the UI for messages whose AI
// classification proposed a brand-new category that the user hasn't approved
// yet. It is not a real configured category.
const SuggestedPseudoCategory = "Suggested"

// Uncategorized is the display bucket for messages not yet classified.
const Uncategorized = "Uncategorized"

// Message is one email plus its local-only AI fields.
type Message struct {
	ID        int64
	Account   string
	Mailbox   string
	UID       uint32
	MessageID string
	FromAddr  string
	FromName  string
	Subject   string
	Date      time.Time
	Snippet   string
	Body      string // plain-text rendering (for reading pane + AI)
	HTML      string // full original HTML part, if any (for browser view)
	Seen      bool

	// Local-only AI fields.
	Category     string // "" = unclassified
	Confidence   string
	SuggestedNew string // non-empty => AI proposed a new bucket, pending approval
	Source       string // how Category was set: "rule", "ai", "manual", or ""
	ClassifiedAt time.Time
}

// Classification source values stored in the source column.
const (
	SourceRule   = "rule"
	SourceAI     = "ai"
	SourceManual = "manual"
)

// Store wraps the SQLite connection.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the database at path and applies migrations.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// modernc sqlite is single-connection friendly; keep it simple.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account       TEXT NOT NULL,
    mailbox       TEXT NOT NULL,
    uid           INTEGER NOT NULL,
    message_id    TEXT,
    from_addr     TEXT,
    from_name     TEXT,
    subject       TEXT,
    date          INTEGER,
    snippet       TEXT,
    body          TEXT,
    html          TEXT,
    seen          INTEGER NOT NULL DEFAULT 0,
    category      TEXT,
    confidence    TEXT,
    suggested_new TEXT,
    source        TEXT,
    classified_at INTEGER,
    UNIQUE(account, mailbox, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category);
CREATE INDEX IF NOT EXISTS idx_messages_unclassified ON messages(category) WHERE category IS NULL;

CREATE TABLE IF NOT EXISTS sync_state (
    account      TEXT NOT NULL,
    mailbox      TEXT NOT NULL,
    uid_validity INTEGER NOT NULL DEFAULT 0,
    last_uid     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account, mailbox)
);

CREATE TABLE IF NOT EXISTS approved_categories (
    name        TEXT PRIMARY KEY,
    description TEXT,
    created_at  INTEGER
);`
	_, err := s.db.Exec(schema)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	// Upgrade older databases: add columns introduced later. SQLite errors if
	// the column already exists, which is fine to ignore.
	s.db.Exec(`ALTER TABLE messages ADD COLUMN source TEXT`)
	s.db.Exec(`ALTER TABLE messages ADD COLUMN html TEXT`)
	return nil
}

// --- sync state ---

// SyncState returns the stored UIDVALIDITY and highest seen UID for a mailbox.
// Returns zeros if the mailbox has never been synced.
func (s *Store) SyncState(account, mailbox string) (uidValidity, lastUID uint32, err error) {
	row := s.db.QueryRow(
		`SELECT uid_validity, last_uid FROM sync_state WHERE account=? AND mailbox=?`,
		account, mailbox)
	var v, l int64
	switch err = row.Scan(&v, &l); err {
	case nil:
		return uint32(v), uint32(l), nil
	case sql.ErrNoRows:
		return 0, 0, nil
	default:
		return 0, 0, err
	}
}

// SetSyncState records the UIDVALIDITY and highest seen UID for a mailbox.
func (s *Store) SetSyncState(account, mailbox string, uidValidity, lastUID uint32) error {
	_, err := s.db.Exec(`
INSERT INTO sync_state(account, mailbox, uid_validity, last_uid)
VALUES(?,?,?,?)
ON CONFLICT(account, mailbox) DO UPDATE SET uid_validity=excluded.uid_validity, last_uid=excluded.last_uid`,
		account, mailbox, int64(uidValidity), int64(lastUID))
	return err
}

// ResetMailbox clears stored messages and sync state for a mailbox. Used when
// the server reports a UIDVALIDITY change (UIDs are no longer comparable).
func (s *Store) ResetMailbox(account, mailbox string) error {
	if _, err := s.db.Exec(`DELETE FROM messages WHERE account=? AND mailbox=?`, account, mailbox); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM sync_state WHERE account=? AND mailbox=?`, account, mailbox)
	return err
}

// --- messages ---

// InsertMessage inserts a fetched message. Existing (account,mailbox,uid) rows
// are left untouched so AI fields survive re-fetches. Returns true if inserted.
func (s *Store) InsertMessage(m *Message) (bool, error) {
	res, err := s.db.Exec(`
INSERT INTO messages(account, mailbox, uid, message_id, from_addr, from_name, subject, date, snippet, body, html, seen)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(account, mailbox, uid) DO NOTHING`,
		m.Account, m.Mailbox, int64(m.UID), m.MessageID, m.FromAddr, m.FromName,
		m.Subject, m.Date.Unix(), m.Snippet, m.Body, m.HTML, boolToInt(m.Seen))
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Unclassified returns up to limit messages with no AI category yet, newest first.
func (s *Store) Unclassified(limit int) ([]Message, error) {
	rows, err := s.db.Query(`
SELECT id, account, mailbox, uid, message_id, from_addr, from_name, subject, date, snippet, body, seen
FROM messages WHERE category IS NULL ORDER BY date DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var date int64
		var seen int
		if err := rows.Scan(&m.ID, &m.Account, &m.Mailbox, &m.UID, &m.MessageID,
			&m.FromAddr, &m.FromName, &m.Subject, &date, &m.Snippet, &m.Body, &seen); err != nil {
			return nil, err
		}
		m.Date = time.Unix(date, 0)
		m.Seen = seen != 0
		out = append(out, m)
	}
	return out, rows.Err()
}

// SetClassification writes a classification result for a message (local only).
// If suggestedNew is non-empty, category is stored as the Suggested pseudo-bucket.
// source records how the category was decided ("rule", "ai", or "manual").
func (s *Store) SetClassification(id int64, category, confidence, suggestedNew, source string) error {
	_, err := s.db.Exec(`
UPDATE messages SET category=?, confidence=?, suggested_new=?, source=?, classified_at=? WHERE id=?`,
		category, confidence, suggestedNew, source, time.Now().Unix(), id)
	return err
}

// ClearCategory resets the given messages to unclassified so the next classify
// run re-evaluates them (rules first, then AI). No-op for an empty slice.
func (s *Store) ClearCategory(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	q := `UPDATE messages SET category=NULL, confidence=NULL, suggested_new=NULL, source=NULL, classified_at=NULL WHERE id IN (` + placeholders(len(ids)) + `)`
	_, err := s.db.Exec(q, idArgs(ids)...)
	return err
}

// SetCategoryManual assigns the given messages directly to category with no AI,
// marking them as manually set. No-op for an empty slice.
func (s *Store) SetCategoryManual(ids []int64, category string) error {
	if len(ids) == 0 {
		return nil
	}
	args := append([]any{category, time.Now().Unix()}, idArgs(ids)...)
	q := `UPDATE messages SET category=?, confidence='high', suggested_new='', source='` + SourceManual + `', classified_at=? WHERE id IN (` + placeholders(len(ids)) + `)`
	_, err := s.db.Exec(q, args...)
	return err
}

// All returns every message, newest first.
func (s *Store) All() ([]Message, error) {
	rows, err := s.db.Query(`
SELECT id, account, mailbox, uid, message_id, from_addr, from_name, subject, date, snippet, body, COALESCE(html,''), seen,
       COALESCE(category,''), COALESCE(confidence,''), COALESCE(suggested_new,''), COALESCE(source,''), COALESCE(classified_at,0)
FROM messages ORDER BY date DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Message
	for rows.Next() {
		var m Message
		var date, classified int64
		var seen int
		if err := rows.Scan(&m.ID, &m.Account, &m.Mailbox, &m.UID, &m.MessageID,
			&m.FromAddr, &m.FromName, &m.Subject, &date, &m.Snippet, &m.Body, &m.HTML, &seen,
			&m.Category, &m.Confidence, &m.SuggestedNew, &m.Source, &classified); err != nil {
			return nil, err
		}
		m.Date = time.Unix(date, 0)
		m.Seen = seen != 0
		if classified > 0 {
			m.ClassifiedAt = time.Unix(classified, 0)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// --- approved categories (promoted from AI suggestions) ---

// ApprovedCategories returns category names the user promoted from suggestions.
func (s *Store) ApprovedCategories() ([]string, error) {
	rows, err := s.db.Query(`SELECT name FROM approved_categories ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// PromoteSuggestion approves a suggested category: it becomes a real category,
// and every message currently parked under that suggestion moves into it.
func (s *Store) PromoteSuggestion(name, description string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
INSERT INTO approved_categories(name, description, created_at) VALUES(?,?,?)
ON CONFLICT(name) DO NOTHING`, name, description, time.Now().Unix()); err != nil {
		return err
	}
	if _, err := tx.Exec(`
UPDATE messages SET category=?, suggested_new='' WHERE suggested_new=?`, name, name); err != nil {
		return err
	}
	return tx.Commit()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// placeholders returns "?,?,...,?" with n placeholders for an IN clause.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// idArgs converts message IDs to a []any for use as query arguments.
func idArgs(ids []int64) []any {
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return args
}
