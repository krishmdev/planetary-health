// Command activator is a scale-to-zero front door for the per-org EHR gateways, in the style of
// Knative's activator: it holds requests for sleeping units, wakes them over the Docker Engine
// API, waits for a usable endorsement path, and then forwards.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/krishmdev/planetary-health/activator/internal/authgate"
	"github.com/krishmdev/planetary-health/activator/internal/config"
	"github.com/krishmdev/planetary-health/activator/internal/engine"
	"github.com/krishmdev/planetary-health/activator/internal/lifecycle"
	"github.com/krishmdev/planetary-health/activator/internal/metrics"
	"github.com/krishmdev/planetary-health/activator/internal/proxy"
	"github.com/krishmdev/planetary-health/activator/internal/readiness"
)

func main() {
	path := flag.String("config", "activator.yaml", "config file")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load(*path)
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}
	met := metrics.New()
	mgr := lifecycle.New(cfg, engine.NewDocker(cfg.DockerSocket), readiness.NewHTTP(), met)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := mgr.Sync(ctx); err != nil {
		log.Error("docker sync", "err", err)
		os.Exit(1)
	}

	login := authgate.NewBucket(cfg.LoginBurst, cfg.LoginPerSecond)
	var servers []*http.Server
	for i := range cfg.APIs {
		api := &cfg.APIs[i]
		h, err := proxy.New(api, mgr, login, met)
		if err != nil {
			log.Error("proxy", "api", api.Name, "err", err)
			os.Exit(1)
		}
		servers = append(servers, &http.Server{Addr: api.Listen, Handler: h, ReadHeaderTimeout: 10 * time.Second})
	}
	servers = append(servers, &http.Server{Addr: cfg.AdminListen, Handler: admin(mgr, met), ReadHeaderTimeout: 10 * time.Second})
	for _, s := range servers {
		go func() {
			if err := s.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Error("listen", "addr", s.Addr, "err", err)
				os.Exit(1)
			}
		}()
	}
	log.Info("activator up", "mode", cfg.Mode, "strategy", cfg.Strategy, "idle", cfg.IdleTimeout.String())

	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			for _, s := range servers {
				_ = s.Shutdown(sctx)
			}
			cancel()
			return
		case <-tick.C:
			mgr.Reap(ctx)
		}
	}
}

func admin(mgr *lifecycle.Manager, met *metrics.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.HandlerFor(met.Registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /_activator/status", func(w http.ResponseWriter, _ *http.Request) {
		mode, units := mgr.Status()
		writeJSON(w, http.StatusOK, map[string]any{"mode": mode, "units": units})
	})
	mux.HandleFunc("POST /_activator/scale-down", func(w http.ResponseWriter, r *http.Request) {
		unit := r.URL.Query().Get("unit")
		if unit == "" {
			unit = "all"
		}
		if err := mgr.ScaleDown(r.Context(), unit); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		mode, units := mgr.Status()
		writeJSON(w, http.StatusOK, map[string]any{"mode": mode, "units": units})
	})
	mux.HandleFunc("POST /_activator/mode", func(w http.ResponseWriter, r *http.Request) {
		m := config.Mode(r.URL.Query().Get("mode"))
		if r.URL.Query().Get("always_on") == "true" {
			m = config.ModeAlwaysOn
		}
		switch m {
		case config.ModeAlwaysOn, config.ModeAPI, config.ModeFull:
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be always_on, api or full"})
			return
		}
		mgr.SetMode(m)
		if m == config.ModeAlwaysOn {
			ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
			defer cancel()
			if err := mgr.WakeAll(ctx); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
				return
			}
		}
		mode, units := mgr.Status()
		writeJSON(w, http.StatusOK, map[string]any{"mode": mode, "units": units})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
