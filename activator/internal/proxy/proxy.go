// Package proxy is the request path: authenticate, activate, forward.
package proxy

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/krishmdev/planetary-health/activator/internal/authgate"
	"github.com/krishmdev/planetary-health/activator/internal/config"
	"github.com/krishmdev/planetary-health/activator/internal/lifecycle"
	"github.com/krishmdev/planetary-health/activator/internal/metrics"
)

type Handler struct {
	api     *config.API
	mgr     *lifecycle.Manager
	auth    *authgate.Verifier
	login   *authgate.Bucket
	met     *metrics.Metrics
	rproxy  *httputil.ReverseProxy
	proxies []*net.IPNet
}

func New(api *config.API, mgr *lifecycle.Manager, login *authgate.Bucket, met *metrics.Metrics, trustedProxies []string) (*Handler, error) {
	u, err := url.Parse(api.Upstream)
	if err != nil {
		return nil, err
	}
	var proxies []*net.IPNet
	for _, c := range trustedProxies {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			return nil, fmt.Errorf("trusted proxy %q: %w", c, err)
		}
		proxies = append(proxies, n)
	}
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.FlushInterval = -1 // stream SSE immediately
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeErr(w, http.StatusBadGateway, "UPSTREAM_ERROR", err.Error(), 0)
	}
	return &Handler{api: api, mgr: mgr, auth: authgate.NewVerifier(api.JWT.Secret, api.JWT.Issuer, api.JWT.Audience),
		login: login, met: met, rproxy: rp, proxies: proxies}, nil
}

func writeErr(w http.ResponseWriter, status int, code, msg string, retryAfter int) {
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code, "message": msg})
}

// clientIP keys the login rate limit. Behind a trusted proxy (nginx for the UI) every request
// comes from the proxy's address, so use the last X-Forwarded-For hop it appended instead.
func (h *Handler) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !h.trusted(ip) {
		return host
	}
	xff := r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return host
	}
	parts := strings.Split(xff, ",")
	return strings.TrimSpace(parts[len(parts)-1])
}

func (h *Handler) trusted(ip net.IP) bool {
	for _, n := range h.proxies {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func bearer(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	if r.URL.Path == "/events" {
		return r.URL.Query().Get("token")
	}
	return ""
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := h.api.Name
	switch {
	case r.URL.Path == "/healthz":
		// Answered here so health checks never wake anything.
		_, units := h.mgr.Status()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"activator": "ok", "unit": name, "units": units})
		return
	case r.URL.Path == "/auth/login":
		if !h.login.Allow(h.clientIP(r)) {
			h.met.Rejections.WithLabelValues(name, "login_rate").Inc()
			writeErr(w, http.StatusTooManyRequests, "RATE_LIMITED", "too many login attempts", 2)
			return
		}
	default:
		if _, err := h.auth.Verify(bearer(r)); err != nil {
			h.met.Rejections.WithLabelValues(name, "unauthenticated").Inc()
			writeErr(w, http.StatusUnauthorized, "UNAUTHENTICATED", "invalid or missing token (checked before wake)", 0)
			return
		}
	}

	// Logging in needs only the gateway process, so it never wakes the endorsement group.
	act, release, err := h.mgr.Acquire(r.Context(), name, r.URL.Path == "/auth/login")
	if err != nil {
		switch {
		case errors.Is(err, lifecycle.ErrQueueFull):
			writeErr(w, http.StatusServiceUnavailable, "ACTIVATION_QUEUE_FULL", err.Error(), 5)
		case errors.Is(err, lifecycle.ErrWakeTimeout):
			h.met.Rejections.WithLabelValues(name, "wake_timeout").Inc()
			writeErr(w, http.StatusServiceUnavailable, "WAKE_TIMEOUT", err.Error(), 10)
		default:
			h.met.Rejections.WithLabelValues(name, "wake_failed").Inc()
			writeErr(w, http.StatusServiceUnavailable, "WAKE_FAILED", err.Error(), 5)
		}
		return
	}
	defer release()
	h.met.Requests.WithLabelValues(name, strconv.FormatBool(act.Cold)).Inc()
	w.Header().Set("X-Cold-Start", strconv.FormatBool(act.Cold))
	if act.Cold {
		w.Header().Set("X-Activation-Ms", strconv.FormatInt(act.TotalMs, 10))
		w.Header().Set("X-Activation-Breakdown", fmt.Sprintf("start=%d;ready=%d;woke=%s", act.StartMs, act.ReadyMs, strings.Join(act.Woke, ",")))
	}
	h.rproxy.ServeHTTP(w, r)
}
