// Hidden acceptance checks for SPEC.md. The soak oracle lays this package
// over the agent's work; it lives in its own package so its helpers can
// never clash with the agent's own test files.
package zzhidden_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	rl "example.com/ratelimit"
)

var start = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

func mustPanic(t *testing.T, what string, f func()) {
	t.Helper()
	defer func() {
		if recover() == nil {
			t.Errorf("%s: expected a panic", what)
		}
	}()
	f()
}

// §1 the fixed bug: refill keeps fractions.
func TestHiddenBucketFractionalRefill(t *testing.T) {
	clock := rl.NewFakeClock(start)
	b := rl.NewTokenBucket(2, 4, clock)
	b.Allow()
	b.Allow()
	var got []bool
	for i := 0; i < 8; i++ {
		clock.Advance(125 * time.Millisecond)
		got = append(got, b.Allow().Allowed)
	}
	want := []bool{false, true, false, true, false, true, false, true}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("125ms steps at 4 tokens/s: got %v want %v", got, want)
		}
	}
	clock.Advance(125 * time.Millisecond)
	if tok := b.Tokens(); tok != 0.5 {
		t.Fatalf("Tokens() = %v, want 0.5", tok)
	}
	if d := b.Allow(); d.Allowed || d.RetryAfter != 125*time.Millisecond || d.Remaining != 0 || d.Limit != 2 {
		t.Fatalf("half a token: %+v", d)
	}
}

func TestHiddenBucketCapAndRemaining(t *testing.T) {
	clock := rl.NewFakeClock(start)
	b := rl.NewTokenBucket(3, 100, clock)
	clock.Advance(time.Hour)
	if tok := b.Tokens(); tok != 3 {
		t.Fatalf("bucket must not exceed capacity: %v", tok)
	}
	for i := 0; i < 3; i++ {
		if d := b.Allow(); !d.Allowed || d.Remaining != 2-i {
			t.Fatalf("request %d: %+v", i, d)
		}
	}
	if d := b.Allow(); d.Allowed || d.RetryAfter != 10*time.Millisecond {
		t.Fatalf("drained at 100/s: %+v", d)
	}
	slow := rl.NewTokenBucket(5, 2, clock)
	slow.Allow()                                           // 4 left
	clock.Advance(250 * time.Millisecond)                  // 4.5
	if d := slow.Allow(); !d.Allowed || d.Remaining != 3 { // 3.5 -> floor 3
		t.Fatalf("remaining is floor of tokens: %+v", d)
	}
	clock.Advance(250 * time.Millisecond) // 4.0
	if tok := slow.Tokens(); tok != 4 {
		t.Fatalf("Tokens() = %v, want 4", tok)
	}
	mustPanic(t, "capacity 0", func() { rl.NewTokenBucket(0, 1, clock) })
}

// §2 sliding window.
func TestHiddenSlidingWindow(t *testing.T) {
	clock := rl.NewFakeClock(start)
	w := rl.NewSlidingWindow(3, 10*time.Second, clock)
	for i, at := range []time.Duration{0, 2 * time.Second, 2 * time.Second} {
		clock.Advance(at)
		if d := w.Allow(); !d.Allowed || d.Remaining != 2-i || d.Limit != 3 || d.RetryAfter != 0 {
			t.Fatalf("request %d: %+v", i, d)
		}
	}
	clock.Advance(time.Second) // t=5
	if d := w.Allow(); d.Allowed || d.RetryAfter != 5*time.Second || d.Remaining != 0 || d.Limit != 3 {
		t.Fatalf("full window at t=5: %+v", d)
	}
	clock.Advance(5 * time.Second) // t=10: the t=0 record is exactly one window old -> expired
	if d := w.Allow(); !d.Allowed || d.Remaining != 0 {
		t.Fatalf("t=10 must be allowed (denied requests are not recorded): %+v", d)
	}
	clock.Advance(time.Second) // t=11: records at 2, 4, 10
	if d := w.Allow(); d.Allowed || d.RetryAfter != time.Second {
		t.Fatalf("t=11: %+v", d)
	}
	clock.Advance(time.Hour)
	if d := w.Allow(); !d.Allowed || d.Remaining != 2 {
		t.Fatalf("after an idle hour: %+v", d)
	}
	mustPanic(t, "limit 0", func() { rl.NewSlidingWindow(0, time.Second, clock) })
	mustPanic(t, "window 0", func() { rl.NewSlidingWindow(1, 0, clock) })
}

// §3 per-key limiters.
func TestHiddenKeyedIndependentAndSweep(t *testing.T) {
	clock := rl.NewFakeClock(start)
	var made int32
	k := rl.NewKeyed(func() rl.Limiter {
		atomic.AddInt32(&made, 1)
		return rl.NewSlidingWindow(1, time.Hour, clock)
	}, clock, time.Minute)
	if !k.Allow("a").Allowed || k.Allow("a").Allowed {
		t.Fatal("key a: first allowed, second denied")
	}
	if !k.Allow("b").Allowed {
		t.Fatal("key b is independent of key a")
	}
	if k.Len() != 2 || atomic.LoadInt32(&made) != 2 {
		t.Fatalf("len %d, limiters made %d", k.Len(), made)
	}
	clock.Advance(30 * time.Second)
	k.Allow("b") // b seen at t=30
	clock.Advance(30 * time.Second)
	if n := k.Sweep(); n != 1 || k.Len() != 1 {
		t.Fatalf("t=60, ttl 1m: a idle exactly 1m must go, b stays: swept %d len %d", n, k.Len())
	}
	if !k.Allow("a").Allowed || atomic.LoadInt32(&made) != 3 {
		t.Fatal("a swept key starts with a new limiter")
	}
	clock.Advance(59 * time.Second) // t=119: b idle 89s, a idle 59s
	if n := k.Sweep(); n != 1 || k.Len() != 1 {
		t.Fatalf("t=119: only b is idle a minute: swept %d len %d", n, k.Len())
	}
	clock.Advance(time.Second) // t=120: a idle exactly 1m
	if n := k.Sweep(); n != 1 || k.Len() != 0 {
		t.Fatalf("t=120: a goes too: swept %d len %d", n, k.Len())
	}

	never := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(1, time.Hour, clock) }, clock, 0)
	never.Allow("x")
	clock.Advance(1000 * time.Hour)
	if n := never.Sweep(); n != 0 || never.Len() != 1 {
		t.Fatalf("idleTTL 0 never sweeps: swept %d len %d", n, never.Len())
	}
}

func TestHiddenKeyedConcurrent(t *testing.T) {
	clock := rl.NewFakeClock(start)
	k := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(50, time.Minute, clock) }, clock, time.Minute)
	var allowed int32
	var wg sync.WaitGroup
	for i := 0; i < 400; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if k.Allow("shared").Allowed {
				atomic.AddInt32(&allowed, 1)
			}
			k.Allow("own-" + string(rune('A'+i%40)))
		}(i)
	}
	wg.Wait()
	if allowed != 50 {
		t.Fatalf("exactly 50 of 400 concurrent requests must pass, got %d", allowed)
	}
	if k.Len() != 41 {
		t.Fatalf("len %d, want 41", k.Len())
	}
}

// §4 middleware.
type served struct{ calls int32 }

func (s *served) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt32(&s.calls, 1)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

func do(h http.Handler, remote string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/items", nil)
	req.RemoteAddr = remote
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHiddenMiddlewareAllowAndDeny(t *testing.T) {
	clock := rl.NewFakeClock(start)
	store := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(2, 90*time.Second, clock) }, clock, time.Hour)
	next := &served{}
	h := rl.Middleware(rl.Options{Store: store})(next)

	r1 := do(h, "198.51.100.7:4000", nil)
	if r1.Code != 200 || r1.Header().Get("X-RateLimit-Limit") != "2" || r1.Header().Get("X-RateLimit-Remaining") != "1" {
		t.Fatalf("first: %d %v", r1.Code, r1.Header())
	}
	clock.Advance(500 * time.Millisecond)
	r2 := do(h, "198.51.100.7:4001", nil) // same IP, other port: same client
	if r2.Code != 200 || r2.Header().Get("X-RateLimit-Remaining") != "0" {
		t.Fatalf("second: %d %v", r2.Code, r2.Header())
	}
	r3 := do(h, "198.51.100.7:4002", nil)
	if r3.Code != http.StatusTooManyRequests {
		t.Fatalf("third must be 429, got %d", r3.Code)
	}
	if got := r3.Header().Get("Retry-After"); got != "90" { // 89.5s rounded up
		t.Fatalf("Retry-After %q, want 90", got)
	}
	if r3.Header().Get("X-RateLimit-Limit") != "2" || r3.Header().Get("X-RateLimit-Remaining") != "0" {
		t.Fatalf("429 headers: %v", r3.Header())
	}
	if ct := r3.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type %q", ct)
	}
	var body struct {
		Error      string `json:"error"`
		RetryAfter int    `json:"retry_after"`
	}
	if err := json.Unmarshal(r3.Body.Bytes(), &body); err != nil || body.Error != "rate_limited" || body.RetryAfter != 90 {
		t.Fatalf("body %q (%v)", r3.Body.String(), err)
	}
	if atomic.LoadInt32(&next.calls) != 2 {
		t.Fatalf("next handler must not run on 429; calls %d", next.calls)
	}
	if r := do(h, "198.51.100.8:4000", nil); r.Code != 200 {
		t.Fatalf("another client is independent: %d", r.Code)
	}
}

func TestHiddenMiddlewareRetryAfterRoundsUpMinOne(t *testing.T) {
	clock := rl.NewFakeClock(start)
	fast := rl.NewKeyed(func() rl.Limiter { return rl.NewTokenBucket(1, 4, clock) }, clock, 0)
	h := rl.Middleware(rl.Options{Store: fast})(&served{})
	do(h, "10.1.1.1:1", nil)
	if r := do(h, "10.1.1.1:1", nil); r.Code != 429 || r.Header().Get("Retry-After") != "1" {
		t.Fatalf("250ms must round up to 1: %d %q", r.Code, r.Header().Get("Retry-After"))
	}
	slow := rl.NewKeyed(func() rl.Limiter { return rl.NewTokenBucket(1, 0.4, clock) }, clock, 0)
	h2 := rl.Middleware(rl.Options{Store: slow})(&served{})
	do(h2, "10.1.1.1:1", nil)
	if r := do(h2, "10.1.1.1:1", nil); r.Code != 429 || r.Header().Get("Retry-After") != "3" {
		t.Fatalf("2.5s must round up to 3: %d %q", r.Code, r.Header().Get("Retry-After"))
	}
}

func TestHiddenMiddlewareExemptKeyFuncAndProxy(t *testing.T) {
	clock := rl.NewFakeClock(start)
	store := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(1, time.Minute, clock) }, clock, 0)
	next := &served{}
	h := rl.Middleware(rl.Options{Store: store, Exempt: func(r *http.Request) bool { return r.Header.Get("X-Health") == "1" }})(next)
	for i := 0; i < 3; i++ {
		r := do(h, "10.0.0.1:1", map[string]string{"X-Health": "1"})
		if r.Code != 200 || r.Header().Get("X-RateLimit-Limit") != "" {
			t.Fatalf("exempt request %d: %d %v", i, r.Code, r.Header())
		}
	}
	if store.Len() != 0 {
		t.Fatalf("exempt requests must not be counted; store has %d keys", store.Len())
	}
	if r := do(h, "10.0.0.1:1", nil); r.Code != 200 {
		t.Fatalf("first counted request: %d", r.Code)
	}

	byUser := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(1, time.Minute, clock) }, clock, 0)
	hu := rl.Middleware(rl.Options{Store: byUser, KeyFunc: func(r *http.Request) string { return r.Header.Get("X-User") }})(&served{})
	if do(hu, "10.0.0.1:1", map[string]string{"X-User": "u1"}).Code != 200 ||
		do(hu, "10.0.0.2:1", map[string]string{"X-User": "u1"}).Code != 429 ||
		do(hu, "10.0.0.1:1", map[string]string{"X-User": "u2"}).Code != 200 {
		t.Fatal("KeyFunc must decide the client")
	}

	proxied := rl.NewKeyed(func() rl.Limiter { return rl.NewSlidingWindow(1, time.Minute, clock) }, clock, 0)
	hp := rl.Middleware(rl.Options{Store: proxied, TrustProxy: true})(&served{})
	if do(hp, "10.9.9.9:1", map[string]string{"X-Forwarded-For": "203.0.113.1, 10.9.9.9"}).Code != 200 ||
		do(hp, "10.9.9.9:1", map[string]string{"X-Forwarded-For": "203.0.113.2, 10.9.9.9"}).Code != 200 ||
		do(hp, "10.9.9.8:1", map[string]string{"X-Forwarded-For": "203.0.113.1"}).Code != 429 {
		t.Fatal("TrustProxy: the default key is the first X-Forwarded-For entry")
	}
	mustPanic(t, "nil Store", func() { rl.Middleware(rl.Options{}) })
}

// §5 client IP.
func TestHiddenClientIP(t *testing.T) {
	mk := func(remote, xff string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return r
	}
	cases := []struct {
		remote, xff string
		trust       bool
		want        string
	}{
		{"192.0.2.1:1234", "", false, "192.0.2.1"},
		{"[2001:db8::1]:443", "", false, "2001:db8::1"},
		{"[::1]:8080", "", true, "::1"},
		{"192.0.2.1:1234", "203.0.113.5", false, "192.0.2.1"},
		{"192.0.2.1:1234", "  203.0.113.5 ,198.51.100.1", true, "203.0.113.5"},
		{"192.0.2.1:1234", "203.0.113.6", true, "203.0.113.6"},
		{"unix-socket", "", false, "unix-socket"},
	}
	for _, c := range cases {
		if got := rl.ClientIP(mk(c.remote, c.xff), c.trust); got != c.want {
			t.Errorf("ClientIP(%q, xff %q, trust %v) = %q, want %q", c.remote, c.xff, c.trust, got, c.want)
		}
	}
}
