// Package readiness decides when a woken unit can take traffic. "Up" is not enough: a peer must
// have committed through a block boundary read from the ordering service, and both orgs must
// actually endorse.
package readiness

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Prober interface {
	// Healthy is the peer operations /healthz check.
	Healthy(ctx context.Context, url string) error
	// APIReady calls the gateway's /readyz. The gateway reads the channel boundary from f+1
	// orderers (Deliver SeekNewest), waits for its peer to commit through it, and endorses Ping
	// on both orgs without submitting. It returns that boundary block number.
	APIReady(ctx context.Context, url string) (uint64, error)
	// PeerHeight reads ledger_blockchain_height for a channel from a peer's /metrics.
	PeerHeight(ctx context.Context, opsURL, channel string) (uint64, error)
}

type HTTP struct {
	Client *http.Client
}

func NewHTTP() *HTTP { return &HTTP{Client: &http.Client{Timeout: 15 * time.Second}} }

func (h *HTTP) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return h.Client.Do(req)
}

func (h *HTTP) Healthy(ctx context.Context, url string) error {
	resp, err := h.get(ctx, strings.TrimSuffix(url, "/")+"/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s/healthz: %d", url, resp.StatusCode)
	}
	return nil
}

func (h *HTTP) APIReady(ctx context.Context, url string) (uint64, error) {
	resp, err := h.get(ctx, url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var body struct {
		OK       bool   `json:"ok"`
		Boundary string `json:"boundary"`
		Error    string `json:"error"`
		Message  string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return 0, fmt.Errorf("readyz: %w", err)
	}
	if resp.StatusCode != http.StatusOK || !body.OK {
		return 0, fmt.Errorf("readyz %d: %s %s", resp.StatusCode, body.Error, body.Message)
	}
	return strconv.ParseUint(body.Boundary, 10, 64)
}

func (h *HTTP) PeerHeight(ctx context.Context, opsURL, channel string) (uint64, error) {
	resp, err := h.get(ctx, strings.TrimSuffix(opsURL, "/")+"/metrics")
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return ParseHeight(resp.Body, channel)
}

// ParseHeight finds ledger_blockchain_height{channel="..."} in Prometheus text output.
func ParseHeight(r io.Reader, channel string) (uint64, error) {
	want := fmt.Sprintf(`channel="%s"`, channel)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "ledger_blockchain_height{") || !strings.Contains(line, want) {
			continue
		}
		f := strings.Fields(line)
		v, err := strconv.ParseFloat(f[len(f)-1], 64)
		if err != nil {
			return 0, err
		}
		return uint64(v), nil
	}
	return 0, fmt.Errorf("no ledger_blockchain_height for channel %s", channel)
}

// Until polls fn every interval until it succeeds or ctx ends, returning the last error.
func Until(ctx context.Context, interval time.Duration, fn func(context.Context) error) error {
	var last error
	for {
		if last = fn(ctx); last == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w (last: %v)", ctx.Err(), last)
		case <-time.After(interval):
		}
	}
}
