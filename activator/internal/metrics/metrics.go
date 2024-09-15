// Package metrics holds the activator's Prometheus collectors.
package metrics

import "github.com/prometheus/client_golang/prometheus"

type Metrics struct {
	Registry        *prometheus.Registry
	Activations     *prometheus.CounterVec
	ActivationSecs  *prometheus.HistogramVec
	UnitState       *prometheus.GaugeVec
	Requests        *prometheus.CounterVec
	IdleStops       *prometheus.CounterVec
	Rejections      *prometheus.CounterVec
	WakesInProgress prometheus.Gauge
}

func New() *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),
		Activations: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "activations_total", Help: "Activations (cold starts) per unit.",
		}, []string{"unit"}),
		ActivationSecs: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "activation_seconds", Help: "Activation time by phase.",
			Buckets: []float64{.05, .1, .25, .5, 1, 2, 4, 8, 16, 32, 64},
		}, []string{"unit", "phase"}),
		UnitState: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "unit_state", Help: "1 for the unit's current state.",
		}, []string{"unit", "state"}),
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "requests_total", Help: "Proxied requests.",
		}, []string{"unit", "cold"}),
		IdleStops: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "idle_stops_total", Help: "Scale-downs after idle timeout or by admin request.",
		}, []string{"unit", "reason"}),
		Rejections: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "rejections_total", Help: "Requests refused before reaching a unit.",
		}, []string{"unit", "reason"}),
		WakesInProgress: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "wakes_in_progress", Help: "Concurrent activations.",
		}),
	}
	m.Registry.MustRegister(m.Activations, m.ActivationSecs, m.UnitState, m.Requests, m.IdleStops, m.Rejections, m.WakesInProgress)
	return m
}

var states = []string{"stopped", "paused", "waking", "ready", "stopping"}

func (m *Metrics) SetState(unit, state string) {
	for _, s := range states {
		v := 0.0
		if s == state {
			v = 1
		}
		m.UnitState.WithLabelValues(unit, s).Set(v)
	}
}
