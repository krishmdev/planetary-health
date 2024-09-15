package engine

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDockerClientOverUnixSocket(t *testing.T) {
	dir, _ := os.MkdirTemp("", "eng")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "d.sock")
	l, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	var calls []string
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1.43/containers/{name}/json", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("name") == "gone" {
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte(`{"State":{"Status":"paused"}}`))
	})
	for _, op := range []string{"start", "stop", "pause", "unpause"} {
		mux.HandleFunc("POST /v1.43/containers/{name}/"+op, func(w http.ResponseWriter, r *http.Request) {
			calls = append(calls, op+":"+r.PathValue("name")+":"+r.URL.RawQuery)
			w.WriteHeader(204)
		})
	}
	mux.HandleFunc("GET /v1.43/containers/json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"Names":["/dev-peer0.org1-ehr_1"]},{"Names":["/other"]}]`))
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(l) }()
	defer srv.Close()

	d := NewDocker(sock)
	ctx := context.Background()
	if s, err := d.State(ctx, "api"); err != nil || s != Paused {
		t.Fatal(s, err)
	}
	if s, err := d.State(ctx, "gone"); err != nil || s != Missing {
		t.Fatal(s, err)
	}
	for _, f := range []func() error{
		func() error { return d.Start(ctx, "a") },
		func() error { return d.Stop(ctx, "a", 7*time.Second) },
		func() error { return d.Pause(ctx, "a") },
		func() error { return d.Unpause(ctx, "a") },
	} {
		if err := f(); err != nil {
			t.Fatal(err)
		}
	}
	if calls[1] != "stop:a:t=7" || len(calls) != 4 {
		t.Fatal(calls)
	}
	names, err := d.ListByPrefix(ctx, "dev-peer0.org1")
	if err != nil || len(names) != 1 || names[0] != "dev-peer0.org1-ehr_1" {
		t.Fatal(names, err)
	}
}
