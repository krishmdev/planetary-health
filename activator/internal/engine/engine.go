// Package engine is a small Docker Engine API client over the unix socket. It covers only what
// the activator needs, so there is no SDK dependency to drift.
package engine

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type State string

const (
	Running State = "running"
	Paused  State = "paused"
	Exited  State = "exited"
	Created State = "created"
	Missing State = "missing"
)

type Engine interface {
	State(ctx context.Context, name string) (State, error)
	Start(ctx context.Context, name string) error
	Stop(ctx context.Context, name string, timeout time.Duration) error
	Pause(ctx context.Context, name string) error
	Unpause(ctx context.Context, name string) error
	ListByPrefix(ctx context.Context, prefix string) ([]string, error)
}

type Docker struct {
	http *http.Client
	base string
}

func NewDocker(socket string) *Docker {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConns: 8,
	}
	return &Docker{http: &http.Client{Transport: tr, Timeout: 60 * time.Second}, base: "http://docker/v1.43"}
}

func (d *Docker) do(ctx context.Context, method, path string, ok ...int) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, d.base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	for _, c := range ok {
		if resp.StatusCode == c {
			return body, resp.StatusCode, nil
		}
	}
	return body, resp.StatusCode, fmt.Errorf("docker %s %s: %d %s", method, path, resp.StatusCode, strings.TrimSpace(string(body)))
}

func (d *Docker) State(ctx context.Context, name string) (State, error) {
	body, code, err := d.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", 200, 404)
	if err != nil {
		return "", err
	}
	if code == 404 {
		return Missing, nil
	}
	var info struct {
		State struct {
			Status string `json:"Status"`
		} `json:"State"`
	}
	if err := json.Unmarshal(body, &info); err != nil {
		return "", err
	}
	return State(info.State.Status), nil
}

func (d *Docker) Start(ctx context.Context, name string) error {
	_, _, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/start", 204, 304)
	return err
}

func (d *Docker) Stop(ctx context.Context, name string, timeout time.Duration) error {
	p := fmt.Sprintf("/containers/%s/stop?t=%d", url.PathEscape(name), int(timeout.Seconds()))
	_, _, err := d.do(ctx, http.MethodPost, p, 204, 304, 404)
	return err
}

func (d *Docker) Pause(ctx context.Context, name string) error {
	_, _, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/pause", 204)
	return err
}

func (d *Docker) Unpause(ctx context.Context, name string) error {
	_, _, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/unpause", 204)
	return err
}

func (d *Docker) ListByPrefix(ctx context.Context, prefix string) ([]string, error) {
	f, _ := json.Marshal(map[string][]string{"name": {prefix}})
	body, _, err := d.do(ctx, http.MethodGet, "/containers/json?all=true&filters="+url.QueryEscape(string(f)), 200)
	if err != nil {
		return nil, err
	}
	var cs []struct {
		Names []string `json:"Names"`
	}
	if err := json.Unmarshal(body, &cs); err != nil {
		return nil, err
	}
	var out []string
	for _, c := range cs {
		for _, n := range c.Names {
			n = strings.TrimPrefix(n, "/")
			if strings.HasPrefix(n, prefix) {
				out = append(out, n)
			}
		}
	}
	return out, nil
}
