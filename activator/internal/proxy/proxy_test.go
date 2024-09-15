package proxy_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krishmdev/planetary-health/activator/internal/authgate"
	"github.com/krishmdev/planetary-health/activator/internal/config"
	"github.com/krishmdev/planetary-health/activator/internal/engine"
	"github.com/krishmdev/planetary-health/activator/internal/lifecycle"
	"github.com/krishmdev/planetary-health/activator/internal/metrics"
	"github.com/krishmdev/planetary-health/activator/internal/proxy"
)

const secret = "org1-secret-that-is-at-least-32-bytes!!"

func sign(t *testing.T, claims map[string]any) string {
	t.Helper()
	h := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	b, _ := json.Marshal(claims)
	p := base64.RawURLEncoding.EncodeToString(b)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(h + "." + p))
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func goodClaims() map[string]any {
	return map[string]any{"sub": "alice", "iss": "planetary-health/org1", "aud": "org1-api", "exp": time.Now().Add(time.Minute).Unix()}
}

type countingEngine struct {
	starts atomic.Int32
	state  atomic.Value
}

func (e *countingEngine) State(context.Context, string) (engine.State, error) {
	return e.state.Load().(engine.State), nil
}
func (e *countingEngine) Start(context.Context, string) error {
	e.starts.Add(1)
	e.state.Store(engine.Running)
	return nil
}
func (e *countingEngine) Stop(context.Context, string, time.Duration) error { return nil }
func (e *countingEngine) Pause(context.Context, string) error                { return nil }
func (e *countingEngine) Unpause(context.Context, string) error              { return nil }
func (e *countingEngine) ListByPrefix(context.Context, string) ([]string, error) {
	return nil, nil
}

type okProbe struct{ fail bool }

func (p okProbe) Healthy(context.Context, string) error { return nil }
func (p okProbe) APIReady(context.Context, string) (uint64, error) {
	if p.fail {
		return 0, context.DeadlineExceeded
	}
	return 3, nil
}
func (p okProbe) PeerHeight(context.Context, string, string) (uint64, error) { return 4, nil }

func setup(t *testing.T, probe okProbe) (*httptest.Server, *countingEngine, *atomic.Int32) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(upstream.Close)
	cfg := &config.Config{Mode: config.ModeAPI, Strategy: config.StrategyStop, IdleTimeout: time.Minute,
		WakeTimeout: 300 * time.Millisecond, MaxConcurrentWakes: 2, QueueLimit: 10,
		APIs: []config.API{{Name: "org1-api", Container: "c", Upstream: upstream.URL, Readiness: "r",
			JWT: config.JWT{Issuer: "planetary-health/org1", Audience: "org1-api", Secret: secret}}}}
	eng := &countingEngine{}
	eng.state.Store(engine.Exited)
	met := metrics.New()
	m := lifecycle.New(cfg, eng, probe, met)
	m.SetPoll(5 * time.Millisecond)
	_ = m.Sync(context.Background())
	h, err := proxy.New(&cfg.APIs[0], m, authgate.NewBucket(2, 0.001), met)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, eng, &hits
}

func get(t *testing.T, url, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

func TestUnauthenticatedRequestsNeverWake(t *testing.T) {
	srv, eng, hits := setup(t, okProbe{})
	expired := goodClaims()
	expired["exp"] = time.Now().Add(-time.Second).Unix()
	wrongAud := goodClaims()
	wrongAud["aud"] = "org2-api"
	for _, tok := range []string{"", "garbage", sign(t, expired), sign(t, wrongAud), sign(t, goodClaims()) + "x"} {
		if r := get(t, srv.URL+"/me", tok); r.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q: status %d, want 401", tok, r.StatusCode)
		}
	}
	if eng.starts.Load() != 0 || hits.Load() != 0 {
		t.Fatal("an unauthenticated request woke or reached the upstream")
	}
	if r := get(t, srv.URL+"/healthz", ""); r.StatusCode != 200 || eng.starts.Load() != 0 {
		t.Fatal("/healthz must answer without waking")
	}
}

func TestColdThenWarmHeaders(t *testing.T) {
	srv, eng, hits := setup(t, okProbe{})
	tok := sign(t, goodClaims())
	r := get(t, srv.URL+"/me", tok)
	if r.StatusCode != 200 || r.Header.Get("X-Cold-Start") != "true" || r.Header.Get("X-Activation-Ms") == "" {
		t.Fatalf("cold: %d %v", r.StatusCode, r.Header)
	}
	r = get(t, srv.URL+"/me", tok)
	if r.Header.Get("X-Cold-Start") != "false" || r.Header.Get("X-Activation-Ms") != "" {
		t.Fatalf("warm: %v", r.Header)
	}
	if eng.starts.Load() != 1 || hits.Load() != 2 {
		t.Fatalf("starts=%d hits=%d", eng.starts.Load(), hits.Load())
	}
}

func TestWakeTimeoutReturns503WithRetryAfter(t *testing.T) {
	srv, _, hits := setup(t, okProbe{fail: true})
	r := get(t, srv.URL+"/me", sign(t, goodClaims()))
	if r.StatusCode != http.StatusServiceUnavailable || r.Header.Get("Retry-After") == "" {
		t.Fatalf("got %d, Retry-After=%q", r.StatusCode, r.Header.Get("Retry-After"))
	}
	if hits.Load() != 0 {
		t.Fatal("request forwarded to a unit that never became ready")
	}
}

func TestLoginIsRateLimited(t *testing.T) {
	srv, _, _ := setup(t, okProbe{})
	codes := map[int]int{}
	for i := 0; i < 5; i++ {
		resp, err := http.Post(srv.URL+"/auth/login", "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		codes[resp.StatusCode]++
	}
	if codes[http.StatusTooManyRequests] != 3 || codes[200] != 2 {
		t.Fatalf("codes %v", codes)
	}
}
