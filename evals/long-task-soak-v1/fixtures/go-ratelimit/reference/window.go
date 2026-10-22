package ratelimit

import (
	"sync"
	"time"
)

// SlidingWindow allows at most limit requests in any window-long period. It
// keeps the times of the allowed requests; a record exactly window old has
// expired.
type SlidingWindow struct {
	mu     sync.Mutex
	clock  Clock
	limit  int
	window time.Duration
	hits   []time.Time // oldest first
}

func NewSlidingWindow(limit int, window time.Duration, clock Clock) *SlidingWindow {
	if limit < 1 || window <= 0 {
		panic("ratelimit: limit must be >= 1 and window > 0")
	}
	return &SlidingWindow{clock: clock, limit: limit, window: window}
}

func (w *SlidingWindow) Allow() Decision {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.clock.Now()
	expired := 0
	for expired < len(w.hits) && now.Sub(w.hits[expired]) >= w.window {
		expired++
	}
	w.hits = w.hits[expired:]
	if len(w.hits) < w.limit {
		w.hits = append(w.hits, now)
		return Decision{Allowed: true, Limit: w.limit, Remaining: w.limit - len(w.hits)}
	}
	return Decision{Allowed: false, Limit: w.limit, Remaining: 0, RetryAfter: w.hits[0].Add(w.window).Sub(now)}
}
