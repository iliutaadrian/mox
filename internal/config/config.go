// Package config loads spark-cli's YAML configuration: mail accounts, the
// fixed category set, and model selection.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Account is a single IMAP/SMTP mailbox. spark-cli only ever reads from IMAP;
// SMTP settings are used solely for sending AI reply drafts (a later feature).
type Account struct {
	Name     string `yaml:"name"` // display name, e.g. "Work"
	IMAPHost string `yaml:"imap_host"`
	IMAPPort int    `yaml:"imap_port"` // default 993
	IMAPUser string `yaml:"imap_user"`
	IMAPPass string `yaml:"imap_pass"`
	Mailbox  string `yaml:"mailbox"` // default "INBOX"

	SMTPHost string `yaml:"smtp_host,omitempty"`
	SMTPPort int    `yaml:"smtp_port,omitempty"`
	SMTPUser string `yaml:"smtp_user,omitempty"`
	SMTPPass string `yaml:"smtp_pass,omitempty"`
	From     string `yaml:"from,omitempty"`
}

// Category is one bucket in the fixed set. The Description is fed to the model
// so it can decide which bucket an email belongs in. A category may also carry
// deterministic sender Match rules; when an email's sender matches, it is
// assigned to that category WITHOUT consulting the AI.
type Category struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description,omitempty"`
	Match       *Match `yaml:"match,omitempty"`
}

// Match holds deterministic sender rules for a category. A category with any
// rule is a "manual" (rule-based) category; one without is AI-only.
type Match struct {
	Domains   []string `yaml:"domains,omitempty"`   // e.g. github.com (matches user@github.com and sub.github.com)
	Addresses []string `yaml:"addresses,omitempty"` // exact sender address, e.g. alerts@honeybadger.io
}

// HasRules reports whether this category assigns mail deterministically by
// sender (i.e. it is a manual/rule category rather than an AI one).
func (c Category) HasRules() bool {
	return c.Match != nil && (len(c.Match.Domains) > 0 || len(c.Match.Addresses) > 0)
}

// MatchCategory returns the name of the first category whose sender rule matches
// fromAddr, or "" if none do. Exact-address rules take precedence over domain
// rules; within each kind, categories are checked in config order.
func (c *Config) MatchCategory(fromAddr string) string {
	addr := strings.ToLower(strings.TrimSpace(fromAddr))
	if addr == "" {
		return ""
	}
	domain := addr
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		domain = addr[i+1:]
	}
	for _, cat := range c.Categories { // addresses first
		if cat.Match == nil {
			continue
		}
		for _, a := range cat.Match.Addresses {
			if strings.ToLower(strings.TrimSpace(a)) == addr {
				return cat.Name
			}
		}
	}
	for _, cat := range c.Categories { // then domains (incl. subdomains)
		if cat.Match == nil {
			continue
		}
		for _, d := range cat.Match.Domains {
			d = strings.ToLower(strings.TrimSpace(d))
			if d != "" && (domain == d || strings.HasSuffix(domain, "."+d)) {
				return cat.Name
			}
		}
	}
	return ""
}

// DomainOf returns the lowercased domain part of an email address, or "".
func DomainOf(fromAddr string) string {
	addr := strings.ToLower(strings.TrimSpace(fromAddr))
	if i := strings.LastIndex(addr, "@"); i >= 0 {
		return addr[i+1:]
	}
	return ""
}

// Config is the whole configuration file.
type Config struct {
	Accounts   []Account  `yaml:"accounts"`
	Categories []Category `yaml:"categories"`

	// FetchLimit caps how many recent messages to pull on a cold mailbox
	// (first sync). Defaults to 200. Ignored when FetchSinceDays > 0.
	FetchLimit int `yaml:"fetch_limit"`

	// FetchSinceDays, when > 0, fetches all messages received within this many
	// days (e.g. 730 = last 2 years) instead of using FetchLimit.
	FetchSinceDays int `yaml:"fetch_since_days"`
}

// DefaultPath returns the config path. For now it lives in the current working
// directory (./config.yaml) so the app can be tested from the project folder
// without a system-wide install. The local SQLite db lands alongside it.
func DefaultPath() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.yaml"), nil
}

// Load reads and validates the config at path.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) applyDefaults() {
	if c.FetchLimit == 0 {
		c.FetchLimit = 200
	}
	for i := range c.Accounts {
		// Trim stray whitespace that creeps into hand-edited configs — a trailing
		// space in imap_user makes some IMAP servers reject the login.
		c.Accounts[i].IMAPUser = strings.TrimSpace(c.Accounts[i].IMAPUser)
		c.Accounts[i].IMAPHost = strings.TrimSpace(c.Accounts[i].IMAPHost)
		c.Accounts[i].Name = strings.TrimSpace(c.Accounts[i].Name)
		c.Accounts[i].Mailbox = strings.TrimSpace(c.Accounts[i].Mailbox)
		if c.Accounts[i].IMAPPort == 0 {
			c.Accounts[i].IMAPPort = 993
		}
		if c.Accounts[i].Mailbox == "" {
			c.Accounts[i].Mailbox = "INBOX"
		}
	}
}

func (c *Config) validate() error {
	if len(c.Accounts) == 0 {
		return fmt.Errorf("config has no accounts")
	}
	if len(c.Categories) == 0 {
		return fmt.Errorf("config has no categories")
	}
	for i, a := range c.Accounts {
		if a.Name == "" {
			return fmt.Errorf("account %d: name is required", i)
		}
		if a.IMAPHost == "" || a.IMAPUser == "" {
			return fmt.Errorf("account %q: imap_host and imap_user are required", a.Name)
		}
	}
	for i, cat := range c.Categories {
		if cat.Name == "" {
			return fmt.Errorf("category %d: name is required", i)
		}
	}
	return nil
}

// CategoryNames returns the configured category names in order.
func (c *Config) CategoryNames() []string {
	names := make([]string, len(c.Categories))
	for i, cat := range c.Categories {
		names[i] = cat.Name
	}
	return names
}

// AddSenderRule appends domains and/or addresses to categoryName's match block
// in the YAML file at path, creating the match block if needed, de-duplicating
// existing entries, and preserving the file's comments and formatting. The
// category must already exist in the file.
func AddSenderRule(path, categoryName string, domains, addresses []string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read config %s: %w", path, err)
	}
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return fmt.Errorf("parse config: %w", err)
	}
	if len(root.Content) == 0 || root.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("unexpected config structure")
	}
	doc := root.Content[0]

	catsNode := mapValue(doc, "categories")
	if catsNode == nil || catsNode.Kind != yaml.SequenceNode {
		return fmt.Errorf("config has no categories list")
	}
	var catMap *yaml.Node
	for _, item := range catsNode.Content {
		if item.Kind == yaml.MappingNode && scalarValue(mapValue(item, "name")) == categoryName {
			catMap = item
			break
		}
	}
	if catMap == nil {
		return fmt.Errorf("category %q not found in %s", categoryName, path)
	}

	matchNode := mapValue(catMap, "match")
	if matchNode == nil {
		matchNode = &yaml.Node{Kind: yaml.MappingNode}
		catMap.Content = append(catMap.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Value: "match"}, matchNode)
	}
	appendToSeq(matchNode, "domains", domains)
	appendToSeq(matchNode, "addresses", addresses)

	out, err := yaml.Marshal(&root)
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	return os.WriteFile(path, out, 0o644)
}

// mapValue returns the value node for key in a mapping node, or nil.
func mapValue(m *yaml.Node, key string) *yaml.Node {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

func scalarValue(n *yaml.Node) string {
	if n == nil {
		return ""
	}
	return n.Value
}

// appendToSeq adds values (deduped against existing) to the named sequence under
// mapping m, creating the sequence if absent. No-op when values is empty.
func appendToSeq(m *yaml.Node, key string, values []string) {
	if len(values) == 0 {
		return
	}
	seq := mapValue(m, key)
	if seq == nil {
		seq = &yaml.Node{Kind: yaml.SequenceNode}
		m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, seq)
	}
	existing := map[string]bool{}
	for _, item := range seq.Content {
		existing[strings.ToLower(item.Value)] = true
	}
	for _, v := range values {
		v = strings.ToLower(strings.TrimSpace(v))
		if v == "" || existing[v] {
			continue
		}
		existing[v] = true
		seq.Content = append(seq.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: v})
	}
}
