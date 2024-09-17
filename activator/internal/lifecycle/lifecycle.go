// Package lifecycle is the scale-to-zero state machine:
//
//	stopped/paused -> waking -> ready -> (idle) -> stopping -> stopped/paused
//
// Concurrent requests for a sleeping API share one activation (singleflight). In full mode an
// activation wakes the API's whole endorsement group first, because with MAJORITY endorsement a
// transaction needs both orgs' peers; waking only the local peer would give a partial
// endorsement and a failed write.
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/krishmdev/planetary-health/activator/internal/config"
	"github.com/krishmdev/planetary-health/activator/internal/engine"
	"github.com/krishmdev/planetary-health/activator/internal/metrics"
	"github.com/krishmdev/planetary-health/activator/internal/readiness"
)

type State string

const (
	Stopped  State = "stopped"
	Paused   State = "paused"
	Waking   State = "waking"
	Ready    State = "ready"
	Stopping State = "stopping"
)

var (
	ErrQueueFull   = errors.New("too many requests waiting for activation")
	ErrWakeTimeout = errors.New("activation timed out")
	ErrBusy        = errors.New("unit has requests in flight")
)

// Activation describes how a request got a ready unit.
type Activation struct {
	Cold    bool
	StartMs int64 // container start/unpause calls returned
	ReadyMs int64 // readiness predicate satisfied
	TotalMs int64
	Woke    []string
}

type call struct {
	done chan struct{}
	act  Activation
	err  error
}

type apiUnit struct {
	cfg          *config.API
	op           sync.Mutex // serializes engine operations (start vs stop)
	mu           sync.Mutex
	state        State
	inflight     int
	waiting      int
	lastActivity time.Time
	wake         *call
}

type groupUnit struct {
	name         string
	cfg          config.Group
	op           sync.Mutex
	mu           sync.Mutex
	state        State
	lastActivity time.Time
	wake         *call
}

type Manager struct {
	cfg    *config.Config
	eng    engine.Engine
	probe  readiness.Prober
	met    *metrics.Metrics
	now    func() time.Time
	poll   time.Duration
	sem    chan struct{}
	modeMu sync.RWMutex
	mode   config.Mode
	apis   map[string]*apiUnit
	groups map[string]*groupUnit
}

func New(cfg *config.Config, eng engine.Engine, probe readiness.Prober, met *metrics.Metrics) *Manager {
	m := &Manager{
		cfg: cfg, eng: eng, probe: probe, met: met, now: time.Now, poll: 200 * time.Millisecond,
		sem: make(chan struct{}, cfg.MaxConcurrentWakes), mode: cfg.Mode,
		apis: map[string]*apiUnit{}, groups: map[string]*groupUnit{},
	}
	for i := range cfg.APIs {
		a := &cfg.APIs[i]
		m.apis[a.Name] = &apiUnit{cfg: a, state: Stopped}
	}
	for name, g := range cfg.Groups {
		m.groups[name] = &groupUnit{name: name, cfg: g, state: Stopped}
	}
	return m
}

// SetClock and SetPoll exist for tests.
func (m *Manager) SetClock(now func() time.Time) { m.now = now }
func (m *Manager) SetPoll(d time.Duration)       { m.poll = d }

func (m *Manager) Mode() config.Mode {
	m.modeMu.RLock()
	defer m.modeMu.RUnlock()
	return m.mode
}

func (m *Manager) SetMode(mode config.Mode) {
	m.modeMu.Lock()
	m.mode = mode
	m.modeMu.Unlock()
}

func (m *Manager) setAPIState(u *apiUnit, s State) {
	u.state = s
	m.met.SetState(u.cfg.Name, string(s))
}

func (m *Manager) setGroupState(g *groupUnit, s State) {
	g.state = s
	m.met.SetState("group:"+g.name, string(s))
}

func fromEngine(s engine.State) State {
	switch s {
	case engine.Running:
		return Ready
	case engine.Paused:
		return Paused
	default:
		return Stopped
	}
}

// Sync reads the current container states. A running API is treated as ready; the first
// request will still fail fast if it isn't.
func (m *Manager) Sync(ctx context.Context) error {
	for _, u := range m.apis {
		s, err := m.eng.State(ctx, u.cfg.Container)
		if err != nil {
			return err
		}
		u.mu.Lock()
		m.setAPIState(u, fromEngine(s))
		u.lastActivity = m.now()
		u.mu.Unlock()
	}
	for _, g := range m.groups {
		all := Ready
		for _, p := range g.cfg.Peers {
			s, err := m.eng.State(ctx, p.Container)
			if err != nil {
				return err
			}
			if s != engine.Running {
				all = Stopped
			}
		}
		g.mu.Lock()
		m.setGroupState(g, all)
		g.lastActivity = m.now()
		g.mu.Unlock()
	}
	return nil
}

func (m *Manager) needsGroup(u *apiUnit) *groupUnit {
	if m.Mode() != config.ModeFull || u.cfg.Group == "" {
		return nil
	}
	return m.groups[u.cfg.Group]
}

// Acquire returns once the API can take the request. The returned release must be called when
// the request (including a streaming response) finishes.
func (m *Manager) Acquire(ctx context.Context, name string) (Activation, func(), error) {
	u, ok := m.apis[name]
	if !ok {
		return Activation{}, nil, fmt.Errorf("unknown api %s", name)
	}
	g := m.needsGroup(u)
	u.mu.Lock()
	u.inflight++
	u.lastActivity = m.now()
	if g != nil {
		g.mu.Lock()
		g.lastActivity = m.now()
		groupReady := g.state == Ready
		g.mu.Unlock()
		if !groupReady && u.state == Ready {
			// The API is up but its endorsement group went to sleep; re-run the activation.
			m.setAPIState(u, Stopped)
		}
	}
	if u.state == Ready {
		u.mu.Unlock()
		return Activation{}, m.releaser(u), nil
	}
	if u.waiting >= m.cfg.QueueLimit {
		u.inflight--
		u.mu.Unlock()
		m.met.Rejections.WithLabelValues(name, "queue_full").Inc()
		return Activation{}, nil, ErrQueueFull
	}
	c := u.wake
	if c == nil {
		c = &call{done: make(chan struct{})}
		u.wake = c
		m.setAPIState(u, Waking)
		go m.activate(u, g, c)
	}
	u.waiting++
	u.mu.Unlock()

	var err error
	select {
	case <-c.done:
		err = c.err
	case <-ctx.Done():
		err = ctx.Err()
	}
	u.mu.Lock()
	u.waiting--
	if err != nil {
		u.inflight--
		u.lastActivity = m.now()
	}
	u.mu.Unlock()
	if err != nil {
		return Activation{}, nil, err
	}
	act := c.act
	act.Cold = true
	return act, m.releaser(u), nil
}

func (m *Manager) releaser(u *apiUnit) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			u.mu.Lock()
			u.inflight--
			u.lastActivity = m.now()
			u.mu.Unlock()
		})
	}
}

func (m *Manager) activate(u *apiUnit, g *groupUnit, c *call) {
	ctx, cancel := context.WithTimeout(context.Background(), m.cfg.WakeTimeout)
	defer cancel()
	t0 := m.now()
	act, err := m.wake(ctx, u, g, t0)
	if err != nil && errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("%w after %s: %v", ErrWakeTimeout, m.cfg.WakeTimeout, err)
	}
	act.TotalMs = m.now().Sub(t0).Milliseconds()
	u.mu.Lock()
	if err != nil {
		m.setAPIState(u, Stopped) // unknown; the next request retries the whole activation
	} else {
		m.setAPIState(u, Ready)
		m.met.Activations.WithLabelValues(u.cfg.Name).Inc()
		m.met.ActivationSecs.WithLabelValues(u.cfg.Name, "start").Observe(float64(act.StartMs) / 1000)
		m.met.ActivationSecs.WithLabelValues(u.cfg.Name, "ready").Observe(float64(act.ReadyMs) / 1000)
		m.met.ActivationSecs.WithLabelValues(u.cfg.Name, "total").Observe(float64(act.TotalMs) / 1000)
	}
	u.wake = nil
	c.act, c.err = act, err
	u.mu.Unlock()
	close(c.done)
}

func (m *Manager) wake(ctx context.Context, u *apiUnit, g *groupUnit, t0 time.Time) (Activation, error) {
	select {
	case m.sem <- struct{}{}:
	case <-ctx.Done():
		return Activation{}, ctx.Err()
	}
	m.met.WakesInProgress.Inc()
	defer func() {
		<-m.sem
		m.met.WakesInProgress.Dec()
	}()

	var act Activation
	var wg sync.WaitGroup
	var gErr, aErr error
	var woke []string
	var wmu sync.Mutex
	add := func(n ...string) {
		wmu.Lock()
		woke = append(woke, n...)
		wmu.Unlock()
	}
	if g != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var names []string
			names, gErr = m.startGroup(ctx, g)
			add(names...)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		u.op.Lock()
		defer u.op.Unlock()
		var started bool
		started, aErr = startOrUnpause(ctx, m.eng, u.cfg.Container)
		if started {
			add(u.cfg.Name)
		}
	}()
	wg.Wait()
	if err := errors.Join(gErr, aErr); err != nil {
		return act, err
	}
	act.StartMs = m.now().Sub(t0).Milliseconds()

	// Readiness: the gateway's /readyz reads the orderer boundary and gets a real endorsement
	// from both orgs. In full mode every group peer must also have committed through it.
	var boundary uint64
	err := readiness.Until(ctx, m.poll, func(ctx context.Context) error {
		b, err := m.probe.APIReady(ctx, u.cfg.Readiness)
		boundary = b
		return err
	})
	if err != nil {
		return act, fmt.Errorf("%s not ready: %w", u.cfg.Name, err)
	}
	if g != nil {
		for _, p := range g.cfg.Peers {
			err := readiness.Until(ctx, m.poll, func(ctx context.Context) error {
				h, err := m.probe.PeerHeight(ctx, p.Ops, g.cfg.Channel)
				if err != nil {
					return err
				}
				if h <= boundary {
					return fmt.Errorf("%s at height %d, boundary block %d", p.Name, h, boundary)
				}
				return nil
			})
			if err != nil {
				return act, err
			}
		}
		g.mu.Lock()
		m.setGroupState(g, Ready)
		g.mu.Unlock()
	}
	act.ReadyMs = m.now().Sub(t0).Milliseconds()
	sort.Strings(woke)
	act.Woke = woke
	return act, nil
}

func startOrUnpause(ctx context.Context, eng engine.Engine, name string) (bool, error) {
	s, err := eng.State(ctx, name)
	if err != nil {
		return false, err
	}
	switch s {
	case engine.Running:
		return false, nil
	case engine.Paused:
		return true, eng.Unpause(ctx, name)
	case engine.Missing:
		return false, fmt.Errorf("container %s does not exist", name)
	default:
		return true, eng.Start(ctx, name)
	}
}

// startGroup starts every peer in the group, singleflight across the APIs that share it, and
// waits for each peer's /healthz. Chaincode containers are relaunched by the peer itself on the
// first invocation (the endorsement probe).
func (m *Manager) startGroup(ctx context.Context, g *groupUnit) ([]string, error) {
	g.mu.Lock()
	if g.state == Ready {
		g.mu.Unlock()
		return nil, nil
	}
	c := g.wake
	leader := c == nil
	if leader {
		c = &call{done: make(chan struct{})}
		g.wake = c
		m.setGroupState(g, Waking)
	}
	g.mu.Unlock()
	if !leader {
		select {
		case <-c.done:
			return nil, c.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	g.op.Lock()
	var woke []string
	errs := make([]error, len(g.cfg.Peers))
	var wg sync.WaitGroup
	var mu sync.Mutex
	for i, p := range g.cfg.Peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started, err := startOrUnpause(ctx, m.eng, p.Container)
			if err == nil {
				err = readiness.Until(ctx, m.poll, func(ctx context.Context) error { return m.probe.Healthy(ctx, p.Ops) })
			}
			errs[i] = err
			if started {
				mu.Lock()
				woke = append(woke, p.Name)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	g.op.Unlock()
	err := errors.Join(errs...)
	g.mu.Lock()
	if err != nil {
		m.setGroupState(g, Stopped)
	}
	// Ready is set by the activation once peers pass the boundary check.
	g.wake = nil
	c.err = err
	g.mu.Unlock()
	close(c.done)
	return woke, err
}

// Reap scales down idle units. It is called periodically.
func (m *Manager) Reap(ctx context.Context) {
	if m.Mode() == config.ModeAlwaysOn {
		return
	}
	now := m.now()
	for _, u := range m.apis {
		u.mu.Lock()
		idle := u.state == Ready && u.inflight == 0 && now.Sub(u.lastActivity) >= m.cfg.IdleTimeout
		u.mu.Unlock()
		if idle {
			_ = m.stopAPI(ctx, u, "idle", false)
		}
	}
	if m.Mode() != config.ModeFull {
		return
	}
	for _, g := range m.groups {
		if m.groupIdle(g, now) {
			_ = m.stopGroup(ctx, g, "idle")
		}
	}
}

func (m *Manager) groupIdle(g *groupUnit, now time.Time) bool {
	for _, u := range m.apis {
		if u.cfg.Group != g.name {
			continue
		}
		u.mu.Lock()
		busy := u.state == Ready || u.state == Waking || u.inflight > 0
		u.mu.Unlock()
		if busy {
			return false
		}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.state == Ready && now.Sub(g.lastActivity) >= m.cfg.PeerIdleTimeout
}

func (m *Manager) stopAPI(ctx context.Context, u *apiUnit, reason string, force bool) error {
	u.op.Lock()
	defer u.op.Unlock()
	u.mu.Lock()
	// Re-check under the lock: a request may have arrived since the reaper looked.
	if u.inflight > 0 || u.state == Waking {
		u.mu.Unlock()
		return ErrBusy
	}
	if !force && m.now().Sub(u.lastActivity) < m.cfg.IdleTimeout {
		u.mu.Unlock()
		return nil
	}
	if u.state == Stopped || u.state == Paused {
		u.mu.Unlock()
		return nil
	}
	m.setAPIState(u, Stopping)
	u.mu.Unlock()

	var err error
	target := Stopped
	if m.cfg.Strategy == config.StrategyPause {
		target = Paused
		err = m.eng.Pause(ctx, u.cfg.Container)
	} else {
		err = m.eng.Stop(ctx, u.cfg.Container, 10*time.Second)
	}
	u.mu.Lock()
	if err != nil {
		m.setAPIState(u, Stopped)
	} else {
		m.setAPIState(u, target)
		m.met.IdleStops.WithLabelValues(u.cfg.Name, reason).Inc()
	}
	u.mu.Unlock()
	return err
}

func (m *Manager) stopGroup(ctx context.Context, g *groupUnit, reason string) error {
	g.op.Lock()
	defer g.op.Unlock()
	g.mu.Lock()
	if g.state == Waking {
		g.mu.Unlock()
		return ErrBusy
	}
	m.setGroupState(g, Stopping)
	g.mu.Unlock()
	var errs []error
	for _, p := range g.cfg.Peers {
		if p.ChaincodePrefix != "" {
			ccs, err := m.eng.ListByPrefix(ctx, p.ChaincodePrefix)
			errs = append(errs, err)
			for _, cc := range ccs {
				errs = append(errs, m.eng.Stop(ctx, cc, 5*time.Second))
			}
		}
		errs = append(errs, m.eng.Stop(ctx, p.Container, 10*time.Second))
	}
	g.mu.Lock()
	m.setGroupState(g, Stopped)
	g.mu.Unlock()
	m.met.IdleStops.WithLabelValues("group:"+g.name, reason).Inc()
	return errors.Join(errs...)
}

// ScaleDown is the admin/harness entry point: "all", an API name, or a group name.
func (m *Manager) ScaleDown(ctx context.Context, unit string) error {
	var errs []error
	matched := false
	for name, u := range m.apis {
		if unit == "all" || unit == name {
			matched = true
			errs = append(errs, m.stopAPI(ctx, u, "forced", true))
		}
	}
	for name, g := range m.groups {
		if unit == "all" || unit == name || unit == "peers" {
			matched = true
			errs = append(errs, m.stopGroup(ctx, g, "forced"))
		}
	}
	if !matched {
		return fmt.Errorf("unknown unit %s", unit)
	}
	return errors.Join(errs...)
}

// WakeAll activates every API (used when switching to always_on).
func (m *Manager) WakeAll(ctx context.Context) error {
	var errs []error
	for name := range m.apis {
		_, release, err := m.Acquire(ctx, name)
		if err == nil {
			release()
		}
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

type UnitStatus struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	State    State  `json:"state"`
	Inflight int    `json:"inflight"`
	IdleForS int64  `json:"idleForS"`
}

func (m *Manager) Status() (config.Mode, []UnitStatus) {
	now := m.now()
	var out []UnitStatus
	for name, u := range m.apis {
		u.mu.Lock()
		out = append(out, UnitStatus{Name: name, Kind: "api", State: u.state, Inflight: u.inflight,
			IdleForS: int64(now.Sub(u.lastActivity).Seconds())})
		u.mu.Unlock()
	}
	for name, g := range m.groups {
		g.mu.Lock()
		out = append(out, UnitStatus{Name: name, Kind: "group", State: g.state, IdleForS: int64(now.Sub(g.lastActivity).Seconds())})
		g.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return m.Mode(), out
}
