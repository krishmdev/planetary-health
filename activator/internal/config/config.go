// Package config loads activator.yaml.
package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Mode string

const (
	// ModeAlwaysOn keeps everything running; the proxy path is identical so overhead matches.
	ModeAlwaysOn Mode = "always_on"
	// ModeAPI scales only the per-org gateway containers to zero.
	ModeAPI Mode = "api"
	// ModeFull also scales the endorsement group (peers + chaincode containers) to zero.
	ModeFull Mode = "full"
)

type Strategy string

const (
	StrategyStop  Strategy = "stop"
	StrategyPause Strategy = "pause"
)

type JWT struct {
	Issuer    string `yaml:"issuer"`
	Audience  string `yaml:"audience"`
	SecretEnv string `yaml:"secret_env"`
	Secret    string `yaml:"-"`
}

type API struct {
	Name      string `yaml:"name"`
	Listen    string `yaml:"listen"`
	Upstream  string `yaml:"upstream"`
	Container string `yaml:"container"`
	Readiness string `yaml:"readiness"`
	Group     string `yaml:"group"`
	JWT       JWT    `yaml:"jwt"`
}

type Peer struct {
	Name            string `yaml:"name"`
	Container       string `yaml:"container"`
	Ops             string `yaml:"ops"`
	ChaincodePrefix string `yaml:"chaincode_prefix"`
}

// Group is an endorsement group: every peer that must endorse a transaction on the channel.
// With MAJORITY of two orgs that is both orgs' peers, so waking one org's API in full mode
// wakes the whole group.
type Group struct {
	Channel string `yaml:"channel"`
	Peers   []Peer `yaml:"peers"`
}

type Config struct {
	AdminListen        string           `yaml:"admin_listen"`
	DockerSocket       string           `yaml:"docker_socket"`
	Mode               Mode             `yaml:"mode"`
	Strategy           Strategy         `yaml:"strategy"`
	IdleTimeout        time.Duration    `yaml:"idle_timeout"`
	PeerIdleTimeout    time.Duration    `yaml:"peer_idle_timeout"`
	WakeTimeout        time.Duration    `yaml:"wake_timeout"`
	MaxConcurrentWakes int              `yaml:"max_concurrent_wakes"`
	QueueLimit         int              `yaml:"queue_limit"`
	LoginBurst         int              `yaml:"login_burst"`
	LoginPerSecond     float64          `yaml:"login_per_second"`
	TrustedProxies     []string         `yaml:"trusted_proxies"`
	AdminToken         string           `yaml:"-"`
	APIs               []API            `yaml:"apis"`
	Groups             map[string]Group `yaml:"groups"`
}

func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(b, os.Getenv)
}

func Parse(b []byte, getenv func(string) string) (*Config, error) {
	c := &Config{
		AdminListen: ":8090", DockerSocket: "/var/run/docker.sock", Mode: ModeAPI, Strategy: StrategyStop,
		IdleTimeout: 60 * time.Second, PeerIdleTimeout: 300 * time.Second, WakeTimeout: 90 * time.Second,
		MaxConcurrentWakes: 4, QueueLimit: 256, LoginBurst: 5, LoginPerSecond: 0.5,
	}
	if err := yaml.Unmarshal(b, c); err != nil {
		return nil, err
	}
	// The admin API can stop containers, so it needs a token (X-Activator-Token).
	c.AdminToken = getenv("ACTIVATOR_ADMIN_TOKEN")
	if m := getenv("ACTIVATOR_MODE"); m != "" {
		c.Mode = Mode(m)
	}
	if s := getenv("ACTIVATOR_STRATEGY"); s != "" {
		c.Strategy = Strategy(s)
	}
	if d := getenv("ACTIVATOR_IDLE_TIMEOUT"); d != "" {
		v, err := time.ParseDuration(d)
		if err != nil {
			return nil, fmt.Errorf("ACTIVATOR_IDLE_TIMEOUT: %w", err)
		}
		c.IdleTimeout = v
	}
	if d := getenv("ACTIVATOR_PEER_IDLE_TIMEOUT"); d != "" {
		v, err := time.ParseDuration(d)
		if err != nil {
			return nil, fmt.Errorf("ACTIVATOR_PEER_IDLE_TIMEOUT: %w", err)
		}
		c.PeerIdleTimeout = v
	}
	return c, c.validate(getenv)
}

func (c *Config) validate(getenv func(string) string) error {
	switch c.Mode {
	case ModeAlwaysOn, ModeAPI, ModeFull:
	default:
		return fmt.Errorf("unknown mode %q", c.Mode)
	}
	if c.Strategy != StrategyStop && c.Strategy != StrategyPause {
		return fmt.Errorf("unknown strategy %q", c.Strategy)
	}
	if len(c.APIs) == 0 {
		return fmt.Errorf("no apis configured")
	}
	seen := map[string]bool{}
	for i := range c.APIs {
		a := &c.APIs[i]
		if a.Name == "" || a.Listen == "" || a.Upstream == "" || a.Container == "" {
			return fmt.Errorf("api %d: name, listen, upstream and container are required", i)
		}
		if seen[a.Name] {
			return fmt.Errorf("duplicate api %s", a.Name)
		}
		seen[a.Name] = true
		if a.Group != "" {
			if _, ok := c.Groups[a.Group]; !ok {
				return fmt.Errorf("api %s: unknown group %s", a.Name, a.Group)
			}
		}
		if a.JWT.SecretEnv == "" {
			return fmt.Errorf("api %s: jwt.secret_env is required (auth runs before wake)", a.Name)
		}
		a.JWT.Secret = getenv(a.JWT.SecretEnv)
		if len(a.JWT.Secret) < 32 {
			return fmt.Errorf("api %s: %s must hold a secret of at least 32 bytes", a.Name, a.JWT.SecretEnv)
		}
	}
	if len(c.AdminToken) < 16 {
		return fmt.Errorf("ACTIVATOR_ADMIN_TOKEN must be set (at least 16 characters)")
	}
	if c.MaxConcurrentWakes < 1 {
		return fmt.Errorf("max_concurrent_wakes must be >= 1")
	}
	return nil
}

func (c *Config) API(name string) *API {
	for i := range c.APIs {
		if c.APIs[i].Name == name {
			return &c.APIs[i]
		}
	}
	return nil
}
