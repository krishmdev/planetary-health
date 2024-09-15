package authgate

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)

func tok(header, payload, secret string) string {
	h := base64.RawURLEncoding.EncodeToString([]byte(header))
	p := base64.RawURLEncoding.EncodeToString([]byte(payload))
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(h + "." + p))
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func TestVerify(t *testing.T) {
	v := NewVerifier("k", "iss", "aud")
	v.now = func() time.Time { return time.Unix(1000, 0) }
	hs := `{"alg":"HS256"}`
	ok := `{"sub":"alice","iss":"iss","aud":"aud","exp":2000}`
	if sub, err := v.Verify(tok(hs, ok, "k")); err != nil || sub != "alice" {
		t.Fatal(sub, err)
	}
	if _, err := v.Verify(tok(hs, `{"sub":"a","iss":"iss","aud":["x","aud"],"exp":2000}`, "k")); err != nil {
		t.Fatal("array audience", err)
	}
	bad := []string{
		tok(hs, ok, "other"),
		tok(`{"alg":"none"}`, ok, "k"),
		tok(hs, `{"sub":"alice","iss":"iss","aud":"aud","exp":999}`, "k"),
		tok(hs, `{"sub":"alice","iss":"x","aud":"aud","exp":2000}`, "k"),
		tok(hs, `{"sub":"alice","iss":"iss","aud":"org2","exp":2000}`, "k"),
		tok(hs, `{"sub":"alice","iss":"iss","aud":"aud","exp":2000,"nbf":1500}`, "k"),
		tok(hs, `{"iss":"iss","aud":"aud","exp":2000}`, "k"),
		"a.b", "",
	}
	for i, b := range bad {
		if _, err := v.Verify(b); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
}

func TestBucket(t *testing.T) {
	b := NewBucket(2, 1)
	now := time.Unix(0, 0)
	b.now = func() time.Time { return now }
	if !b.Allow("ip") || !b.Allow("ip") || b.Allow("ip") {
		t.Fatal("burst of 2")
	}
	if !b.Allow("other") {
		t.Fatal("buckets are per key")
	}
	now = now.Add(time.Second)
	if !b.Allow("ip") {
		t.Fatal("refill")
	}
}
