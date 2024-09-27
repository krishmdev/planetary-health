package config

import (
	"os"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestParseShippedConfig(t *testing.T) {
	b, err := os.ReadFile("../../activator.yaml")
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Repeat("s", 32)
	c, err := Parse(b, env(map[string]string{"ORG1_JWT_SECRET": s, "ORG2_JWT_SECRET": s, "ACTIVATOR_ADMIN_TOKEN": s, "ACTIVATOR_MODE": "full", "ACTIVATOR_IDLE_TIMEOUT": "5s"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != ModeFull || c.IdleTimeout.Seconds() != 5 || len(c.Groups["ehrchannel"].Peers) != 2 {
		t.Fatalf("%+v", c)
	}
	if c.API("org2-api").JWT.Secret != s {
		t.Fatal("secret not loaded from env")
	}
}

func TestValidation(t *testing.T) {
	s := strings.Repeat("s", 32)
	base := "apis:\n  - {name: a, listen: ':1', upstream: 'http://x', container: c, jwt: {secret_env: S}}\n"
	cases := map[string]string{
		"short secret": base,
		"bad mode":     "mode: sometimes\n" + base,
		"no apis":      "mode: api\n",
		"bad group":    "apis:\n  - {name: a, listen: ':1', upstream: 'http://x', container: c, group: g, jwt: {secret_env: S}}\n",
		"no jwt":       "apis:\n  - {name: a, listen: ':1', upstream: 'http://x', container: c}\n",
	}
	for name, y := range cases {
		e := map[string]string{"S": s, "ACTIVATOR_ADMIN_TOKEN": s}
		if name == "short secret" {
			e["S"] = "short"
		}
		if _, err := Parse([]byte(y), env(e)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if _, err := Parse([]byte(base), env(map[string]string{"S": s, "ACTIVATOR_ADMIN_TOKEN": s})); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse([]byte(base), env(map[string]string{"S": s})); err == nil {
		t.Fatal("a missing admin token must be rejected")
	}
}
