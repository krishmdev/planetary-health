// Package authgate verifies the org gateway's HS256 JWTs before anything is woken, so an
// unauthenticated flood cannot turn into a flood of cold starts.
package authgate

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

var ErrInvalid = errors.New("invalid token")

type Verifier struct {
	secret   []byte
	issuer   string
	audience string
	now      func() time.Time
}

func NewVerifier(secret, issuer, audience string) *Verifier {
	return &Verifier{secret: []byte(secret), issuer: issuer, audience: audience, now: time.Now}
}

type claims struct {
	Sub string          `json:"sub"`
	Iss string          `json:"iss"`
	Aud json.RawMessage `json:"aud"`
	Exp float64         `json:"exp"`
	Nbf float64         `json:"nbf"`
}

func (v *Verifier) audOK(raw json.RawMessage) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == v.audience
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		for _, a := range many {
			if a == v.audience {
				return true
			}
		}
	}
	return false
}

// Verify checks the header algorithm, the HMAC, issuer, audience and expiry. It returns the
// subject.
func (v *Verifier) Verify(token string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrInvalid
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", ErrInvalid
	}
	var hdr struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(hb, &hdr) != nil || hdr.Alg != "HS256" {
		return "", ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return "", ErrInvalid
	}
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", ErrInvalid
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", ErrInvalid
	}
	var c claims
	if json.Unmarshal(pb, &c) != nil {
		return "", ErrInvalid
	}
	now := float64(v.now().Unix())
	if c.Sub == "" || c.Iss != v.issuer || !v.audOK(c.Aud) || c.Exp <= now || (c.Nbf != 0 && c.Nbf > now) {
		return "", ErrInvalid
	}
	return c.Sub, nil
}

// Bucket is a per-key token bucket.
type Bucket struct {
	mu       sync.Mutex
	capacity float64
	rate     float64
	state    map[string]*bucketState
	now      func() time.Time
}

type bucketState struct {
	tokens float64
	at     time.Time
}

func NewBucket(capacity int, perSecond float64) *Bucket {
	return &Bucket{capacity: float64(capacity), rate: perSecond, state: map[string]*bucketState{}, now: time.Now}
}

func (b *Bucket) Allow(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	s, ok := b.state[key]
	if !ok {
		s = &bucketState{tokens: b.capacity, at: now}
		b.state[key] = s
	}
	s.tokens = min(b.capacity, s.tokens+now.Sub(s.at).Seconds()*b.rate)
	s.at = now
	if len(b.state) > 10000 {
		b.state = map[string]*bucketState{key: s}
	}
	if s.tokens < 1 {
		return false
	}
	s.tokens--
	return true
}
