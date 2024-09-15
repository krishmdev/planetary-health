package lifecycle_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/krishmdev/planetary-health/activator/internal/config"
	"github.com/krishmdev/planetary-health/activator/internal/engine"
	"github.com/krishmdev/planetary-health/activator/internal/lifecycle"
	"github.com/krishmdev/planetary-health/activator/internal/metrics"
)

type fakeEngine struct {
	mu     sync.Mutex
	state  map[string]engine.State
	starts map[string]int
	stops  map[string]int
	pauses map[string]int
	delay  time.Duration
}

func newEngine(states map[string]engine.State) *fakeEngine {
	return &fakeEngine{state: states, starts: map[string]int{}, stops: map[string]int{}, pauses: map[string]int{}}
}

func (e *fakeEngine) State(_ context.Context, n string) (engine.State, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	s, ok := e.state[n]
	if !ok {
		return engine.Missing, nil
	}
	return s, nil
}

func (e *fakeEngine) set(n string, s engine.State) {
	e.mu.Lock()
	e.state[n] = s
	e.mu.Unlock()
}

func (e *fakeEngine) Start(_ context.Context, n string) error {
	time.Sleep(e.delay)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.starts[n]++
	e.state[n] = engine.Running
	return nil
}

func (e *fakeEngine) Stop(_ context.Context, n string, _ time.Duration) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stops[n]++
	if _, ok := e.state[n]; ok {
		e.state[n] = engine.Exited
	}
	return nil
}

func (e *fakeEngine) Pause(_ context.Context, n string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.pauses[n]++
	e.state[n] = engine.Paused
	return nil
}

func (e *fakeEngine) Unpause(_ context.Context, n string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.starts[n]++
	e.state[n] = engine.Running
	return nil
}

func (e *fakeEngine) ListByPrefix(_ context.Context, p string) ([]string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for n := range e.state {
		if len(n) >= len(p) && n[:len(p)] == p {
			out = append(out, n)
		}
	}
	return out, nil
}

func (e *fakeEngine) count(m map[string]int, n string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return m[n]
}

// fakeProbe models the gateway's /readyz: it only succeeds when the API container and *both*
// endorsing peers are running, as the real endorsement probe requires.
type fakeProbe struct {
	eng       *fakeEngine
	boundary  uint64
	heights   map[string]uint64
	mu        sync.Mutex
	neverOK   bool
	readyCall atomic.Int32
}

func (p *fakeProbe) running(n string) bool {
	s, _ := p.eng.State(context.Background(), n)
	return s == engine.Running
}

func (p *fakeProbe) Healthy(_ context.Context, url string) error {
	if !p.running(url) {
		return fmt.Errorf("%s down", url)
	}
	return nil
}

func (p *fakeProbe) APIReady(_ context.Context, url string) (uint64, error) {
	p.readyCall.Add(1)
	if p.neverOK {
		return 0, errors.New("endorsement probe failed")
	}
	api := url[:len(url)-len("/readyz")]
	for _, n := range []string{api, "peer0.org1", "peer0.org2"} {
		if !p.running(n) {
			return 0, fmt.Errorf("%s not running, cannot endorse", n)
		}
	}
	return p.boundary, nil
}

func (p *fakeProbe) PeerHeight(_ context.Context, ops, _ string) (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	h := p.heights[ops]
	p.heights[ops] = h + 1 // catching up one block per poll
	return h, nil
}

func testConfig(mode config.Mode) *config.Config {
	return &config.Config{
		Mode: mode, Strategy: config.StrategyStop, IdleTimeout: time.Minute, PeerIdleTimeout: 5 * time.Minute,
		WakeTimeout: 2 * time.Second, MaxConcurrentWakes: 4, QueueLimit: 256,
		APIs: []config.API{
			{Name: "org1-api", Container: "org1-api", Readiness: "org1-api/readyz", Group: "ehr"},
			{Name: "org2-api", Container: "org2-api", Readiness: "org2-api/readyz", Group: "ehr"},
		},
		Groups: map[string]config.Group{"ehr": {Channel: "ehrchannel", Peers: []config.Peer{
			{Name: "peer0.org1", Container: "peer0.org1", Ops: "peer0.org1", ChaincodePrefix: "dev-peer0.org1"},
			{Name: "peer0.org2", Container: "peer0.org2", Ops: "peer0.org2", ChaincodePrefix: "dev-peer0.org2"},
		}}},
	}
}

func setup(t *testing.T, mode config.Mode, states map[string]engine.State) (*lifecycle.Manager, *fakeEngine, *fakeProbe) {
	t.Helper()
	eng := newEngine(states)
	probe := &fakeProbe{eng: eng, boundary: 20, heights: map[string]uint64{"peer0.org1": 21, "peer0.org2": 21}}
	m := lifecycle.New(testConfig(mode), eng, probe, metrics.New())
	m.SetPoll(5 * time.Millisecond)
	if err := m.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	return m, eng, probe
}

func allStopped() map[string]engine.State {
	return map[string]engine.State{
		"org1-api": engine.Exited, "org2-api": engine.Exited,
		"peer0.org1": engine.Exited, "peer0.org2": engine.Exited,
		"dev-peer0.org1-ehr_1.0-abc": engine.Exited, "dev-peer0.org2-ehr_1.0-abc": engine.Exited,
	}
}

func TestFullColdFirstRequestWakesWholeEndorsementGroup(t *testing.T) {
	m, eng, _ := setup(t, config.ModeFull, allStopped())
	act, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if !act.Cold {
		t.Fatal("first request after idle must be a cold start")
	}
	for _, n := range []string{"org1-api", "peer0.org1", "peer0.org2"} {
		if eng.count(eng.starts, n) != 1 {
			t.Fatalf("%s started %d times, want 1", n, eng.count(eng.starts, n))
		}
	}
	if eng.count(eng.starts, "org2-api") != 0 {
		t.Fatal("the other org's API is not part of the endorsement path and should stay asleep")
	}
	if act.ReadyMs < act.StartMs || act.TotalMs < act.ReadyMs {
		t.Fatalf("bad breakdown %+v", act)
	}
	// Second request is warm.
	act2, rel2, err := m.Acquire(context.Background(), "org1-api")
	if err != nil || act2.Cold {
		t.Fatalf("want warm, got %+v %v", act2, err)
	}
	rel2()
}

func TestWarmOrg1WaitsForSleepingOrg2(t *testing.T) {
	states := allStopped()
	states["org1-api"] = engine.Running
	states["peer0.org1"] = engine.Running
	m, eng, _ := setup(t, config.ModeFull, states)

	act, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if !act.Cold || eng.count(eng.starts, "peer0.org2") != 1 {
		t.Fatalf("org2's peer must be woken before a write is forwarded: %+v", act)
	}
	if eng.count(eng.starts, "org1-api") != 0 || eng.count(eng.starts, "peer0.org1") != 0 {
		t.Fatal("running containers must not be restarted")
	}
}

func TestPeersMustPassOrdererBoundary(t *testing.T) {
	m, _, probe := setup(t, config.ModeFull, allStopped())
	probe.heights["peer0.org2"] = 15 // behind the boundary (20); needs six more blocks
	act, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if probe.heights["peer0.org2"] <= 21 {
		t.Fatalf("activation returned before peer0.org2 caught up (height %d)", probe.heights["peer0.org2"])
	}
	_ = act
}

func TestWakeTimeoutIsAnErrorNotAPartialActivation(t *testing.T) {
	m, _, probe := setup(t, config.ModeFull, allStopped())
	probe.neverOK = true
	_, _, err := m.Acquire(context.Background(), "org1-api")
	if !errors.Is(err, lifecycle.ErrWakeTimeout) {
		t.Fatalf("want ErrWakeTimeout, got %v", err)
	}
	_, units := m.Status()
	for _, u := range units {
		if u.Name == "org1-api" && (u.State == lifecycle.Ready || u.Inflight != 0) {
			t.Fatalf("unit left %+v after a failed activation", u)
		}
	}
}

func TestConcurrentRequestsShareOneActivation(t *testing.T) {
	m, eng, _ := setup(t, config.ModeFull, allStopped())
	eng.delay = 20 * time.Millisecond
	var wg sync.WaitGroup
	var cold atomic.Int32
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			api := "org1-api"
			if i%2 == 1 {
				api = "org2-api"
			}
			act, release, err := m.Acquire(context.Background(), api)
			if err != nil {
				t.Error(err)
				return
			}
			if act.Cold {
				cold.Add(1)
			}
			release()
		}(i)
	}
	wg.Wait()
	for _, n := range []string{"org1-api", "org2-api", "peer0.org1", "peer0.org2"} {
		if c := eng.count(eng.starts, n); c != 1 {
			t.Fatalf("%s started %d times, want exactly 1", n, c)
		}
	}
	if cold.Load() == 0 {
		t.Fatal("waiters should see the cold start")
	}
}

func TestAPIModeLeavesPeersAlone(t *testing.T) {
	states := allStopped()
	states["peer0.org1"] = engine.Running
	states["peer0.org2"] = engine.Running
	m, eng, _ := setup(t, config.ModeAPI, states)
	_, release, err := m.Acquire(context.Background(), "org2-api")
	if err != nil {
		t.Fatal(err)
	}
	release()
	if eng.count(eng.starts, "org2-api") != 1 || eng.count(eng.starts, "peer0.org1") != 0 {
		t.Fatal("api mode wakes only the API")
	}
}

func TestIdleReaping(t *testing.T) {
	states := allStopped()
	for _, n := range []string{"org1-api", "org2-api", "peer0.org1", "peer0.org2"} {
		states[n] = engine.Running
	}
	m, eng, _ := setup(t, config.ModeFull, states)
	now := time.Now()
	m.SetClock(func() time.Time { return now })

	_, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	m.Reap(context.Background())
	if eng.count(eng.stops, "org1-api") != 0 {
		t.Fatal("a unit with an in-flight request (e.g. an open SSE stream) must not be stopped")
	}
	release()
	now = now.Add(30 * time.Second)
	m.Reap(context.Background())
	if eng.count(eng.stops, "org1-api") != 0 {
		t.Fatal("stopped before the idle timeout")
	}
	now = now.Add(31 * time.Second)
	m.Reap(context.Background())
	if eng.count(eng.stops, "org1-api") != 1 || eng.count(eng.stops, "org2-api") != 1 {
		t.Fatal("idle APIs should stop after idle_timeout")
	}
	if eng.count(eng.stops, "peer0.org1") != 0 {
		t.Fatal("peers have their own, longer idle timeout")
	}
	now = now.Add(5 * time.Minute)
	m.Reap(context.Background())
	for _, n := range []string{"peer0.org1", "peer0.org2", "dev-peer0.org1-ehr_1.0-abc", "dev-peer0.org2-ehr_1.0-abc"} {
		if eng.count(eng.stops, n) != 1 {
			t.Fatalf("%s should be stopped once the group is idle", n)
		}
	}
}

func TestAlwaysOnNeverReaps(t *testing.T) {
	states := allStopped()
	states["org1-api"] = engine.Running
	m, eng, _ := setup(t, config.ModeAlwaysOn, states)
	now := time.Now()
	m.SetClock(func() time.Time { return now.Add(time.Hour) })
	m.Reap(context.Background())
	if eng.count(eng.stops, "org1-api") != 0 {
		t.Fatal("always_on must not stop anything")
	}
}

func TestPauseStrategy(t *testing.T) {
	states := allStopped()
	states["org1-api"] = engine.Running
	states["peer0.org1"] = engine.Running
	states["peer0.org2"] = engine.Running
	cfg := testConfig(config.ModeAPI)
	cfg.Strategy = config.StrategyPause
	eng := newEngine(states)
	probe := &fakeProbe{eng: eng, boundary: 1, heights: map[string]uint64{}}
	m := lifecycle.New(cfg, eng, probe, metrics.New())
	m.SetPoll(time.Millisecond)
	_ = m.Sync(context.Background())
	if err := m.ScaleDown(context.Background(), "org1-api"); err != nil {
		t.Fatal(err)
	}
	if eng.count(eng.pauses, "org1-api") != 1 {
		t.Fatal("pause strategy should pause")
	}
	act, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil || !act.Cold {
		t.Fatalf("resume from pause: %+v %v", act, err)
	}
	release()
	if s, _ := eng.State(context.Background(), "org1-api"); s != engine.Running {
		t.Fatal("not unpaused")
	}
}

func TestForcedScaleDownRefusesBusyUnit(t *testing.T) {
	states := allStopped()
	states["org1-api"] = engine.Running
	m, _, _ := setup(t, config.ModeAPI, states)
	_, release, err := m.Acquire(context.Background(), "org1-api")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.ScaleDown(context.Background(), "org1-api"); !errors.Is(err, lifecycle.ErrBusy) {
		t.Fatalf("want ErrBusy, got %v", err)
	}
	release()
	if err := m.ScaleDown(context.Background(), "nope"); err == nil {
		t.Fatal("unknown unit should error")
	}
}

func TestQueueLimit(t *testing.T) {
	cfg := testConfig(config.ModeAPI)
	cfg.QueueLimit = 1
	eng := newEngine(allStopped())
	eng.delay = 100 * time.Millisecond
	probe := &fakeProbe{eng: eng, boundary: 1, heights: map[string]uint64{}}
	eng.state["peer0.org1"], eng.state["peer0.org2"] = engine.Running, engine.Running
	m := lifecycle.New(cfg, eng, probe, metrics.New())
	m.SetPoll(time.Millisecond)
	_ = m.Sync(context.Background())
	done := make(chan error, 1)
	go func() {
		_, rel, err := m.Acquire(context.Background(), "org1-api")
		if rel != nil {
			rel()
		}
		done <- err
	}()
	time.Sleep(20 * time.Millisecond)
	if _, _, err := m.Acquire(context.Background(), "org1-api"); !errors.Is(err, lifecycle.ErrQueueFull) {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
