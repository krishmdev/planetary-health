package readiness

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseHeight(t *testing.T) {
	text := "# HELP x\nledger_blockchain_height{channel=\"ehrraft\"} 4\nledger_blockchain_height{channel=\"ehrchannel\"} 17\n"
	h, err := ParseHeight(strings.NewReader(text), "ehrchannel")
	if err != nil || h != 17 {
		t.Fatal(h, err)
	}
	if _, err := ParseHeight(strings.NewReader(text), "nope"); err == nil {
		t.Fatal("want error")
	}
}

func TestHTTPProber(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			w.WriteHeader(200)
		case "/readyz":
			_, _ = w.Write([]byte(`{"ok":true,"boundary":"42"}`))
		case "/bad/readyz":
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"ok":false,"error":"STALE_PEER"}`))
		case "/metrics":
			_, _ = w.Write([]byte("ledger_blockchain_height{channel=\"ehrchannel\"} 43\n"))
		}
	}))
	defer srv.Close()
	p := NewHTTP()
	ctx := context.Background()
	if err := p.Healthy(ctx, srv.URL); err != nil {
		t.Fatal(err)
	}
	if b, err := p.APIReady(ctx, srv.URL+"/readyz"); err != nil || b != 42 {
		t.Fatal(b, err)
	}
	if _, err := p.APIReady(ctx, srv.URL+"/bad/readyz"); err == nil || !strings.Contains(err.Error(), "STALE_PEER") {
		t.Fatal(err)
	}
	if h, err := p.PeerHeight(ctx, srv.URL, "ehrchannel"); err != nil || h != 43 {
		t.Fatal(h, err)
	}
}

func TestUntil(t *testing.T) {
	n := 0
	err := Until(context.Background(), time.Millisecond, func(context.Context) error {
		n++
		if n < 3 {
			return errors.New("not yet")
		}
		return nil
	})
	if err != nil || n != 3 {
		t.Fatal(err, n)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := Until(ctx, time.Millisecond, func(context.Context) error { return errors.New("never") }); err == nil {
		t.Fatal("want timeout")
	}
}
